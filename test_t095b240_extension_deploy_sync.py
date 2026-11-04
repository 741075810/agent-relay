"""T240: the deploy-consistency tool must be provable offline, and must be boring about it.

The failure it exists to prevent is not a crash, it is silence: the repository moved, the unpacked
install directory did not, and everything looked fine. So the tests here are about the *claims* the
tool makes -- "in sync", "drift", "applied and verified", "rolled back" -- and about the one thing
it must never do, which is write when it was only asked to look.

Every test builds its own trees under a temporary directory. Nothing reads a real Chrome profile,
a real install directory, or this machine's layout: the tool takes both paths as arguments and the
tests take that seriously.
"""
import contextlib
import hashlib
import io as _io
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools'))
import extension_deploy_sync as deploy  # noqa: E402
import extension_stamp  # noqa: E402

MANIFEST = {
    'manifest_version': 3,
    'name': 'install fixture',
    'version': '0.1.1',
    'permissions': ['storage', 'tabs'],
    'host_permissions': ['https://example.test/*'],
    'background': {'service_worker': 'background.js', 'type': 'module'},
}


def write(path, text, newline='\n'):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline=newline) as handle:
        handle.write(text)


def stamp_literal(root, label='T112'):
    """Write a stamp that actually describes the tree, the way tools/extension_stamp.py would."""
    short, _count = extension_stamp.tree_digest(root)
    write(os.path.join(root, 'lib', 'build_stamp.js'),
          "const BUILD_STAMP = '%s-%s';\n" % (label, short))
    return '%s-%s' % (label, short)


def make_extension(root, body='console.log("v1");\n', with_stamp=True):
    write(os.path.join(root, 'manifest.json'), json.dumps(MANIFEST, indent=2) + '\n')
    write(os.path.join(root, 'background.js'), body)
    write(os.path.join(root, 'lib', 'helper.js'), 'export const x = 1;\n')
    write(os.path.join(root, 'popup.html'), '<!doctype html><title>t</title>\n')
    if with_stamp:
        return stamp_literal(root)
    return None


def tree_hashes(root):
    out = {}
    for base, _dirs, files in os.walk(root):
        for name in files:
            full = os.path.join(base, name)
            with open(full, 'rb') as handle:
                out[os.path.relpath(full, root)] = hashlib.sha256(handle.read()).hexdigest()
    return out


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='t240-')
        self.source = os.path.join(self.tmp, 'repo', 'extension')
        self.target = os.path.join(self.tmp, 'install', 'extension')
        make_extension(self.source)
        make_extension(self.target)
        # A fresh install copy must carry the same stamp as the source or the stamp test would
        # start red for the wrong reason.
        shutil.copy2(os.path.join(self.source, 'lib', 'build_stamp.js'),
                     os.path.join(self.target, 'lib', 'build_stamp.js'))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_tool(self, *argv):
        with contextlib.redirect_stdout(_io.StringIO()):
            return deploy.main(['--source', self.source, '--target', self.target] + list(argv))

    def backups(self):
        parent = os.path.dirname(self.target)
        return [name for name in os.listdir(parent) if '.backup-' in name]


class ReadOnlyDefault(Fixture):
    def test_check_writes_nothing_at_all(self):
        write(os.path.join(self.source, 'background.js'), 'console.log("v2");\n')
        before = tree_hashes(self.target)
        self.assertEqual(self.run_tool(), 1)
        self.assertEqual(tree_hashes(self.target), before)
        self.assertEqual(self.backups(), [], 'a check must not create a backup directory')

    def test_in_sync_is_rc0_and_says_so(self):
        self.assertEqual(self.run_tool(), 0)

    def test_drift_names_the_file_and_both_hashes(self):
        write(os.path.join(self.source, 'background.js'), 'console.log("v2");\n')
        stream = _Capture()
        report = deploy.compare(self.source, self.target)
        deploy.render(_report(report, self.source, self.target), stream)
        text = stream.text
        self.assertIn('background.js', text)
        self.assertIn('differs', text)
        row = [item for item in report if item['path'] == 'background.js'][0]
        self.assertIn(row['source'], text)
        self.assertIn(row['target'], text)

    def test_missing_and_extra_are_separate_classes(self):
        os.remove(os.path.join(self.target, 'popup.html'))
        write(os.path.join(self.target, 'stale.js'), 'old\n')
        states = {row['path']: row['state'] for row in deploy.compare(self.source, self.target)}
        self.assertEqual(states['popup.html'], deploy.MISSING)
        self.assertEqual(states['stale.js'], deploy.EXTRA)

    def test_line_endings_alone_are_not_drift(self):
        # A Windows install of the same source can differ only by CRLF. That is not a stale build,
        # and calling it one would train the operator to ignore the check.
        write(os.path.join(self.target, 'background.js'), 'console.log("v1");\n', newline='\r\n')
        states = {row['path']: row['state'] for row in deploy.compare(self.source, self.target)}
        self.assertEqual(states['background.js'], deploy.TEXT_EQUIV)
        self.assertEqual(self.run_tool(), 0)

    def test_stamp_mismatch_is_reported(self):
        write(os.path.join(self.target, 'lib', 'build_stamp.js'), "const BUILD_STAMP = 'T112-00000000';\n")
        stream = _Capture()
        report = _report(deploy.compare(self.source, self.target), self.source, self.target)
        deploy.render(report, stream)
        self.assertIn('stamp', stream.text)
        self.assertIn('DRIFT', stream.text)

    def test_manifest_permission_change_is_spelled_out(self):
        changed = dict(MANIFEST)
        changed['permissions'] = ['storage', 'tabs', 'scripting']
        write(os.path.join(self.target, 'manifest.json'), json.dumps(changed, indent=2) + '\n')
        notes = deploy.manifest_diff(deploy.manifest_facts(self.source),
                                     deploy.manifest_facts(self.target))
        self.assertTrue(any(note.startswith('permissions: the install has scripting')
                            for note in notes), notes)


