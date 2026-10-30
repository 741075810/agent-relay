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
EXPECTED_SKIPS = 13  # +2: POSIX-only lock-swap test, Windows-only junction test

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
# unittest says `Ran 1 test` in the singular and `Ran 2 tests` in the plural. Requiring
# the plural made any repository with exactly one test read as "printed no test count".
PY_RAN = re.compile(r'^Ran (\d+) tests?\b', re.MULTILINE)
# unittest ends with `OK`, `OK (skipped=3)`, `FAILED (failures=1)` or
# `FAILED (failures=1, errors=2, skipped=43)` -- the parts vary in order and number.
PY_SUMMARY = re.compile(r'^(?:OK|FAILED) \(([^)]*)\)', re.MULTILINE)
PY_SKIPPED = re.compile(r'skipped=(\d+)')
PY_OK = re.compile(r'^OK\b', re.MULTILINE)

# `native_turns.py` reports `zstandard_missing` and reads zero turns without this, so it
# is a production dependency that was never declared. Its absence is invisible on the
# machine it was written on and fatal everywhere else: the host silently finds nothing to
# notify about. Thirty-odd tests skip without it, which made a green run greener than its
# coverage.
REQUIRED_PYTHON = [('zstandard', 'the host cannot read session.v4.jsonl.zstd without it')]
NODE_ZSTD_FLOOR = (22, 15)


def python_skips(text):
    """Skips counted by unittest, or None when the run printed no summary line at all.

    A bare `OK` means zero skips, and that is a different fact from no summary at all
    (`NO TESTS RAN` has none). Collapsing them made a clean single-test suite read as
    "neither passed nor skipped".
    """
    summary = PY_SUMMARY.search(text)
    if summary:
        counted = PY_SKIPPED.search(summary.group(1))
        return int(counted.group(1)) if counted else 0
    if PY_OK.search(text):
        return 0
    return None


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


# A hung suite must produce a verdict, not a stack trace. `subprocess.run(timeout=...)`
# kills the child it started -- but the e2e suites start their own host process, and that
# grandchild survives the kill and holds the pipe open. Killed by group, not by pid.
STEP_TIMEOUT = 1800


def kill_tree(proc):
    """Kill a child and everything it started."""
    if os.name == 'nt':
        subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=60)
    else:
        try:
            os.killpg(os.getpgid(proc.pid), 9)
        except OSError:
            proc.kill()


def run(command, cwd, timeout=None):
    """Run one step, and never let it run forever.

    On timeout the result says so and carries whatever output arrived first, so the gate
    can name the step that hung. The first version let `TimeoutExpired` escape, which
    killed the whole gate with a traceback: the run that is supposed to explain a failure
    became an unexplained failure of its own.
    """
    limit = STEP_TIMEOUT if timeout is None else timeout
    started = time.time()
    options = {}
    if os.name == 'nt':
        options['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options['start_new_session'] = True
    proc = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env=child_env(), **options)
    timed_out = False
    try:
        out = proc.communicate(timeout=limit)[0]
    except subprocess.TimeoutExpired:
        timed_out = True
        kill_tree(proc)
        try:
            out = proc.communicate(timeout=60)[0]
        except subprocess.TimeoutExpired:
            out = b''
    return {
        'command': ' '.join(command),
        'returncode': None if timed_out else proc.returncode,
        'output': (out or b'').decode('utf-8', 'replace'),
        'seconds': round(time.time() - started, 1),
        'timeout': timed_out,
        'timeout_seconds': limit,
    }


def step(name, command, cwd, timeout=None):
    outcome = run(command, cwd, timeout)
    outcome['name'] = name
    if outcome['timeout']:
        outcome['ok'] = False
        outcome['problem'] = ('<no verdict> timed out after %ss and was killed with its '
                              'children' % outcome['timeout_seconds'])
    else:
        outcome['ok'] = outcome['returncode'] == 0
    return outcome


