"""Do unpacked install files match the extension this repository ships?

`tools/extension_stamp.py` answers a narrower question -- "does this tree's declared stamp match
its own files" -- and says outright that it cannot see what Chrome loaded. The gap that kept
biting (T234, T237): the repository moved, the unpacked install directory did not, the operator
reloaded, and the old code kept running with no visible symptom. The popup showed a stamp that
looked plausible because it described the *source* the operator was reading, not the bytes on the
disk Chrome reads.

This tool closes that gap without touching a browser:

    check (default, read-only)   per-file SHA256 of source vs install, with the stamp of each side
    --apply                      back up, copy whitelisted static files, verify, roll back on failure
    --preflight                  opt-in strict raw-SHA256 disk status; Chrome loaded runtime unknown

What it deliberately does not do: it never reloads an extension, never writes a Chrome profile,
never reads one, never starts or stops a browser or a host process. The install directory is a
plain directory of files; everything here is file I/O inside it.

Exit codes: 0 in sync, 1 drift, 2 refused (bad target/arguments), 3 apply failed and was rolled back.
"""
import argparse
import datetime
import hashlib
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import extension_stamp  # noqa: E402

REPO_EXTENSION = os.path.join(os.path.dirname(HERE), 'extension')

# Only files Chrome executes or renders. Anything else (a scratch note, a .py, an .exe) is never
# copied into an install directory, however it got into the source tree.
STATIC_SUFFIXES = ('.js', '.mjs', '.html', '.htm', '.css', '.svg', '.png', '.json')
TEXT_SUFFIXES = ('.js', '.mjs', '.html', '.htm', '.css', '.json', '.txt', '.md', '.py', '.sh')

# A path that contains one of these is a browser profile, not an install directory. Writing there
# would edit the operator's profile, which is the one thing this tool may never do.
PROFILE_MARKERS = ('user data', 'local extension settings', 'sync extension settings')

IDENTICAL, DIFFERS, TEXT_EQUIV, MISSING, EXTRA = 'identical', 'differs', 'text_equivalent', 'missing', 'extra'

# Explicit opt-in only: never discover a directory through Chrome's private profile.
INSTALL_ENV = ('DSH_EXTENSION_INSTALL', 'T218_INSTALLED_EXT')
DRIFT_MARKER = 'source updated, installed outdated; needs explicit sync + human Chrome Reload'
UNCONFIGURED_MARKER = ('installed files NOT compared: set DSH_EXTENSION_INSTALL to the '
                       'unpacked install directory; Chrome loaded runtime UNKNOWN')
IN_SYNC_MARKER = ('installed files match source bytes; Chrome loaded runtime UNKNOWN '
                  '(disk equality does not prove human Chrome Reload)')


def configured_target(environ=None):
    """Explicit environment configuration; no discovery or persistent environment edits."""
    environ = os.environ if environ is None else environ
    return next(((environ.get(name) or '').strip() for name in INSTALL_ENV
                 if (environ.get(name) or '').strip()), None)


class PreflightError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _ordinary_path(path):
    """Reject links/reparse points, including ancestors, before reading their contents."""
    import stat
    current = os.path.abspath(path)
    while True:
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise PreflightError('unsafe_link', 'symlink/reparse point: %s' % current)
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent


def _preflight_snapshot(root):
    """Full SHA256 inventory; scandir failures must not become silently missing files."""
    import stat
    _ordinary_path(root)
    result = {}

    def visit(directory):
        with os.scandir(directory) as scan:
            entries = sorted(scan, key=lambda item: item.name)
        for entry in entries:
            info = entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise PreflightError('unsafe_link', 'symlink/reparse point: %s' % entry.path)
            if stat.S_ISDIR(info.st_mode):
                visit(entry.path)
            elif stat.S_ISREG(info.st_mode):
                rel = os.path.relpath(entry.path, root).replace('\\', '/')
                result[rel] = sha256_file(entry.path)
            else:
                raise PreflightError('unsafe_file', 'not a regular file: %s' % entry.path)
    visit(root)
    return result


