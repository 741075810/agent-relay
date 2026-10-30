"""Read-only upgrade preflight for the queue lock and queue file.

T089 proved that the pre-T088 lock and this one cannot exclude each other: the old host
creates `queue.lock` with `O_EXCL`, writes nothing, unlinks it when done, and holds no
operating-system lock, while this host takes a `flock`/`msvcrt.locking` on a file it never
deletes. An upgrade is therefore a stop-the-old-host operation, and this tool exists to tell
an operator -- before they start the new host -- which of those states the directory is
actually in.

Three rules it obeys, because getting any of them wrong is how a preflight becomes the
outage:

  * **read-only.** It opens nothing for writing, takes no lock (a live host's lock is not
    this tool's to touch), deletes nothing, and creates no temporary files. A test snapshots
    the directory before and after and demands it be byte-identical.
  * **fail-closed.** No read-only check can prove that no host process is running. So the
    "safe" verdict requires the operator to say so with `--host-stopped`; without it the
    answer is "confirm by hand", never "go ahead".
  * **it says which way it failed.** A missing lock, an empty one, an unknown one, a damaged
    queue and a queue with unsent events are five different facts with five different
    answers, and they are never collapsed into one message.

Exit codes: 0 safe to start, 2 needs a human decision, 3 something is damaged.
"""
import argparse
import io
import errno
import json
import os
import stat
import sys

sys.dont_write_bytecode = True

# Run as `python tools/upgrade_preflight.py`, this file's own directory is what lands on
# sys.path and `host` lives one level up. Without this the tool only worked when the
# caller's working directory happened to be the repository root -- which is exactly the
# situation a preflight launched from a maintenance shell is not.
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import host  # noqa: E402  - constants only (no side effects at import)

VERDICT_SAFE = 'safe_to_start'
VERDICT_CONFIRM = 'needs_operator_confirmation'
VERDICT_LEGACY = 'legacy_lock_remove_by_hand'
VERDICT_UNKNOWN_LOCK = 'unknown_lock_content'
VERDICT_DAMAGED = 'queue_damaged'
VERDICT_DEBRIS = 'interrupted_save_detected'

EXIT_SAFE = 0
EXIT_CONFIRM = 2
EXIT_DAMAGED = 3


_NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
_REPARSE_POINT = 0x400          # FILE_ATTRIBUTE_REPARSE_POINT; junctions land here


def _is_link(info):
    """A junction is a reparse point that `stat.S_ISLNK` does not report as a link."""
    if getattr(info, 'st_file_attributes', 0) & _REPARSE_POINT:
        return True
    return stat.S_ISLNK(info.st_mode)


