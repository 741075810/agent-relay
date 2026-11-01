"""T181: the builder's own failure branches, driven through the real function.

No file-operation mime: `_rename` is the single hook every directory move goes through, so failing it fails
the actual code path, and `candidate_identity` is called with directories built from real manifests.
"""

import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "tools" / "build_extension_rc.py"
SOURCE = ROOT / "extension"
MANIFEST = "RC_MANIFEST.json"


def load_module():
    spec = importlib.util.spec_from_file_location("rcbuild", BUILD)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Recovery(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        self._rename = self.module._rename
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.src = self.base / "src"
        shutil.copytree(SOURCE, self.src, ignore=shutil.ignore_patterns(".*"))
        self.out = ROOT / "dist" / ("t181-" + uuid.uuid4().hex[:8])

    def tearDown(self):
        self.module._rename = self._rename
        shutil.rmtree(self.out, ignore_errors=True)
        for stale in self.out.parent.glob(self.out.name + ".*"):
            shutil.rmtree(stale, ignore_errors=True)
        self.tmp.cleanup()

    def build(self):
        return self.module.build(self.out, source=self.src, allow_temp=True)

    def test_a_failed_swap_restores_the_previous_candidate(self):
        self.assertEqual(self.build(), 0)
        before = (self.out / MANIFEST).read_bytes()
        calls = {"n": 0}

        def failing(src, dst):
            # Let the retire move through, fail the staged -> out move.
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError("injected swap failure")
            return self._rename(src, dst)

        self.module._rename = failing
        self.assertEqual(self.build(), 1)
        self.assertEqual((self.out / MANIFEST).read_bytes(), before,
                         "the previous candidate must be back, byte for byte")
        self.assertEqual(list(self.out.parent.glob(self.out.name + ".*.retired")), [],
                         "a restored swap leaves no recovery copy behind")

    def test_a_failed_swap_and_failed_restore_keep_the_recovery_copy(self):
        self.assertEqual(self.build(), 0)
        before = (self.out / MANIFEST).read_bytes()
        calls = {"n": 0}

        def failing(src, dst):
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError("injected swap failure")
            if calls["n"] == 3:
                raise OSError("injected restore failure")
            return self._rename(src, dst)

        self.module._rename = failing
        self.assertEqual(self.build(), 1)
        retired = list(self.out.parent.glob(self.out.name + ".*.retired"))
        self.assertEqual(len(retired), 1, "the recovery copy must survive both failures")
        self.assertEqual((retired[0] / MANIFEST).read_bytes(), before)
        self.assertFalse(self.out.exists(), "the target is genuinely gone, which is why the copy matters")

    def test_the_recovery_copy_is_removed_only_after_a_verified_build(self):
        self.assertEqual(self.build(), 0)
        self.assertEqual(self.build(), 0)
        self.assertEqual(list(self.out.parent.glob(self.out.name + ".*.retired")), [],
                         "a successful verified build cleans up")
        self.assertEqual(list(self.out.parent.glob(self.out.name + ".staging-*")), [])

    def test_an_unverified_candidate_never_replaces_the_previous_one(self):
        """Staging is verified before any swap, so a bad build leaves the old candidate untouched."""
        self.assertEqual(self.build(), 0)
        before = (self.out / MANIFEST).read_bytes()
        original_verify = self.module.verify
        self.module.verify = lambda *a, **k: 1
        try:
            self.assertEqual(self.build(), 1)
        finally:
            self.module.verify = original_verify
        self.assertEqual((self.out / MANIFEST).read_bytes(), before,
                         "the previous candidate must still be there")
        self.assertEqual(list(self.out.parent.glob(self.out.name + ".*.retired")), [],
                         "nothing was retired, because nothing was swapped")
        self.assertEqual(list(self.out.parent.glob(self.out.name + ".staging-*")), [])


class Identity(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.src = self.base / "src"
        shutil.copytree(SOURCE, self.src, ignore=shutil.ignore_patterns(".*"))
        self.out = ROOT / "dist" / ("t181-id-" + uuid.uuid4().hex[:8])
        self.assertEqual(self.module.build(self.out, source=self.src, allow_temp=True), 0)

    def tearDown(self):
        shutil.rmtree(self.out, ignore_errors=True)
        for stale in self.out.parent.glob(self.out.name + ".*"):
            shutil.rmtree(stale, ignore_errors=True)
        self.tmp.cleanup()

    def test_a_byte_change_is_refused_by_digest(self):
        target = self.out / "popup.js"
        target.write_text(target.read_text(encoding="utf-8") + "\n// drift\n", encoding="utf-8")
        ok, why = self.module.candidate_identity(self.out)
        self.assertFalse(ok)
        self.assertIn("does not match the digest", why)

    def test_a_hidden_foreign_file_is_refused(self):
        (self.out / ".env").write_text("x", encoding="utf-8")
        ok, why = self.module.candidate_identity(self.out)
        self.assertFalse(ok)
        self.assertIn(".env", why)

    def test_a_manifest_path_that_escapes_the_candidate_is_refused(self):
        manifest = json.loads((self.out / MANIFEST).read_text(encoding="utf-8"))
        manifest["files"]["../outside.txt"] = "0" * 64
        (self.out / MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
        ok, why = self.module.candidate_identity(self.out)
        self.assertFalse(ok)
        self.assertIn("not a path inside the candidate", why)


if __name__ == "__main__":
    unittest.main()