def python_suite(root):
    """Run the suite verbosely so a skip carries its reason.

    Without `-v` the output says `skipped=43` and nothing about why, and a skip count is
    exactly the number that hides a real gap: a runner that skips thirty tests it would
    pass on a developer machine is greener than its coverage.
    """
    outcome = step('python suite',
                   [sys.executable, '-B', '-W', 'ignore::ResourceWarning',
                    '-m', 'unittest', 'discover', '-s', '.', '-p', 'test_*.py', '-v'],
                   root)
    ran = PY_RAN.search(outcome['output'])
    skips = python_skips(outcome['output'])
    outcome['tests'] = int(ran.group(1)) if ran else 0
    outcome['skips'] = skips or 0
    if outcome['ok'] and ran is None:
        outcome['ok'] = False
        outcome['problem'] = 'the suite printed no test count'
    elif outcome['ok'] and skips is None:
        outcome['ok'] = False
        outcome['problem'] = ('the suite neither passed nor skipped cleanly; the last '
                              'lines were: ' + outcome['output'].strip().splitlines()[-1])
    return outcome


def dependencies(root):
    """The optional-looking packages that are not optional.

    Checked separately from the suites because their absence does not fail those suites
    -- it makes them skip, and a skip count is exactly the number that hides a gap.
    """
    problems = []
    versions = {}
    for module, why in REQUIRED_PYTHON:
        probe = run([sys.executable, '-B', '-c',
                     'import %s as m; print(getattr(m, "__version__", "present"))'
                     % module], root)
        if probe['returncode'] != 0:
            problems.append('%s is missing: %s (pip install -r requirements.txt)'
                            % (module, why))
        else:
            versions[module] = probe['output'].strip()
    probe = run(['node', '-e',
                 'const z=require("node:zlib");'
                 'if(typeof z.zstdCompressSync!=="function")'
                 '{console.error("no zstdCompressSync");process.exit(3)}'
                 'process.stdout.write(process.versions.node)'], root)
    if probe['returncode'] != 0:
        problems.append('node %d.%d or newer is required for zlib.zstdCompressSync; '
                        'the session-log fixtures cannot be built without it'
                        % NODE_ZSTD_FLOOR)
    else:
        versions['node'] = probe['output'].strip()
    return {'name': 'dependencies', 'ok': not problems, 'problems': problems,
            'versions': versions,
            'output': '\n'.join(problems) if problems else
                      ', '.join('%s %s' % (k, v) for k, v in sorted(versions.items()))}


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
            'failed': failed, 'assertions': assertions, 'ok': not failed,
            'timed_out': [entry['name'] for entry in suites if entry.get('timeout')]}


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
    published. Both are one command and both have bitten before.

    `ok` requires a *clean* tree. The first version set `ok` from the exit code of
    `git status` alone and recorded cleanliness in a separate `clean` flag that the
    verdict never read, so the check that exists to stop an accidental push of
    uncommitted work reported PASS on a dirty tree -- for the whole first release.
    `test_release_gate.py` found it.
    """
    dirty = run(['git', 'status', '--porcelain'], root)
    listed = dirty['output'].strip() if dirty['returncode'] == 0 else ''
    return {
        'name': 'worktree',
        'git_ok': dirty['returncode'] == 0,
        'output': listed,
        'clean': dirty['returncode'] == 0 and listed == '',
        'ok': dirty['returncode'] == 0 and listed == '',
    }


def gate(root, clean_clone=False):
    parts = [worktree_state(root), dependencies(root), hygiene(root),
             python_suite(root), js_suites(root)]
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
        elif part['name'] == 'dependencies':
            extra = ('ok' if part['ok']
                     else '; '.join(part.get('problems') or ['missing']))
        else:
            extra = '%d suites, %d assertions' % (part['count'], part['assertions'])
            if part['failed']:
                extra += '; failing: ' + ', '.join(part['failed'])
            if part.get('timed_out'):
                extra += '; timed out: ' + ', '.join(part['timed_out'])
        print('%-8s %-14s %s' % (mark, part['name'], extra))
        if not part['ok']:
            for line in detail_lines(part):
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


# The lines that say why, out of a suite's whole output. A bare tail is not enough: a
# node:test suite prints its failing assertion above its summary, so the tail shows
# "fail 1" and nothing about what failed.
HIGH_LINE = re.compile(
    r'(^FAIL:|^ERROR:|^FAILED \(|AssertionError|^not ok |^# Subtest|^  FAIL |'
    r'ModuleNotFoundError|ImportError|^Error:|^error:|unexplained|ENOENT|EACCES|'
    r'EPERM|^Could not|^cannot |exit code|'
    # The hygiene scanner's own rows: the rule name that fired is here and nowhere else.
    r'^\s*(LEAK|REVIEW|STALE|excused)\s)')
LOW_LINE = re.compile(r'(Traceback|^\s+File "|^\s+\w+Error|\^)')

# Annotations are part of the public check-run record, so a machine path must not ride
# out on one. The negative test that proved this module works printed the operator's
# own temp directory into an annotation.
# A drive letter must not be the last letter of a word: without the lookbehind, `https://`
# matches as drive `s`, and every URL in an annotation becomes `http<path>`. That went
# unnoticed until a test asserted the scheme survives.
ABSOLUTE_PATH = re.compile(r'(?<![\w])[A-Za-z]:[\\/][^\s"\')]*')
USER_SEGMENT = re.compile(r'(Users[\\/]+)[^\\/\s"\')]+')
# POSIX paths too. This repository is Windows-first, so the scrubber only knew drive
# letters -- and the first run of the Linux CI job published a runner's temporary
# directory inside a check-run annotation, which is public. Two segments minimum, and not
# after a `:` or another `/`, so a URL keeps its scheme.
POSIX_PATH = re.compile(r'(?<![\w:/])/(?:[\w.@+\-]+/)+[\w.@+\-]*')
# `-v` puts the reason inside the skip line: `test_x (...) ... skipped 'why'`.
SKIP_REASON = re.compile(r"skipped '([^']+)'")


def skip_summary(part, keep=3):
    """Why tests were skipped, most frequent first, or None."""
    counts = {}
    for match in SKIP_REASON.finditer(part.get('output') or ''):
        reason = match.group(1)
        counts[reason] = counts.get(reason, 0) + 1
    if not counts:
        return None
    top = sorted(counts.items(), key=lambda item: -item[1])[:keep]
    return '; '.join('%dx %s' % (count, scrub(reason)[:100]) for reason, count in top)


def scrub(text):
    """Remove machine-specific paths from anything headed for a public annotation.

    Drive-letter paths first (that rule also swallows the account segment inside one),
    then an account segment on its own for a path that appears without a drive letter,
    then POSIX paths.
    """
    text = USER_SEGMENT.sub(r'\1<user>', ABSOLUTE_PATH.sub('<path>', text))
    return POSIX_PATH.sub('<path>', text)


def text_of(part):
    """The output that explains a part.

    `hygiene` is itself two steps, and its scan output -- the one that names the rule that
    fired -- lives under `detail`, not `output`. Reading only `output` made the hygiene
    annotation say the word "hygiene" and nothing else.
    """
    if part.get('output'):
        return part['output']
    return (part.get('detail') or {}).get('output') or ''


def headline(part):
    """One line that identifies what failed, before any detail floods the budget."""
    name = part['name']
    if name == 'js suites' and part.get('failed'):
        return name + ': ' + ', '.join(part['failed'])
    if name == 'python suite':
        return name + ': %d tests, %d skips' % (part.get('tests'), part.get('skips'))
    if name == 'hygiene':
        detail = part.get('detail') or {}
        return '%s: %s unexplained, %s stale' % (name, detail.get('unexplained'),
                                                 detail.get('stale'))
    if name == 'dependencies':
        return name + ': ' + ', '.join(part.get('problems') or ['ok'])
    return name


def detail_lines(part, limit=8):
    """The few lines of a part's output that explain the failure, most telling first."""
    if part.get('problem'):
        return [scrub(str(part['problem']))][:limit]
    text = text_of(part)
    high, low = [], []
    for line in text.splitlines():
        stripped = line.rstrip()
        if not stripped:
            continue
        if HIGH_LINE.search(stripped):
            high.append(scrub(stripped[:300]))
        elif LOW_LINE.search(stripped):
            low.append(scrub(stripped[:300]))
    picked = (high + low)[:limit]
    if picked:
        return picked
    return [scrub(line) for line in text.strip().splitlines()[-limit:]]


