"""T176: the release-candidate builder must catch bytes, missing files, extras and unparsable scripts.

The builder is called as a subprocess, exactly as an operator would call it, against a throwaway copy.
"""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TOOL = ROOT / "tools" / "build_extension_rc.py"


def run(*args):
    return subprocess.run([sys.executable, "-B", str(TOOL), *map(str, args)],
                          capture_output=True, text=True)


class ReleaseCandidateBuild(unittest.TestCase):
    def test_build_then_verify_is_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "rc"
            built = run("--out", out)
            self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
            self.assertIn("PASS", built.stdout)
            manifest = json.loads((out / "RC_MANIFEST.json").read_text(encoding="utf-8"))
            self.assertIn("T112-", manifest["stamp"])
            self.assertGreater(manifest["fileCount"], 20)
            checked = run("--verify", out, "--check-parse")
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)

    def test_a_changed_byte_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "rc"
            self.assertEqual(run("--out", out).returncode, 0)
            target = out / "popup.js"
            target.write_text(target.read_text(encoding="utf-8") + "\n// tampered\n", encoding="utf-8")
            checked = run("--verify", out)
            self.assertEqual(checked.returncode, 1)
            self.assertIn("changed: popup.js", checked.stdout)

    def test_a_missing_file_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "rc"
            self.assertEqual(run("--out", out).returncode, 0)
            (out / "lib" / "diagnostic_view.js").unlink()
            checked = run("--verify", out)
            self.assertEqual(checked.returncode, 1)
            self.assertIn("missing: lib/diagnostic_view.js", checked.stdout)

    def test_an_extra_file_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "rc"
            self.assertEqual(run("--out", out).returncode, 0)
            (out / "stowaway.js").write_text("console.log(1);\n", encoding="utf-8")
            checked = run("--verify", out)
            self.assertEqual(checked.returncode, 1)
            self.assertIn("extra: stowaway.js", checked.stdout)

    def test_an_unparsable_module_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "rc"
            self.assertEqual(run("--out", out).returncode, 0)
            broken = out / "lib" / "diagnostic_store.js"
            broken.write_text("export function ( {", encoding="utf-8")
            checked = run("--verify", out, "--check-parse")
            self.assertEqual(checked.returncode, 1)
            self.assertRegex(checked.stdout, r"lib/diagnostic_store\.js")

    def test_the_candidate_never_touches_the_extension_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "rc"
            before = (ROOT / "extension" / "manifest.json").read_bytes()
            self.assertEqual(run("--out", out).returncode, 0)
            self.assertEqual((ROOT / "extension" / "manifest.json").read_bytes(), before)
            self.assertNotEqual(Path(out), ROOT / "extension")


if __name__ == "__main__":
    unittest.main()
