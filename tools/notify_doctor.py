"""Why did no notice go out? Answered from files, read-only.

Tonight's constraint is that nothing may be asked of the operator, so this tool only
reads. It opens the four artifacts under `state/` for reading, never for writing, never
creates a directory, and never touches the extension store, the native host process or
its registration. `test_t095b77_notify_doctor.py` asserts that by hashing the state
directory before and after a run.

What it can and cannot see
--------------------------
The notify chain has four visible stages on disk and one that is not visible:

    terminal-origin.json   the host has read these terminal turns     (visible)
    terminal-source.json   which of them are still pending / acked     (visible)
    terminal-arm.json      what the extension had armed at `takenAt`   (visible)
    queue.json             what the host enqueued and who took it      (visible)
    the extension's own store (LevelDB)                                (NOT visible)

The last one is reported as `extension_store_not_read` rather than guessed at. A tool
that invents a reason is worse than no tool: it is the same failure as a gate nobody
ran, wearing a table.

Time
----
Two encodings arrive from these files and they are not interchangeable:

  * every numeric timestamp in the artifacts is **epoch seconds** (ten digits). The
    extension side stores milliseconds, so a segfault here renders 1970 or 2157.
  * `queue.json` events carry `createdAt` as a 20-character ISO-8601 UTC string.

`to_ms` normalises by magnitude, exactly once, and records which unit it read. Rendering
is UTC+8 computed arithmetically, so the output does not depend on the machine's
timezone setting -- which matters, because the operator reads these at night and a
silent hour of skew is indistinguishable from a stalled chain.
"""
import argparse
import datetime
import json
import os

SECONDS_LIMIT = 10 ** 11        # below this an epoch value is seconds, above it is ms
BEIJING = datetime.timezone(datetime.timedelta(hours=8))
DEFAULT_STALE_MINUTES = 15


def to_ms(value):
    """(milliseconds, unit-as-read). Scaling happens here and nowhere else."""
    if isinstance(value, bool) or value is None:
        return None, 'absent'
    if isinstance(value, (int, float)):
        number = int(value)
        if number <= 0:
            return None, 'not_a_time'
        if number < SECONDS_LIMIT:
            return number * 1000, 'seconds'
        return number, 'milliseconds'
    if isinstance(value, str):
        parsed = parse_iso(value)
        return (parsed, 'iso') if parsed is not None else (None, 'unparsable')
    return None, 'unknown'


def parse_iso(text):
    candidate = text.strip()
    if not candidate:
        return None
    if candidate.endswith('Z'):
        candidate = candidate[:-1] + '+00:00'
    try:
        moment = datetime.datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.timezone.utc)
    return int(moment.timestamp() * 1000)


def beijing(ms):
    if ms is None:
        return 'unknown'
    moment = datetime.datetime.fromtimestamp(ms / 1000.0, BEIJING)
    return moment.strftime('%Y-%m-%d %H:%M:%S.') + '%03d' % (ms % 1000)


# Keys a consumer might use for "I took this". Named explicitly rather than "any value
# that parses", because a numeric field like a retry counter parses as a millisecond
# timestamp and would turn a claim into evidence.
TAKEN_KEYS = ('at', 'deliveredAt', 'takenAt', 'consumedAt', 'ackedAt', 'ts', 'time')
CLAIM_KEYS = ('status', 'state', 'deliveryState', 'delivery', 'phase')
CLAIM_WORDS = ('delivered', 'sent', 'taken', 'acked', 'consumed', 'ok')


def _any_timestamp(value):
    """A millisecond timestamp, ISO-8601 string, or a receipt carrying one.

    For a receipt, a key from `TAKEN_KEYS` is enough. A single-value receipt whose only
    value parses as a time also counts: a receipt has no other reason to hold one number,
    and `{'c': 1793000000}` is a shape a real consumer uses. A counter is not a timestamp
    because `to_ms` rejects the magnitude, which is why this does not degenerate into
    "any number at all".
    """
    if isinstance(value, bool) or value is None:
        return False
    if isinstance(value, dict):
        for key in TAKEN_KEYS:
            if _any_timestamp(value.get(key)):
                return True
        if len(value) == 1:
            return _any_timestamp(list(value.values())[0])
        return False
    if to_ms(value)[0] is not None:
        return True
    return isinstance(value, str) and parse_iso(value) is not None