def preflight(source=None, target=None, environ=None):
    """Read-only disk comparison; never a statement about Chrome's loaded generation.

    Raw SHA256 equality is stricter than T240's CRLF-equivalent default check. Stamps are
    supplemental: changing build_stamp.js is drift even if tree_digest excludes that file.
    Files are inventoried twice to notice ordinary concurrent updates; this is not an atomic
    filesystem snapshot. All failures have a distinct code and remain UNCHECKED, not IN_SYNC.
    """
    source = os.path.abspath(source or REPO_EXTENSION)
    target = target or configured_target(environ)
    report = {'state': 'unchecked', 'checked': False, 'code': 'missing_config',
              'marker': UNCONFIGURED_MARKER, 'source': source, 'target': None,
              'loaded_runtime': 'unknown', 'comparison': 'raw_sha256'}
    if not target:
        return report
    target = os.path.abspath(target)
    report['target'] = target
    try:
        for label, root in (('source', source), ('install', target)):
            if looks_like_profile(root):
                raise PreflightError('profile_path', '%s looks like a Chrome profile' % label)
            _ordinary_path(root)
            if not os.path.isdir(root):
                raise PreflightError('invalid_directory', '%s is not a directory' % label)
        src, dst = os.path.normcase(source), os.path.normcase(target)
        try:
            common = os.path.commonpath([src, dst])
        except ValueError:  # Different Windows drives are fine.
            common = None
        if common in (src, dst):
            raise PreflightError('overlapping_directories', 'source/install directories overlap')
        source_files = _preflight_snapshot(source)
        target_files = _preflight_snapshot(target)
        for label, root, files in (('source', source, source_files), ('install', target, target_files)):
            if 'manifest.json' not in files:
                raise PreflightError('missing_manifest', '%s has no manifest.json' % label)
            with open(os.path.join(root, 'manifest.json'), encoding='utf-8') as handle:
                manifest = json.load(handle)
            if not isinstance(manifest, dict) or manifest.get('manifest_version') not in (2, 3):
                raise PreflightError('invalid_manifest', '%s has an invalid extension manifest' % label)
        source_stamp, source_digest, _count = stamp_of(source)
        target_stamp, target_digest, _count = stamp_of(target)
        if (source_files != _preflight_snapshot(source)
                or target_files != _preflight_snapshot(target)):
            raise PreflightError('files_changed_during_check', 'files changed during comparison; retry explicitly')
        rows = []
        for rel in sorted(set(source_files) | set(target_files)):
            source_hash, target_hash = source_files.get(rel), target_files.get(rel)
            if source_hash != target_hash:
                state = MISSING if target_hash is None else EXTRA if source_hash is None else DIFFERS
                rows.append({'path': rel, 'state': state, 'source': source_hash, 'target': target_hash})
        state = 'drift' if rows else 'in_sync'
        report.update(state=state, checked=True, code=state,
                      marker=DRIFT_MARKER if rows else IN_SYNC_MARKER,
                      source_stamp=source_stamp, install_stamp=target_stamp,
                      stamp_match=bool(source_digest and source_digest == target_digest),
                      source_files=len(source_files), target_files=len(target_files),
                      differing=[row['path'] for row in rows][:10], differing_count=len(rows),
                      differences=rows)
    except PreflightError as err:
        report.update(code=err.code, marker='installed files NOT compared: %s; Chrome loaded runtime UNKNOWN' % err)
    except (OSError, ValueError, RecursionError) as err:
        report.update(code='read_failed', marker='installed files NOT compared: %s; Chrome loaded runtime UNKNOWN' % err)
    return report


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


def normalised_digest(path):
    """sha256 of the file with line endings folded, for telling "drifted" from "different newline"."""
    with open(path, 'rb') as handle:
        data = handle.read()
    return hashlib.sha256(data.replace(b'\r\n', b'\n')).hexdigest()