def github_escape(text):
    return (text.replace('%', '%25').replace('\r', '%0D')
            .replace('\n', '%0A').replace(':', '%3A').replace(',', '%2C'))


def github_report(result):
    """Emit `::error::` / `::notice::` workflow commands.

    The reason is not only in the log: job logs need `actions: read`, so an operator (or
    an agent) without that scope can see *that* CI is red and not *why*. Annotations are
    part of the public check-run record, so a failure that explains itself here can be
    read with an unauthenticated API call. That is how the first red run was diagnosed.
    """
    emitted = 0
    for part in result['parts']:
        if part['ok']:
            continue
        # One summary annotation per failing check first, so no check can be crowded out
        # by another one's detail. The first run of this mode spent all eight of its
        # annotations on Python tracebacks and never named the failing JS suites.
        print('::error title=gate %s::%s' % (github_escape(part['name']),
                                             github_escape(headline(part))))
        emitted += 1
    for part in result['parts']:
        if part['ok']:
            continue
        for line in detail_lines(part, limit=max(2, 8 - emitted)):
            if emitted >= 8:
                break
            print('::error title=gate %s::%s'
                  % (github_escape(part['name']), github_escape(line)))
            emitted += 1
    clone = result.get('clean_clone')
    if clone and not clone['ok']:
        for problem in (clone.get('problems') or [])[:3]:
            print('::error title=gate clean-clone::%s' % github_escape(problem))
            emitted += 1
    if result['ok']:
        parts = {part['name']: part for part in result['parts']}
        py = parts.get('python suite', {})
        js = parts.get('js suites', {})
        hy = parts.get('hygiene', {}).get('detail', {})
        skips = skip_summary(py) or 'none'
        print('::notice title=gate::passed: python %s tests, js %s suites/%s '
              'assertions, hygiene %s unexplained/%s excused/%s stale'
              % (py.get('tests'), js.get('count'), js.get('assertions'),
                 hy.get('unexplained'), hy.get('excused'), hy.get('stale')))
        # Why anything was skipped, on every run. A green run that skipped half the
        # suite is greener than its coverage and must not read as "all clear".
        print('::notice title=gate skips::%s skipped (%s)'
              % (py.get('skips'), github_escape(skips)))
    else:
        failing = [part['name'] for part in result['parts'] if not part['ok']]
        print('::error title=gate verdict::DO NOT PUSH -- failing: %s'
              % github_escape(', '.join(failing) or 'clean clone'))
        python = [part for part in result['parts'] if part['name'] == 'python suite']
        if python:
            skips = skip_summary(python[0])
            if skips:
                print('::error title=gate python skips::%s skipped (%s)'
                      % (python[0].get('skips'), github_escape(skips)))
    return 0 if result['ok'] else 1


def main(argv=None):
    global STEP_TIMEOUT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=HERE)
    parser.add_argument('--clean-clone', action='store_true',
                        help='also clone HEAD and run both suites there')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--github', action='store_true',
                        help='emit ::error::/::notice:: workflow commands so the reason '
                             'survives in the check-run annotations, which unlike job '
                             'logs need no token to read')
    parser.add_argument('--skip-worktree', action='store_true',
                        help='run the checks but do not require a clean worktree; use '
                             'before committing, not before pushing')
    parser.add_argument('--step-timeout', type=int, default=None,
                        help='seconds any single step may run before it is killed with '
                             'its children and reported as a failure (default %d). CI '
                             'sets this to the job budget so a hung suite is named '
                             'rather than timing the job out with no verdict.'
                             % STEP_TIMEOUT)
    args = parser.parse_args(argv)

    if args.step_timeout:
        STEP_TIMEOUT = args.step_timeout
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
    code = summarise(result)
    if args.github:
        github_report(result)
    return code


if __name__ == '__main__':
    raise SystemExit(main())
