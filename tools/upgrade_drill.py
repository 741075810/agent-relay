"""Offline upgrade/rollback drill, and the handover evidence it produces.

Everything here happens inside a `tempfile.mkdtemp` fixture. The drill never takes a path
from the operator, because a drill that can be pointed at a real state directory is one
accident away from being an upgrade. What it proves is the *sequence*: which verdict the
shipped preflight returns at each stage, what the new protocol does to a real-format queue,
and what the refusal paths leave behind.

It deliberately does not prove that the old host is stopped. That is an operator statement,
passed in as `--attest-stopped`, and the drill only records that it was made.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import host  # noqa: E402

PREFLIGHT = os.path.join(ROOT, 'tools', 'upgrade_preflight.py')


def snapshot(directory):
    """Name -> sha256 for every file, so "unchanged" is a fact rather than a claim."""
    digest = {}
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if not os.path.isfile(path):
            continue
        with open(path, 'rb') as handle:
            digest[name] = hashlib.sha256(handle.read()).hexdigest()[:16]
    return digest


def preflight(state_dir, stopped=False, extra=()):
    command = [sys.executable, '-B', PREFLIGHT, '--state', state_dir, '--json']
    if stopped:
        command.append('--host-stopped')
    command.extend(extra)
    done = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          timeout=300)
    try:
        report = json.loads(done.stdout.decode('utf-8', 'replace'))
    except ValueError:
        report = {'verdict': '<unparseable>', 'exit_code': done.returncode,
                  'output': done.stdout.decode('utf-8', 'replace')[:400]}
    report['process_exit'] = done.returncode
    return report


def make_legacy_state(directory):
    """What a pre-T088 host leaves behind: an empty lock file and a queue in today's format.

    The queue is written by the current code rather than by hand, so the drill is testing the
    format that will actually be read, not a guess about it.
    """
    os.makedirs(directory, exist_ok=True)
    host.append_events(directory, [
        {'eventId': 'evt-a', 'runId': 'run-1', 'text': 'first'},
        {'eventId': 'evt-b', 'runId': 'run-1', 'text': 'second'},
        {'eventId': 'evt-c', 'runId': 'run-2', 'text': 'third'},
    ])
    host.ack_events(directory, ['evt-a'], consumer='page')
    # The legacy lock goes on last: the current code refuses to write into a directory whose
    # lock it does not recognise, which is the behaviour being drilled.
    with open(os.path.join(directory, host.LOCK_FILE), 'wb'):
        pass
    return directory


def stage(records, name, **facts):
    record = {'stage': name}
    record.update(facts)
    records.append(record)
    return record


def drill(state_dir, attested):
    """Run the sequence and return the record of it."""
    records = []
    verdicts = []
    make_legacy_state(state_dir)
    before = snapshot(state_dir)
    stage(records, 'prepared', files=sorted(before), queue_version=1,
          lock_bytes=os.path.getsize(os.path.join(state_dir, host.LOCK_FILE)))

    first = preflight(state_dir)
    verdicts.append(first['verdict'])
    stage(records, 'preflight-with-legacy-lock', verdict=first['verdict'],
          exit_code=first['process_exit'],
          kinds={k: first['lock']['kind'] for k in ('kind',)})

    refused = preflight(state_dir, stopped=True)
    verdicts.append(refused['verdict'])
    stage(records, 'preflight-legacy-with-attestation', verdict=refused['verdict'],
          exit_code=refused['process_exit'],
          note='an attestation does not make a legacy lock safe')

    if not attested:
        stage(records, 'stopped', attested=False,
              note='the drill stops here: stopping the old host is an operator action')
        return records, verdicts

    stage(records, 'stopped', attested=True,
          note='operator statement, not something this drill can verify')
    os.remove(os.path.join(state_dir, host.LOCK_FILE))
    after_removal = preflight(state_dir, stopped=True)
    verdicts.append(after_removal['verdict'])
    stage(records, 'preflight-after-removal', verdict=after_removal['verdict'],
          exit_code=after_removal['process_exit'])
    if after_removal['verdict'] != 'safe_to_start':
        stage(records, 'aborted', reason='the preflight did not clear the directory')
        return records, verdicts

    # What the new host does at startup, in order, against the same queue.
    busy = preflight(state_dir, stopped=True)
    verdicts.append(busy['verdict'])
    stage(records, 'start', lock_kind=busy['lock']['kind'],
          lock_held=busy['lock'].get('held_by_a_process'),
          note='a fresh os-v1 lock is not a running host yet')

    host.append_events(state_dir, [{'eventId': 'evt-d', 'runId': 'run-3', 'text': 'new'}])
    host.ack_events(state_dir, ['evt-b'], consumer='page')
    # pending_events answers with a tuple whose head is the events; the rest is cursor state.
    page_events = host.pending_events(state_dir, consumer='page')[0]
    other_events = host.pending_events(state_dir, consumer='other')[0]
    document = host.load_queue(state_dir)
    delivered = [event['eventId'] for event in page_events]
    stage(records, 'verify',
          page_sees=delivered,
          other_sees=[event['eventId'] for event in other_events],
          acked_page=len((document.get('consumer_acks') or {}).get('page') or []),
          acked_global=len(document.get('acked') or []),
          consumers=sorted(document.get('consumer_acks') or {}),
          generation=document.get('generation'),
          no_event_lost=sorted(host.known_event_ids(document))
          == ['evt-a', 'evt-b', 'evt-c', 'evt-d'])

    final = preflight(state_dir)
    verdicts.append(final['verdict'])
    stage(records, 'rollback-view', verdict=final['verdict'],
          exit_code=final['process_exit'],
          note='rolling back also needs the new host stopped and its lock removed by hand')

    after = snapshot(state_dir)
    stage(records, 'summary', files_before=sorted(before), files_after=sorted(after),
          changed=sorted(name for name in after if before.get(name) != after[name]))
    return records, verdicts


class _Fixture(object):
    def __init__(self):
        self.path = tempfile.mkdtemp(prefix='t096-drill-')

    def __enter__(self):
        return self.path

    def __exit__(self, *_):
        shutil.rmtree(self.path, ignore_errors=True)


def refusal_cases():
    """The two refusals that must leave the fixture untouched."""
    results = []
    with _Fixture() as directory:
        host.append_events(directory, [{'eventId': 'evt-a', 'runId': 'run-1', 'text': 'x'}])
        with open(os.path.join(directory, host.LOCK_FILE), 'wb') as handle:
            handle.write(b'\x00\x01THIS-IS-NOT-A-KNOWN-LOCK-PROTOCOL')
        before = snapshot(directory)
        report = preflight(directory, stopped=True)
        results.append({'case': 'unknown-lock', 'verdict': report['verdict'],
                        'exit_code': report['process_exit'],
                        'unchanged': snapshot(directory) == before})

    with _Fixture() as directory:
        make_legacy_state(directory)
        with open(os.path.join(directory, host.QUEUE_FILE), 'w', encoding='utf-8') as out:
            out.write('{"version": 1, "events": [')
        before = snapshot(directory)
        report = preflight(directory, stopped=True)
        results.append({'case': 'damaged-queue', 'verdict': report['verdict'],
                        'exit_code': report['process_exit'],
                        'unchanged': snapshot(directory) == before})
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description='offline upgrade/rollback drill; never '
                                                 'touches a directory you name')
    parser.add_argument('--attest-stopped', action='store_true',
                        help='the operator states the old host is stopped; without it the '
                             'drill stops after the read-only stages')
    parser.add_argument('--report', default=None,
                        help='write the record here instead of stdout')
    args = parser.parse_args(argv)

    with _Fixture() as directory:
        records, verdicts = drill(directory, args.attest_stopped)
        refusals = refusal_cases()
    report = {'attested_stopped': bool(args.attest_stopped), 'stages': records,
              'verdicts': verdicts, 'refusals': refusals}
    text = json.dumps(report, indent=2, sort_keys=True)
    if args.report:
        with open(args.report, 'w', encoding='utf-8') as out:
            out.write(text + '\n')
        print('wrote %s (%d stages)' % (args.report, len(records)))
    else:
        print(text)

    problems = [case for case in refusals if not case['unchanged']]
    if problems:
        print('the refusal path changed the fixture: %s' % problems, file=sys.stderr)
        return 2
    if args.attest_stopped and verdicts[:3] != ['legacy_lock_remove_by_hand',
                                                'legacy_lock_remove_by_hand',
                                                'safe_to_start']:
        print('the verdict sequence was not the documented one: %s' % verdicts,
              file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