def delivery_evidence(event):
    """Did a *timestamp* record the handover? This is the only thing that counts.

    The host writing `deliveredAt` is the host describing what it did. A consumer's
    receipt is a second party confirming it. Either has a time attached, and a time is
    the part that can be checked against the clock and against the other artifacts.
    """
    if _any_timestamp(event.get('deliveredAt')):
        return True
    return _any_timestamp(event.get('consumerDeliveredAt'))


def delivery_claimed(event):
    """Something says the event was delivered, with no timestamp behind the claim.

    That is not a failure to report as one, and it is certainly not a delivery. It is the
    case this tool used to get wrong: any non-empty `consumerDeliveredAt` counted as
    taken, so a receipt stub with no time read as proof that a notice arrived.
    """
    consumer = event.get('consumerDeliveredAt')
    if isinstance(consumer, dict):
        if consumer:
            return True
    elif consumer not in (None, '', False):
        return True
    for key in CLAIM_KEYS:
        value = event.get(key)
        if isinstance(value, str) and value.strip().lower() in CLAIM_WORDS:
            return True
    count = event.get('deliveries')
    return isinstance(count, int) and not isinstance(count, bool) and count > 0


def load(state, name):
    """(document, code). A missing or broken artifact is a finding, not an exception."""
    path = os.path.join(state, name)
    if not os.path.exists(path):
        return None, 'artifact_absent'
    try:
        with open(path, encoding='utf-8') as handle:
            document = json.load(handle)
    except (OSError, ValueError):
        return None, 'artifact_unreadable'
    if not isinstance(document, dict):
        return None, 'schema_unexpected'
    return document, None


def id_set(document, key):
    if not isinstance(document, dict):
        return set()
    values = document.get(key)
    if not isinstance(values, list):
        return set()
    return {value for value in values if isinstance(value, str)}


