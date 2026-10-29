"""One command that answers "may this be pushed?".

`AGENTS.md` lists the checks in prose in a fixed order, which is the right order and the
wrong mechanism: it is run by hand, remembered differently each time, and its output is
a number someone has to copy correctly. T095B77 found three real identifiers in the
published tree while the prose gate printed nothing, so the mechanism is the problem,
not the list.

This runs every check in that list and prints one verdict. It writes nothing outside a
temporary directory, opens no network connection, and never touches the running
extension, the native host registration or the host queue.

Usage
-----
    python -B tools/release_gate.py                 # suites + hygiene in this tree
    python -B tools/release_gate.py --clean-clone   # and once more in a fresh clone
    python -B tools/release_gate.py --json
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# `AGENTS.md`: with the launcher binary and the real manifest absent, the Python suite
# must report exactly this many skips. Asserting the number means a check that silently
# stopped running is noticed; a changed number is a deliberate edit to this constant.
EXPECTED_SKIPS = 11

RESULT_LINE = re.compile(r'^RESULT: (\d+) passed, (\d+) failed', re.MULTILINE)
# Three output conventions live in this repository and all are legitimate:
#   `RESULT: 72 passed, 0 failed`      hand-rolled suites
#   `T056: 33 passed, 0 failed`        the same, prefixed with the task id
#   `ℹ pass 12` / `# fail 0`           suites written against node:test
# Reading only the first kind reported seven healthy suites as failures on the gate's
# first run -- the gate was wrong, not them.
COUNT_LINE = re.compile(r'(\d+) passed, (\d+) failed')
SENTENCE_RESULT = re.compile(r'^RESULT: ', re.MULTILINE)
TAP_PASS = re.compile(r'^[\u2139#]\s*pass (\d+)', re.MULTILINE)
TAP_FAIL = re.compile(r'^[\u2139#]\s*fail (\d+)', re.MULTILINE)
PY_RAN = re.compile(r'^Ran (\d+) tests', re.MULTILINE)
PY_SKIPS = re.compile(r'^(?:OK|FAILED) \(skipped=(\d+)\)', re.MULTILINE)


def parse_summary(text):
    """(convention, passed, failed), or None when the file prints no summary at all."""
    match = RESULT_LINE.search(text)
    if match:
        return 'RESULT', int(match.group(1)), int(match.group(2))
    counts = COUNT_LINE.search(text)
    if counts:
        return 'COUNT', int(counts.group(1)), int(counts.group(2))
    tap_pass = TAP_PASS.search(text)
    tap_fail = TAP_FAIL.search(text)
    if tap_pass or tap_fail:
        return ('TAP', int(tap_pass.group(1)) if tap_pass else 0,
                int(tap_fail.group(1)) if tap_fail else 0)
    if SENTENCE_RESULT.search(text):
        # A suite that reports its verdict in words. It still fails through its exit
        # code, but it contributes no assertion count and must not be called a helper.
        return 'sentence', 0, 0
    return None


def child_env():
    """The JS suites spawn Python for their Python helpers and read it from here."""
    env = dict(os.environ)
    env['PYTHON'] = sys.executable
    env.pop('PYTHONDONTWRITEBYTECODE', None)
    return env


def run(command, cwd, timeout=1800):
    started = time.time()
    done = subprocess.run(command, cwd=cwd, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          env=child_env(), timeout=timeout)
    return {
        'command': ' '.join(command),
        'returncode': done.returncode,
        'output': done.stdout.decode('utf-8', 'replace'),
        'seconds': round(time.time() - started, 1),
    }


def step(name, command, cwd, timeout=1800):
    outcome = run(command, cwd, timeout)
    outcome['name'] = name
    outcome['ok'] = outcome['returncode'] == 0
    return outcome


def python_suite(root):
    outcome = step('python suite',
                   [sys.executable, '-B', '-W', 'ignore::ResourceWarning',
                    '-m', 'unittest', 'discover', '-s', '.', '-p', 'test_*.py'],
                   root)
    ran = PY_RAN.search(outcome['output'])
    skips = PY_SKIPS.search(outcome['output'])
    outcome['tests'] = int(ran.group(1)) if ran else 0
    outcome['skips'] = int(skips.group(1)) if skips else 0
    if outcome['ok'] and skips is None:
        outcome['ok'] = False
        outcome['problem'] = ('the suite neither passed nor skipped cleanly; the last '
                              'lines were: ' + outcome['output'].strip().splitlines()[-1])
    return outcome


def js_suites(root):
    """Every `test_*.mjs`, each in its own node process.

    Run one at a time on purpose: a suite that hangs cannot then be reported as a number
    of passes, and the failing suite is named. A file that prints no summary at all and
    exits 0 is a shared helper (one of them, `test_t048_fakes.mjs`, is imported by other
    suites and is not a suite itself); it is listed as a helper rather than counted.
    """
    names = sorted(name for name in os.listdir(root)
                   if name.startswith('test_') and name.endswith('.mjs'))
    suites = []
    helpers = []
    assertions = 0
    failed = []
    for name in names:
        outcome = step(name, ['node', name], root)
        summary = parse_summary(outcome['output'])
        if summary is None:
            passed = broke = 0
            convention = 'none'
        else:
            convention, passed, broke = summary
        assertions += passed
        outcome['passed'] = passed
        outcome['failed_assertions'] = broke
        outcome['convention'] = convention
        if convention == 'none':
            # No summary at all: a shared helper, not a suite. Its exit code still has
            # to be 0 or something broke while it was imported.
            if outcome['returncode'] == 0:
                helpers.append(name)
                outcome['ok'] = True
            else:
                outcome['ok'] = False
                failed.append(name)
        else:
            outcome['ok'] = outcome['returncode'] == 0 and broke == 0
            if not outcome['ok']:
                failed.append(name)
        suites.append(outcome)
    return {'name': 'js suites', 'suites': suites,
            'count': len(names) - len(helpers), 'helpers': helpers,
            'failed': failed, 'assertions': assertions, 'ok': not failed}


def hygiene(root):
    tool = os.path.join(root, 'tools', 'hygiene_scan.py')
    self_test = step('hygiene self-test', [sys.executable, '-B', tool, '--self-test'], root)
    scan = step('hygiene scan', [sys.executable, '-B', tool, '--all', '--root', root], root)
    counts = re.search(r'hygiene: (\d+) unexplained, (\d+) excused with a reason, '
                       r'(\d+) stale', scan['output'])
    scan['unexplained'] = int(counts.group(1)) if counts else None
    scan['excused'] = int(counts.group(2)) if counts else None
    scan['stale'] = int(counts.group(3)) if counts else None
    scan['ok'] = scan['ok'] and counts is not None and scan['unexplained'] == 0
    return {'name': 'hygiene', 'steps': [self_test, scan], 'ok': self_test['ok'] and scan['ok'],
            'detail': scan}


def worktree_state(root):
    """Nothing uncommitted may be pushed by accident, and nothing ignored may be
    published. Both are one command and both have bitten before."""
    dirty = run(['git', 'status', '--porcelain'], root)
    outcome = {
        'name': 'worktree',
        'ok': dirty['returncode'] == 0,
        'output': dirty['output'].strip(),
    }
    outcome['clean'] = outcome['ok'] and outcome['output'] == ''
    return outcome


def gate(root, clean_clone=False):
    parts = [worktree_state(root), hygiene(root), python_suite(root), js_suites(root)]
    result = {
        'root': root,
        'ok': all(part['ok'] for part in parts),
        'parts': parts,
        'clean_clone': None,
    }
    if clean_clone:
        result['clean_clone'] = clone_gate(root)
        result['ok'] = result['ok'] and result['clean_clone']['ok']
    return result


def clone_gate(root):
    """The suites must pass in a checkout of what is committed, not only here.

    A working tree carries untracked helpers, stale build output and, once already, a
    live directory that a suite was quietly reading instead of its own. None of that
    travels with a push.
    """
    temp = tempfile.mkdtemp(prefix='agentrelay-gate-')
    target = os.path.join(temp, 'clone')
    try:
        clone = run(['git', 'clone', '--quiet', '--depth', '1',
                     'file://' + root.replace('\\', '/'), target], temp)
        if clone['returncode'] != 0:
            return {'ok': False, 'problem': clone['output'].strip()[:400]}
        head = run(['git', 'rev-parse', 'HEAD'], target)
        py = python_suite(target)
        js = js_suites(target)
        problems = []
        if not py['ok']:
            problems.append('python suite failed in the clone')
        if py['skips'] != EXPECTED_SKIPS:
            problems.append('expected %d skips in a clone, saw %d -- update '
                            'EXPECTED_SKIPS deliberately if this changed'
                            % (EXPECTED_SKIPS, py['skips']))
        if not js['ok']:
            problems.append('js suites failed in the clone: %s' % ', '.join(js['failed']))
        return {'ok': not problems, 'sha': head['output'].strip()[:40],
                'python': {'tests': py['tests'], 'skips': py['skips'], 'ok': py['ok']},
                'js': {'count': js['count'], 'assertions': js['assertions'],
                       'ok': js['ok']},
                'problems': problems}
    finally:
        shutil.rmtree(temp, ignore_errors=True)


def summarise(result):
    print('')
    print('=' * 78)
    for part in result['parts']:
        mark = 'PASS' if part['ok'] else 'FAIL'
        if part['name'] == 'worktree':
            extra = 'clean' if part.get('clean') else (
                'uncommitted changes:\n' + (part.get('output') or '(none)'))
        elif part['name'] == 'hygiene':
            detail = part['detail']
            extra = ('%s unexplained, %s excused, %s stale; self-test %s'
                     % (detail['unexplained'], detail['excused'], detail['stale'],
                        'passed' if part['steps'][0]['ok'] else 'FAILED'))
        elif part['name'] == 'python suite':
            extra = '%d tests, %d skips' % (part['tests'], part['skips'])
        else:
            extra = '%d suites, %d assertions' % (part['count'], part['assertions'])
            if part['failed']:
                extra += '; failing: ' + ', '.join(part['failed'])
        print('%-8s %-14s %s' % (mark, part['name'], extra))
        if not part['ok']:
            tail = part.get('output', '').strip().splitlines()[-6:]
            for line in tail:
                print('         ' + line)
    if result['clean_clone']:
        clone = result['clean_clone']
        print('%-8s %-14s %s' % ('PASS' if clone['ok'] else 'FAIL', 'clean clone',
                                 clone.get('sha') or clone.get('problem')))
        for problem in clone.get('problems') or []:
            print('         ' + problem)
    print('')
    print('VERDICT: %s' % ('may be pushed' if result['ok'] else 'DO NOT PUSH'))
    return 0 if result['ok'] else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=HERE)
    parser.add_argument('--clean-clone', action='store_true',
                        help='also clone HEAD and run both suites there')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--skip-worktree', action='store_true',
                        help='run the checks but do not require a clean worktree; use '
                             'before committing, not before pushing')
    args = parser.parse_args(argv)

    root = os.path.abspath(args.root)
    result = gate(root, clean_clone=args.clean_clone)
    if args.skip_worktree:
        for part in result['parts']:
            if part['name'] == 'worktree':
                part['ok'] = True
        result['ok'] = all(part['ok'] for part in result['parts'])
        if result['clean_clone']:
            result['ok'] = result['ok'] and result['clean_clone']['ok']
    if args.json:
        slim = {'ok': result['ok'], 'clean_clone': result['clean_clone'],
                'parts': [{'name': p['name'], 'ok': p['ok'],
                           **{k: p[k] for k in ('tests', 'skips', 'count',
                                                'assertions', 'failed')
                              if k in p}} for p in result['parts']]}
        print(json.dumps(slim, indent=2))
        return 0 if result['ok'] else 1
    return summarise(result)


if __name__ == '__main__':
    raise SystemExit(main())
