"""T044 native messaging host: the local end of the DSH -> Chrome channel.

Chrome starts this program as a child process and talks to it over stdin/stdout
using the framing in protocol.py. Two consequences shape everything below:

1. **The host cannot wake the extension.** Chrome gives the host no signal, no
   socket and no callback. An MV3 service worker that has gone idle stays idle
   until something *inside the browser* wakes it (an alarm, a tab event, a user
   action). So delivery is extension-initiated polling. This is a hard limit of
   the platform, not a shortcut taken here, and it is why the extension carries
   an alarm instead of a long-lived port.

2. **The host may die at any moment.** Chrome kills it when the port closes or
   the service worker is evicted. Anything held only in memory is lost, so the
   queue is a file and every mutation is a read-modify-write under a lock.

The prototype's one absolute rule: this host never emits an instruction to type,
click or submit. `protocol.CAPABILITIES['deliver']` is false, `validate_event`
requires `deliverable: false` on every event, and there is no op that carries
page actions. A real-send capability would need a new op, a new event field and
an explicit decision -- not a flag flip.

Standalone check (no Chrome involved):
    python -B host.py --self-check
    python -B host.py --simulate 3 --dump        # print synthetic events
"""
import argparse
import hashlib
import json
import os
import re
import struct
import sys
import time

import protocol as P
import terminal_source

HOST_NAME = 'com.dsh.notify'

DEFAULT_STATE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'state')
QUEUE_FILE = 'queue.json'
LOCK_FILE = 'queue.lock'

# How long a delivered-but-unacked event is kept before it is offered again.
# Chrome may evict the service worker between `poll` and `ack`, and an event
# that vanished in that window would be a silently dropped notification.
REDELIVER_AFTER_S = 300
ACKED_RETENTION_S = 7 * 24 * 60 * 60
CONSUMER_LEASE_S = 30 * 24 * 60 * 60
MAX_CONSUMERS = 64

MAX_POLL_LIMIT = 50


class HostError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


# -- state -------------------------------------------------------------
def _empty_queue():
    return {'version': 1, 'next_seq': 1, 'events': [], 'acked': []}


def load_queue(state_dir):
    path = os.path.join(state_dir, QUEUE_FILE)
    if not os.path.isfile(path):
        return _empty_queue()
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            doc = json.load(handle)
    except (OSError, ValueError) as exc:
        # An unreadable queue must stop delivery, not be read as "nothing
        # pending": the second interpretation loses notifications silently.
        raise HostError(P.E_INTERNAL, 'queue %s is unreadable: %s' % (path, exc))
    if not isinstance(doc, dict) or doc.get('version') != 1:
        raise HostError(P.E_INTERNAL, 'queue %s is not ours' % path)
    doc.setdefault('next_seq', 1)
    doc.setdefault('events', [])
    doc.setdefault('acked', [])
    return doc


def save_queue(state_dir, doc):
    os.makedirs(state_dir, exist_ok=True)
    path = os.path.join(state_dir, QUEUE_FILE)
    tmp = '%s.tmp-%d' % (path, os.getpid())
    try:
        with open(tmp, 'w', encoding='utf-8') as handle:
            json.dump(doc, handle, ensure_ascii=False, indent=1, sort_keys=True)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        # A failed save must not leave debris: a full disk would then fill the state
        # directory a little more on every retry, and the next reader has to walk past
        # files that are not part of anything.
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


