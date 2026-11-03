#!/usr/bin/env python3
"""T218: recompute an unpacked extension's id instead of trusting that it did not change.

Chrome derives the id of an extension loaded from a directory from that directory's path: sha256 of the UTF-16LE path
string, first 32 hex digits, each digit mapped onto `a`..`p`. A manifest `key` overrides it; this tree has none. So the id
is a *consequence* of where the files live, and "we only replaced files, not moved them" is a claim that can be checked
rather than asserted.

    python -B tools/rollout/extension_identity.py --path LOADED_DIR [--expect ID] [--chrome-user-data DIR]

With `--chrome-user-data` it also reads Chrome's own record (`Secure Preferences`, read-only) and reports whether Chrome
has the same path and the same id bound to it. Exit 0 only when every check that was requested agrees.
"""

import argparse
import hashlib
import json
import os
import sys

ALPHABET = 'abcdefghijklmnop'


def unpacked_id(path):
    """Chrome's derivation for an unpacked extension without a `key` in its manifest."""
    digest = hashlib.sha256(path.encode('utf-16-le')).hexdigest()
    return ''.join(ALPHABET[int(ch, 16)] for ch in digest[:32])


def manifest_key(root):
    try:
        with open(os.path.join(root, 'manifest.json'), encoding='utf-8-sig') as handle:
            return (json.load(handle) or {}).get('key')
    except (OSError, ValueError):
        return None


def chrome_record(user_data, wanted_id):
    for profile in ('Default', 'Profile 1', 'Profile 2'):
        path = os.path.join(user_data, profile, 'Secure Preferences')
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding='utf-8') as handle:
                doc = json.load(handle)
        except (OSError, ValueError):
            continue
        table = (doc.get('extensions') or {}).get('settings') or {}
        for ident, entry in table.items():
            if wanted_id and ident.lower() != wanted_id.lower():
                continue
            return {'profile': profile, 'id': ident, 'path': entry.get('path'),
                    'location': entry.get('location'), 'from_webstore': entry.get('from_webstore')}
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description='recompute the id of an unpacked extension')
    ap.add_argument('--path', required=True, help='the directory Chrome loads the extension from')
    ap.add_argument('--expect', default=None, help='the id that must come out of the derivation')
    ap.add_argument('--chrome-user-data', default=None, help='Chrome user data directory, for the record check')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args(argv)

    root = os.path.abspath(args.path)
    if not os.path.isdir(root):
        print('no such directory: %s' % root, file=sys.stderr)
        return 2
    key = manifest_key(root)
    derived = unpacked_id(root)
    report = {'path': root, 'manifestKey': bool(key), 'derivedId': derived,
              'expectedId': args.expect, 'matchesExpectation': (args.expect is None or derived == args.expect)}
    if args.chrome_user_data:
        record = chrome_record(args.chrome_user_data, args.expect or derived)
        report['chromeRecord'] = record
        report['chromeAgrees'] = bool(
            record and record['id'].lower() == derived.lower()
            and os.path.normcase(record['path'] or '') == os.path.normcase(root))
    else:
        report['chromeRecord'] = None
        report['chromeAgrees'] = None
    if key:
        report['manifestKeyNote'] = 'a manifest key pins the id, so the path derivation does not apply'
    if args.json:
        print(json.dumps(report, sort_keys=True))
    else:
        print('path            : %s' % report['path'])
        print('derived id      : %s' % derived)
        if args.expect:
            print('expected id     : %s  (%s)' % (args.expect, 'match' if report['matchesExpectation'] else 'MISMATCH'))
        if report['chromeRecord']:
            print('chrome record   : %s, path=%s, agrees=%s'
                  % (report['chromeRecord']['profile'], report['chromeRecord']['path'], report['chromeAgrees']))
    ok = (not key or report['matchesExpectation']) and report['matchesExpectation'] and report['chromeAgrees'] is not False
    return 0 if ok else 3


if __name__ == '__main__':
    raise SystemExit(main())
