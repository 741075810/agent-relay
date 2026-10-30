"""T095B112: the extension stamp must describe the tree next to it, and must be able to say no.

The defect this pins: `extension/lib/build_stamp.js` carried `T069-terminal-ms` for more than
forty changes, and `popup.js` carried a second copy of the same literal. A stamp like that cannot
tell an operator whether the unpacked extension Chrome is running is the tree on disk -- which is
the only question it exists to answer.

So the stamp is now derived (`T###-<8 hex>` over every shipped file except the stamp itself) and
`tools/extension_stamp.py --check` refuses when it disagrees. These tests exercise the refusal on
a copy, never on the working tree.
"""
import json
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


def run(*args, cwd=ROOT):
    proc = subprocess.run([sys.executable, '-B', TOOL] + list(args),
                          cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, timeout=120)
    return proc


class StampTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='t112-stamp-')
        self.copy = os.path.join(self.tmp, 'extension')
        shutil.copytree(EXT, self.copy)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_the_shipped_stamp_matches_the_shipped_tree(self):
        proc = run('--check', '--json')
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        report = json.loads(proc.stdout)
        self.assertTrue(report['fresh'], report)
        self.assertRegex(report['declared'], r'^T\d{3}-[0-9a-f]{8}$')
        self.assertEqual(report['declared'].split('-')[1], report['tree'])
        self.assertGreater(report['files'], 20, 'the digest covers almost nothing')

    def test_editing_any_shipped_file_makes_the_stamp_stale(self):
        target = os.path.join(self.copy, 'content.js')
        with open(target, 'r', encoding='utf-8') as handle:
            body = handle.read()
        with open(target, 'w', encoding='utf-8') as handle:
            handle.write(body + '\n// one more line\n')
        proc = subprocess.run([sys.executable, '-B', TOOL, '--root', self.copy,
                               '--check', '--json'],
                              cwd=self.tmp, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, timeout=120)
        self.assertEqual(proc.returncode, 1,
                         'a changed tree still reported a fresh stamp: %s' % proc.stdout)
        self.assertFalse(json.loads(proc.stdout)['fresh'])


    def test_write_refreshes_a_stale_stamp(self):
        target = os.path.join(self.copy, 'lib', 'build_stamp.js')
        with open(target, 'r', encoding='utf-8') as handle:
            text = handle.read()
        stale = re.sub(r"BUILD_STAMP = '[^']*'", "BUILD_STAMP = 'T000-00000000'", text)
        self.assertIn("T000-00000000", stale)
        with open(target, 'w', encoding='utf-8') as handle:
            handle.write(stale)
        proc = subprocess.run([sys.executable, '-B', TOOL, '--root', self.copy, '--write'],
                              cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        with open(target, 'r', encoding='utf-8') as handle:
            written = handle.read()
        self.assertNotIn('T000-00000000', written)
        self.assertRegex(written, r"BUILD_STAMP = 'T112-[0-9a-f]{8}'")

    def test_the_popup_declares_no_stamp_of_its_own(self):
        with open(os.path.join(EXT, 'popup.js'), encoding='utf-8') as handle:
            popup = handle.read()
        self.assertNotIn("const BUILD_STAMP = '", popup,
                         'the duplicate literal is back; it is what went stale for forty changes')
        self.assertIn('globalThis.BUILD_STAMP', popup)
        with open(os.path.join(EXT, 'popup.html'), encoding='utf-8') as handle:
            html = handle.read()
        self.assertLess(html.index('src="lib/build_stamp.js"'), html.index('src="popup.js"'),
                        'the stamp script must load before the popup that reads it')


if __name__ == '__main__':
    unittest.main()
