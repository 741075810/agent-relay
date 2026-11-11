"""The native admission contract must not drift from the source that enforces it.

Two directions are checked, and both are things a careless edit gets wrong silently:

* the contract document names every refusal code the boundary raises, and claims nothing the
  repository does not have;
* the gate in `tools/dsh-direct/productive_owner.mjs` is still closed, still reports the same
  two missing items the document explains, and `DISPATCH_GATE` still agrees with it.

No runtime is imported and no session is touched: this reads source text only, so it runs
anywhere the suites run.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
OWNER = ROOT / 'tools' / 'dsh-direct' / 'productive_owner.mjs'
RESUME = ROOT / 'tools' / 'dsh-direct' / 'productive_resume.mjs'
CONTRACT = ROOT / 'tools' / 'dsh-direct' / 'NATIVE_ADMISSION_CONTRACT.md'

GATE = 'writer_fencing_unavailable'
MISSING = ('all-ledger-writers-coordinated', 'atomic-session-admission-lease')
CODES = (
    'admission_required',
    'admission_unknown_session',
    'admission_session_mismatch',
    'admission_owner_mismatch',
    'admission_generation_stale',
    'admission_released',
    'admission_epoch_unknown',
)
BOUNDARY_CODES = ('session/admission-required', 'session/admission-refused',
                  'session/admission-mismatch', 'session/request-id-conflict')
UNCOVERED = ('raw `Session.append', 'durable replay', 'cancellation', 'ledger writer')


class ContractDocument(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = CONTRACT.read_text(encoding='utf-8')

    def test_document_opens_as_a_contract_not_a_claim(self):
        self.assertTrue(CONTRACT.is_file())
        self.assertTrue(self.text.startswith('# Native admission contract'))
        self.assertIn('contract, not a claim', self.text)

    def test_every_boundary_refusal_code_is_documented(self):
        missing = [code for code in CODES if code not in self.text]
        self.assertEqual(missing, [], 'undocumented refusal codes: %s' % missing)

    def test_controller_level_codes_are_documented(self):
        missing = [code for code in BOUNDARY_CODES if code not in self.text]
        self.assertEqual(missing, [], 'undocumented controller codes: %s' % missing)

    def test_the_document_does_not_claim_the_gate_is_open(self):
        self.assertIn(GATE, self.text)
        self.assertIn('still', self.text.lower())
        for phrase in ('no longer blocks', 'gate is open', 'is satisfied today'):
            self.assertNotIn(phrase, self.text.lower())

    def test_the_uncovered_paths_are_named(self):
        missing = [item for item in UNCOVERED if item not in self.text]
        self.assertEqual(missing, [], 'uncovered paths not named: %s' % missing)

    def test_the_commit_point_and_the_no_await_rule_are_stated(self):
        self.assertIn('agent/inbox/spliced', self.text)
        self.assertIn('no `await`', self.text)


class GateStaysClosed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.owner = OWNER.read_text(encoding='utf-8')
        cls.resume = RESUME.read_text(encoding='utf-8')

    def test_admission_gate_still_refuses(self):
        self.assertIn("code: '%s'" % GATE, self.owner)
        self.assertIn('ok: false', self.owner)

    def test_both_missing_items_are_still_reported(self):
        for item in MISSING:
            self.assertIn("'%s'" % item, self.owner, 'gate no longer reports %s' % item)

    def test_dispatch_gate_agrees_with_the_admission_gate(self):
        match = re.search(r"export const DISPATCH_GATE\s*=\s*'([^']+)'", self.resume)
        self.assertIsNotNone(match, 'DISPATCH_GATE literal is gone')
        self.assertEqual(match.group(1), GATE)

    def test_there_is_no_boolean_override_for_the_gate(self):
        # A configuration switch would turn a proven absence into an operator preference.
        for source in (self.owner, self.resume):
            for marker in ('allowUnsigned', 'skipWriterFence', 'forceAdmission'):
                self.assertNotIn(marker, source)


if __name__ == '__main__':
    unittest.main()
