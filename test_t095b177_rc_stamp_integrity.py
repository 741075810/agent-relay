"""T177: a stale stamp must never produce a PASS, and the candidate must be a byte copy of its source.

The old builder took `stdout.splitlines()[0]` from `extension_stamp.py --check` and ignored the exit code,
so a directory printed "STALE -- run --write" (exit 1) and still passed. These tests reproduce that and pin
the refusal, working on throwaway copies so `extension/` itself is never touched.
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "tools" / "build_extension_rc.py"
STAMP = ROOT / "tools" / "extension_stamp.py"
SOURCE = ROOT / "extension"
LITERAL = re.compile(r"T112-[0-9a-f]{8}")


def run(*args):
    return subprocess.run([sys.executable, "-B", *map(str, args)], capture_output=True, text=True)


def copy_source(tmp: Path) -> Path:
    copy = tmp / "src"
    shutil.copytree(SOURCE, copy, ignore=shutil.ignore_patterns(".*"))
    return copy


def set_literal(root: Path, value: str) -> None:
    path = root / "lib" / "build_stamp.js"
    text = path.read_text(encoding="utf-8")
    path.write_text(LITERAL.sub(value, text, count=1), encoding="utf-8")


class ReleaseCandidateStampIntegrity(unittest.TestCase):
    def test_the_old_failure_mode_is_reproducible(self):
        """A stale tree makes extension_stamp.py --check exit 1 while still printing something."""
        with tempfile.TemporaryDirectory() as tmp:
            src = copy_source(Path(tmp))
            (src / "popup.js").write_text(
                (src / "popup.js").read_text(encoding="utf-8") + "\n// one changed byte\n",
                encoding="utf-8")
            probe = run(STAMP, "--check", "--root", src)
            self.assertEqual(probe.returncode, 1, probe.stdout)
            self.assertIn("STALE", probe.stdout)
            # That first line is exactly what the old builder mistook for a stamp.
            self.assertTrue(probe.stdout.splitlines()[0].startswith("declared"))

    def test_a_stale_source_is_refused_even_when_bytes_match_each_other(self):
        """Source and candidate identical, both declaring an old stamp: still no candidate."""
        with tempfile.TemporaryDirectory() as tmp:
            src = copy_source(Path(tmp))
            set_literal(src, "T112-00000000")
            out = Path(tmp) / "rc"
            built = run(BUILD, "--out", out, "--source", src)
            self.assertEqual(built.returncode, 1, built.stdout)
            self.assertIn("stale stamp", built.stdout)
            self.assertIn("T112-00000000", built.stdout)
            self.assertIn("declared", built.stdout)
            self.assertFalse((out / "RC_MANIFEST.json").exists(),
                             "a refused build must not leave a manifest behind")

    def test_verify_refuses_a_changed_source_byte(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = copy_source(Path(tmp))
            out = Path(tmp) / "rc"
            self.assertEqual(run(BUILD, "--out", out, "--source", src).returncode, 0)
            (src / "popup.js").write_text(
                (src / "popup.js").read_text(encoding="utf-8") + "\n// drift\n", encoding="utf-8")
            checked = run(BUILD, "--verify", out, "--source", src)
            self.assertEqual(checked.returncode, 1)
            self.assertIn("differs from src/", checked.stdout)

    def test_verify_refuses_a_tampered_candidate_stamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = copy_source(Path(tmp))
            out = Path(tmp) / "rc"
            self.assertEqual(run(BUILD, "--out", out, "--source", src).returncode, 0)
            set_literal(out, "T112-deadbeef")
            checked = run(BUILD, "--verify", out, "--source", src)
            self.assertEqual(checked.returncode, 1)
            self.assertRegex(checked.stdout, r"(changed: lib/build_stamp\.js|declares T112-deadbeef)")

    def test_verify_accepts_a_fresh_candidate_and_reports_its_stamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = copy_source(Path(tmp))
            out = Path(tmp) / "rc"
            built = run(BUILD, "--out", out, "--source", src)
            self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
            manifest = json.loads((out / "RC_MANIFEST.json").read_text(encoding="utf-8"))
            tree = run(STAMP, "--check", "--root", src).stdout
            digest = re.search(r"tree\s+([0-9a-f]{8})", tree).group(1)
            self.assertEqual(manifest["stamp"], "T112-" + digest,
                             "the manifest must carry the checker's digest, not a first line of output")
            checked = run(BUILD, "--verify", out, "--source", src, "--check-parse")
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)

    def test_the_repository_tree_still_builds_and_verifies(self):
        """The shipped tree is the real case: build a candidate beside it and check it."""
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "rc"
            built = run(BUILD, "--out", out)
            self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
            self.assertIn("stamp T112-", built.stdout)
            checked = run(BUILD, "--verify", out, "--check-parse")
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
            self.assertEqual((SOURCE / "manifest.json").read_bytes(),
                             (out / "manifest.json").read_bytes())


if __name__ == "__main__":
    unittest.main()
