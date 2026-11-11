"""The internal-producer capability rules must stay written down where a build reads them.

The dangerous regressions are the two easy paraphrases: turning the capability into a payload field,
and letting a stale one keep working after a handover. Both read like simplifications in review, so
the wording is pinned here together with the grant's stated limit (in-process module trust).
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
CONTRACT = ROOT / 'tools' / 'dsh-direct' / 'NATIVE_ADMISSION_CONTRACT.md'
OWNER = ROOT / 'tools' / 'dsh-direct' / 'productive_owner.mjs'


class CapabilitySection(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = CONTRACT.read_text(encoding='utf-8')
        match = re.search(r'^## 6\. .*?$(.*?)(?=^## )', cls.text, re.S | re.M)
        assert match is not None, 'section 6 is missing'
        cls.body = match.group(1)

    def test_the_grant_is_named_and_registry_based(self):
        self.assertIn('grantInternalProducer(session, label, generation)', self.body)
        self.assertIn('module-private', self.body)
        self.assertIn('keyed by the object itself', self.body)

    def test_it_travels_out_of_band(self):
        self.assertIn('out of band', self.body)
        self.assertIn('`append(type, data, { internal })`', self.body)
        self.assertIn('never\n  snapshotted into the event', self.body.replace('\r\n', '\n'))

    def test_it_is_bound_to_session_and_generation(self):
        self.assertIn('one session', self.body)
        self.assertIn('`admission_required`', self.body)
        self.assertIn('one generation', self.body)
        self.assertIn('`admission_generation_stale`', self.body)
        self.assertIn('abandoned by the previous owner', self.body)

    def test_a_clone_is_not_the_capability(self):
        for phrase in ('`structuredClone`', 'JSON round-trip', 'spread'):
            self.assertIn(phrase, self.body, 'clone rule missing: %s' % phrase)

    def test_the_event_records_which_internal_producer_wrote(self):
        self.assertIn('internal: <label>', self.body)

    def test_the_limit_of_the_grant_is_stated(self):
        self.assertIn('code that already runs in the same process', self.body)
        self.assertIn('module-trust question', self.body)


class GateStillClosed(unittest.TestCase):
    def test_admission_gate_is_unchanged(self):
        owner = OWNER.read_text(encoding='utf-8')
        self.assertIn("code: 'writer_fencing_unavailable'", owner)
        self.assertIn('ok: false', owner)
        for item in ('all-ledger-writers-coordinated', 'atomic-session-admission-lease'):
            self.assertIn("'%s'" % item, owner)


if __name__ == '__main__':
    unittest.main()