def diagnose(state, now_ms=None, stale_ms=DEFAULT_STALE_MINUTES * 60 * 1000):
    if now_ms is None:
        now_ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    report = {'state': state,
              'now': beijing(now_ms),
              'stages': {},
              'findings': [],
              'limitations': ['extension_store_not_read',
                              'bridge_ledger_not_read']}

    def note(code, detail, severity='blocker'):
        """`blocker` means the chain broke; `expected` means silence is correct here;
        `unknown` means this tool cannot tell and must not pretend it can.

        The first two are the whole tool. A first draft of this file reported "pending
        turns exist but none are armed" as a fault, which is what a turn looks like in
        the minutes after it ends and before the operator arms anything: three quarters
        of the findings would have been normal operation, and a diagnostic that cries
        wolf at normal operation is read once and then ignored.

        `unknown` exists because the third state is the dangerous one. A record that
        *says* an event was delivered, without a timestamp from either side, is neither a
        failure nor a success: reporting it as delivery invents evidence, and reporting
        it as a break sends someone hunting for a bug that may not exist.
        """
        if severity not in ('blocker', 'expected', 'unknown'):
            raise ValueError('severity %r is not blocker/expected/unknown' % severity)
        report['findings'].append({'code': code, 'detail': detail,
                                   'severity': severity})

    origin, origin_code = load(state, 'terminal-origin.json')
    source, source_code = load(state, 'terminal-source.json')
    arm, arm_code = load(state, 'terminal-arm.json')
    queue, queue_code = load(state, 'queue.json')

    for name, code in (('terminal-origin', origin_code), ('terminal-source', source_code),
                       ('terminal-arm', arm_code), ('queue', queue_code)):
        if code:
            note(code, '%s.json' % name)
    if all(code for code in (origin_code, source_code, arm_code, queue_code)):
        report['primary'] = 'nothing_readable'
        # Say which way it failed. Unreadable is not the same fact as "nothing to send",
        # and an answer of None here reads as a bug in the tool rather than a finding.
        report['chain_intact'] = False
        return report

    origin_ids = id_set(origin, 'ids')
    read_ms, read_unit = to_ms((origin or {}).get('readAt'))
    report['stages']['origin'] = {
        'turns_read': len(origin_ids),
        'read_at': beijing(read_ms), 'unit_read': read_unit,
        'age_minutes': None if read_ms is None else round((now_ms - read_ms) / 60000.0, 1),
        'source': (origin or {}).get('source')}

    pending = id_set(source, 'pendingIds') - id_set(source, 'ackedIds')
    acked = id_set(source, 'ackedIds')
    baseline_count = (source or {}).get('baselineCount')
    baseline_dropped = (source or {}).get('baselineDropped') or 0
    report['stages']['source'] = {
        'pending': len(pending), 'acked': len(acked),
        'baseline_ids': len(id_set(source, 'baselineIds')),
        'baseline_count': baseline_count, 'baseline_dropped': baseline_dropped}

    armed = id_set(arm, 'ids')
    taken_ms, taken_unit = to_ms((arm or {}).get('takenAt'))
    arm_age = None if taken_ms is None else now_ms - taken_ms
    report['stages']['arm'] = {
        'armed': len(armed), 'taken_at': beijing(taken_ms), 'unit_read': taken_unit,
        'age_minutes': None if arm_age is None else round(arm_age / 60000.0, 1),
        'truncated': bool((arm or {}).get('truncated')),
        'has_epoch': bool((arm or {}).get('epoch'))}

    events = (queue or {}).get('events') if isinstance((queue or {}).get('events'),
                                                      list) else []
    joined = set()
    deliverable = suppressed = undelivered = evidenced = claimed = 0
    fresh_created = None
    for event in events:
        if not isinstance(event, dict):
            continue
        run_id = event.get('runId')
        if isinstance(run_id, str):
            joined.add(run_id)
        created_ms, _unit = to_ms(event.get('createdAt'))
        if created_ms is not None and (fresh_created is None or created_ms > fresh_created):
            fresh_created = created_ms
        if event.get('deliverable'):
            deliverable += 1
            if delivery_evidence(event):
                evidenced += 1
            elif delivery_claimed(event):
                claimed += 1
            else:
                undelivered += 1
        else:
            suppressed += 1
    consumer_acks = (queue or {}).get('consumer_acks')
    report['stages']['queue'] = {
        'events': len(events), 'deliverable': deliverable, 'suppressed': suppressed,
        'undelivered': undelivered, 'evidenced': evidenced, 'claimed_only': claimed,
        'next_seq': (queue or {}).get('next_seq'),
        'consumers': sorted((queue or {}).get('consumers') or {}),
        'newest_created_at': beijing(fresh_created)}

    # --- the reasoning, in chain order -------------------------------------------
    if not origin_ids:
        # An explanation, not a break: a fresh install and a machine whose conversations
        # have never ended both look exactly like this, and both are correct silence.
        note('no_terminal_turns', 'the host has read no terminal turn, so the chain has '
                                  'nothing to start from', 'expected')
    if baseline_dropped:
        note('baseline_truncated', '%d baseline id(s) were dropped when the baseline was '
                                   'recorded; a turn past the cap cannot be recalled, so '
                                   'silence about it is expected' % baseline_dropped,
             'expected')
    if (arm or {}).get('truncated'):
        note('arm_truncated', 'the armed snapshot was truncated at capture time',
             'expected')
    if arm_age is not None and arm_age < 0:
        note('clock_skew', 'terminal-arm takenAt is in the future by %d ms; the two sides '
                           'do not share a clock' % -arm_age)
    if not pending and not armed:
        note('nothing_to_send', 'nothing is pending and nothing was armed: correct '
                                'silence, not a fault', 'expected')
    if pending and armed and not (pending & armed):
        note('pending_not_armed', '%d pending turn(s) are outside the armed snapshot, so '
                                  'the trigger cannot fire on them; expected unless a '
                                  'notice was wanted for one of them' % len(pending),
             'expected')
    armed_pending = pending & armed
    if armed_pending and arm_age is not None and arm_age > stale_ms:
        note('arm_stale', 'the armed snapshot is %d minutes old and %d turn(s) it covers '
                          'are still pending: the trigger is looking at a window that '
                          'has already passed'
             % (round(arm_age / 60000.0), len(armed_pending)))
    missed = armed_pending - joined
    if missed:
        # Only a turn the trigger was actually armed for must appear in the queue. A
        # pending turn that arrived after the snapshot has no reason to be there yet.
        note('armed_but_not_enqueued', '%d armed turn(s) produced no queue event: the '
                                       'fire happened without an enqueue' % len(missed))
    if claimed:
        note('delivery_claimed_without_timestamp',
             '%d event(s) are marked delivered with no timestamp on either side: not a '
             'failure, and not evidence that a notice arrived' % claimed, 'unknown')
    if undelivered:
        note('waiting_for_consumer', '%d deliverable event(s) were never taken by any '
                                     'consumer' % undelivered)
    if deliverable == 0 and suppressed:
        note('suppressed_by_gate', 'every event was marked undeliverable (a replay, '
                                   'already notified, or the turn was not armed)',
             'expected')

    blockers = [f for f in report['findings'] if f['severity'] == 'blocker']
    unknowns = [f for f in report['findings'] if f['severity'] == 'unknown']
    # `delivered` is claimed only on evidence. An unevidenced claim is graded `unknown`
    # above and never promoted to delivery here.
    report['delivery'] = ('evidenced' if evidenced else
                          'claimed_only' if claimed else
                          'none' if deliverable else 'nothing_deliverable')
    if evidenced:
        report['primary'] = 'delivered'
    elif blockers:
        report['primary'] = blockers[0]['code']
    elif unknowns:
        report['primary'] = unknowns[0]['code']
    elif report['findings']:
        report['primary'] = 'expected_silence'
    else:
        report['primary'] = 'no_reason_found'
    report['chain_intact'] = not blockers
    return report


