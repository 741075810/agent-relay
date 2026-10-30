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
import json
import os
import sys

sys.dont_write_bytecode = True

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


def _lock_report(state_dir):
    path = os.path.join(state_dir, host.LOCK_FILE)
    report = {'path': host.LOCK_FILE, 'present': False, 'kind': 'absent',
              'size': 0, 'token': None}
    try:
        with open(path, 'rb') as handle:
            raw = handle.read(4096)
    except FileNotFoundError:
        return report
    except OSError as exc:
        report.update(kind='unreadable', detail='%s: %s' % (type(exc).__name__, exc))
        return report
    report['present'] = True
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
    if not os.path.isfile(path):
        return report
    report['present'] = True
    try:
        document = host.load_queue(state_dir)
    except host.HostError as exc:
        report['readable'] = False
        report['error'] = '%s: %s' % (type(exc).__name__, exc)
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


def inspect(state_dir, host_stopped=False):
    """Everything the operator needs, and nothing that changes the directory."""
    lock = _lock_report(state_dir)
    queue = _queue_report(state_dir)
    debris = _debris_report(state_dir)

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
    elif lock['kind'] == 'unknown':
        reasons.append('the lock file holds something this tool does not recognise (%s); '
                       'do not start a host against it' % lock.get('detail'))
        needs_manual = True
    elif lock['kind'] == 'unreadable':
        reasons.append('the lock file cannot be read (%s)' % lock.get('detail'))
        needs_manual = True

    if not queue['readable']:
        reasons.append('the queue is damaged: %s' % queue['error'])
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

    return {'state_dir': os.path.abspath(state_dir), 'verdict': verdict,
            'exit_code': code, 'host_stopped_attested': bool(host_stopped),
            'lock': lock, 'queue': queue, 'debris': debris, 'reasons': reasons}


def main(argv=None):
    parser = argparse.ArgumentParser(description='read-only lock/queue upgrade preflight')
    parser.add_argument('--state', required=True, help='state directory to inspect')
    parser.add_argument('--host-stopped', action='store_true',
                        help='the operator attests the old host is not running')
    parser.add_argument('--json', action='store_true', help='machine-readable output')
    args = parser.parse_args(argv)

    if not os.path.isdir(args.state):
        print('state directory does not exist: %s' % args.state, file=sys.stderr)
        return EXIT_DAMAGED
    report = inspect(args.state, host_stopped=args.host_stopped)
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