class Apply(Fixture):
    def test_apply_writes_only_static_extension_files(self):
        write(os.path.join(self.source, 'notes.txt'), 'scratch\n')
        write(os.path.join(self.source, 'lib', 'payload.exe'), 'MZ\n')
        write(os.path.join(self.source, 'background.js'), 'console.log("v2");\n')
        self.assertEqual(self.run_tool('--apply'), 0)
        self.assertFalse(os.path.exists(os.path.join(self.target, 'notes.txt')))
        self.assertFalse(os.path.exists(os.path.join(self.target, 'lib', 'payload.exe')))
        with open(os.path.join(self.target, 'background.js'), encoding='utf-8') as handle:
            self.assertEqual(handle.read(), 'console.log("v2");\n')

    def test_apply_backs_up_then_verifies(self):
        old = hashlib.sha256(open(os.path.join(self.target, 'background.js'), 'rb').read()).hexdigest()
        write(os.path.join(self.source, 'background.js'), 'console.log("v2");\n')
        self.assertEqual(self.run_tool('--apply'), 0)
        names = self.backups()
        self.assertEqual(len(names), 1)
        backup = os.path.join(os.path.dirname(self.target), names[0])
        with open(os.path.join(backup, 'SHA256SUMS.txt'), encoding='utf-8') as handle:
            self.assertIn(old, handle.read())
        self.assertEqual(tree_hashes(self.target)['background.js'],
                         tree_hashes(self.source)['background.js'])

    def test_apply_leaves_the_install_manifest_alone_without_the_flag(self):
        write(os.path.join(self.source, 'manifest.json'),
              json.dumps(dict(MANIFEST, version='0.1.2'), indent=2) + '\n')
        self.assertEqual(self.run_tool('--apply'), 0)
        with open(os.path.join(self.target, 'manifest.json'), encoding='utf-8') as handle:
            self.assertEqual(json.load(handle)['version'], '0.1.1')
        self.assertFalse(os.path.exists(os.path.join(self.target, 'background.js.diff')))

    def test_apply_refuses_a_permission_change_even_when_asked_to_sync_the_manifest(self):
        changed = dict(MANIFEST)
        changed['permissions'] = ['storage', 'tabs', 'scripting']
        write(os.path.join(self.target, 'manifest.json'), json.dumps(changed, indent=2) + '\n')
        before = tree_hashes(self.target)
        self.assertEqual(self.run_tool('--apply', '--sync-manifest'), 2)
        self.assertEqual(tree_hashes(self.target), before)
        self.assertEqual(self.backups(), [])

    def test_apply_syncs_the_manifest_when_permissions_agree(self):
        write(os.path.join(self.source, 'manifest.json'),
              json.dumps(dict(MANIFEST, version='0.1.2'), indent=2) + '\n')
        self.assertEqual(self.run_tool('--apply', '--sync-manifest'), 0)
        with open(os.path.join(self.target, 'manifest.json'), encoding='utf-8') as handle:
            self.assertEqual(json.load(handle)['version'], '0.1.2')

    def test_nothing_to_write_is_rc0_and_creates_no_backup(self):
        self.assertEqual(self.run_tool('--apply'), 0)
        self.assertEqual(self.backups(), [])

    def test_extra_files_are_never_deleted(self):
        write(os.path.join(self.target, 'operator-note.js'), 'keep me\n')
        self.assertEqual(self.run_tool('--apply'), 0)
        self.assertTrue(os.path.isfile(os.path.join(self.target, 'operator-note.js')))