def walk_tree(root):
    found = {}
    for base, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(base, name)
            rel = os.path.relpath(full, root).replace('\\', '/')
            found[rel] = full
    return found


def stamp_of(root):
    """(declared stamp, tree digest, file count) for one tree, via the stamp tool's own definition."""
    try:
        short, count = extension_stamp.tree_digest(root)
        value, _text = extension_stamp.declared(os.path.join(root, 'lib', 'build_stamp.js'))
    except (OSError, SystemExit, AttributeError):
        return None, None, 0
    suffix = value.split('-', 1)[1] if value and '-' in value else None
    return value, short, count if suffix == short else count


def manifest_facts(root):
    path = os.path.join(root, 'manifest.json')
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding='utf-8') as handle:
            document = json.load(handle)
    except (OSError, ValueError):
        return {'unreadable': True}
    return {
        'version': document.get('version'),
        'permissions': sorted(document.get('permissions') or []),
        'host_permissions': sorted(document.get('host_permissions') or []),
        'background': (document.get('background') or {}).get('service_worker'),
    }


def compare(source, target):
    """Every file on either side, classified. Read-only."""
    src = walk_tree(source)
    tgt = walk_tree(target)
    rows = []
    for rel in sorted(set(src) | set(tgt)):
        if rel in src and rel not in tgt:
            rows.append({'path': rel, 'state': MISSING, 'source': sha256_file(src[rel])[:16], 'target': None})
        elif rel in tgt and rel not in src:
            rows.append({'path': rel, 'state': EXTRA, 'source': None, 'target': sha256_file(tgt[rel])[:16]})
        else:
            source_hash = sha256_file(src[rel])
            target_hash = sha256_file(tgt[rel])
            if source_hash == target_hash:
                state = IDENTICAL
            elif (rel.lower().endswith(TEXT_SUFFIXES)
                  and normalised_digest(src[rel]) == normalised_digest(tgt[rel])):
                state = TEXT_EQUIV
            else:
                state = DIFFERS
            rows.append({'path': rel, 'state': state,
                         'source': source_hash[:16], 'target': target_hash[:16]})
    return rows


def manifest_diff(source_facts, target_facts):
    """Human sentences about anything a reload would change the meaning of. Read-only."""
    if source_facts is None or target_facts is None:
        return ['manifest.json missing on one side']
    if source_facts.get('unreadable') or target_facts.get('unreadable'):
        return ['manifest.json unreadable on one side']
    notes = []
    for field in ('version', 'background'):
        if source_facts.get(field) != target_facts.get(field):
            notes.append('%s: source %r vs install %r'
                         % (field, source_facts.get(field), target_facts.get(field)))
    for field in ('permissions', 'host_permissions'):
        # Phrased from the install's point of view, because that is the machine the operator is
        # looking at: what a deploy would add to it, and what it already has that source does not.
        added = [item for item in source_facts.get(field) or [] if item not in (target_facts.get(field) or [])]
        removed = [item for item in target_facts.get(field) or [] if item not in (source_facts.get(field) or [])]
        if added:
            notes.append('%s: the install lacks %s, which source grants' % (field, ', '.join(added)))
        if removed:
            notes.append('%s: the install has %s, which source does not grant'
                         % (field, ', '.join(removed)))
    return notes


def looks_like_profile(path):
    parts = [part.lower() for part in os.path.abspath(path).replace('/', os.sep).split(os.sep)]
    return any(marker in parts for marker in PROFILE_MARKERS)


