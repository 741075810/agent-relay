"""T095B113: does the extension stamp detect what it claims to detect?

T112 derived the stamp from a digest over every shipped file, with `\\r\\n` normalised to `\\n`
so a Windows checkout and a Linux checkout agree. That normalisation is right for text and
dangerous for anything else: a PNG with the bytes `0D 0A` inside is not a line ending, and two
different binaries that differ only in that pair would hash the same. The extension ships no
binary today -- only `.html`, `.js`, `.json` -- so the defect is latent rather than live, which is
exactly why it is worth pinning now, before someone adds an icon and trusts the gate.

Everything here runs on a copy in a temporary directory. The working tree is never touched.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(ROOT, 'tools', 'extension_stamp.py')
EXT = os.path.join(ROOT, 'extension')
TEXT_SUFFIXES = ('.js', '.html', '.json', '.css', '.txt', '.md')
STAMP_RE = re.compile(r"BUILD_STAMP = '([^']*)'")


def run_check(root_dir):
    proc = subprocess.run([sys.executable, '-B', TOOL, '--root', root_dir, '--check', '--json'],
                          cwd=root_dir, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, timeout=180)
    return proc


def run_write(root_dir):
    proc = subprocess.run([sys.executable, '-B', TOOL, '--root', root_dir, '--write'],
                          cwd=root_dir, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, timeout=180)
    return proc


class StampRegressionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='t113-stamp-')
        self.copy = os.path.join(self.tmp, 'extension')
        shutil.copytree(EXT, self.copy)
        self.assertEqual(run_check(self.copy).returncode, 0, 'the copy starts out fresh')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, rel, data):
        path = os.path.join(self.copy, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        mode = 'wb' if isinstance(data, bytes) else 'w'
        with open(path, mode) as handle:
            handle.write(data)

    def stale(self):
        return run_check(self.copy).returncode != 0

    # -- what must be detected ------------------------------------------------------------
    def test_a_changed_script_is_detected(self):
        path = os.path.join(self.copy, 'content.js')
        with open(path, encoding='utf-8') as handle:
            body = handle.read()
        self.write('content.js', body + '\n// touch\n')
        self.assertTrue(self.stale(), 'a changed script did not invalidate the stamp')

    def test_a_changed_manifest_is_detected(self):
        path = os.path.join(self.copy, 'manifest.json')
        with open(path, encoding='utf-8') as handle:
            body = handle.read()
        self.write('manifest.json', body.replace('"version": "0.1.1"', '"version": "0.1.2"'))
        self.assertTrue(self.stale(), 'a version bump in manifest.json slipped past the stamp')

    def test_an_added_or_removed_resource_is_detected(self):
        self.write('lib/extra.js', '// new file\n')
        self.assertTrue(self.stale(), 'a newly added file did not invalidate the stamp')
        os.remove(os.path.join(self.copy, 'lib', 'extra.js'))
        self.assertEqual(run_check(self.copy).returncode, 0, 'removing it again should agree')
        os.remove(os.path.join(self.copy, 'content.js'))
        self.assertTrue(self.stale(), 'a deleted file did not invalidate the stamp')

    def test_a_changed_binary_is_detected(self):
        """A binary resource must hash as bytes, not through the line-ending normaliser."""
        self.write('icons/logo.png', b'\x89PNG\r\n\x1a\n' + b'\x00' * 8)
        self.assertTrue(self.stale(), 'a new binary resource did not invalidate the stamp')
        self.assertEqual(run_write(self.copy).returncode, 0, 'could not refresh the stamp')
        self.assertEqual(run_check(self.copy).returncode, 0, 'the refreshed stamp still disagrees')
        # Flip one byte of the embedded CRLF pair. Two files, one byte apart, one digest.
        self.write('icons/logo.png', b'\x89PNG\r\r\x1a\n' + b'\x00' * 8)
        self.assertTrue(self.stale(),
                        'changing a byte pair that looks like CRLF in a binary went unnoticed')

    def test_binary_and_normalised_text_are_not_the_same_file(self):
        """The blind spot: a binary whose *only* change is an embedded CRLF pair.

        Same path, same length minus one byte, and after `\\r\\n` -> `\\n` the two contents are
        identical. If the digest normalises binaries too, this edit is invisible -- a changed
        icon would ship under a stamp that still claims to describe it.
        """
        with_crlf = b'\x89PNG\r\n\x1a\n' + b'\x00' * 4
        self.write('icons/a.png', with_crlf)
        self.assertEqual(run_write(self.copy).returncode, 0)
        self.assertEqual(run_check(self.copy).returncode, 0, 'the fresh stamp disagrees')
        self.write('icons/a.png', with_crlf.replace(b'\r\n', b'\n'))
        self.assertTrue(self.stale(),
                        'a binary whose only difference is an embedded CRLF pair hashed like its '
                        'normalised twin, so the change is invisible to the stamp')

    # -- what must NOT be detected --------------------------------------------------------
    def test_line_endings_alone_do_not_invalidate_the_stamp(self):
        """A Windows checkout must not look like a different build."""
        for base, _dirs, files in os.walk(self.copy):
            for name in files:
                path = os.path.join(base, name)
                if not name.endswith(TEXT_SUFFIXES) or name == 'build_stamp.js':
                    continue
                with open(path, 'rb') as handle:
                    body = handle.read()
                if b'\r\n' in body:
                    continue
                with open(path, 'wb') as handle:
                    handle.write(body.replace(b'\n', b'\r\n'))
        self.assertEqual(run_check(self.copy).returncode, 0,
                         'a CRLF copy of the same source was reported as a different build')

    def test_a_trailing_newline_change_is_still_a_change(self):
        path = os.path.join(self.copy, 'content.js')
        with open(path, 'rb') as handle:
            body = handle.read()
        with open(path, 'wb') as handle:
            handle.write(body.rstrip(b'\n'))
        self.assertTrue(self.stale(), 'stripping the final newline went unnoticed')

    # -- the tool's own contract ----------------------------------------------------------
    def test_root_verifies_another_copy_and_a_relative_path_works(self):
        proc = subprocess.run([sys.executable, '-B', TOOL, '--root', 'extension', '--check'],
                              cwd=self.tmp, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, timeout=180)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.write('content.js', '// tampered\n')
        again = subprocess.run([sys.executable, '-B', TOOL, '--root', 'extension', '--check'],
                               cwd=self.tmp, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, timeout=180)
        self.assertEqual(again.returncode, 1, 'a tampered copy verified as fresh')

    def test_a_wrong_root_is_refused_rather_than_scored(self):
        """An empty walk hashes to a digest; that must never be mistaken for a verdict."""
        proc = subprocess.run([sys.executable, '-B', TOOL, '--root',
                               os.path.join(self.tmp, 'not-here'), '--check'],
                              cwd=self.tmp, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, timeout=180)
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('no extension directory', proc.stdout)
        self.assertNotIn('Traceback', proc.stderr)

    def test_the_popup_loads_its_scripts_in_dependency_order(self):
        with open(os.path.join(EXT, 'popup.html'), encoding='utf-8') as handle:
            html = handle.read()
        stamp_at = html.index('src="lib/build_stamp.js"')
        view_at = html.index('src="lib/queue_error_view.js"')
        popup_at = html.index('src="popup.js"')
        self.assertLess(stamp_at, popup_at, 'popup.js runs before the stamp it reads')
        self.assertLess(view_at, popup_at, 'popup.js runs before the wording helper it calls')
        with open(os.path.join(EXT, 'popup.js'), encoding='utf-8') as handle:
            popup = handle.read()
        self.assertNotRegex(popup, r"BUILD_STAMP = 'T\d",
                            'the popup declares a stamp of its own again')


if __name__ == '__main__':
    unittest.main()