class Safety(Fixture):
    def test_refuses_when_source_and_target_are_the_same_directory(self):
        with contextlib.redirect_stdout(_io.StringIO()):
            self.assertEqual(deploy.main(['--source', self.source, '--target', self.source]), 2)

    def test_refuses_a_directory_that_is_not_an_extension(self):
        empty = os.path.join(self.tmp, 'not-an-extension')
        os.makedirs(empty)
        with contextlib.redirect_stdout(_io.StringIO()):
            self.assertEqual(deploy.main(['--source', self.source, '--target', empty]), 2)

    def test_refuses_a_browser_profile_path(self):
        profile = os.path.join(self.tmp, 'Default', 'Local Extension Settings', 'abcdefghijklmnop')
        os.makedirs(profile)
        write(os.path.join(profile, 'manifest.json'), json.dumps(MANIFEST) + '\n')
        with contextlib.redirect_stdout(_io.StringIO()):
            self.assertEqual(deploy.main(['--source', self.source, '--target', profile]), 2)

    def test_refuses_a_backup_directory_inside_the_install(self):
        write(os.path.join(self.source, 'background.js'), 'console.log("v2");\n')
        inside = os.path.join(self.target, 'backup')
        self.assertEqual(self.run_tool('--apply', '--backup-dir', inside), 2)
        self.assertFalse(os.path.exists(inside))

    def test_a_failed_copy_is_rolled_back(self):
        # `lib` becomes a file, so copying lib/helper.js cannot work. The tool must put back what it
        # already wrote rather than leave a half-synced install behind.
        original = tree_hashes(self.target)
        write(os.path.join(self.source, 'background.js'), 'console.log("v2");\n')
        write(os.path.join(self.source, 'lib', 'helper.js'), 'export const x = 2;\n')
        shutil.rmtree(os.path.join(self.target, 'lib'))
        write(os.path.join(self.target, 'lib'), 'not a directory\n')
        self.assertEqual(self.run_tool('--apply'), 3)
        with open(os.path.join(self.target, 'background.js'), 'rb') as handle:
            self.assertEqual(hashlib.sha256(handle.read()).hexdigest(), original['background.js'])
        self.assertEqual(len(self.backups()), 1)


class Paths(Fixture):
    def test_chinese_and_space_paths_work_end_to_end(self):
        base = os.path.join(self.tmp, '中文 路径 with spaces')
        source = os.path.join(base, '仓库 源 extension')
        target = os.path.join(base, '安装 目录 extension')
        make_extension(source)
        make_extension(target)
        shutil.copy2(os.path.join(source, 'lib', 'build_stamp.js'),
                     os.path.join(target, 'lib', 'build_stamp.js'))
        write(os.path.join(source, '背景 脚本.js'), 'console.log("中文");\n')
        with contextlib.redirect_stdout(_io.StringIO()):
            self.assertEqual(deploy.main(['--source', source, '--target', target]), 1)
            self.assertEqual(deploy.main(['--source', source, '--target', target, '--apply']), 0)
        self.assertTrue(os.path.isfile(os.path.join(target, '背景 脚本.js')))
        with contextlib.redirect_stdout(_io.StringIO()):
            self.assertEqual(deploy.main(['--source', source, '--target', target]), 0)

    def test_json_output_is_parseable(self):
        stream = _Capture()
        report = _report(deploy.compare(self.source, self.target), self.source, self.target)
        stream.write(json.dumps(report, indent=2, sort_keys=True))
        parsed = json.loads(stream.text)
        for key in ('source', 'target', 'files', 'stamp', 'manifest', 'verdict'):
            self.assertIn(key, parsed)


class _Capture:
    def __init__(self):
        self.text = ''

    def write(self, text):
        self.text += text


def _report(rows, source, target):
    source_stamp, source_digest, _count = deploy.stamp_of(source)
    target_stamp, target_digest, _count = deploy.stamp_of(target)
    drift = [row for row in rows if row['state'] in (deploy.DIFFERS, deploy.MISSING, deploy.EXTRA)]
    return {
        'source': source,
        'target': target,
        'source_files': len(deploy.walk_tree(source)),
        'target_files': len(deploy.walk_tree(target)),
        'files': rows,
        'stamp': {'source': source_stamp, 'target': target_stamp,
                  'match': bool(source_digest and source_digest == target_digest)},
        'manifest': deploy.manifest_diff(deploy.manifest_facts(source), deploy.manifest_facts(target)),
        'verdict': 'in sync' if not drift else 'DRIFT (%d files)' % len(drift),
    }


if __name__ == '__main__':
    unittest.main()
