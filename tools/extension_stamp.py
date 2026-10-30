"""One description of what the extension source *is*, so "the popup shows an old stamp" means
something specific.

The problem this closes: `extension/lib/build_stamp.js` sat at `T069-terminal-ms` for more than
forty changes. A stamp that is only edited by hand is either stale (so a stale load is invisible)
or freshly hardcoded (so it says nothing about the files next to it). Neither answers the only
question an operator has after reloading an unpacked extension: *is what Chrome is running the
tree I am looking at?*

So the stamp is derived, not asserted:

    T112-<8 hex>            the first 8 hex digits of a digest over the extension tree

The digest covers every file under `extension/` except the stamp file itself, in sorted relative
path order, hashing `path\\0bytes\\0` for each. `--write` refreshes the literal; `--check`
refuses when it disagrees with the tree, which is what makes a stale load visible instead of
plausible. A test-only or deploy-only file that changes the tree will invalidate the stamp, and
that is the point.

What this cannot do, and does not claim: it says nothing about which build Chrome has loaded. The
digest describes *source*. Proving what is loaded needs the popup's printed stamp compared by eye
against this value, or `chrome://extensions` -- an operator step, not something this repository
can observe.
"""
import argparse
import hashlib
import json
import os
import re
import sys

EXTENSION = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'extension')
STAMP_FILE = os.path.join(EXTENSION, 'lib', 'build_stamp.js')
STAMP_RE = re.compile(r"BUILD_STAMP = '([^']*)'")
EXCLUDE = {os.path.join('lib', 'build_stamp.js')}


def tree_digest(root=None):
    """Digest of every shipped file except the stamp, in a fixed order."""
    root = root or EXTENSION
    entries = []
    for base, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(base, name)
            rel = os.path.relpath(full, root)
            if rel.replace('\\', '/') in {item.replace('\\', '/') for item in EXCLUDE}:
                continue
            with open(full, 'rb') as handle:
                # Normalise line endings: the digest must describe the source, not the checkout.
                # A Windows clone with `core.autocrlf` gives every text file CRLF, and a stamp
                # that changes with the checkout would fail its own gate on a clean clone --
                # which is exactly where the gate runs.
                entries.append((rel.replace('\\', '/'), handle.read().replace(b'\r\n', b'\n')))
    digest = hashlib.sha256()
    for rel, data in sorted(entries):
        digest.update(rel.encode('utf-8'))
        digest.update(b'\0')
        digest.update(hashlib.sha256(data).hexdigest().encode('ascii'))
        digest.update(b'\0')
    return digest.hexdigest()[:8], len(entries)


def declared(path=None):
    path = path or STAMP_FILE
    with open(path, encoding='utf-8') as handle:
        text = handle.read()
    match = STAMP_RE.search(text)
    return (match.group(1) if match else None), text


def write_stamp(label='T112', path=None):
    path = path or STAMP_FILE
    short, count = tree_digest()
    value = '%s-%s' % (label, short)
    _, text = declared(path)
    if not STAMP_RE.search(text):
        raise SystemExit('cannot find the BUILD_STAMP literal in %s' % path)
    text = STAMP_RE.sub("BUILD_STAMP = '%s'" % value, text)
    with open(path, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(text)
    return value, count


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--check', action='store_true',
                        help='exit non-zero when the declared stamp is not the tree digest')
    parser.add_argument('--write', action='store_true', help='refresh the stamp literal')
    parser.add_argument('--json', action='store_true', help='machine-readable output')
    parser.add_argument('--root', default=None,
                        help='verify another copy of the extension (a deploy directory) '
                             'instead of the one beside this tool')
    args = parser.parse_args(argv)

    global EXTENSION, STAMP_FILE
    if args.root:
        EXTENSION = os.path.abspath(args.root)
        STAMP_FILE = os.path.join(EXTENSION, 'lib', 'build_stamp.js')

    current, files = tree_digest()
    value, _text = declared()
    suffix = value.split('-', 1)[1] if value and '-' in value else None
    fresh = suffix == current

    if args.write:
        value, files = write_stamp()
        suffix = value.split('-', 1)[1]
        fresh = True

    report = {'declared': value, 'tree': current, 'files': files, 'fresh': fresh}
    if args.json:
        print(json.dumps(report, sort_keys=True))
    else:
        print('declared  %s' % value)
        print('tree      %s  (%d files)' % (current, files))
        print('verdict   %s' % ('matches the tree' if fresh else 'STALE -- run --write'))
    if args.check and not fresh:
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