def plan_apply(rows, sync_manifest, manifest_notes):
    """Which rows `--apply` may write, and which it must leave alone."""
    writes, skipped, refusals = [], [], []
    for row in rows:
        rel = row['path']
        if row['state'] == IDENTICAL:
            continue
        if rel == 'manifest.json':
            if not sync_manifest:
                skipped.append({'path': rel, 'why': 'manifest.json is only synced with --sync-manifest'})
                continue
            permissions_changed = any(note.startswith(('permissions', 'host_permissions'))
                                      for note in manifest_notes)
            if permissions_changed:
                refusals.append('manifest permissions differ; a permission change is an operator decision, '
                                'not a sync')
                continue
            writes.append(rel)
            continue
        if not rel.lower().endswith(STATIC_SUFFIXES):
            skipped.append({'path': rel, 'why': 'not a static extension file'})
            continue
        if row['state'] == EXTRA:
            skipped.append({'path': rel, 'why': 'only in the install directory; never deleted by this tool'})
            continue
        writes.append(rel)
    return writes, skipped, refusals


def backup_target(target, rows, backup_dir):
    """Copy the files that are about to change into a timestamped directory with a SHA256 list."""
    os.makedirs(backup_dir, exist_ok=True)
    lines = ['# backup of the unpacked extension install directory',
             '# target %s' % target,
             '# at %s' % datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
             '']
    restored = []
    for row in rows:
        if row['state'] not in (DIFFERS, TEXT_EQUIV, MISSING):
            continue
        live = os.path.join(target, row['path'].replace('/', os.sep))
        if not os.path.isfile(live):
            lines.append('%s  (absent)  %s' % ('-' * 64, row['path']))
            continue
        keep = os.path.join(backup_dir, row['path'].replace('/', os.sep))
        keep_parent = os.path.dirname(keep)
        if keep_parent:
            os.makedirs(keep_parent, exist_ok=True)
        shutil.copy2(live, keep)
        lines.append('%s  %s' % (sha256_file(live), row['path']))
        restored.append(row['path'])
    with open(os.path.join(backup_dir, 'SHA256SUMS.txt'), 'w', encoding='utf-8', newline='\n') as handle:
        handle.write('\n'.join(lines) + '\n')
    return restored


def apply_sync(source, target, rows, writes, backup_dir):
    """Copy, then prove equality. Any failure restores the backup."""
    backup_target(target, rows, backup_dir)
    written = []
    try:
        for rel in writes:
            src = os.path.join(source, rel.replace('/', os.sep))
            dst = os.path.join(target, rel.replace('/', os.sep))
            parent = os.path.dirname(dst)
            if parent:
                os.makedirs(parent, exist_ok=True)
            shutil.copy2(src, dst)
            written.append(rel)
        after = compare(source, target)
        expected = set(writes)
        residual = [row for row in after
                    if row['path'] in expected and row['state'] in (DIFFERS, MISSING)]
        if residual:
            raise RuntimeError('verification failed for %s'
                               % ', '.join(row['path'] for row in residual[:5]))
        return written, None
    except (OSError, RuntimeError, shutil.Error) as err:
        restore_backup(target, backup_dir, rows)
        return written, str(err)


def restore_backup(target, backup_dir, rows):
    """Put back every file the backup holds; remove files the sync created that had no backup."""
    restored, removed = [], []
    for row in rows:
        keep = os.path.join(backup_dir, row['path'].replace('/', os.sep))
        live = os.path.join(target, row['path'].replace('/', os.sep))
        if os.path.isfile(keep):
            parent = os.path.dirname(live)
            if parent:
                os.makedirs(parent, exist_ok=True)
            shutil.copy2(keep, live)
            restored.append(row['path'])
        elif row['state'] == MISSING and os.path.isfile(live):
            os.remove(live)
            removed.append(row['path'])
    return restored, removed


def emit(stream, text):
    """Write one line, degrading glyphs the target encoding cannot represent.

    A CJK install directory on a cp1252 console must produce a readable line with a replaced
    character, not a UnicodeEncodeError from inside the report of a check that already ran.
    """
    try:
        stream.write(text)
    except UnicodeEncodeError:
        encoding = getattr(stream, 'encoding', None) or 'ascii'
        stream.write(text.encode(encoding, 'backslashreplace').decode(encoding, 'replace'))