def _open_verified(path):
    """Open the path and prove that what was opened is what was inspected.

    `lstat` followed by `open` is two syscalls with a window between them, in a directory an
    operator may be inspecting as root while another process can write to it. `O_NOFOLLOW`
    refuses a link at the last moment where the platform has it; where it does not, the
    descriptor's own identity is compared with what `lstat` reported, and any disagreement is
    reported rather than read.

    Returns (fd, info, problem); exactly one of fd and problem is set.
    """
    try:
        before = os.lstat(path)
    except FileNotFoundError:
        return None, None, None
    except OSError as exc:
        return None, None, 'cannot be examined (%s: %s)' % (type(exc).__name__, exc)
    if _is_link(before):
        return None, before, 'is a link (symlink or reparse point), not a file here'
    try:
        fd = os.open(path, os.O_RDONLY | _NOFOLLOW)
    except FileNotFoundError:
        return None, before, 'disappeared between the check and the open'
    except OSError as exc:
        if exc.errno == getattr(errno, 'ELOOP', -1):
            return None, before, 'became a link between the check and the open'
        return None, before, 'cannot be opened (%s: %s)' % (type(exc).__name__, exc)
    opened = os.fstat(fd)
    if ((opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
            or not stat.S_ISREG(opened.st_mode)):
        os.close(fd)
        return None, before, ('was replaced between the check and the open, so a report about '
                              'it would describe a file that was never inspected')
    return fd, opened, None


def _lock_report(state_dir):
    path = os.path.join(state_dir, host.LOCK_FILE)
    report = {'path': host.LOCK_FILE, 'present': False, 'kind': 'absent',
              'size': 0, 'token': None}
    fd, info, problem = _open_verified(path)
    if info is None and problem is None:
        return report
    report['present'] = True
    report['size'] = getattr(info, 'st_size', 0)
    if problem:
        if 'link' in problem:
            kind = 'symlink'
        elif problem.startswith('cannot be opened') or problem.startswith('cannot be examined'):
            kind = 'unreadable'          # permissions, not a race
        else:
            kind = 'raced'
        report.update(kind=kind, detail=problem)
        if report['kind'] == 'symlink':
            try:
                report['target'] = os.readlink(path)
            except OSError:
                report['target'] = None
        return report
    try:
        with os.fdopen(fd, 'rb') as handle:
            raw = handle.read(4096)
    except OSError as exc:
        report.update(kind='unreadable', detail='%s: %s' % (type(exc).__name__, exc))
        return report
    report['size'] = len(raw)
    # Byte 0 belongs to the operating-system lock on Windows, so content starts at 1.
    body = raw[1:] if len(raw) > 1 else b''
    if not body.strip(b'\x00'):
        # Exactly what the pre-T088 host leaves: it created the file and wrote nothing.
        report['kind'] = 'legacy_empty'
        return report
    if body.startswith(host.LOCK_MARKER):
        report['kind'] = 'os_v1'
        rest = body[len(host.LOCK_MARKER):].strip(b' \r\n\x00')
        report['token'] = rest.decode('ascii', 'replace') or None
        return report
    report['kind'] = 'unknown'
    report['detail'] = 'first bytes: %r' % (body[:24],)
    return report


def _queue_report(state_dir):
    report = {'path': host.QUEUE_FILE, 'present': False, 'readable': True,
              'version': None, 'generation': None, 'events': 0, 'acked': 0,
              'unacknowledged': 0, 'handed_over': 0, 'consumers': {}, 'error': None}
    path = os.path.join(state_dir, host.QUEUE_FILE)
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return report
    except OSError as exc:
        report.update(readable=False, error='%s: %s' % (type(exc).__name__, exc))
        return report
    report['present'] = True
    if stat.S_ISLNK(info.st_mode):
        # Same reason as the lock: a link is not this state directory's queue.
        report.update(readable=False,
                      error='the queue file is a symbolic link; refusing to read through it')
        return report
    try:
        document = host.load_queue(state_dir)
    except host.HostError as exc:
        report['readable'] = False
        report['error'] = '%s: %s' % (type(exc).__name__, exc)
        try:
            with io.open(path, 'r', encoding='utf-8') as handle:
                report['version'] = json.load(handle).get('version')
        except (OSError, ValueError, AttributeError):
            pass
        return report
    events = document.get('events') or []
    per_consumer = document.get('consumer_acks') or {}
    acked_everywhere = set(document.get('acked') or [])
    for values in per_consumer.values():
        acked_everywhere |= set(values or [])
    report['version'] = document.get('version')
    report['generation'] = document.get('generation')
    report['events'] = len(events)
    report['acked'] = len(acked_everywhere)
    report['consumers'] = {name: len(values or [])
                           for name, values in sorted(per_consumer.items())}
    report['unacknowledged'] = len([e for e in events
                                    if isinstance(e, dict)
                                    and e.get('eventId') not in acked_everywhere])
    report['handed_over'] = len([e for e in events
                                 if isinstance(e, dict) and e.get('deliveredAt')])
    return report


def _debris_report(state_dir):
    prefix = host.QUEUE_FILE + '.tmp-'
    try:
        names = os.listdir(state_dir)
    except OSError:
        return []
    return sorted(name for name in names if name.startswith(prefix))


def _lock_probe(path, kind):
    """Is a process holding this lock right now?

    True / False / None, and None is not a yes. --host-stopped is the operator's word about
    a process this tool cannot see; the lock is the one place where the operating system will
    answer that question, by refusing a second holder. The probe takes the lock and gives it
    straight back -- it locks byte 0 only, where the marker does not live.
    """
    # A lock that cannot be read is not necessarily a corrupt lock: on Windows a byte-range
    # lock held by a live host makes that byte unreadable through another handle, which is
    # exactly how a running host looks. Ask the operating system either way.
    if kind not in ('os_v1', 'unreadable', 'unknown'):
        return None
    flags = (os.O_RDWR if os.name == 'nt' else os.O_RDONLY) | getattr(os, 'O_NOFOLLOW', 0)
    try:
        handle = os.open(path, flags)
    except OSError:
        return None
    try:
        if os.name == 'nt':
            import msvcrt
            try:
                os.lseek(handle, 0, os.SEEK_SET)
                msvcrt.locking(handle, msvcrt.LK_NBLCK, 1)
            except OSError:
                return True
            os.lseek(handle, 0, os.SEEK_SET)
            msvcrt.locking(handle, msvcrt.LK_UNLCK, 1)
            return False
        import fcntl
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return True
        fcntl.flock(handle, fcntl.LOCK_UN)
        return False
    finally:
        os.close(handle)


def _path_redirected(path):
    """Is any component of this path a link, junction or reparse point?

    Comparing the declared path with ealpath looked like the same question and is not:
    on Windows ealpath also expands 8.3 short names, so an ordinary temp directory under
    RUNNER~1 came out "redirected" and every verdict was downgraded. Walking the components
    asks the actual question, and answers it the same way on both platforms.
    """
    current = os.path.abspath(path)
    while True:
        try:
            info = os.lstat(current)
        except OSError:
            return False
        if _is_link(info):
            return True
        parent = os.path.dirname(current)
        if parent == current:
            return False
        current = parent


def _dir_identity(path):
    """Identity of the directory itself, so the two halves of the report cannot come from
    two different installations."""
    try:
        info = os.stat(path)
    except OSError:
        return None
    return (info.st_dev, info.st_ino)


def inspect(state_dir, host_stopped=False, accept_realpath=None):
    """Everything the operator needs, and nothing that changes the directory.

    `accept_realpath` is the operator saying "I know this path resolves elsewhere, and that
    is where I meant". Without it a redirected path is reported but never approved: the
    verdict would otherwise be a claim about a directory nobody named.
    """
    real = os.path.realpath(state_dir)
    declared = os.path.abspath(state_dir)
    paths = {'declared': declared, 'realpath': real,
             'through_symlink': _path_redirected(declared)}
    before = _dir_identity(state_dir)
    lock = _lock_report(state_dir)
    lock['held_by_a_process'] = _lock_probe(os.path.join(state_dir, host.LOCK_FILE),
                                           lock.get('kind'))
    queue = _queue_report(state_dir)
    debris = _debris_report(state_dir)
    after = _dir_identity(state_dir)

    reasons = []
    needs_manual = False
    damaged = False

    if lock['kind'] == 'os_v1':
        reasons.append('the lock file carries this host\'s marker; it holds no lock when '
                       'no process is running, and this tool does not take one')
    elif lock['kind'] == 'legacy_empty':
        reasons.append('the lock file is empty, which is what a pre-T088 host leaves '
                       'behind; the old protocol and this one cannot exclude each other, '
                       'so remove the file by hand once the old host is gone')
        needs_manual = True
    if paths['through_symlink']:
        accepted = (isinstance(accept_realpath, str) and accept_realpath
                    and os.path.normcase(os.path.realpath(accept_realpath))
                    == os.path.normcase(real))
        if accepted:
            reasons.append('the state path is reached through a symbolic link (%s -> %s), '
                           'and that resolved location was acknowledged with '
                           '--accept-realpath' % (declared, real))
        else:
            reasons.append('the state path is reached through a symbolic link (%s -> %s); '
                           'this verdict describes the resolved directory, so approve it '
                           'with --accept-realpath %s if that is the tree you meant'
                           % (declared, real, real))
            needs_manual = True
    if before != after:
        reasons.append('the state directory itself was replaced between the first and the '
                       'last read (identity %r -> %r), so the lock and the queue in this '
                       'report may come from different trees' % (before, after))
        needs_manual = True
    if lock['kind'] == 'symlink':
        reasons.append('the lock path is a symbolic link or junction (%s); this tool reports on the state directory, not on whatever a link points at' % (lock.get('detail'),))
        needs_manual = True
    elif lock['kind'] == 'unknown':
        reasons.append('the lock file holds something this tool does not recognise (%s); '
                       'do not start a host against it' % lock.get('detail'))
        needs_manual = True
    elif lock['kind'] == 'unreadable':
        reasons.append('the lock file cannot be read (%s)' % lock.get('detail'))
        needs_manual = True

    if lock.get('held_by_a_process') is True:
        reasons.append('a process is holding the queue lock right now, so the host is still '
                       'running (which is also why the marker may be unreadable); stop it '
                       'before going any further')
        needs_manual = True
        damaged = False
    elif lock.get('held_by_a_process') is None and lock.get('kind') == 'os_v1':
        reasons.append('whether the lock is currently held could not be determined, so this '
                       'tool will not call the directory safe on the strength of the marker '
                       'alone')
        needs_manual = True

    if not queue['readable']:
        reasons.append('the queue is damaged: %s (version field: %r)' % (queue['error'], queue.get('version')))
        damaged = True
    if debris:
        reasons.append('%d interrupted save(s) left behind (%s); the last write did not '
                       'finish' % (len(debris), ', '.join(debris[:3])))
        needs_manual = True
    if queue['handed_over']:
        reasons.append('%d event(s) were polled but the page never confirmed them; '
                       'polled is not the same as seen' % queue['handed_over'])

    if damaged:
        verdict, code = VERDICT_DAMAGED, EXIT_DAMAGED
    elif needs_manual:
        verdict, code = (VERDICT_LEGACY if lock['kind'] == 'legacy_empty'
                         else VERDICT_UNKNOWN_LOCK), EXIT_CONFIRM
        if debris and lock['kind'] == 'os_v1':
            verdict = VERDICT_DEBRIS
    elif not host_stopped:
        verdict, code = VERDICT_CONFIRM, EXIT_CONFIRM
        reasons.append('no read-only check can prove the old host is stopped; re-run with '
                       '--host-stopped once you have confirmed it is not running')
    else:
        verdict, code = VERDICT_SAFE, EXIT_SAFE

    return {'state_dir': os.path.abspath(state_dir), 'paths': paths, 'verdict': verdict,
            'exit_code': code, 'host_stopped_attested': bool(host_stopped),
            'lock': lock, 'queue': queue, 'debris': debris, 'reasons': reasons,
            'accepted_realpath': accept_realpath}


def main(argv=None):
    parser = argparse.ArgumentParser(description='read-only lock/queue upgrade preflight')
    parser.add_argument('--state', required=True, help='state directory to inspect')
    parser.add_argument('--host-stopped', action='store_true',
                        help='the operator attests the old host is not running')
    parser.add_argument('--accept-realpath', default=None,
                        help='acknowledge that the state path resolves to this directory')
    parser.add_argument('--json', action='store_true', help='machine-readable output')
    args = parser.parse_args(argv)

    if not os.path.isdir(args.state):
        print('state directory does not exist: %s' % args.state, file=sys.stderr)
        return EXIT_DAMAGED
    report = inspect(args.state, host_stopped=args.host_stopped,
                     accept_realpath=args.accept_realpath)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print('state        %s' % report['state_dir'])
        print('verdict      %s (exit %d)' % (report['verdict'], report['exit_code']))
        print('lock         %s, %d byte(s)%s'
              % (report['lock']['kind'], report['lock']['size'],
                 ', token %s' % report['lock']['token'] if report['lock']['token'] else ''))
        print('queue        %s'
              % ('absent' if not report['queue']['present']
                 else '%d event(s), %d unacknowledged, %d polled, generation %r'
                 % (report['queue']['events'], report['queue']['unacknowledged'],
                    report['queue']['handed_over'], report['queue']['generation'])))
        for reason in report['reasons']:
            print('  - %s' % reason)
    return report['exit_code']


if __name__ == '__main__':
    sys.exit(main())
