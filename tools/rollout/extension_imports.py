#!/usr/bin/env python3
"""T218: does every module the extension loads actually exist?

A service worker that imports a missing file fails at registration, which Chrome reports in the extensions page and
nowhere the popup can see. That is a bad way to discover a half-copied upgrade, so this reads the entry points and follows
their relative imports.

    python -B tools/rollout/extension_imports.py --root PATH_TO_EXTENSION

Exit 0 when the entry point and every relative import resolve, 3 when something is missing, and the missing names are
printed with the file that asked for them.
"""

import argparse
import os
import re
import sys

# `import x from './a.js'`, `export { y } from './b.js'`, and the side-effect form `import './c.js'`, which has no
# `from` and is exactly how a half-copied upgrade usually breaks.
IMPORT = re.compile(r'''(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]'''
                    r'''|(?:^|[\s;])import\s*['"]([^'"]+)['"]''', re.MULTILINE)
DYNAMIC = re.compile(r'''import\(\s*['"]([^'"]+)['"]\s*\)''')
ENTRY_POINTS = ('background.js',)


def targets(path):
    try:
        with open(path, encoding='utf-8', errors='replace') as handle:
            text = handle.read()
    except OSError:
        return []
    found = []
    for static_match, side_effect in IMPORT.findall(text):
        found.append(static_match or side_effect)
    return found + DYNAMIC.findall(text)


def walk(root):
    seen, reached, missing, queue = set(), [], [], list(ENTRY_POINTS)
    while queue:
        name = queue.pop()
        if name in seen:
            continue
        seen.add(name)
        full = os.path.join(root, name.replace('/', os.sep))
        if not os.path.isfile(full):
            missing.append((name, 'entry point' if name in ENTRY_POINTS else 'imported'))
            continue
        reached.append(name)
        for target in targets(full):
            if not target.startswith('.'):
                continue                      # chrome.*, node builtins, bare specifiers: not files in this tree
            resolved = os.path.normpath(os.path.join(os.path.dirname(name), target))
            queue.append(resolved.replace(os.sep, '/'))
    return sorted(reached), missing


def main(argv=None):
    ap = argparse.ArgumentParser(description='resolve the extension\'s relative module graph')
    ap.add_argument('--root', required=True)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args(argv)
    if not os.path.isdir(args.root):
        print('no such directory: %s' % args.root, file=sys.stderr)
        return 2
    reached, missing = walk(args.root)
    if args.json:
        import json
        print(json.dumps({'reached': reached, 'missing': [m[0] for m in missing]}, sort_keys=True))
    else:
        print('modules reached from background.js: %d' % len(reached))
        for name, why in missing:
            print('  MISSING %s (%s)' % (name, why))
    return 3 if missing else 0


if __name__ == '__main__':
    raise SystemExit(main())