def render(report, stream=None):
    # Late-bound on purpose: a default of `sys.stdout` is resolved at import time, so a caller that
    # redirects stdout (a test, a caller capturing output) would still print to the real console.
    stream = stream if stream is not None else sys.stdout
    rows = report['files']
    counts = {}
    for row in rows:
        counts[row['state']] = counts.get(row['state'], 0) + 1
    emit(stream, 'source   %s\n' % report['source'])
    emit(stream, 'install  %s\n' % report['target'])
    emit(stream, 'files    source %d  install %d\n' % (report['source_files'], report['target_files']))
    emit(stream, 'stamp    source %s  install %s  %s\n'
         % (report['stamp']['source'], report['stamp']['target'],
            'in sync' if report['stamp']['match'] else 'DRIFT -- the install is another build'))
    for row in rows:
        if row['state'] == IDENTICAL:
            continue
        emit(stream, '  %-16s %-44s %s -> %s\n'
             % (row['state'], row['path'], row['source'] or '(absent)', row['target'] or '(absent)'))
    emit(stream, 'summary  %s\n' % ', '.join('%s=%d' % (key, counts[key]) for key in sorted(counts)))
    for note in report['manifest']:
        emit(stream, 'manifest %s\n' % note)
    if report.get('backup'):
        emit(stream, 'backup   %s\n' % report['backup'])
    if report.get('written'):
        emit(stream, 'written  %s\n' % ', '.join(report['written']))
    for item in report.get('skipped') or []:
        emit(stream, 'skipped  %-44s %s\n' % (item['path'], item['why']))
    for item in report.get('refusals') or []:
        emit(stream, 'refused  %s\n' % item)
    if report.get('rollback'):
        emit(stream, 'rollback %s\n' % report['rollback'])
    emit(stream, 'verdict  %s\n' % report['verdict'])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--source', default=REPO_EXTENSION,
                        help='the repository copy of extension/ (default: the one beside this tool)')
    parser.add_argument('--target', default=None,
                        help='the unpacked install directory Chrome loads; with --preflight, defaults to DSH_EXTENSION_INSTALL')
    parser.add_argument('--apply', action='store_true',
                        help='write the reviewed change set into the install directory (default: read-only)')
    parser.add_argument('--sync-manifest', action='store_true',
                        help='also sync manifest.json, and only when its permissions are unchanged')
    parser.add_argument('--backup-dir', default=None,
                        help='where the rollback copy goes (default: <target>.backup-<utc> beside it)')
    parser.add_argument('--json', action='store_true', help='machine-readable output')
    parser.add_argument('--preflight', action='store_true',
                        help='one status line for the loaded extension, using DSH_EXTENSION_INSTALL; '
                             'exit 0 in sync, 1 drift, 2 not compared')
    args = parser.parse_args(argv)

    # A path may contain characters the console codepage cannot draw (a CJK install directory on a
    # cp1252 terminal). Degrade those glyphs instead of failing the check that just ran.
    reconfigure = getattr(sys.stdout, 'reconfigure', None)
    if reconfigure is not None:
        try:
            reconfigure(errors='replace')
        except (ValueError, OSError):
            pass

    if args.preflight:
        if args.apply or args.sync_manifest or args.backup_dir:
            parser.error('--preflight is read-only; no apply/manifest/backup options')
        verdict = preflight(args.source, args.target)
        if args.json:
            json.dump(verdict, sys.stdout, indent=2, sort_keys=True)
            sys.stdout.write('\n')
        else:
            emit(sys.stdout, 'install  %s: %s\n'
                 % (verdict['state'].upper(), verdict['marker']))
            if verdict.get('target'):
                emit(sys.stdout, 'target   %s\n' % verdict['target'])
            if verdict['state'] == 'drift':
                emit(sys.stdout, 'files    %d differ: %s\n'
                     % (verdict['differing_count'], ', '.join(verdict['differing'])))
                emit(sys.stdout, 'stamp    source %s  install %s\n'
                     % (verdict.get('source_stamp'), verdict.get('install_stamp')))
        return {'in_sync': 0, 'drift': 1}.get(verdict['state'], 2)

    if not args.target:
        print('--target is required for check/apply; environment config is used only with --preflight')
        return 2
    source = os.path.abspath(args.source)
    target = os.path.abspath(args.target)
    for label, path in (('source', source), ('target', target)):
        if not os.path.isdir(path):
            print('no directory at %s (%s)' % (path, label))
            return 2
    if os.path.normcase(os.path.realpath(source)) == os.path.normcase(os.path.realpath(target)):
        print('source and target are the same directory; there is nothing to sync and nothing to prove')
        return 2
    if not os.path.isfile(os.path.join(target, 'manifest.json')):
        print('%s has no manifest.json, so it is not an extension install directory' % target)
        return 2
    if looks_like_profile(target):
        print('%s looks like a browser profile, not an install directory; this tool never writes there'
              % target)
        return 2

    rows = compare(source, target)
    source_stamp, source_digest, source_count = stamp_of(source)
    target_stamp, target_digest, target_count = stamp_of(target)
    source_manifest = manifest_facts(source)
    target_manifest = manifest_facts(target)
    notes = manifest_diff(source_manifest, target_manifest)
    report = {
        'source': source,
        'target': target,
        'source_files': len(walk_tree(source)),
        'target_files': len(walk_tree(target)),
        'files': rows,
        'stamp': {'source': source_stamp, 'target': target_stamp,
                  'match': bool(source_digest and source_digest == target_digest),
                  'source_digest': source_digest, 'target_digest': target_digest},
        'manifest': notes,
        'applied': False,
    }
    drift = [row for row in rows if row['state'] in (DIFFERS, MISSING, EXTRA)]
    report['verdict'] = 'in sync' if not drift else 'DRIFT (%d file%s)' % (len(drift), '' if len(drift) == 1 else 's')

    if args.apply:
        writes, skipped, refusals = plan_apply(rows, args.sync_manifest, notes)
        report['skipped'] = skipped
        report['refusals'] = refusals
        if refusals:
            report['verdict'] = 'refused; nothing was written'
            (json.dump(report, sys.stdout, indent=2, sort_keys=True) if args.json else render(report))
            return 2
        stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
        backup_dir = os.path.abspath(args.backup_dir or (target.rstrip(os.sep) + '.backup-' + stamp))
        if os.path.normcase(os.path.commonpath([backup_dir, target])) == os.path.normcase(target):
            print('the backup directory must live outside the install directory, or the next check '
                  'would report the backup as drift')
            return 2
        report['backup'] = backup_dir
        if not writes:
            report['verdict'] = 'nothing to write'
            (json.dump(report, sys.stdout, indent=2, sort_keys=True) if args.json else render(report))
            return 0
        written, failure = apply_sync(source, target, rows, writes, backup_dir)
        report['written'] = written
        report['applied'] = failure is None
        if failure:
            report['rollback'] = 'restored from %s because %s' % (backup_dir, failure)
            report['verdict'] = 'apply failed; install restored from backup'
            (json.dump(report, sys.stdout, indent=2, sort_keys=True) if args.json else render(report))
            return 3
        after = compare(source, target)
        expected = set(written)
        still = [row for row in after
                 if row['path'] in expected and row['state'] in (DIFFERS, MISSING)]
        report['files'] = after
        report['verdict'] = ('applied and verified: install is byte-identical to source'
                             if not still else 'applied, but %d file(s) still differ' % len(still))

    if args.json:
        json.dump(report, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write('\n')
    else:
        render(report)
    if report['verdict'].startswith('applied, but'):
        return 1
    if report['applied'] or report['verdict'].startswith(('applied and verified', 'nothing to write')):
        return 0
    return 0 if report['verdict'] == 'in sync' else 1


if __name__ == '__main__':
    sys.exit(main())
