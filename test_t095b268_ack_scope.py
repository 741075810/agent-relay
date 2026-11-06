"""T268: an ACK must consume the fact the page actually saw, not the whole run.

The defect this pins, on the shipping chain (`host.py terminal-list` -> `terminal_source.sample` ->
`candidates_from` -> `acknowledge` -> `terminal-ack`):

1. a run becomes terminal as `failed` (the Bridge recorded `task.interrupted`), the host offers it, the
   extension stores it and acknowledges it -- a bare run id, which is what `background.js` sends;
2. `acknowledge()` moves that bare id into `ackedIds`, and `candidates_from` then excludes the id from
   every future candidate, whatever its status;
3. the same run later *completes* (an interruption followed by a resume that finished -- the shape T267
   made readable, and the reason the Bridge keeps both events);
4. the host resolves the status to `completed` ... and offers nothing, because the run id was already
   consumed. The page keeps the `failed` notice it was given, and the corrected fact is dropped in
   silence. Nobody can tell it happened: `ackedIds` looks exactly like a run that was reported once.

That is the invariant T268 states: an ACK consumes the offered fact, and a status transition must be
decided by the latest credible fact instead of being swallowed by an earlier one. The same run must not
be offered twice for *one* fact.

The fixture is the real production sequence -- a real arm snapshot, a real ledger file, a real SQLite
Bridge database with the live schema, and a temporary state directory. Nothing here reads a production
path, writes a notice, or invents a receipt.
"""

import json
import os
import sqlite3
import tempfile
import unittest

import terminal_source as T

RUN = 'cc33dd44-ee55-4f66-9a77-bb8899001122'
START_MS = 1793460000000
INTERRUPT_SECONDS = 1793463704.25
COMPLETE_SECONDS = 1793467300.75


