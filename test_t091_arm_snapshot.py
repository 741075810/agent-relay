"""T091: the host-side arm snapshot, tested directly.

The end-to-end suite (test_t091_atomic_snapshot.mjs) proves the behaviour through the
real host and the real worker. This file is the same boundary at the unit level, where
the failure modes are cheap to enumerate: a partial snapshot, a corrupt one, an
unreadable ledger, a missing epoch. Every one of them must refuse rather than arm,
because an armed-but-partial snapshot is exactly the condition that would deliver
history as if it were new work.
"""
import json
import os
import shutil
import tempfile
import unittest

import terminal_source as T


def run(request_id, status='completed', created=1759000000000):
    return {'requestID': request_id, 'status': status, 'createdAt': created}


class ArmSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='t091-')
        self.state = os.path.join(self.dir, 'state')
        self.root = os.path.join(self.dir, 'agents')
        os.makedirs(self.state, exist_ok=True)
        self.ledger_dir = os.path.join(self.root, 'c' * 64)
        os.makedirs(self.ledger_dir, exist_ok=True)
        self.ledger = os.path.join(self.ledger_dir, 'endpoint.json.runs.json')
        # T067R: the sampler reads two sources now, and the second one defaults to
        # the operator's live ~/.dsh/sessions. This suite is about the arm boundary,
        # so the native reader is switched off rather than allowed to inject real
        # channel-B turns into a hermetic fixture.
        self._saved_native = T.native_turns.sample
        T.native_turns.sample = staticmethod(
            lambda *args, **kwargs: {'ok': False, 'code': 'native_disabled_in_test',
                                     'turns': [], 'files': 0, 'sessions': 0,
                                     'error': None})

    def tearDown(self):
        T.native_turns.sample = self._saved_native
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, runs):
        with open(self.ledger, 'w', encoding='utf-8') as handle:
            json.dump(runs, handle)

    def snapshot(self, epoch='epoch-1'):
        return T.arm_snapshot(self.state, self.root, epoch)

    # ---------------------------------------------------------------- the happy path
    def test_only_terminal_runs_are_recorded(self):
        self.write([run('a'), run('b', 'running'), run('c', 'failed')])
        report = self.snapshot()
        self.assertTrue(report['ok'])
        self.assertEqual(report['epoch'], 'epoch-1')
        self.assertEqual(report['count'], 2)
        self.assertFalse(report['truncated'])
        doc = T.load_arm(self.state)
        self.assertEqual(sorted(doc['ids']), ['a', 'c'])
        self.assertEqual(doc['version'], T.ARM_VERSION)
        self.assertIsInstance(doc['takenAt'], int)

    def test_the_snapshot_survives_a_reload(self):
        self.write([run('a')])
        self.snapshot('epoch-a')
        # A host restart re-reads the file; the epoch must still be there or every
        # later sample would look like a different round.
        again = T.load_arm(self.state)
        self.assertEqual(again['epoch'], 'epoch-a')

    def test_a_second_arm_replaces_the_first(self):
        self.write([run('a')])
        self.snapshot('epoch-a')
        self.write([run('a'), run('b')])
        report = self.snapshot('epoch-b')
        self.assertTrue(report['ok'])
        doc = T.load_arm(self.state)
        self.assertEqual(doc['epoch'], 'epoch-b')
        self.assertEqual(sorted(doc['ids']), ['a', 'b'])

    # ------------------------------------------------------------------- refusals
    def test_a_truncated_snapshot_is_refused_not_clipped(self):
        # One past the bound. A clipped snapshot would drop its oldest ids and every
        # dropped id would then read as new work -- the precise failure this exists
        # to prevent, so the whole arm is refused instead.
        self.write([run('r%05d' % i) for i in range(T.MAX_SNAPSHOT_IDS + 1)])
        report = self.snapshot()
        self.assertFalse(report['ok'])
        self.assertEqual(report['code'], 'snapshot_truncated')
        self.assertEqual(report['limit'], T.MAX_SNAPSHOT_IDS)
        self.assertIsNone(T.load_arm(self.state))

    def test_an_unreadable_ledger_refuses(self):
        self.write([{'status': 'completed'}])          # no requestID
        report = self.snapshot()
        self.assertFalse(report['ok'])
        self.assertEqual(report['code'], 'source_unavailable')
        self.assertIsNone(T.load_arm(self.state))

    def test_a_missing_ledger_refuses(self):
        if os.path.isfile(self.ledger):
            os.remove(self.ledger)
        report = self.snapshot()
        self.assertFalse(report['ok'])
        self.assertEqual(report['code'], 'source_unavailable')

    def test_a_missing_epoch_is_refused(self):
        self.write([run('a')])
        for bad in (None, '', 7, [], {}):
            report = T.arm_snapshot(self.state, self.root, bad)
            self.assertFalse(report['ok'], bad)
            self.assertEqual(report['code'], 'bad_epoch', bad)
        self.assertIsNone(T.load_arm(self.state))

    def test_an_overlong_epoch_is_refused(self):
        self.write([run('a')])
        report = T.arm_snapshot(self.state, self.root, 'x' * 129)
        self.assertFalse(report['ok'])
        self.assertEqual(report['code'], 'bad_epoch')

    # ------------------------------------------------------- a corrupt snapshot file
    def test_a_corrupt_snapshot_is_reported_not_ignored(self):
        self.write([run('a')])
        self.snapshot('epoch-a')
        with open(T._arm_path(self.state), 'w', encoding='utf-8') as handle:
            handle.write('{not json')
        with self.assertRaises(T.SourceError):
            T.load_arm(self.state)

    def test_a_snapshot_without_an_epoch_is_refused(self):
        with open(T._arm_path(self.state), 'w', encoding='utf-8') as handle:
            json.dump({'version': T.ARM_VERSION, 'ids': [], 'takenAt': 1,
                       'truncated': False}, handle)
        with self.assertRaises(T.SourceError):
            T.load_arm(self.state)

    def test_a_truncated_document_is_refused_on_load(self):
        with open(T._arm_path(self.state), 'w', encoding='utf-8') as handle:
            json.dump({'version': T.ARM_VERSION, 'epoch': 'e', 'ids': ['a'],
                       'takenAt': 1, 'truncated': True}, handle)
        with self.assertRaises(T.SourceError):
            T.load_arm(self.state)

    def test_a_wrong_version_is_refused(self):
        with open(T._arm_path(self.state), 'w', encoding='utf-8') as handle:
            json.dump({'version': T.ARM_VERSION + 1, 'epoch': 'e', 'ids': [],
                       'takenAt': 1, 'truncated': False}, handle)
        with self.assertRaises(T.SourceError):
            T.load_arm(self.state)

    # --------------------------------------------------- how a sample uses the snapshot
    def test_a_sample_marks_each_offer_against_the_snapshot(self):
        self.write([run('old')])
        self.snapshot('epoch-a')
        # Establish the sampler baseline on the same ledger, then add a new run.
        T.sample(self.state, self.root)
        self.write([run('old'), run('new', created=1759000600000)])
        report = T.sample(self.state, self.root)
        self.assertTrue(report['ok'])
        self.assertEqual(report['armEpoch'], 'epoch-a')
        marked = {c['runId']: c['postArm'] for c in report['candidates']}
        self.assertEqual(marked.get('new'), True)
        self.assertNotIn('old', marked)     # it was in the baseline, not offered

    def test_the_first_sample_does_not_swallow_post_arm_work(self):
        # A fresh install: the operator arms before any sample has established a
        # baseline, then something finishes before the first read. Without the
        # snapshot the first sample absorbs every terminal run as history and that
        # completion is lost forever. With it, the run is provably post-arm.
        self.write([run('history')])
        self.snapshot('epoch-a')
        self.write([run('history'), run('later', created=1759000600000)])
        report = T.sample(self.state, self.root)
        self.assertTrue(report['ok'])
        offered = [c['runId'] for c in report['candidates']]
        self.assertEqual(offered, ['later'])
        self.assertEqual(report['candidates'][0]['postArm'], True)
        state = T.load_state(self.state)
        self.assertEqual(state['baselineIds'], ['history'])
        self.assertEqual(state['pendingIds'], ['later'])

    def test_a_sample_without_a_snapshot_says_so(self):
        self.write([run('old')])
        report = T.sample(self.state, self.root)
        self.assertTrue(report['ok'])
        self.assertIsNone(report['armEpoch'])
        self.assertIsNone(report['armTakenAt'])
        self.assertIsNone(report['armCount'])

    def test_a_sample_with_a_corrupt_snapshot_refuses(self):
        self.write([run('old')])
        self.snapshot('epoch-a')
        with open(T._arm_path(self.state), 'w', encoding='utf-8') as handle:
            handle.write('{not json')
        report = T.sample(self.state, self.root)
        self.assertFalse(report['ok'])
        self.assertEqual(report['code'], 'arm_snapshot_unreadable')
        self.assertEqual(report['candidates'], [])


class ProtocolTests(unittest.TestCase):
    def test_the_new_op_is_declared(self):
        import protocol as P
        self.assertIn('terminal-arm-snapshot', P.OPS)
        # And it stays a read-only describe/record op: the deliver gate is untouched.
        self.assertNotIn('deliver', P.OPS)
        self.assertFalse(P.CAPABILITIES['deliver'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
