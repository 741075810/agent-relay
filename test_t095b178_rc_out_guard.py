"""T178: the builder must never delete a directory it cannot prove it created.

`build()` used to call `shutil.rmtree(out)` before any validation, so `--out extension`, `--out .` or a typo
could destroy the source tree or the checkout. Every case here runs against temp directories; no test names a
real path, and the source tree is only ever read.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "tools" / "build_extension_rc.py"
SOURCE = ROOT / "extension"


def run(*args):
    return subprocess.run([sys.executable, "-B", str(BUILD), *map(str, args)],
                          capture_output=True, text=True)


def copy_source(tmp: Path) -> Path:
    copy = tmp / "src"
    shutil.copytree(SOURCE, copy, ignore=shutil.ignore_patterns(".*"))
    return copy


class OutGuard(unittest.TestCase):
    def assert_refused(self, completed, needle):
        self.assertEqual(completed.returncode, 1, completed.stdout + completed.stderr)
        self.assertIn("refusing --out", completed.stdout)
        self.assertIn(needle, completed.stdout)

    def test_out_equal_to_source_is_refused_and_survives(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = copy_source(Path(tmp))
            before = {p.name: p.stat().st_size for p in src.iterdir()}
            out = run("--out", src, "--source", src)
            self.assert_refused(out, "it is the source tree")
            self.assertEqual({p.name: p.stat().st_size for p in src.iterdir()}, before)

    def test_out_containing_the_source_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = copy_source(Path(tmp))
            out = run("--out", Path(tmp), "--source", src)
            self.assert_refused(out, "it contains the source tree")
            self.assertTrue((src / "manifest.json").is_file())

    def test_out_inside_the_source_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = copy_source(Path(tmp))
            out = run("--out", src / "lib" / "rc", "--source", src)
            self.assert_refused(out, "it is inside the source tree")
            self.assertTrue((src / "lib" / "build_stamp.js").is_file())

    def test_repository_root_and_its_ancestors_are_refused(self):
        for target in (ROOT, ROOT.parent):
            out = run("--out", target)
            self.assert_refused(out, "repository")
        self.assertTrue((SOURCE / "manifest.json").is_file())

    def test_outside_the_dist_root_is_refused_for_the_real_tree(self):
        """With the shipped source, nothing outside dist/ may be created."""
        with tempfile.TemporaryDirectory() as tmp:
            out = run("--out", Path(tmp) / "rc")
            self.assert_refused(out, "may only be created under")
            self.assertFalse((Path(tmp) / "rc").exists())

    def test_an_existing_foreign_directory_is_never_deleted(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = copy_source(Path(tmp))
            victim = ROOT / "dist" / ("t178-victim-" + next(tempfile._get_candidate_names()))
            victim.mkdir(parents=True)
            (victim / "keep.txt").write_text("do not delete", encoding="utf-8")
            try:
                out = run("--out", victim, "--source", src)
                self.assertEqual(out.returncode, 1, out.stdout)
                self.assertIn("refusing to delete a directory this tool cannot account for", out.stdout)
                self.assertEqual((victim / "keep.txt").read_text(encoding="utf-8"), "do not delete")
            finally:
                shutil.rmtree(victim, ignore_errors=True)

    def test_a_stale_source_leaves_the_existing_candidate_intact(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = copy_source(Path(tmp))
            victim = self.made_candidate(tmp, src)
            try:
                # Break the source stamp without touching the candidate.
                stamp = src / "lib" / "build_stamp.js"
                stamp.write_text(stamp.read_text(encoding="utf-8").replace("T112-", "T112-0"),
                                 encoding="utf-8")
                before = (victim / "RC_MANIFEST.json").read_bytes()
                out = run("--out", victim, "--source", src)
                self.assertEqual(out.returncode, 1, out.stdout)
                self.assertIn("stale", out.stdout.lower())
                self.assertEqual((victim / "RC_MANIFEST.json").read_bytes(), before)
            finally:
                shutil.rmtree(victim, ignore_errors=True)

    def test_a_verified_candidate_is_replaced_only_after_a_good_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = copy_source(Path(tmp))
            victim = self.made_candidate(tmp, src)
            try:
                old = (victim / "RC_MANIFEST.json").read_bytes()
                again = run("--out", victim, "--source", src)
                self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
                manifest = json.loads((victim / "RC_MANIFEST.json").read_text(encoding="utf-8"))
                self.assertEqual(manifest["kind"], "extension-release-candidate")
                self.assertEqual(manifest["fileCount"], len(manifest["files"]))
                self.assertEqual((victim / "RC_MANIFEST.json").read_bytes(), old,
                                 "rebuilding the same source must reproduce the same manifest")
                leftovers = [p.name for p in victim.parent.iterdir() if ".staging-" in p.name]
                self.assertEqual(leftovers, [], "no staging directory may be left behind")
            finally:
                shutil.rmtree(victim, ignore_errors=True)

    def made_candidate(self, tmp: Path, src: Path) -> Path:
        import uuid
        target = ROOT / "dist" / ("t178-probe-" + uuid.uuid4().hex[:8])
        built = run("--out", target, "--source", src)
        self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
        return target


if __name__ == "__main__":
    unittest.main()