class Bridged(unittest.TestCase):

    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t268-state-')
        self.root = tempfile.mkdtemp(prefix='t268-ledger-')
        self.native = tempfile.mkdtemp(prefix='t268-native-')
        self.db = os.path.join(tempfile.mkdtemp(prefix='t268-bridge-'), 'service.sqlite')
        sub = os.path.join(self.root, 'd' * 64)
        os.makedirs(sub)
        with open(os.path.join(sub, 'endpoint.json.runs.json'), 'w', encoding='utf-8') as handle:
            json.dump([{
                'requestID': RUN, 'createdAt': START_MS, 'status': 'running',
                'turn': 4, 'sessionID': 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            }], handle)
        self.write_bridge('interrupted', [('task.interrupted', INTERRUPT_SECONDS)])

    # ---------------------------------------------------------------- the sources

    def write_bridge(self, status, events):
        if os.path.exists(self.db):
            os.remove(self.db)
        conn = sqlite3.connect(self.db)
        conn.executescript(
            'create table bridge_service_tasks (task_id TEXT primary key, status TEXT, provider_run_id TEXT, '
            'failure_code TEXT, created_at REAL, updated_at REAL);'
            'create table bridge_service_task_events (event_id integer primary key autoincrement, task_id TEXT, '
            'kind TEXT, summary TEXT, details TEXT, created_at REAL);')
        conn.execute('insert into bridge_service_tasks (task_id, status, provider_run_id, failure_code, created_at, '
                     'updated_at) values (?,?,?,?,?,?)',
                     ('tsk-t268', status, RUN, None, START_MS / 1000.0, START_MS / 1000.0 + 60))
        for kind, at in events:
            conn.execute('insert into bridge_service_task_events (task_id, kind, summary, created_at) '
                         'values (?,?,?,?)', ('tsk-t268', kind, 'fixture', at))
        conn.commit()
        conn.close()

    def arm(self, epoch='e-t268'):
        report = T.arm_snapshot(self.state, self.root, epoch)
        self.assertTrue(report['ok'], report)
        self.assertEqual(report['count'], 0, 'the run is still running, so the snapshot cannot hold it')

    def sample(self):
        report = T.sample(self.state, root=self.root, bridge_db=self.db, native_root=self.native)
        self.assertTrue(report.get('ok'), report)
        return report['candidates'], T.load_state(self.state)

    def ack(self, ids):
        return T.acknowledge(self.state, list(ids))

    # ------------------------------------------------------------------ the tests

    def test_the_corrected_fact_is_offered_after_the_first_one_was_acknowledged(self):
        self.arm()
        first, _ = self.sample()
        self.assertEqual([(c['runId'], c['status']) for c in first], [(RUN, 'failed')])
        self.assertEqual(self.ack([RUN])['acked'], 1)

        # The same fact is never offered twice: this is the duplicate the ACK exists to stop.
        again, state = self.sample()
        self.assertEqual(again, [], 'a consumed fact must not be re-offered')
        self.assertIn(RUN, state['ackedIds'])

        # The run then really finished. The page has never seen this fact.
        self.write_bridge('completed', [('task.interrupted', INTERRUPT_SECONDS),
                                        ('task.completed', COMPLETE_SECONDS)])
        flipped, state = self.sample()
        self.assertEqual([(c['runId'], c['status']) for c in flipped], [(RUN, 'completed')],
                         'the completion of a run whose failure was announced must still be announceable')
        self.assertTrue(flipped[0].get('postArm'), 'it finished after the arm snapshot')

        # And once that one is consumed, nothing is left to say about this run.
        self.assertEqual(self.ack([RUN])['acked'], 1)
        self.assertEqual(self.sample()[0], [])

    def test_the_older_failure_is_not_relabelled_as_the_completion(self):
        self.arm()
        self.assertEqual([c['status'] for c in self.sample()[0]], ['failed'])
        self.ack([RUN])
        self.write_bridge('completed', [('task.interrupted', INTERRUPT_SECONDS),
                                        ('task.completed', COMPLETE_SECONDS)])
        flipped, _ = self.sample()
        # A completion is announced as a completion, once, and it is a distinct fact from the failure the
        # page already holds -- not the same entry with its status rewritten.
        self.assertEqual(len(flipped), 1)
        self.assertEqual(flipped[0]['status'], 'completed')
        self.assertEqual(self.ack([RUN])['acked'], 1)

    def test_an_identical_status_is_not_reannounced_after_a_second_ack(self):
        self.arm()
        self.sample()
        self.ack([RUN])
        self.assertEqual(self.sample()[0], [])
        self.assertEqual(self.sample()[0], [])

    def test_a_legacy_bare_ack_keeps_suppressing_every_status(self):
        # An upgrade must not re-announce history: a state file written before this change holds bare ids
        # with no record of which fact was consumed, so it keeps meaning "this run is done".
        self.arm()
        doc = T.load_state(self.state) or {}
        doc.update({'version': T.STATE_VERSION, 'baselineIds': [], 'pendingIds': [], 'ackedIds': [RUN],
                    'baselineDropped': 0, 'baselineCount': 0})
        T.save_state(self.state, doc)
        self.write_bridge('completed', [('task.completed', COMPLETE_SECONDS)])
        self.assertEqual(self.sample()[0], [], 'a bare historical ACK must not be re-opened by an upgrade')

    def test_an_ack_for_something_never_offered_still_does_nothing(self):
        self.arm()
        self.sample()
        self.assertEqual(self.ack(['11111111-2222-4333-8444-555555555555'])['acked'], 0)
        # The offered candidate is untouched by the ignored ACK.
        state = T.load_state(self.state)
        self.assertEqual(state['ackedIds'], [])
        self.assertIn(RUN, state['pendingIds'])

    def test_the_ack_does_not_leak_into_the_relay_journal(self):
        self.arm()
        self.sample()
        self.ack([RUN])
        state = T.load_state(self.state)
        self.assertEqual(state.get('relayAckedIds') or [], [],
                         'a native ACK must not be journalled as a relay ACK')


if __name__ == '__main__':
    unittest.main()
