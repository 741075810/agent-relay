"""Scan a tree for machine-identifying data before it is published.

Why this exists
---------------
`AGENTS.md` has described a publish gate in prose since the first release. Prose is not
a gate: it is run when someone remembers, with the patterns someone remembered. That
failure mode is documented in the same file -- a genuine unpacked-extension id shipped
in the first published commit "despite a report claiming it had been replaced", because
the scan cited in the report did not look for ids at all.

T095B77 ran the prose gate and it printed nothing, while the tree contained a real DSH
session id, one machine's absolute working path, and one machine's interpreter path.
Three reasons, each now encoded as a rule here:

  * the gate looked for identifiers only in the form `ghp_...`, never for the
    `session-<uuid>` form this project writes everywhere;
  * the path rule was written as `[A-Z]:\\\\Users`, i.e. one literal backslash, while
    source code stores an escaped path as two. `E:\\\\program\\\\python312` was therefore
    invisible. Any regex for a Windows path in source has to tolerate one *or* two;
  * nothing looked at forward-slash drive paths, which is how the JavaScript suites
    spell theirs.

Fragmenting the canaries
-----------------------
This file is itself scanned by the gate it contains, so it must not hold a single
literal shape that the rules forbid. Every canary below is assembled from pieces at run
time, and the backslash character is `chr(92)` written once. The first draft embedded the
canaries directly and the scanner immediately reported three leaks in itself -- which is
the check working, on its author.

The scan is deliberately mechanical and its output is masked: CI logs are public, so a
finding must not become the leak it reports.

Usage
-----
    python -B tools/hygiene_scan.py --all
    python -B tools/hygiene_scan.py --all --json
    python -B tools/hygiene_scan.py --self-test      # plants canaries, must catch all
    python -B tools/hygiene_scan.py --paths a.py b.mjs

Exit code is 1 when any finding is unexplained by the allowlist.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

# The file types this gate looks at. Documentation is deliberately excluded: a document
# that explains which patterns are forbidden has to contain them, and a gate that fires
# on its own explanation gets switched off.
SOURCE_SUFFIXES = ('.py', '.mjs', '.js', '.json', '.html', '.cs', '.ps1', '.yml', '.yaml')

# A path separator as it appears in raw file text: one backslash, or the two that a
# Python/JS string literal uses to represent one.
SEP = r'(?:\\\\|\\|/)'

RULES = [
    # (name, severity, pattern, description)
    ('windows-user-path', 'leak',
     re.compile(r'[A-Za-z]:' + SEP + r'{2}Users' + SEP, re.IGNORECASE),
     'a Windows user directory names the person the machine belongs to'),

    ('windows-path', 'review',
     re.compile(r'(?<![A-Za-z0-9])[A-Za-z]:' + SEP + r'[A-Za-z0-9_.$~-]+'),
     'an absolute Windows path publishes one machine\'s layout'),

    ('session-id', 'leak',
     re.compile(r'session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'),
     'a DSH session id is a real identifier unless it is self-evidently patterned'),

    ('conversation-id', 'review',
     re.compile(r'''["']?conversation_?I[dD]["']?\s*[:=]\s*["']'''
                r'''[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}["']'''),
     'a conversation id points at one real conversation'),

    ('extension-id', 'review',
     re.compile(r'chrome-extension://[a-p]{32}'),
     'a Chrome extension id, for unpacked extensions, is a hash of the load path'),

    ('private-key', 'leak',
     re.compile(r'BEGIN [A-Z ]*PRIVATE KEY'),
     'a private key'),

    ('host-token', 'leak',
     re.compile(r'gh[pousr]_[A-Za-z0-9]{20,}'),
     'a GitHub token'),
]

UUID_GROUP = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


def is_self_evidently_synthetic(uuid):
    """True when no human would mistake this for a real identifier.

    The test is narrow on purpose: the first eight hex characters must all be the same
    character. `11111111-...`, `aaaaaaaa-...` and `cccccccc-...` pass; `644cd4ce` and
    `d93ea870` do not. Version and variant groups are ignored -- `4xxx` and `8yyy` are
    the encoding, not identity, and every fixture in this repository uses them.

    A real id that happened to start with eight identical hex characters would be
    reported for review rather than passed. That is the right direction: the cost is a
    line in the allowlist, and the alternative is a leak nobody looked at.
    """
    if not isinstance(uuid, str):
        return False
    body = uuid
    if body.startswith('session-'):
        body = body[len('session-'):]
    if not UUID_GROUP.match(body):
        return False
    head = body.split('-')[0]
    return len(set(head)) == 1


def mask(text):
    """Show enough to locate the finding, not enough to republish it."""
    text = text.strip()
    if len(text) <= 14:
        return text[:4] + '...'
    return text[:10] + '...' + text[-4:]


def classify(name, match):
    """Turn a regex hit into a finding, applying the synthetic-identifier test."""
    text = match.group(0)
    if name == 'session-id':
        candidate = re.search(r'session-[0-9a-f-]{36}', text)
        if candidate and is_self_evidently_synthetic(candidate.group(0)):
            return None
    if name == 'conversation-id':
        candidate = re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}'
                              r'-[0-9a-f]{4}-[0-9a-f]{12}', text)
        if candidate and is_self_evidently_synthetic(candidate.group(0)):
            return None
    if name == 'extension-id':
        ident = text.rsplit('/', 1)[-1]
        # A single repeated letter, or a recognisable descending sequence, is
        # self-evidently synthetic. Chrome maps base16 onto a-p, so every real id
        # matches the regex too -- which is why these need judging, not patterning.
        if len(set(ident)) == 1 or ident == 'ponmlkjihgfedcbaponmlkjihgfedcba':
            return None
    return {'rule': name, 'excerpt': mask(text)}


def load_allowlist(root):
    """Entries are `rule  path  reason`.

    A reason is mandatory. An allowlist line without one is how an exception becomes
    indistinguishable from an oversight six months later.
    """
    entries = []
    path = os.path.join(root, '.hygiene-allow.txt')
    if not os.path.isfile(path):
        return entries
    with open(path, encoding='utf-8') as handle:
        for lineno, raw in enumerate(handle, 1):
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split(None, 2)
            if len(parts) < 3 or not parts[2].strip():
                raise ValueError('%s:%d: allowlist entry needs rule, path and a reason'
                                 % (os.path.basename(path), lineno))
            entries.append({'rule': parts[0], 'path': parts[1].replace('\\', '/'),
                            'reason': parts[2].strip()})
    return entries


def allowlisted(findings, allowlist):
    kept, excused = [], []
    for finding in findings:
        hit = None
        for entry in allowlist:
            if entry['rule'] != finding['rule']:
                continue
            if finding['path'] == entry['path'] or finding['path'].startswith(
                    entry['path'].rstrip('*')):
                hit = entry
                break
        if hit:
            excused.append(dict(finding, reason=hit['reason']))
        else:
            kept.append(finding)
    return kept, excused


def stale_entries(allowlist, findings):
    """Allowlist entries that no longer excuse anything.

    A stale entry is not harmless: it sits there matching the same rule and path
    prefix, so the day a *new* finding appears in that file it is excused by an entry
    written about a value that is no longer there. Failing on staleness forces the
    judgement to be renewed rather than inherited.
    """
    stale = []
    for entry in allowlist:
        prefix = entry['path'].rstrip('*')
        matched = any(
            finding['rule'] == entry['rule']
            and (finding['path'] == entry['path'] or finding['path'].startswith(prefix))
            for finding in findings)
        if not matched:
            stale.append(entry)
    return stale


def scan_text(relpath, text):
    findings = []
    for name, severity, pattern, description in RULES:
        for match in pattern.finditer(text):
            verdict = classify(name, match)
            if verdict is None:
                continue
            line = text.count('\n', 0, match.start()) + 1
            findings.append({'path': relpath, 'line': line, 'severity': severity,
                             'rule': verdict['rule'], 'excerpt': verdict['excerpt'],
                             'why': description})
    return findings


def iter_tracked(root):
    """Tracked files only. An untracked scratch file is not published, and scanning it
    would make the gate fail for reasons the gate cannot fix."""
    try:
        out = subprocess.run(['git', 'ls-files'], cwd=root, check=True,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit('cannot list tracked files (not a git checkout?): %s' % exc)
    for raw in out.stdout.decode('utf-8', 'replace').splitlines():
        name = raw.strip()
        if not name or not name.lower().endswith(SOURCE_SUFFIXES):
            continue
        yield name.replace('\\', '/'), os.path.join(root, name)


def iter_walk(root):
    """A plain directory walk, for trees that are not a git checkout.

    `--all` deliberately means *tracked* files: a publish gate that fails on someone's
    untracked scratch file is a gate that gets switched off. `--walk` exists so tests
    and ad-hoc audits can point at a temporary directory with no repository in it.
    """
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ('.git', 'node_modules',
                                                        '__pycache__')]
        for filename in filenames:
            if not filename.lower().endswith(SOURCE_SUFFIXES):
                continue
            full = os.path.join(dirpath, filename)
            yield os.path.relpath(full, root).replace('\\', '/'), full


def scan_tree(root, explicit=None, walk=False):
    if explicit:
        targets = [(p.replace('\\', '/'), os.path.join(root, p)) for p in explicit]
    elif walk:
        targets = list(iter_walk(root))
    else:
        targets = list(iter_tracked(root))
    findings = []
    for relpath, full in targets:
        try:
            with open(full, 'rb') as handle:
                text = handle.read().decode('utf-8', 'replace')
        except OSError as exc:
            findings.append({'path': relpath, 'line': 0, 'severity': 'review',
                             'rule': 'unreadable', 'excerpt': mask(str(exc)),
                             'why': 'a file that cannot be read cannot be cleared'})
            continue
        findings.extend(scan_text(relpath, text))
    return findings


def report(findings, excused, as_json, stale=(), partial=False):
    if as_json:
        print(json.dumps({'findings': findings, 'excused': excused,
                          'stale': list(stale), 'partial': partial}, indent=2))
        return
    for item in excused:
        print('  excused  %-28s %s:%d  (%s)'
              % (item['rule'], item['path'], item['line'], item['reason']))
    for item in findings:
        print('  %-8s %-28s %s:%d  %s'
              % (item['severity'].upper(), item['rule'], item['path'], item['line'],
                 item['excerpt']))
    for item in stale:
        print('  STALE    %-28s %s  (excuses nothing; remove or update it)'
              % (item['rule'], item['path']))
    print('')
    print('hygiene: %d unexplained, %d excused with a reason, %d stale%s'
          % (len(findings), len(excused), len(stale),
             '  (staleness not judged on a partial scan)' if partial else ''))


# --------------------------------------------------------------------- self-test
# Canaries are assembled at run time from fragments so that this file does not itself
# contain the shapes it forbids. The values are fabricated: they look like the real
# thing to the pattern and are nothing to a human.
def self_test():
    secretish = 'a1b2c3d4' + '-5e6f-4a7b-8c9d-' + '0e1f2a3b4c5d'
    bslash = chr(92)                     # one separator character, spelled once
    two = bslash + bslash                # how source code stores one
    slash = chr(47)
    canaries = {
        'canary_session.py': "SESSION = 'session-" + secretish + "'\n",
        # Two separators: how Python source stores one. The prose gate could not see
        # this form, which is why a real interpreter path survived for months.
        'canary_path_escaped.py': 'RUN = r"E:' + two + 'program' + two + 'python312"\n',
        'canary_path_forward.mjs': "const H = '" + 'E:' + slash + 'some-machine'
                                   + slash + 'work' + "';\n",
        'canary_user_path.json': '{"p": "' + 'D:' + two + 'Users' + two
                                 + 'someone' + '"}\n',
        # Exactly 32 characters in a-p: 16 distinct letters, twice. An earlier draft
        # used a 15-letter fragment doubled -- 30 characters -- so that canary proved
        # nothing about the rule. The self-test caught its own fixture.
        'canary_extension.py': "ORIGIN = 'chrome-extension://"
                               + 'abcdefghijklmnop' * 2 + "'\n",
        'canary_key.py': 'KEY = "-----' + 'BEGIN ' + 'RSA ' + 'PRIVATE KEY' + '-----"\n',
        'canary_token.py': "TOKEN = 'ghp_" + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
                           + "'\n",
        'clean_file.py': "CONV = '11111111-1111-4111-8111-111111111111'\n"
                         "SESSION = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'\n"
                         "ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\n",
    }
    expected = {'canary_session.py': 'session-id',
                'canary_path_escaped.py': 'windows-path',
                'canary_path_forward.mjs': 'windows-path',
                'canary_user_path.json': 'windows-user-path',
                'canary_extension.py': 'extension-id',
                'canary_key.py': 'private-key',
                'canary_token.py': 'host-token'}
    problems = []
    with tempfile.TemporaryDirectory() as root:
        for name, body in canaries.items():
            with open(os.path.join(root, name), 'w', encoding='utf-8') as handle:
                handle.write(body)
        for name, rule in expected.items():
            findings = scan_tree(root, [name])
            hit = [f for f in findings if f['rule'] == rule]
            if not hit:
                problems.append('%s was not caught by %s (got %s)'
                                % (name, rule, [f['rule'] for f in findings] or 'nothing'))
                continue
            # CI logs are public, so a finding must never carry the value it found.
            leaked = hit[0]['excerpt']
            if secretish in leaked or len(leaked) > 24:
                problems.append('%s excerpt is not masked: %r' % (name, leaked))
        clean = scan_tree(root, ['clean_file.py'])
        if clean:
            problems.append('the clean file produced %d finding(s): %s'
                            % (len(clean), [f['rule'] for f in clean]))
    # And the rule that made the old gate useless must stay fixed: a regex written for
    # one literal backslash cannot see a path that source code stores with two.
    if patterns_miss_escaped_paths():
        problems.append('the windows-path rule stopped tolerating escaped separators')

    if problems:
        for problem in problems:
            print('  SELF-TEST FAILED: ' + problem)
        print('')
        print('self-test: %d problem(s)' % len(problems))
        return 1
    print('self-test: %d canary classes caught, clean file untouched, output masked'
          % len(expected))
    return 0


def patterns_miss_escaped_paths():
    pattern = dict((name, regex) for name, _sev, regex, _d in RULES)['windows-path']
    return pattern.search('E:\\\\program\\\\python312') is None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='.', help='tree to scan (default: cwd)')
    parser.add_argument('--all', action='store_true',
                        help='scan every tracked source file (default when no --paths)')
    parser.add_argument('--paths', nargs='*', default=None,
                        help='scan exactly these paths, relative to --root')
    parser.add_argument('--walk', action='store_true',
                        help='walk the directory instead of asking git (temp trees)')
    parser.add_argument('--self-test', action='store_true',
                        help='prove the rules catch what they claim to')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    root = os.path.abspath(args.root)
    findings = scan_tree(root, args.paths, walk=args.walk)
    allowlist = load_allowlist(root)
    kept, excused = allowlisted(findings, allowlist)
    # Staleness is a property of the tree, not of this invocation: judging it on a
    # `--paths` subset would declare every entry for every other file stale.
    partial = bool(args.paths)
    stale = [] if partial else stale_entries(allowlist, findings)
    report(kept, excused, args.json, stale, partial)
    return 1 if (kept or stale) else 0


if __name__ == '__main__':
    raise SystemExit(main())
