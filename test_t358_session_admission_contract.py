"""The journal section of the admission contract must keep saying the things that were learned.

Two of these are easy to lose and expensive to rediscover: the payload is snapshotted before the
event is built (so a refusal really does leave the log untouched), and the driver's local
`driver-context` exemption does not survive at the journal. The rest pins the explicit permitted
list and the fact that the gate is still closed.

Source text only: no runtime module is imported, so this runs wherever the suites run.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
CONTRACT = ROOT / 'tools' / 'dsh-direct' / 'NATIVE_ADMISSION_CONTRACT.md'
OWNER = ROOT / 'tools' / 'dsh-direct' / 'productive_owner.mjs'


class JournalSection(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = CONTRACT.read_text(encoding='utf-8')

    def section(self, number):
        match = re.search(r'^## %d\. (.*?)$(.*?)(?=^## |\Z)' % number, self.text, re.S | re.M)
        self.assertIsNotNone(match, 'section %d is missing' % number)
        return match.group(2)

    def test_the_journal_is_named_as_the_shared_commit(self):
        body = self.section(6)
        self.assertIn('Session.append()', body)
        self.assertIn('every', body.lower())
        self.assertIn('ReactLoopInbox', body, 'the section must say what the inbox cannot cover')

    def test_the_three_journal_properties_are_stated(self):
        body = self.section(6)
        for phrase in ('snapshotted before the event is built', 'deep-frozen', 'survives into the log'):
            self.assertIn(phrase, body, 'journal property no longer stated: %s' % phrase)

    def test_the_permitted_list_stays_explicit(self):
        body = self.section(6)
        self.assertIn('any event type other than `agent/inbox/spliced`', body)
        self.assertIn('`inserted` list is empty', body)
        self.assertIn('cannot introduce content', body)

    def test_the_driver_context_conflict_is_recorded(self):
        body = self.section(6)
        self.assertIn('`driver-context`', body)
        self.assertIn('refused', body)
        self.assertIn('contract change', body)

    def test_uncovered_paths_are_still_listed(self):
        body = self.section(7)
        for item in ('raw `Session.append', 'durable replay', 'cancellation', 'ledger writer'):
            self.assertIn(item, body, 'uncovered path no longer listed: %s' % item)


class GateStillClosed(unittest.TestCase):
    def test_admission_gate_is_unchanged(self):
        owner = OWNER.read_text(encoding='utf-8')
        self.assertIn("code: 'writer_fencing_unavailable'", owner)
        self.assertIn('ok: false', owner)
        for item in ('all-ledger-writers-coordinated', 'atomic-session-admission-lease'):
            self.assertIn("'%s'" % item, owner)


if __name__ == '__main__':
    unittest.main()
