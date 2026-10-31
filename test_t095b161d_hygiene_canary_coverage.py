"""T095B161 round 4: every hygiene rule must have a canary, and the canary must actually fire.

The repository's own AGENTS.md names the failure this test exists to prevent: "a gate you believe in but
never actually ran". A rule with no canary is exactly that -- it is in the list, it looks like coverage,
and nobody has ever seen it fire.

Two layers:

* a data-driven sweep that builds one sample file per rule in a temp tree, runs the real scanner over it,
  and asserts every rule id appears in the findings;
* a structural check that `self_test()` mentions every rule id, so adding a rule without a canary fails
  here instead of shipping untested.
"""

import importlib.util
import re
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODULE_PATH = ROOT / "tools" / "hygiene_scan.py"


def load_scanner():
    spec = importlib.util.spec_from_file_location("hygiene_scan_t161d", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# One sample per rule. Each is the smallest thing that must be caught; the point is not realism but that
# the pattern is wired to a findable shape.
SAMPLES = {
    "windows-user-path": 'HOME = "C:' + chr(92) * 2 + 'Users' + chr(92) + 'someone"\n',
    "windows-path": 'RUN = "E:' + chr(92) + 'program"\n',
    "session-id": "SESSION = 'session-" + "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d" + "'\n",
    "conversation-id": 'CONV = {"conversationId": "'
                       + "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d" + '"}\n',
    # Not 32 copies of one letter: the scanner deliberately excuses self-evidently synthetic ids, so a
    # repeated-letter sample would prove nothing.
    "extension-id": "URL = 'chrome-extension://" + "cbfomfmdgjhgkhaljnmkjhpmhjlnkfaj" + "/popup.html'\n",
    "private-key": "-----BEGIN RSA PRIVATE KEY-----\n",
    "host-token": "TOKEN = 'ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'\n",
}


class RuleCanaryTest(unittest.TestCase):
    def setUp(self):
        self.scanner = load_scanner()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_registry_and_the_samples_cover_the_same_rules(self):
        registry = {rule[0] for rule in self.scanner.RULES}
        self.assertEqual(registry, set(SAMPLES),
                         "a rule without a sample here is a rule nobody has watched fire")

    def test_every_rule_fires_on_its_own_sample(self):
        for rule, text in SAMPLES.items():
            # One rule at a time, so a pattern that only works "in company" cannot hide.
            sub = self.root / rule
            sub.mkdir()
            (sub / "canary.py").write_text(text, encoding="utf-8")
            findings = self.scanner.scan_tree(sub, walk=True)
            hit = {finding['rule'] for finding in findings}
            self.assertIn(rule, hit, "rule %r did not fire on its own sample" % rule)

    def test_the_clean_file_stays_untouched_by_every_rule(self):
        clean = self.root / "clean"
        clean.mkdir()
        (clean / "fine.py").write_text(
            'PATH_VAR = "relative/dir"\n# session ids look like session-<uuid> but this is prose\n',
            encoding="utf-8")
        self.assertEqual(self.scanner.scan_tree(clean, walk=True), [])

    def test_self_test_names_every_rule_so_a_new_rule_cannot_ship_untested(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        start = source.index("def self_test")
        body = source[start:source.index("\ndef ", start + 1)]
        covered = {rule[0] for rule in self.scanner.RULES if rule[0] in body}
        missing = {rule[0] for rule in self.scanner.RULES} - covered
        self.assertEqual(missing, set(),
                         "self_test has no canary for: %s" % ", ".join(sorted(missing)))

    def test_the_self_test_still_passes_and_reports_its_canary_count(self):
        self.assertEqual(self.scanner.self_test(), 0)


if __name__ == "__main__":
    unittest.main()
