"""T044 offline tests: protocol, host, and the read-only claim.

What is actually verified here, and what is not.

Verified: the framing (including the truncation and oversize paths Chrome does
not report), request validation, the origin check Chrome's argv contract depends
on, queue durability and idempotency, cursor semantics, and -- through a real
subprocess speaking the real wire -- that a host started the way Chrome starts it
answers correctly.

Not verified: anything inside a browser. No Chrome is launched, no extension is
loaded, no registry key is written, no page is opened. The JavaScript is checked
by `node --check` for syntax and by targeted source assertions for the absence of
write APIs. Those are static checks and are labelled as such: they cannot prove
the extension behaves correctly at runtime, only that it contains no code that
could type into a conversation.

No notification is sent anywhere and no account is touched.

Run: python -B -m unittest test_t044_native_messaging -v
 or: python -B test_t044_native_messaging.py
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import host as H
import protocol as P

EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'
EXT_ORIGIN = 'chrome-extension://%s/' % EXT_ID
PYTHON = sys.executable


def frame(message):
    return P.encode(message)


def unframe(raw):
    """Decode every framed message in `raw`."""
    out = []
    stream = io.BytesIO(raw)
    while True:
        doc = P.read_message(stream)
        if doc is None:
            return out
        out.append(doc)


class TempState(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='t044-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state = os.path.join(self.tmp, 'state')

    def manifest(self, origins=(EXT_ORIGIN,)):
        path = os.path.join(self.tmp, 'host_manifest.json')
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump({'name': H.HOST_NAME, 'type': 'stdio',
                       'allowed_origins': list(origins)}, handle)
        return path


# -- framing -----------------------------------------------------------
class FramingTests(unittest.TestCase):
    def test_encode_prepends_a_little_endian_length(self):
        raw = P.encode({'a': 1})
        body = json.dumps({'a': 1}, ensure_ascii=True,
                          separators=(',', ':')).encode('utf-8')
        self.assertEqual(raw[:4], len(body).to_bytes(4, 'little'))
        self.assertEqual(raw[4:], body)

    def test_round_trip_through_a_stream(self):
        messages = [{'v': 1, 'id': 'a', 'op': 'hello'},
                    {'v': 1, 'id': 'b', 'op': 'status'},
                    {'v': 1, 'id': 'c', 'op': 'poll', 'args': {'limit': 3}}]
        stream = io.BytesIO(b''.join(frame(m) for m in messages))
        got = []
        while True:
            doc = P.read_message(stream)
            if doc is None:
                break
            got.append(doc)
        self.assertEqual(got, messages)

    def test_clean_eof_is_none_not_an_error(self):
        self.assertIsNone(P.read_message(io.BytesIO(b'')))

    def test_truncated_prefix_is_an_error(self):
        with self.assertRaises(P.ProtocolError) as ctx:
            P.read_message(io.BytesIO(b'\x10\x00'))
        self.assertEqual(ctx.exception.code, P.E_BAD_FRAME)

    def test_truncated_body_is_an_error(self):
        raw = frame({'v': 1, 'id': 'x', 'op': 'hello'})[:-5]
        with self.assertRaises(P.ProtocolError) as ctx:
            P.read_message(io.BytesIO(raw))
        self.assertEqual(ctx.exception.code, P.E_BAD_FRAME)

    def test_zero_length_is_refused(self):
        with self.assertRaises(P.ProtocolError) as ctx:
            P.decode_frame(b'\x00\x00\x00\x00')
        self.assertEqual(ctx.exception.code, P.E_BAD_FRAME)

    def test_a_huge_claimed_length_is_refused_before_allocating(self):
        # 0xFFFFFFFF is the largest a 4-byte prefix can express.
        with self.assertRaises(P.ProtocolError) as ctx:
            P.decode_frame((0xFFFFFFFF).to_bytes(4, 'little'))
        self.assertEqual(ctx.exception.code, P.E_TOO_LARGE)

    def test_non_utf8_body_is_reported_as_bad_json(self):
        body = b'\xff\xfe{}'
        raw = len(body).to_bytes(4, 'little') + body
        with self.assertRaises(P.ProtocolError) as ctx:
            P.read_message(io.BytesIO(raw))
        self.assertEqual(ctx.exception.code, P.E_BAD_JSON)

    def test_oversize_response_is_refused_instead_of_silently_dropped(self):
        """Chrome discards a >1MB host message without an error of its own."""
        big = {'v': 1, 'id': 'x', 'ok': True,
               'result': {'message': 'A' * (P.MAX_TO_HOST_BYTES + 10)}}
        with self.assertRaises(P.ProtocolError) as ctx:
            P.encode(big)
        self.assertEqual(ctx.exception.code, P.E_TOO_LARGE)

    def test_ascii_escaping_keeps_the_size_check_honest(self):
        """3-byte characters must be counted as bytes, not characters."""
        text = '\u4e2d' * (P.MAX_TO_HOST_BYTES // 3 + 10)
        with self.assertRaises(P.ProtocolError):
            P.encode({'v': 1, 'id': 'x', 'ok': True, 'result': {'m': text}})


# -- request validation ------------------------------------------------
class ValidationTests(unittest.TestCase):
    def test_a_good_request_passes(self):
        op, args = P.validate_request({'v': 1, 'id': 'r1', 'op': 'poll',
                                       'args': {'limit': 5}})
        self.assertEqual((op, args), ('poll', {'limit': 5}))

    def test_args_is_optional(self):
        op, args = P.validate_request({'v': 1, 'id': 'r1', 'op': 'hello'})
        self.assertEqual((op, args), ('hello', {}))

    def test_version_mismatch_is_named(self):
        with self.assertRaises(P.ProtocolError) as ctx:
            P.validate_request({'v': 99, 'id': 'r1', 'op': 'hello'})
        self.assertEqual(ctx.exception.code, P.E_VERSION_MISMATCH)

    def test_missing_id_is_refused(self):
        with self.assertRaises(P.ProtocolError) as ctx:
            P.validate_request({'v': 1, 'op': 'hello'})
        self.assertEqual(ctx.exception.code, P.E_BAD_REQUEST)

    def test_unknown_op_lists_what_is_supported(self):
        with self.assertRaises(P.ProtocolError) as ctx:
            P.validate_request({'v': 1, 'id': 'r1', 'op': 'deliver'})
        self.assertEqual(ctx.exception.code, P.E_UNKNOWN_OP)
        self.assertIn('hello', ctx.exception.message)

    def test_no_op_can_deliver(self):
        """The prototype must not expose a delivery op even by accident."""
        self.assertNotIn('deliver', P.OPS)
        self.assertNotIn('type', P.OPS)
        self.assertNotIn('click', P.OPS)
        self.assertFalse(P.CAPABILITIES['deliver'])

    def test_deliverable_true_is_refused(self):
        """An event that claims it may be delivered must not leave the host."""
        base = {'eventId': 'e1', 'name': 'task.completed', 'runId': 'r1',
                'message': 'm'}
        P.validate_event(dict(base, deliverable=False))
        for bad in (True, None):
            with self.assertRaises(P.ProtocolError) as ctx:
                P.validate_event(dict(base, deliverable=bad))
            self.assertEqual(ctx.exception.code, P.E_NOT_ALLOWED)

    def test_an_event_without_an_id_cannot_be_sent(self):
        with self.assertRaises(P.ProtocolError):
            P.validate_event({'name': 'x', 'runId': 'r', 'message': 'm',
                              'deliverable': False})


# -- origin check ------------------------------------------------------
class OriginTests(TempState):
    def test_missing_origin_is_refused(self):
        with self.assertRaises(H.HostError) as ctx:
            H.check_origin(None, self.manifest())
        self.assertEqual(ctx.exception.code, P.E_NOT_ALLOWED)

    def test_the_listed_origin_is_accepted(self):
        self.assertEqual(H.check_origin(EXT_ORIGIN, self.manifest()), EXT_ORIGIN)

    def test_an_unlisted_origin_is_refused(self):
        other = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/'
        with self.assertRaises(H.HostError) as ctx:
            H.check_origin(other, self.manifest())
        self.assertEqual(ctx.exception.code, P.E_NOT_ALLOWED)

    def test_a_manifest_without_origins_refuses_everyone(self):
        """An empty allow-list must fail closed, not open."""
        with self.assertRaises(H.HostError):
            H.check_origin(EXT_ORIGIN, self.manifest(origins=()))

    def test_a_missing_manifest_refuses_everyone(self):
        with self.assertRaises(H.HostError):
            H.check_origin(EXT_ORIGIN, os.path.join(self.tmp, 'nope.json'))

    def test_a_prefix_of_a_real_origin_is_not_accepted(self):
        """Guards against a startswith-style comparison."""
        with self.assertRaises(H.HostError):
            H.check_origin('chrome-extension://abcdefghijklmnop',
                           self.manifest())


class SplitOriginTests(unittest.TestCase):
    """Chrome's argv contract, which the first version of host.py broke.

    Chrome runs `host <origin>` and nothing else. Passing the whole argv to
    argparse made the host die with "unrecognized arguments:
    chrome-extension://..." -- it could not start under Chrome at all, while
    `python host.py --self-check` worked fine from a shell. These cases pin the
    split so that cannot regress.
    """

    def test_chromes_origin_is_taken_off_the_front(self):
        origin, ours = H.split_origin(['host.py', EXT_ORIGIN])
        self.assertEqual(origin, EXT_ORIGIN)
        self.assertEqual(ours, ['host.py'])

    def test_an_origin_appended_after_our_options_is_also_found(self):
        """The shape run_host.cmd actually produces: %* lands last."""
        origin, ours = H.split_origin(
            ['host.py', '--state-dir', 'D', '--manifest', 'M', EXT_ORIGIN])
        self.assertEqual(origin, EXT_ORIGIN)
        self.assertEqual(ours, ['host.py', '--state-dir', 'D',
                                '--manifest', 'M'])

    def test_options_after_the_origin_are_kept(self):
        origin, ours = H.split_origin(
            ['host.py', EXT_ORIGIN, '--state-dir', 'D'])
        self.assertEqual(origin, EXT_ORIGIN)
        self.assertEqual(ours, ['host.py', '--state-dir', 'D'])

    def test_a_standalone_run_has_no_origin(self):
        origin, ours = H.split_origin(['host.py', '--self-check'])
        self.assertIsNone(origin)
        self.assertEqual(ours, ['host.py', '--self-check'])

    def test_an_empty_argv_does_not_crash(self):
        origin, ours = H.split_origin(['host.py'])
        self.assertIsNone(origin)

    def test_chrome_parent_window_zero_is_consumed(self):
        origin, ours = H.split_origin(
            ['host.py', '--parent-window=0', EXT_ORIGIN])
        self.assertEqual(origin, EXT_ORIGIN)
        self.assertEqual(ours, ['host.py'])

    def test_chrome_parent_window_nonzero_is_consumed(self):
        origin, ours = H.split_origin(
            ['host.py', EXT_ORIGIN, '--parent-window=4294967295'])
        self.assertEqual(origin, EXT_ORIGIN)
        self.assertEqual(ours, ['host.py'])

    def test_malformed_parent_window_is_left_for_argparse_to_reject(self):
        for value in ('', '-1', '+1', ' 1', '1 ', '1.0', '0x10', '١',
                      '18446744073709551616', '9' * 5000):
            with self.subTest(value=value):
                _origin, ours = H.split_origin(
                    ['host.py', '--parent-window=' + value, EXT_ORIGIN])
                self.assertIn('--parent-window=' + value, ours)

    def test_duplicate_parent_window_is_left_for_argparse_to_reject(self):
        _origin, ours = H.split_origin(
            ['host.py', '--parent-window=0', '--parent-window=1', EXT_ORIGIN])
        self.assertEqual(ours, ['host.py', '--parent-window=1'])

    def test_unknown_option_is_not_consumed(self):
        _origin, ours = H.split_origin(
            ['host.py', '--parent-window=0', '--unsafe-option', EXT_ORIGIN])
        self.assertEqual(ours, ['host.py', '--unsafe-option'])


# -- queue behaviour ---------------------------------------------------
class QueueTests(TempState):
    def test_simulate_enqueues_and_poll_returns(self):
        H.append_events(self.state, H.simulated_events(2))
        events, cursor, more = H.pending_events(self.state, None, 10)
        self.assertEqual(len(events), 2)
        self.assertFalse(more)
        self.assertEqual(cursor, events[-1]['seq'])

    def test_events_are_marked_not_deliverable_end_to_end(self):
        H.append_events(self.state, H.simulated_events(1))
        events, _cursor, _more = H.pending_events(self.state, None, 10)
        self.assertIs(events[0]['deliverable'], False)

    def test_duplicate_event_ids_are_ignored(self):
        batch = H.simulated_events(2)
        self.assertEqual(H.append_events(self.state, batch), 2)
        self.assertEqual(H.append_events(self.state, batch), 0)
        persisted, _c, _m = H.pending_events(self.state, None, 10)
        self.assertEqual(len(persisted), 2)

    def test_ack_removes_the_event_and_is_idempotent(self):
        H.append_events(self.state, H.simulated_events(2))
        events, _c, _m = H.pending_events(self.state, None, 10)
        ids = [e['eventId'] for e in events]
        self.assertEqual(H.ack_events(self.state, ids), 2)
        self.assertEqual(H.ack_events(self.state, ids), 0)
        left, _c, _m = H.pending_events(self.state, None, 10)
        self.assertEqual(left, [])

    def test_ack_tombstone_payload_expires_after_retention(self):
        H.append_events(self.state, H.simulated_events(1))
        events, _cursor, _more = H.pending_events(self.state, None, 10)
        ident = events[0]['eventId']
        H.ack_events(self.state, [ident], consumer='profile-a')
        doc = H.load_queue(self.state)
        doc['acked_at'][ident] -= H.ACKED_RETENTION_S + 1
        H.save_queue(self.state, doc)
        H.pending_events(self.state, None, 10, consumer='profile-b')
        self.assertEqual(H.load_queue(self.state)['events'], [])

    def test_ack_from_one_consumer_does_not_hide_from_another(self):
        H.append_events(self.state, H.simulated_events(1))
        first, _cursor, _more = H.pending_events(
            self.state, None, 10, consumer='profile-a')
        ident = first[0]['eventId']
        H.ack_events(self.state, [ident], consumer='profile-a')
        self.assertEqual(H.pending_events(
            self.state, None, 10, consumer='profile-a')[0], [])
        second, _cursor, _more = H.pending_events(
            self.state, None, 10, consumer='profile-b')
        self.assertEqual([event['eventId'] for event in second], [ident])

    def test_foreign_ack_does_not_advance_this_consumers_cursor(self):
        H.append_events(self.state, H.simulated_events(1))
        first, cursor, _more = H.pending_events(
            self.state, None, 10, consumer='profile-a')
        ident = first[0]['eventId']
        H.ack_events(self.state, [ident], consumer='profile-a')
        second, second_cursor, _more = H.pending_events(
            self.state, None, 10, consumer='profile-b')
        self.assertEqual([event['eventId'] for event in second], [ident])
        self.assertEqual(second_cursor, cursor)

    def test_an_acked_id_is_not_re_enqueued(self):
        H.append_events(self.state, H.simulated_events(1))
        events, _c, _m = H.pending_events(self.state, None, 10)
        H.ack_events(self.state, [events[0]['eventId']])
        # Replaying the same event id must not resurrect it.
        self.assertEqual(H.append_events(self.state, events), 0)
        self.assertEqual(H.pending_events(self.state, None, 10)[0], [])

    def test_the_cursor_does_not_repeat_unexpired_seen_events(self):
        H.append_events(self.state, H.simulated_events(3))
        first, cursor, _more = H.pending_events(self.state, None, 2)
        self.assertEqual(len(first), 2)
        second, _cursor2, _more2 = H.pending_events(self.state, cursor, 10)
        self.assertEqual(len(second), 1)
        self.assertNotIn(second[0]['eventId'],
                         [e['eventId'] for e in first])

    def test_an_unacked_event_redelivers_after_cursor_has_advanced(self):
        H.append_events(self.state, H.simulated_events(2))
        first, cursor, _more = H.pending_events(self.state, None, 1)
        self.assertEqual(cursor, first[0]['seq'])
        doc = H.load_queue(self.state)
        doc['events'][0]['deliveredAt'] -= H.REDELIVER_AFTER_S
        doc['events'][0].setdefault('consumerDeliveredAt', {})['test-consumer'] = (
            doc['events'][0]['deliveredAt'])
        H.save_queue(self.state, doc)
        retried, retry_cursor, _more = H.pending_events(
            self.state, cursor, 10, consumer='test-consumer')
        self.assertIn(first[0]['eventId'], [e['eventId'] for e in retried])
        self.assertEqual(retry_cursor, cursor + 1)
        rows = {event['eventId']: event for event in H.load_queue(self.state)['events']}
        self.assertEqual(rows[first[0]['eventId']]['deliveries'], 2)

    def test_acknowledged_event_is_not_redelivered_after_cursor_advance(self):
        H.append_events(self.state, H.simulated_events(1))
        first, cursor, _more = H.pending_events(self.state, None, 10)
        H.ack_events(self.state, [first[0]['eventId']])
        again, _cursor, _more = H.pending_events(self.state, cursor, 10)
        self.assertEqual(again, [])

    def test_two_consumers_ack_independently(self):
        H.append_events(self.state, H.simulated_events(1))
        first, cursor, _more = H.pending_events(
            self.state, None, 10, consumer='profile-a')
        ident = first[0]['eventId']
        H.ack_events(self.state, [ident], consumer='profile-a')
        self.assertEqual(len(H.load_queue(self.state)['events']), 1)
        second, _cursor, _more = H.pending_events(
            self.state, None, 10, consumer='profile-b')
        self.assertEqual([e['eventId'] for e in second], [ident])
        H.ack_events(self.state, [ident], consumer='profile-b')
        retained = H.load_queue(self.state)['events']
        self.assertEqual([event['eventId'] for event in retained], [ident])
        replay, _cursor, _more = H.pending_events(
            self.state, cursor, 10, consumer='profile-a')
        self.assertEqual(replay, [])
        replay_b, _cursor, _more = H.pending_events(
            self.state, cursor, 10, consumer='profile-b')
        self.assertEqual(replay_b, [])

    def test_consumer_id_is_strictly_validated(self):
        H.append_events(self.state, H.simulated_events(1))
        for bad in ('', 'space id', '\\u0661', 'x' * 81):
            with self.subTest(consumer=bad):
                with self.assertRaises(H.HostError):
                    H.pending_events(self.state, consumer=bad)

    def test_legacy_global_ack_still_works(self):
        H.append_events(self.state, H.simulated_events(1))
        first, _cursor, _more = H.pending_events(self.state, None, 10)
        H.ack_events(self.state, [first[0]['eventId']])
        self.assertEqual(H.pending_events(self.state, None, 10)[0], [])

    def test_more_is_reported_when_the_page_is_full(self):
        H.append_events(self.state, H.simulated_events(5))
        _events, _cursor, more = H.pending_events(self.state, None, 2)
        self.assertTrue(more)

    def test_an_unacked_event_is_counted_as_delivered_at_least_once(self):
        H.append_events(self.state, H.simulated_events(1))
        H.pending_events(self.state, None, 10)
        doc = H.load_queue(self.state)
        self.assertEqual(doc['events'][0]['deliveries'], 1)
        self.assertIsNotNone(doc['events'][0]['deliveredAt'])

    def test_a_corrupt_queue_is_an_error_not_an_empty_queue(self):
        os.makedirs(self.state, exist_ok=True)
        with open(os.path.join(self.state, H.QUEUE_FILE), 'w',
                  encoding='utf-8') as handle:
            handle.write('{ this is not json')
        with self.assertRaises(H.HostError):
            H.load_queue(self.state)

    def test_a_foreign_queue_file_is_refused(self):
        os.makedirs(self.state, exist_ok=True)
        with open(os.path.join(self.state, H.QUEUE_FILE), 'w',
                  encoding='utf-8') as handle:
            json.dump({'version': 99, 'events': []}, handle)
        with self.assertRaises(H.HostError):
            H.load_queue(self.state)

    def test_the_lock_is_released_after_a_write(self):
        H.append_events(self.state, H.simulated_events(1))
        self.assertFalse(os.path.exists(
            os.path.join(self.state, H.LOCK_FILE)),
            'the lock file was left behind, which would block the next run')


# -- request handling --------------------------------------------------
class HandlerTests(TempState):
    def call(self, message):
        return H.handle_request(self.state, message)

    def test_hello_reports_the_absence_of_delivery(self):
        reply = self.call({'v': 1, 'id': 'h', 'op': 'hello'})
        self.assertTrue(reply['ok'])
        self.assertIs(reply['result']['deliver'], False)
        self.assertIs(reply['result']['capabilities']['deliver'], False)
        self.assertIs(reply['result']['capabilities']['detect'], True)

    def test_the_response_echoes_the_request_id(self):
        reply = self.call({'v': 1, 'id': 'abc-1', 'op': 'hello'})
        self.assertEqual(reply['id'], 'abc-1')

    def test_an_unknown_op_is_an_error_response_not_a_crash(self):
        reply = self.call({'v': 1, 'id': 'u', 'op': 'deliver'})
        self.assertFalse(reply['ok'])
        self.assertEqual(reply['error']['code'], P.E_UNKNOWN_OP)

    def test_a_bad_request_still_answers(self):
        reply = self.call({'v': 1, 'op': 'hello'})
        self.assertFalse(reply['ok'])
        self.assertEqual(reply['error']['code'], P.E_BAD_REQUEST)

    def test_simulate_then_poll_returns_the_events(self):
        self.call({'v': 1, 'id': 's', 'op': 'simulate', 'args': {'count': 2}})
        reply = self.call({'v': 1, 'id': 'p', 'op': 'poll',
                           'args': {'limit': 10}})
        self.assertTrue(reply['ok'])
        self.assertEqual(len(reply['result']['events']), 2)
        self.assertTrue(reply['result']['events'][0]['replay'])
        self.assertIs(reply['result']['deliver'], False)

    def test_poll_limit_is_clamped(self):
        self.call({'v': 1, 'id': 's', 'op': 'simulate', 'args': {'count': 60}})
        reply = self.call({'v': 1, 'id': 'p', 'op': 'poll',
                           'args': {'limit': 9999}})
        self.assertLessEqual(len(reply['result']['events']), H.MAX_POLL_LIMIT)

    def test_a_bad_limit_is_refused(self):
        for bad in (0, -1, 'x', 1.5):
            reply = self.call({'v': 1, 'id': 'p', 'op': 'poll',
                               'args': {'limit': bad}})
            self.assertFalse(reply['ok'], 'limit %r was accepted' % (bad,))

    def test_simulate_count_is_bounded(self):
        reply = self.call({'v': 1, 'id': 's', 'op': 'simulate',
                           'args': {'count': 1000}})
        self.assertFalse(reply['ok'])

    def test_status_reports_queue_depth(self):
        self.call({'v': 1, 'id': 's', 'op': 'simulate', 'args': {'count': 3}})
        reply = self.call({'v': 1, 'id': 't', 'op': 'status'})
        self.assertTrue(reply['ok'])
        self.assertEqual(reply['result']['queued'], 3)
        self.assertIs(reply['result']['deliver'], False)


# -- the real wire, through a real subprocess --------------------------
class ServeTests(TempState):
    def serve(self, messages, origins=(EXT_ORIGIN,)):
        """Run host.py exactly as Chrome would, and decode what it writes."""
        manifest = self.manifest(origins=origins)
        payload = b''.join(frame(m) for m in messages)
        proc = subprocess.run(
            [PYTHON, '-B', os.path.join(HERE, 'host.py'),
             '--state-dir', self.state, '--manifest', manifest, EXT_ORIGIN],
            input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=HERE, timeout=60)
        return proc, unframe(proc.stdout)

    def test_a_real_host_process_answers_hello(self):
        proc, replies = self.serve([{'v': 1, 'id': 'w1', 'op': 'hello'}])
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', 'replace'))
        self.assertEqual(len(replies), 1)
        self.assertTrue(replies[0]['ok'])
        self.assertEqual(replies[0]['id'], 'w1')
        self.assertIs(replies[0]['result']['deliver'], False)

    def test_the_whole_simulate_poll_ack_cycle_over_the_wire(self):
        proc, replies = self.serve([
            {'v': 1, 'id': '1', 'op': 'simulate', 'args': {'count': 2}},
            {'v': 1, 'id': '2', 'op': 'poll', 'args': {'limit': 10}},
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', 'replace'))
        events = replies[1]['result']['events']
        self.assertEqual(len(events), 2)
        ids = [e['eventId'] for e in events]

        _proc2, replies2 = self.serve([
            {'v': 1, 'id': '3', 'op': 'ack', 'args': {'acked': ids}},
            {'v': 1, 'id': '4', 'op': 'poll', 'args': {'limit': 10}},
        ])
        self.assertEqual(replies2[1]['result']['events'], [],
                         'acked events came back on a later poll')

    def test_state_survives_a_host_restart(self):
        """Chrome kills the host freely; the queue must outlive it."""
        self.serve([{'v': 1, 'id': '1', 'op': 'simulate',
                     'args': {'count': 1}}])
        _proc, replies = self.serve([{'v': 1, 'id': '2', 'op': 'poll',
                                      'args': {'limit': 10}}])
        self.assertEqual(len(replies[0]['result']['events']), 1)

    def test_parent_window_and_listed_origin_answer_hello(self):
        manifest = self.manifest()
        proc = subprocess.run(
            [PYTHON, '-B', os.path.join(HERE, 'host.py'),
             '--state-dir', self.state, '--manifest', manifest,
             EXT_ORIGIN, '--parent-window=0'],
            input=frame({'v': 1, 'id': 'pw0', 'op': 'hello'}),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=HERE, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', 'replace'))
        replies = unframe(proc.stdout)
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0].get('id'), 'pw0')
        self.assertTrue(replies[0].get('ok'))

    def test_parent_window_preserves_origin_allowlist(self):
        proc = subprocess.run(
            [PYTHON, '-B', os.path.join(HERE, 'host.py'),
             '--state-dir', self.state, '--manifest', self.manifest(),
             'chrome-extension://not-allowed/', '--parent-window=0'],
            input=b'', stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=HERE, timeout=30)
        self.assertEqual(proc.returncode, 3)
        self.assertEqual(proc.stdout, b'')
        self.assertIn(b'not_allowed', proc.stderr)

    def test_unknown_option_is_rejected_before_host_starts(self):
        proc = subprocess.run(
            [PYTHON, '-B', os.path.join(HERE, 'host.py'),
             '--state-dir', self.state, '--manifest', self.manifest(),
             EXT_ORIGIN, '--unsafe-option'],
            input=b'', stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=HERE, timeout=30)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, b'')
        self.assertIn(b'unrecognized arguments', proc.stderr)

    def test_a_wrong_origin_makes_the_host_refuse_to_start(self):
        proc = subprocess.run(
            [PYTHON, '-B', os.path.join(HERE, 'host.py'),
             '--state-dir', self.state, '--manifest', self.manifest(),
             'chrome-extension://someoneelse/'],
            input=b'', stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=HERE, timeout=60)
        self.assertEqual(proc.returncode, 3)
        self.assertEqual(proc.stdout, b'',
                         'a refused host must write nothing on the wire')
        self.assertIn(b'not_allowed', proc.stderr)

    def test_no_origin_argument_at_all_is_refused(self):
        proc = subprocess.run(
            [PYTHON, '-B', os.path.join(HERE, 'host.py'),
             '--state-dir', self.state, '--manifest', self.manifest()],
            input=b'', stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=HERE, timeout=60)
        self.assertEqual(proc.returncode, 3)

    def test_a_framing_error_is_reported_then_the_host_stops(self):
        manifest = self.manifest()
        proc = subprocess.run(
            [PYTHON, '-B', os.path.join(HERE, 'host.py'),
             '--state-dir', self.state, '--manifest', manifest, EXT_ORIGIN],
            input=b'\x00\x00\x00\x00', stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, cwd=HERE, timeout=60)
        replies = unframe(proc.stdout)
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]['error']['code'], P.E_BAD_FRAME)

    def test_nothing_is_written_that_is_not_a_framed_message(self):
        """stdout is the wire; a stray print would corrupt the stream."""
        _proc, replies = self.serve([
            {'v': 1, 'id': '1', 'op': 'hello'},
            {'v': 1, 'id': '2', 'op': 'status'},
            {'v': 1, 'id': '3', 'op': 'poll'},
        ])
        self.assertEqual([r['id'] for r in replies], ['1', '2', '3'])


# -- the extension, statically ----------------------------------------
class ExtensionSourceTests(unittest.TestCase):
    EXT = os.path.join(HERE, 'extension')

    def read(self, name):
        with open(os.path.join(self.EXT, name), encoding='utf-8') as handle:
            return handle.read()

    @staticmethod
    def strip_comments(source):
        """Remove `//` and `/* */` comments so prose cannot trip a code check.

        The first version of these checks searched the raw file and failed on
        `content.js` because its own header says "does not call form.submit()".
        A check that a comment can satisfy or break proves nothing about the
        code, so the code is what gets searched.
        """
        out = []
        i = 0
        in_line = False
        in_block = False
        quote = None
        while i < len(source):
            two = source[i:i + 2]
            ch = source[i]
            if in_line:
                if ch == '\n':
                    in_line = False
                    out.append(ch)
                i += 1
                continue
            if in_block:
                if two == '*/':
                    in_block = False
                    i += 2
                    continue
                i += 1
                continue
            if quote:
                out.append(ch)
                if ch == '\\':
                    out.append(source[i + 1:i + 2])
                    i += 2
                    continue
                if ch == quote:
                    quote = None
                i += 1
                continue
            if two == '//':
                in_line = True
                i += 2
                continue
            if two == '/*':
                in_block = True
                i += 2
                continue
            if ch in ('"', "'", '`'):
                quote = ch
            out.append(ch)
            i += 1
        return ''.join(out)

    def test_the_manifest_is_mv3_and_requests_only_what_is_used(self):
        doc = json.loads(self.read('manifest.json'))
        self.assertEqual(doc['manifest_version'], 3)
        # T095B76 added `scripting`, and nothing else, so a content script destroyed
        # by an extension reload can be re-injected into the tab the operator already
        # bound. The old assertion forbade it outright; the new one pins the boundary
        # that replaced it -- scripting yes, anything wider no.
        self.assertEqual(sorted(doc['permissions']),
                         ['alarms', 'nativeMessaging', 'scripting', 'storage', 'tabs'])
        for wider in ('webNavigation', 'debugger', '<all_urls>'):
            self.assertNotIn(wider, doc['permissions'],
                             '%s is broader than the reconnect needs' % wider)

    def test_the_content_script_cannot_write_into_the_page(self):
        """The read-only promise, checked against code rather than prose."""
        source = self.strip_comments(self.read('content.js'))
        forbidden = [
            'execCommand', 'insertText', 'insertHTML',
            'value =', '.value=', 'dispatchEvent', 'KeyboardEvent',
            'InputEvent', 'clipboardData', 'submit()', '.click()',
            'setAttribute', 'appendChild', 'innerHTML =',
        ]
        hits = [token for token in forbidden if token in source]
        self.assertEqual(hits, [],
                         'content.js contains write paths: %r' % (hits,))

    def test_the_comment_stripper_actually_removes_comments(self):
        """A meta-check: if it did nothing, the test above would be vacuous."""
        sample = '// form.submit()\n/* .click() */\nconst ok = 1;\n'
        stripped = self.strip_comments(sample)
        self.assertNotIn('submit()', stripped)
        self.assertNotIn('.click()', stripped)
        self.assertIn('const ok = 1;', stripped)

    def test_the_content_script_does_not_read_message_text(self):
        source = self.strip_comments(self.read('content.js'))
        for token in ('innerText', 'textContent', 'nodeValue'):
            self.assertNotIn(token, source,
                             'content.js reads page text via %r' % token)
        self.assertIn('OWN_MESSAGE_SELECTOR).length', source,
                      'the own-message signal should be a count, not text')

    def test_queue_delivery_persists_before_ack_and_commits_after_ack(self):
        source = self.read(os.path.join('lib', 'queue_delivery.js'))
        persist = source.index('const saved = await this.storeEvents(result.events);')
        ack = source.index("await this.request('ack'", persist)
        cursor = source.index('await this.set({', ack)
        self.assertLess(persist, ack)
        self.assertLess(ack, cursor)
        self.assertIn("consumer: consumerId", source[ack:cursor])
        self.assertIn('result.more', source)
        self.assertIn('this._scheduleRetry()', source)

    def test_retry_uses_alarms_and_does_not_use_worker_timeouts(self):
        source = self.read('background.js')
        self.assertIn("chrome.alarms.create(RETRY_ALARM", source)
        self.assertIn('queueDelivery.retryFromAlarm()', source)
        delivery = self.read(os.path.join('lib', 'queue_delivery.js'))
        self.assertNotIn('setTimeout(', delivery)

    def test_the_background_never_calls_a_page_write_api(self):
        source = self.strip_comments(self.read('background.js'))
        for token in ('executeScript', 'insertCSS', 'tabs.update',
                      'tabs.reload', 'tabs.create', 'window.open',
                      'chrome.windows.update'):
            self.assertNotIn(token, source,
                             'background.js uses %r' % token)
        # T095B76: the background now hands `chrome.scripting` to the reconnect module
        # -- it never calls it. One mention, as a property passed in, is the whole
        # allowance; a second one would mean a call site grew here.
        self.assertEqual(source.count('chrome.scripting'), 1,
                         'background.js may only pass chrome.scripting along, once '
                         '(%d mentions)' % source.count('chrome.scripting'))
        self.assertIn('scripting: chrome.scripting', source)
        # And the one injection site can only re-run a file that ships with the
        # extension. `func:` would let it run arbitrary code, and `world: 'MAIN'`
        # would put it where the page's own JavaScript can reach it.
        reconnect = self.strip_comments(
            self.read(os.path.join('lib', 'content_reconnect.js')))
        self.assertIn("files: [options.file || 'content.js']", reconnect)
        for token in ('func:', 'args:', "'MAIN'", '"MAIN"', 'world'):
            self.assertNotIn(token, reconnect,
                             'content_reconnect.js uses %r' % token)
        self.assertNotIn('insertCSS', reconnect)

    def test_manual_probe_is_read_only_and_not_automatic(self):
        source = self.strip_comments(self.read('background.js'))
        self.assertIn("msg.type === 'readonly-dry-run'", source)
        self.assertIn('runReadonlyProbe(chrome)', source)
        alarm_source = source[source.index('chrome.alarms.onAlarm'):source.index(
            'chrome.runtime.onMessage.addListener')]
        self.assertNotIn('probeChatGPTTabs()', alarm_source)
        probe = self.read(os.path.join('lib', 'readonly_preflight.js'))
        self.assertIn('api.tabs.sendMessage', probe)
        self.assertIn('api.tabs.get', probe)

    def test_content_probe_does_not_read_message_text_or_write(self):
        source = self.strip_comments(self.read('content.js'))
        for token in ('innerText', 'textContent', 'nodeValue', '.click(',
                      'dispatchEvent(', 'execCommand(', '.value =',
                      'innerHTML ='):
            self.assertNotIn(token, source,
                             'content.js uses %r' % token)
        self.assertIn("msg.type === 'readonly-probe'", source)
        self.assertIn('routeStable', source)

    def test_readonly_preflight_never_authorizes_sending(self):
        source = self.read(os.path.join('lib', 'readonly_preflight.js'))
        self.assertIn('sendEligible: false', source)
        self.assertIn("accountIdentity: 'unavailable'", source)
        self.assertIn("deliveryReceipt: 'unsupported'", source)
        for token in ('chrome.', 'innerText', 'textContent', '.click(',
                      'dispatchEvent('):
            self.assertNotIn(token, source)

    def test_t053_binding_is_manual_session_scoped_and_read_only(self):
        background = self.strip_comments(self.read('background.js'))
        binding = self.read(os.path.join('lib', 'target_binding.js'))
        controller = self.read(os.path.join('lib', 'target_binding_controller.js'))
        content = self.strip_comments(self.read('content.js'))
        popup = self.read('popup.js')
        manifest = json.loads(self.read('manifest.json'))
        for message in ('t053-binding-state', 't053-binding-scan',
                        't053-binding-confirm', 't053-binding-health',
                        't053-binding-clear'):
            self.assertIn(message, background)
        self.assertIn("sender.url !== chrome.runtime.getURL('popup.html')", background)
        self.assertIn('chrome.storage.session', background)
        self.assertNotIn('storage.local', controller)
        self.assertIn('documentInstanceId', content)
        probe = content[content.index('function readonlyProbe'):content.index(
            'chrome.runtime.onMessage.addListener')]
        for token in ('innerText', 'textContent', 'countOwnMessages',
                      'document.body', 'document.documentElement'):
            self.assertNotIn(token, probe)
        self.assertIn('sendEligible: false', binding)
        self.assertIn("accountIdentity: 'unverified'", binding)
        self.assertNotIn('send_gate', controller)
        self.assertNotIn('window.prompt', popup)
        self.assertEqual(sorted(manifest['permissions']),
                         ['alarms', 'nativeMessaging', 'scripting', 'storage', 'tabs'])
        # T095B76: `executeScript` is allowed in one module and nowhere else, and
        # navigation stays forbidden everywhere.
        self.assertIn('scripting.executeScript',
                      self.read(os.path.join('lib', 'content_reconnect.js')))
        for token in ('chrome.tabs.update', 'executeScript',
                      'webNavigation', 'send_gate'):
            self.assertNotIn(token, background)

    def test_extension_queue_enforces_deliverable_false(self):
        source = self.strip_comments(
            self.read(os.path.join('lib', 'queue_delivery.js')))
        self.assertIn('event.deliverable !== false', source,
                      'the extension queue must refuse events not marked '
                      'non-deliverable')

    def test_t054_dry_run_is_read_only_and_not_a_send_path(self):
        background = self.strip_comments(self.read('background.js'))
        controller = self.read(
            os.path.join('lib', 'bound_dry_run_controller.js'))
        policy = self.read(os.path.join('lib', 'bound_dry_run.js'))
        popup = self.read('popup.js')
        popup_html = self.read('popup.html')
        manifest = json.loads(self.read('manifest.json'))
        self.assertIn('t054-dry-run', background)
        self.assertIn('t054-state', background)
        self.assertIn("sender.url !== chrome.runtime.getURL('popup.html')",
                      background)
        # The boundary must refuse unknown fields explicitly instead of quietly
        # stripping them, otherwise free text could look "accepted".
        self.assertIn('event_fields_not_allowed', background)
        self.assertIn("new Set(['type', 'runId', 'status', 'proposalId'])",
                      background)
        for source, name in ((controller, 'controller'), (policy, 'policy')):
            for token in ('chrome.', 'send_gate', 'executeScript',
                          'innerText', 'sendMessage', 'storage.local',
                          'nativeMessaging'):
                self.assertNotIn(token, source,
                                 '%s references %r' % (name, token))
        self.assertIn('reviewAllowed', policy)
        self.assertIn('sendEligible: false', policy)
        self.assertIn('pageWriteEligible: false', policy)
        self.assertIn('wouldSend: false', policy)
        self.assertIn('deliveryReceipt: \'unsupported\'', policy)
        self.assertEqual(sorted(manifest['permissions']),
                         ['alarms', 'nativeMessaging', 'scripting', 'storage', 'tabs'])
        self.assertNotIn('id="send', popup_html.lower())
        self.assertIn('dryRunEvaluate', popup_html)
        self.assertIn('t054-dry-run', popup)
        self.assertNotIn('window.prompt', popup)

    def test_the_popup_has_no_control_that_sends(self):
        """Look for a send *control*, not for the word in a warning label.

        The popup says "仅展示，不发送" on purpose, so a substring search for
        发送 is meaningless; an id or a button whose label is a verb is not.
        """
        html = self.read('popup.html')
        lowered = html.lower()
        self.assertNotIn('id="send', lowered)
        for marker in ('<button', '<input'):
            start = 0
            while True:
                at = lowered.find(marker, start)
                if at < 0:
                    break
                end = lowered.find('>', at)
                element = lowered[at:end]
                self.assertNotIn('send', element,
                                 'a form control mentions send: %r' % element)
                self.assertNotIn('提交', element)
                self.assertNotIn('发送', html[at:end])
                start = end + 1

    def test_the_extension_declares_no_unused_host_permission(self):
        doc = json.loads(self.read('manifest.json'))
        hosts = doc.get('host_permissions') or []
        self.assertTrue(hosts)
        for entry in hosts:
            self.assertTrue(entry.startswith('https://chatgpt.com/')
                            or entry.startswith('https://chat.openai.com/'),
                            'unexpected host permission %r' % entry)


# -- JavaScript syntax -------------------------------------------------
class JavaScriptSyntaxTests(unittest.TestCase):
    def test_every_extension_script_parses(self):
        if shutil.which('node') is None:
            self.skipTest('node not available')
        ext = os.path.join(HERE, 'extension')
        names = ['background.js', 'content.js', 'popup.js',
                 os.path.join('lib', 'native_client.js'),
                 os.path.join('lib', 'queue_delivery.js'),
                 os.path.join('lib', 'readonly_preflight.js'),
                  os.path.join('lib', 'target_binding.js'),
                  os.path.join('lib', 'target_binding_controller.js'),
                 os.path.join('lib', 'bound_dry_run.js'),
                 os.path.join('lib', 'bound_dry_run_controller.js')]
        for name in names:
            proc = subprocess.run(['node', '--check', os.path.join(ext, name)],
                                  capture_output=True, text=True, timeout=120)
            self.assertEqual(proc.returncode, 0,
                             '%s failed node --check:\n%s'
                             % (name, proc.stderr))

    def test_the_manifest_is_valid_json(self):
        with open(os.path.join(HERE, 'extension', 'manifest.json'),
                  encoding='utf-8') as handle:
            json.load(handle)


if __name__ == '__main__':
    unittest.main(verbosity=2)
