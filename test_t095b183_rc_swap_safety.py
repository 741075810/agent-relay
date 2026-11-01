"""T183: the two ordering defects found in review, exercised through `build()` itself.

1. the target was validated, then the staged candidate was built and verified (seconds), then the target was
   retired -- a change in that window meant an unvalidated file set was deleted;
2. a candidate that failed verification *after* the swap stayed in place while the healthy copy was parked.

Failure injection happens by wrapping `verify` / `_rename` on the loaded module, so the real branch runs.
"""

import importlib.util
import json
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "tools" / "build_extension_rc.py"
SOURCE = ROOT / "extension"
MANIFEST = "RC_MANIFEST.json"


def load_module():
    spec = importlib.util.spec_from_file_location("rcbuild183", BUILD)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SwapSafety(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        self._verify = self.module.verify
        self._rename = self.module._rename
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.src = self.base / "src"
        shutil.copytree(SOURCE, self.src, ignore=shutil.ignore_patterns(".*"))
        self.out = ROOT / "dist" / ("t183-" + uuid.uuid4().hex[:8])

    def tearDown(self):
        self.module.verify = self._verify
        self.module._rename = self._rename
        shutil.rmtree(self.out, ignore_errors=True)
        for stale in self.out.parent.glob(self.out.name + ".*"):
            shutil.rmtree(stale, ignore_errors=True)
        self.tmp.cleanup()

    def build(self):
        return self.module.build(self.out, source=self.src, allow_temp=True)

    def test_a_target_changed_after_validation_is_not_retired(self):
        self.assertEqual(self.build(), 0)
        marker = self.out / "operator-notes.txt"
        marker.write_text("written while a build was running", encoding="utf-8")
        before = (self.out / MANIFEST).read_bytes()
        original = self.module.verify

        def mutating_verify(root, *args, **kwargs):
            # Runs after `candidate_identity` accepted the target and before the retire rename.
            target = self.out / "appeared-later.txt"
            if (self.out / MANIFEST).is_file() and not target.exists():
                target.write_text("raced", encoding="utf-8")
            return original(root, *args, **kwargs)

        self.module.verify = mutating_verify
        self.assertEqual(self.build(), 1)
        self.assertTrue(self.out.is_dir(), "the target must not be retired")
        self.assertEqual((self.out / MANIFEST).read_bytes(), before)
        self.assertTrue(marker.is_file(), "the file the race added must not be deleted")
        self.assertEqual(list(self.out.parent.glob(self.out.name + ".*.retired")), [])

    def test_a_candidate_that_fails_after_the_swap_restores_the_previous_one(self):
        self.assertEqual(self.build(), 0)
        before = (self.out / MANIFEST).read_bytes()
        original = self.module.verify

        def failing_final_verify(root, *args, **kwargs):
            if Path(root) == self.out:      # only the post-swap verification fails
                return 1
            return original(root, *args, **kwargs)

        self.module.verify = failing_final_verify
        self.assertEqual(self.build(), 1, "an untrusted candidate must not exit 0")
        self.assertEqual((self.out / MANIFEST).read_bytes(), before,
                         "the healthy candidate must be back at its own path")
        self.assertEqual(list(self.out.parent.glob(self.out.name + ".*.retired")), [])
        self.assertEqual(list(self.out.parent.glob(self.out.name + ".*.rejected")), [])

    def test_if_the_restore_also_fails_the_backup_survives_and_is_named(self):
        self.assertEqual(self.build(), 0)
        before = (self.out / MANIFEST).read_bytes()
        original = self.module.verify

        def failing_final_verify(root, *args, **kwargs):
            if Path(root) == self.out:
                return 1
            return original(root, *args, **kwargs)

        def failing_restore(src, dst):
            if ".retired" in str(src) and str(dst) == str(self.out):
                raise OSError("injected restore failure")
            return self._rename(src, dst)

        self.module.verify = failing_final_verify
        self.module._rename = failing_restore
        self.assertEqual(self.build(), 1)
        retired = list(self.out.parent.glob(self.out.name + ".*.retired"))
        self.assertEqual(len(retired), 1, "the healthy copy must survive a failed restore")
        self.assertEqual((retired[0] / MANIFEST).read_bytes(), before)
        rejected = list(self.out.parent.glob(self.out.name + ".*.rejected"))
        self.assertEqual(len(rejected), 1, "the untrusted candidate must be parked, not left in place")
        self.assertFalse((self.out / MANIFEST).exists(),
                         "out must not still look like a candidate")

    def test_a_foreign_file_still_blocks_replacement_and_is_never_deleted(self):
        self.assertEqual(self.build(), 0)
        stray = self.out / ".DS_Store"
        stray.write_bytes(b"\x00finder\x00")
        result = self.build()
        self.assertEqual(result, 1)
        self.assertTrue(stray.is_file(), "the tool must never delete it for the operator")

    def test_the_foreign_file_advice_is_actionable(self):
        source = BUILD.read_text(encoding="utf-8")
        self.assertIn("delete that file yourself", source)
        self.assertIn("will not delete it for you", source)
        # and no bypass was added along with the advice
        self.assertNotIn("--force", source)
        self.assertNotIn("--adopt", source)


if __name__ == "__main__":
    unittest.main()