def stats_only(report):
    """The report reduced to counts, grades and codes. Nothing that identifies anything.

    Written for the case where the diagnosis has to leave the machine: a chat message, an
    issue, a pasted comment. `report` itself carries the state directory, consumer names
    and turn identifiers, and pasting it is how a diagnostic turns into a leak. This is
    the same reasoning with the identifying parts removed, so it can be shared as-is and
    still say which rule fired.
    """
    counts = {'blocker': 0, 'unknown': 0, 'expected': 0}
    for finding in report['findings']:
        counts[finding['severity']] = counts.get(finding['severity'], 0) + 1
    stages = {}
    for name, stage in report['stages'].items():
        kept = {}
        for key, value in stage.items():
            if isinstance(value, bool) or value is None:
                kept[key] = value
            elif isinstance(value, (int, float)):
                kept[key] = value
            elif key == 'consumers':
                # Names are identities. The count is the fact.
                kept['consumers'] = len(value or ())
            elif key == 'newest_created_at':
                kept[key] = value          # a timestamp, not a secret
        stages[name] = kept
    return {
        'primary': report['primary'],
        'delivery': report.get('delivery'),
        'chain_intact': report.get('chain_intact'),
        'grades': counts,
        'codes': [finding['code'] for finding in report['findings']],
        'stages': stages,
        'limitations': report['limitations'],
    }


def render(report):
    print('state : %s' % report['state'])
    print('now   : %s (Beijing)' % report['now'])
    for name in ('origin', 'source', 'arm', 'queue'):
        stage = report['stages'].get(name)
        if stage is None:
            continue
        print('')
        print('[%s]' % name)
        for key in sorted(stage):
            print('  %-20s %s' % (key, stage[key]))
    print('')
    print('findings:')
    if not report['findings']:
        print('  (none)')
    for finding in report['findings']:
        print('  %-9s %-24s %s' % (finding['severity'], finding['code'],
                                   finding['detail']))
    print('')
    print('not visible to this tool: %s' % ', '.join(report['limitations']))
    print('delivery      : %s' % report.get('delivery'))
    print('primary reason: %s' % report['primary'])
    print('chain intact  : %s' % report.get('chain_intact'))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', default=None,
                        help='directory holding the four artifacts (read-only)')
    parser.add_argument('--now', default=None,
                        help='override the clock, ISO-8601; for reproducing a report')
    parser.add_argument('--stale-minutes', type=int, default=DEFAULT_STALE_MINUTES)
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--json-stats', action='store_true',
                        help='the same reasoning as counts, grades and codes only: no '
                             'state path, no consumer names, no turn identifiers, so it '
                             'can be pasted into a message without leaking anything')
    args = parser.parse_args(argv)

    state = args.state or os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), 'state')
    now_ms = parse_iso(args.now) if args.now else None
    if args.now and now_ms is None:
        parser.error('--now is not an ISO-8601 timestamp')
    report = diagnose(state, now_ms=now_ms,
                      stale_ms=args.stale_minutes * 60 * 1000)
    if args.json_stats:
        print(json.dumps(stats_only(report), indent=2, ensure_ascii=False))
        return 0
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0
    return render(report)


if __name__ == '__main__':
    raise SystemExit(main())