class _Lock(object):
    """Exclusive create-based lock, held only for one read-modify-write.

    Same shape as the notifier's engine lock, and for the same reason: two
    Chrome profiles can load the same extension against one host, and two
    interleaved `ack` calls would lose an event id from the acked set.
    """

    def __init__(self, state_dir, timeout_s=5.0):
        self.path = os.path.join(state_dir, LOCK_FILE)
        self.timeout_s = timeout_s
        self.handle = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        end = time.time() + self.timeout_s
        while True:
            try:
                self.handle = os.open(self.path,
                                      os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                return self
            except FileExistsError:
                if time.time() > end:
                    # A stale lock from a killed host must not wedge delivery
                    # forever, so it is broken rather than waited on.
                    try:
                        os.unlink(self.path)
                    except OSError:
                        pass
                    end = time.time() + self.timeout_s
                time.sleep(0.02)

    def __exit__(self, *_exc):
        if self.handle is not None:
            os.close(self.handle)
            self.handle = None
            try:
                os.unlink(self.path)
            except OSError:
                pass
        return False


def known_event_ids(doc):
    """Every event id this queue still remembers: payloads and every ack form.

    Kept as a pure function of a loaded document so read-only callers (the
    preview dry-run) can answer "would this be a duplicate?" without taking the
    write lock or touching the file.
    """
    return (set(event.get('eventId') for event in doc['events'])
            | set(doc['acked']) | set(doc.get('acked_at', {}))
            | {ident for values in doc.get('consumer_acks', {}).values()
               for ident in values})


def append_events(state_dir, events):
    """Add events, skipping any `eventId` already present. Returns added count."""
    with _Lock(state_dir):
        doc = load_queue(state_dir)
        known = known_event_ids(doc)
        added = 0
        for event in events:
            if event['eventId'] in known:
                continue
            row = dict(event)
            row['seq'] = doc['next_seq']
            doc['next_seq'] += 1
            row['enqueuedAt'] = int(time.time())
            row['deliveredAt'] = None
            row['deliveries'] = 0
            doc['events'].append(row)
            known.add(event['eventId'])
            added += 1
        if added:
            save_queue(state_dir, doc)
        return added


def _valid_consumer_id(value):
    return (isinstance(value, str) and 1 <= len(value) <= 80
            and all(ch.isascii() and (ch.isalnum() or ch in '._-')
                    for ch in value))


def _prune_ack_retention(doc, now):
    cutoff = now - ACKED_RETENTION_S
    acked_at = doc.setdefault('acked_at', {})
    expired = {ident for ident, stamp in acked_at.items()
               if isinstance(stamp, int) and stamp < cutoff}
    if not expired:
        return
    doc['events'] = [event for event in doc['events']
                     if event['eventId'] not in expired]
    doc['acked'] = [ident for ident in doc.get('acked', [])
                    if ident not in expired]
    doc['acked_at'] = {ident: stamp for ident, stamp in acked_at.items()
                       if ident not in expired}
    for values in doc.setdefault('consumer_acks', {}).values():
        values[:] = [ident for ident in values if ident not in expired]


def pending_events(state_dir, cursor=None, limit=20, consumer=None):
    """Return new or expired unacked events, oldest first.

    Cursor is only a scan optimization, never acknowledgement. Scoped consumers
    keep separate ack records and payloads remain available for late consumers
    through the bounded retention window. Legacy callers retain global ack rules.
    """
    if consumer is not None and not _valid_consumer_id(consumer):
        raise HostError(P.E_BAD_REQUEST, '"consumer" is not a valid token')
    since = cursor if isinstance(cursor, int) and not isinstance(cursor, bool) and cursor >= 0 else 0
    now = int(time.time())
    with _Lock(state_dir):
        doc = load_queue(state_dir)
        _prune_ack_retention(doc, now)
        if consumer is not None:
            consumers = doc.setdefault('consumers', {})
            active = {key: value for key, value in consumers.items()
                      if isinstance(value, dict)
                      and now - int(value.get('last_seen', 0)) <= CONSUMER_LEASE_S}
            if consumer not in active and len(active) >= MAX_CONSUMERS:
                raise HostError(P.E_INTERNAL,
                                'consumer registry is full; refusing poll')
            active[consumer] = {'last_seen': now}
            doc['consumers'] = active
        acked = (set(doc['acked']) if consumer is None else
                 set(doc['acked']) | set(
                     doc.get('consumer_acks', {}).get(consumer, [])))
        ordered = sorted(doc['events'], key=lambda event: event.get('seq', 0))
        out = []
        next_cursor = since
        has_more = False
        for event in ordered:
            seq = event.get('seq', 0)
            is_acked = event['eventId'] in acked
            acked_at = doc.get('acked_at', {}).get(event['eventId'])
            if consumer is not None and isinstance(acked_at, int):
                is_acked = (event['eventId'] in
                            doc.get('consumer_acks', {}).get(consumer, []))
            delivered_at = (event.get('consumerDeliveredAt', {}).get(
                                consumer, event.get('deliveredAt'))
                            if consumer is not None else event.get('deliveredAt'))
            expired = (isinstance(delivered_at, int)
                       and now - delivered_at >= REDELIVER_AFTER_S)
            eligible = (not is_acked and
                        (seq > since or (seq <= since and expired)))
            if eligible:
                if len(out) >= limit:
                    has_more = True
                    break
                out.append(event)
            if seq > since:
                next_cursor = seq

        by_id = {event['eventId']: event for event in doc['events']}
        for event in out:
            row = by_id.get(event['eventId'])
            if row is not None:
                row['deliveredAt'] = now
                if consumer is not None:
                    row.setdefault('consumerDeliveredAt', {})[consumer] = now
                row['deliveries'] = int(row.get('deliveries') or 0) + 1
        if out or consumer is not None:
            save_queue(state_dir, doc)

    return out, next_cursor, has_more


def ack_events(state_dir, event_ids, consumer=None):
    """Record an idempotent global or per-consumer acknowledgement."""
    if not isinstance(event_ids, list):
        raise HostError(P.E_BAD_REQUEST, '"acked" must be a list of event ids')
    if consumer is not None and not _valid_consumer_id(consumer):
        raise HostError(P.E_BAD_REQUEST, '"consumer" is not a valid token')
    with _Lock(state_dir):
        doc = load_queue(state_dir)
        if consumer is None:
            acked = set(doc['acked'])
            before = len(acked)
            known_payload_ids = {event['eventId'] for event in doc['events']}
            for ident in event_ids:
                if isinstance(ident, str) and ident and ident in known_payload_ids:
                    acked.add(ident)
                    doc.setdefault('acked_at', {}).setdefault(ident, now_seconds())
            doc['acked'] = sorted(acked)
            _prune_ack_retention(doc, now_seconds())
            save_queue(state_dir, doc)
            return len(acked) - before

        consumer_acks = doc.setdefault('consumer_acks', {})
        consumers = doc.setdefault('consumers', {})
        active = {key: value for key, value in consumers.items()
                  if isinstance(value, dict)
                  and now_seconds() - int(value.get('last_seen', 0))
                  <= CONSUMER_LEASE_S}
        if consumer not in active and len(active) >= MAX_CONSUMERS:
            raise HostError(P.E_INTERNAL, 'consumer registry is full; refusing ack')
        active[consumer] = {'last_seen': now_seconds()}
        doc['consumers'] = active
        prior = set(consumer_acks.get(consumer, []))
        before = len(prior)
        known_payload_ids = {event['eventId'] for event in doc['events']}
        for ident in event_ids:
            if isinstance(ident, str) and ident and ident in known_payload_ids:
                prior.add(ident)
                doc.setdefault('acked_at', {}).setdefault(ident, now_seconds())
        consumer_acks[consumer] = sorted(prior)
        _prune_ack_retention(doc, now_seconds())
        save_queue(state_dir, doc)
        return len(prior) - before


def now_seconds():
    return int(time.time())


# -- simulated events --------------------------------------------------
def simulated_events(count=1, start_seq=1):
    """Synthetic events for offline testing. Clearly labelled as such."""
    out = []
    base = 1759000000
    for i in range(count):
        n = start_seq + i
        out.append(P.make_event(
            event_id='evt_sim_run%04d_task_completed' % n,
            name='task.completed',
            run_id='sim-run-%04d' % n,
            status='completed',
            created_at=time.strftime('%Y-%m-%dT%H:%M:%SZ',
                                     time.gmtime(base + n * 60)),
            message='[DSH 任务通知·模拟] run sim-run-%04d 已完成' % n,
            replay=True,
        ))
    return out


# -- request handling --------------------------------------------------
def handle_request(state_dir, doc, ledger_root=None, bridge_db=None,
                   bridge_fixture=None, native_root=None):
    try:
        op, args = P.validate_request(doc)
    except P.ProtocolError as exc:
        ident = doc.get('id') if isinstance(doc, dict) else None
        return P.error_response(ident, exc.code, exc.message)

    ident = doc['id']
    try:
        if op == 'hello':
            return P.ok_response(ident, {
                'host': HOST_NAME,
                'hostVersion': P.HOST_VERSION,
                'protocolVersion': P.PROTOCOL_VERSION,
                'capabilities': dict(P.CAPABILITIES),
                'deliver': False,
                'note': 'prototype: simulated events and read-only detection only',
            })

        if op == 'status':
            doc_q = load_queue(state_dir)
            acked = set(doc_q['acked']) | set(doc_q.get('acked_at', {}))
            unacked = [e for e in doc_q['events'] if e['eventId'] not in acked]
            return P.ok_response(ident, {
                'hostVersion': P.HOST_VERSION,
                'queued': len(unacked),
                'acked': len(acked),
                'nextSeq': doc_q['next_seq'],
                'deliver': False,
                'stateDir': os.path.abspath(state_dir),
            })

        if op == 'poll':
            limit = args.get('limit', 20)
            if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
                raise HostError(P.E_BAD_REQUEST,
                                '"limit" must be a positive integer')
            limit = min(limit, MAX_POLL_LIMIT)
            cursor = args.get('cursor')
            if cursor is not None and (not isinstance(cursor, int)
                                       or isinstance(cursor, bool)):
                raise HostError(P.E_BAD_REQUEST,
                                '"cursor" must be an integer when present')
            events, next_cursor, has_more = pending_events(
                state_dir, cursor, limit, consumer=args.get('consumer'))
            return P.ok_response(ident, {
                'events': events,
                'cursor': next_cursor,
                'more': has_more,
                'deliver': False,
            })

        if op == 'ack':
            added = ack_events(state_dir, args.get('acked'),
                               consumer=args.get('consumer'))
            return P.ok_response(ident, {'newlyAcked': added})

        if op == 'simulate':
            count = args.get('count', 1)
            if not isinstance(count, int) or count < 1 or count > 100:
                raise HostError(P.E_BAD_REQUEST,
                                '"count" must be an integer from 1 to 100')
            doc_q = load_queue(state_dir)
            events = simulated_events(count, doc_q['next_seq'])
            added = append_events(state_dir, events)
            return P.ok_response(ident, {
                'added': added,
                'simulated': True,
                'deliver': False,
            })

        if op == 'terminal-list':
            # T059: a separate, read-only query for finished tasks.
            #
            # It deliberately does not use the queue: the notification queue is
            # `deliverable:false` by construction and must stay that way, so the
            # auto-send path gets its candidates from the Bridge ledger directly
            # and never from a stored notification. Nothing is written to the
            # queue here; the only file this touches is the sampler's own state.
            #
            # No project path, session id or message crosses this boundary --
            # see terminal_source for why the identifier set is that small.
            report = terminal_source.sample(state_dir, ledger_root, bridge_db,
                                            load_origin_fixture(bridge_fixture),
                                            native_root)
            return P.ok_response(ident, report)

        if op == 'terminal-running':
            # T068: what is running *now*, so the operator can decide before the
            # task ends instead of after. Strictly read-only: no state write, no
            # pending list, no ACK. Opening the popup must not be able to change
            # what gets sent, and this op is what opening the popup calls.
            report = terminal_source.running_report(
                state_dir, ledger_root, bridge_db, native_root)
            return P.ok_response(ident, report)

        if op == 'terminal-arm-snapshot':
            # T091: the arming boundary itself. The extension names an epoch, the
            # host records which runs are already terminal at this instant, and
            # every later `terminal-list` echoes that epoch back so the two sides
            # can never disagree about which arm round a snapshot belongs to.
            #
            # Refusing is the whole point: a partial snapshot, an unreadable
            # ledger or a malformed epoch all come back as `ok:false`, and the
            # extension must not enable the trigger on that answer.
            report = terminal_source.arm_snapshot(
                state_dir, ledger_root, args.get('epoch'))
            return P.ok_response(ident, report)

        if op == 'terminal-ack':            # T059: consumed, and only on Chrome's word. The candidate list is
            # re-offered until this arrives, so a disconnect between the answer
            # and the save costs a duplicate offer, never a lost completion.
            # Still nothing to do with the notification queue.
            try:
                acked = terminal_source.acknowledge(state_dir, args.get('acked'))
            except terminal_source.SourceError as exc:
                # A malformed ACK is a bad request, not a crash. The host has to
                # keep answering: a thrown error here would take down the whole
                # pipe for a typo in one message.
                raise HostError(P.E_BAD_REQUEST, str(exc))
            return P.ok_response(ident, acked)

        raise HostError(P.E_UNKNOWN_OP, 'unhandled op %r' % op)
    except HostError as exc:
        return P.error_response(ident, exc.code, exc.message)
    except P.ProtocolError as exc:
        return P.error_response(ident, exc.code, exc.message)


# -- origin check ------------------------------------------------------
def expected_origins(manifest_path=None):
    """Extension origins this host will talk to.

    Chrome passes the caller's origin as argv[1]. Without this check any
    extension in the browser -- including one the operator never chose -- could
    read the notification queue, which contains task ids and project paths.
    """
    origin = None
    if manifest_path and os.path.isfile(manifest_path):
        try:
            with open(manifest_path, 'r', encoding='utf-8-sig') as handle:
                origin = (json.load(handle) or {}).get('allowed_origins')
        except (OSError, ValueError):
            origin = None
    if isinstance(origin, list) and origin:
        return tuple(origin)
    return ()


def _valid_parent_window_arg(value):
    """Accept Chrome's ASCII decimal HWND within this process's pointer range."""
    if re.fullmatch(r'[0-9]+', value) is None:
        return False
    try:
        return int(value) <= (1 << (8 * struct.calcsize('P'))) - 1
    except ValueError:
        return False


def split_origin(argv):
    """Separate Chrome's caller origin and its one Windows-only option.

    Chrome supplies the caller origin and, on Windows, may also supply
    `--parent-window=<decimal>`. Consume only that exact ASCII-decimal form
    (bounded to an unsigned pointer value), at most once. Malformed, duplicate,
    and unrelated options remain in argv so argparse rejects them. The caller origin is still checked separately
    against the manifest allow-list before any Native Messaging service starts.

    Returns `(origin_or_None, argv_with_chrome_metadata_removed)`.
    """
    origin = None
    parent_window_seen = False
    rest = []
    for index, item in enumerate(argv):
        if index > 0 and item.startswith('chrome-extension://'):
            if origin is not None:
                rest.append(item)
            else:
                origin = item
            continue
        if index > 0 and item.startswith('--parent-window='):
            value = item[len('--parent-window='):]
            valid = not parent_window_seen and _valid_parent_window_arg(value)
            if valid:
                parent_window_seen = True
                continue
        rest.append(item)
    return origin, rest


def check_origin(caller, manifest_path=None):
    """Return the caller id, or raise.

    `caller` is what Chrome passed as argv[1]; None means it was absent, which is
    a refusal rather than a default. There is deliberately no "allow if no origin
    was given" branch: that would be an open door for anything that can launch a
    process.
    """
    if not caller:
        raise HostError(
            P.E_NOT_ALLOWED,
            'no caller origin on the command line; Chrome always passes '
            'chrome-extension://<id>/ as the first argument')
    allowed = expected_origins(manifest_path)
    if not allowed:
        raise HostError(
            P.E_NOT_ALLOWED,
            'no allowed_origins in the host manifest, so no caller can be '
            'verified; refusing to serve')
    normalised = caller if caller.endswith('/') else caller + '/'
    if normalised not in [a if a.endswith('/') else a + '/' for a in allowed]:
        raise HostError(
            P.E_NOT_ALLOWED,
            'caller %r is not in allowed_origins; refusing to serve'
            % caller[:120])
    return caller


# -- entry points ------------------------------------------------------
def load_origin_fixture(path):
    """Read the test-only origin manifest, or None.

    Re-read on every request rather than once at startup: the suites that drive
    this host generate their run ids as they go, and the manifest has to be able to
    say "everything in this ledger is a bridge run" without being rewritten. A
    malformed or missing file yields None, which makes the host fall back to the
    real classification -- never to a permissive default.
    """
    if not path:
        return None
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def serve(state_dir, manifest_path, stdin, stdout, ledger_root=None,
          bridge_db=None, bridge_fixture=None, native_root=None):
    """Answer requests until the pipe closes."""
    while True:
        try:
            doc = P.read_message(stdin)
        except P.ProtocolError as exc:
            # A framing error leaves the stream position unknown, so the only
            # honest move is to report it and stop rather than resynchronise
            # into the middle of a message.
            try:
                stdout.write(P.encode(P.error_response(None, exc.code,
                                                       exc.message)))
                stdout.flush()
            except Exception:                      # noqa: BLE001
                pass
            return 1
        if doc is None:
            return 0
        response = handle_request(state_dir, doc, ledger_root, bridge_db,
                                  bridge_fixture, native_root)
        try:
            stdout.write(P.encode(response))
            stdout.flush()
        except P.ProtocolError as exc:
            ident = doc.get('id') if isinstance(doc, dict) else None
            stdout.write(P.encode(P.error_response(ident, exc.code,
                                                   exc.message)))
            stdout.flush()


def main(argv=None):
    argv = list(sys.argv if argv is None else argv)
    origin, ours = split_origin(argv)
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--state-dir', default=DEFAULT_STATE_DIR)
    ap.add_argument('--ledger-root', default=None,
                    help='AgentState root to sample terminal runs from; defaults '
                         'to the production ledger. For tests only: this lets the '
                         'end-to-end suite drive the real host against a temporary '
                         'ledger instead of the live one.')
    ap.add_argument('--manifest', default=None,
                    help='host manifest, for allowed_origins (required to serve)')
    ap.add_argument('--bridge-db', default=None,
                    help='Bridge service database the run-dispatch bindings live '
                         'in; defaults to the production one. T067: this is what '
                         'tells a Bridge-dispatched run (auto-notified) from one '
                         'started in DSH Desktop itself (opt-in per task). For '
                         'tests only, same reason as --ledger-root.')
    ap.add_argument('--bridge-db-fixture', default=None,
                    help='tests only: a JSON manifest standing in for the bridge '
                         'dispatch bindings ({"version":1,"bridge":"*"}), so an '
                         'end-to-end suite can exercise channel A or B without a '
                         'real bridge. Never passed by the production launcher.')
    ap.add_argument('--native-root', default=None,
                    help='DSH session-log root used to discover tasks a person '
                         'started directly in DSH Desktop; defaults to the '
                         'production ~/.dsh/sessions. For tests only, same reason '
                         'as --ledger-root.')
    ap.add_argument('--self-check', action='store_true',
                    help='verify framing and the simulated queue; no Chrome')
    ap.add_argument('--simulate', type=int, metavar='N',
                    help='enqueue N simulated events and exit')
    ap.add_argument('--dump', action='store_true',
                    help='with --simulate: print the enqueued events')
    args = ap.parse_args(ours[1:])

    if args.self_check:
        # Run the framing, extension-client, and live-launcher suites together so
        # a host or launcher change cannot silently bypass its protocol checks.
        import unittest
        loader = unittest.TestLoader()
        suite = unittest.TestSuite([
            loader.loadTestsFromName('test_t044_native_messaging'),
            loader.loadTestsFromName('test_t045_host_launcher'),
            loader.loadTestsFromName('test_t046_live_launcher'),
        ])
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        return 0 if result.wasSuccessful() else 1

    if args.simulate is not None:
        if args.simulate < 1 or args.simulate > 100:
            print('--simulate takes 1..100', file=sys.stderr)
            return 2
        doc = load_queue(args.state_dir)
        events = simulated_events(args.simulate, doc['next_seq'])
        added = append_events(args.state_dir, events)
        print('SIMULATED %d event(s) into %s (added %d)'
              % (args.simulate, os.path.abspath(args.state_dir), added))
        if args.dump:
            for event in events:
                print(json.dumps(event, ensure_ascii=False, sort_keys=True))
        return 0

    try:
        check_origin(origin, args.manifest)
    except HostError as exc:
        print('%s: %s' % (exc.code, exc.message), file=sys.stderr)
        return 3
    return serve(args.state_dir, args.manifest, sys.stdin.buffer,
                 sys.stdout.buffer, args.ledger_root, args.bridge_db,
                 args.bridge_db_fixture, args.native_root)


if __name__ == '__main__':
    raise SystemExit(main())
