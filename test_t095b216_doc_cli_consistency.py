"""T216: the documents must describe the programs that exist, and the rollout must be reversible on a fake install.

Three things are checked here, all offline and all in temporary directories:

  * **document/CLI agreement** -- every `--flag` the runbook or checklist shows for `arm_with_relay.py`,
    `readiness_audit.py`, `shadow_observe.py` and `host.py` exists in that program's own parser, and every *required*
    argument appears in the arm example. A runbook that omits `--ledger-root` is a runbook that fails at the keyboard.
  * **ordering** -- the audit is a verdict on the new install: the runbook must not present a GO check before the
    launcher and extension steps that make GO possible.
  * **reversibility** -- the backup/switch/rollback sequence is executed against a fake install tree and must restore
    every file byte for byte, must not touch anything outside its own directory, and must produce the same audit
    verdict it started with.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(ROOT, 'docs')
AUDIT = os.path.join(ROOT, 'tools', 'rollout', 'readiness_audit.py')
SHADOW = os.path.join(ROOT, 'tools', 'rollout', 'shadow_observe.py')
ARM = os.path.join(ROOT, 'tools', 'service', 'arm_with_relay.py')
HOST = os.path.join(ROOT, 'host.py')
EXT = 'chrome-extension://' + 'a' * 32 + '/'
FLAG = re.compile(r'(?<![\w-])(--[a-z][a-z0-9-]*)')


def read(name):
    with open(os.path.join(DOCS, name), encoding='utf-8') as handle:
        return handle.read()


def logical_commands(text):
    """Join PowerShell line continuations, so a multi-line invocation is one string."""
    commands, buffer = [], ''
    for line in text.splitlines():
        stripped = line.rstrip()
        if stripped.endswith('`'):
            buffer += stripped[:-1] + ' '
            continue
        buffer += stripped
        if buffer.strip():
            commands.append(buffer)
        buffer = ''
    if buffer.strip():
        commands.append(buffer)
    return commands


def documented_flags(text, program):
    """The flags a document shows on a command line that invokes `program`."""
    found = set()
    for command in logical_commands(text):
        if program in command:
            found |= set(FLAG.findall(command))
    return found


def flat(text):
    """Whitespace-normalised text, for sentences that wrap across lines."""
    return re.sub(r'\s+', ' ', text)


def parser_flags(script, args=('--help',)):
    done = subprocess.run([sys.executable, '-B', script] + list(args), capture_output=True, text=True)
    return set(FLAG.findall(done.stdout + done.stderr))


class DocumentsMatchPrograms(unittest.TestCase):

    def test_the_arm_example_carries_every_required_flag(self):
        text = read('release-readiness-runbook.md')
        self.assertIn('arm_with_relay.py', text)
        for required in ('--state-dir', '--ledger-root', '--relay-url', '--relay-token-file', '--epoch'):
            self.assertIn(required, text, 'the runbook must show %s, which the tool requires' % required)

    def test_a_command_line_that_omits_a_required_flag_is_caught(self):
        """The exact defect T216 was raised for: a runbook example that would fail at the keyboard."""
        broken = 'python -B tools/service/arm_with_relay.py --state-dir STATE --epoch E\n'
        required = {'--state-dir', '--ledger-root', '--relay-url', '--relay-token-file', '--epoch'}
        self.assertTrue(required - documented_flags(broken, 'arm_with_relay.py'),
                        'a partial invocation must be detectable by the same extraction the suite uses')
        good = read('release-readiness-runbook.md')
        self.assertEqual(required - documented_flags(good, 'arm_with_relay.py'), set())

    def test_every_documented_flag_exists_in_the_program(self):
        cases = (('release-readiness-runbook.md', ARM, 'arm_with_relay.py'),
                 ('release-readiness-runbook.md', AUDIT, 'readiness_audit.py'),
                 ('release-readiness-runbook.md', SHADOW, 'shadow_observe.py'),
                 ('release-readiness-checklist.md', ARM, 'arm_with_relay.py'),
                 ('release-readiness-checklist.md', AUDIT, 'readiness_audit.py'),
                 ('release-readiness-checklist.md', SHADOW, 'shadow_observe.py'))
        for doc, script, name in cases:
            known = parser_flags(script)
            shown = documented_flags(read(doc), name)
            unknown = {flag for flag in shown if flag not in known and flag not in ('--help',)}
            self.assertEqual(unknown, set(), '%s shows flags %s that %s does not accept' % (doc, unknown, name))

    def test_the_host_flags_the_runbook_uses_are_real(self):
        known = parser_flags(HOST)
        text = read('release-readiness-runbook.md') + read('release-readiness-checklist.md')
        for flag in ('--state-dir', '--manifest', '--bridge-db', '--native-root',
                     '--ledger-root', '--relay-url', '--relay-token-file'):
            self.assertIn(flag, known, '%s is not a host flag' % flag)
            self.assertIn(flag, text, '%s is a host flag the documents should mention' % flag)


class OrderingIsHonest(unittest.TestCase):

    def test_the_audit_is_not_presented_as_passing_before_the_switch(self):
        text = flat(read('release-readiness-runbook.md'))
        self.assertIn('before** the audit can return GO', text)
        self.assertIn('verdict on the *new* install', text)
        # the launcher and the extension steps must be numbered before the GO check
        order = [text.index(marker) for marker in
                 ('Rebuild the launcher with relay flags', 'Reload the extension', 'Re-run the audit against the new install')]
        self.assertEqual(order, sorted(order), 'launcher and extension must be repaired before the audit can say GO')

    def test_the_checklist_names_both_blocking_manual_steps(self):
        text = read('release-readiness-checklist.md')
        self.assertIn('Launcher rebuilt', text)
        self.assertIn('Extension reloaded', text)
        self.assertIn('NO-GO', text)

    def test_the_documents_do_not_promise_a_host_only_switch(self):
        for name in ('release-readiness-runbook.md', 'release-readiness-checklist.md'):
            text = flat(read(name)).lower()
            self.assertNotIn('only swap the host is safe', text)
            self.assertTrue(('no other step can enable relay' in text or 'not safe' in text
                             or 'cannot reach a relay service' in text),
                            '%s must state that a host-only swap cannot enable relay' % name)


class LauncherEntryIsDescribedTruthfully(unittest.TestCase):

    def test_the_runbook_matches_what_the_launcher_actually_passes(self):
        with open(os.path.join(ROOT, 'launcher', 'HostLauncher.cs'), encoding='utf-8') as handle:
            source = handle.read()
        # the launcher builds the command line itself
        self.assertIn('--state-dir', source)
        self.assertIn('--manifest', source)
        self.assertNotIn('--relay-url', source, 'if the launcher ever forwards relay flags, update the runbook first')
        runbook = read('release-readiness-runbook.md')
        self.assertIn('passes **only** `--state-dir', runbook)
        self.assertIn('launcher.forwards_relay_flag', runbook)

    def test_the_audit_reads_the_launcher_bytes_rather_than_a_claim(self):
        sys.path.insert(0, os.path.join(ROOT, 'tools', 'rollout'))
        import readiness_audit
        work = tempfile.mkdtemp(prefix='t216-launcher-')
        self.addCleanup(shutil.rmtree, work, True)
        quiet = os.path.join(work, 'quiet.exe')
        with open(quiet, 'wb') as handle:
            handle.write(b'MZ' + b'\x00' * 200)
        loud = os.path.join(work, 'loud.exe')
        with open(loud, 'wb') as handle:
            handle.write(b'MZ\x00 --relay-url \x00' + b'\x00' * 200)
        self.assertIs(readiness_audit.launcher_forwards(quiet), False)
        self.assertIs(readiness_audit.launcher_forwards(loud), True)
        self.assertIsNone(readiness_audit.launcher_forwards(os.path.join(work, 'absent.exe')))


class Rehearsal(unittest.TestCase):
    """Backup, switch, rollback -- on a fake install, in one temporary directory."""

    def setUp(self):
        self.work = tempfile.mkdtemp(prefix='t216-drill-')
        self.addCleanup(shutil.rmtree, self.work, True)
        self.install = os.path.join(self.work, 'install')
        os.makedirs(os.path.join(self.install, 'extension', 'lib'))
        self._write(os.path.join(self.install, 'host.py'), 'import sys\nOPS = ()\n')
        self._write(os.path.join(self.install, 'host_launcher.exe'), 'MZ launcher --state-dir --manifest\n')
        self._write(os.path.join(self.install, 'host_manifest.json'),
                    json.dumps({'name': 'com.dsh.notify', 'type': 'stdio',
                                'path': os.path.join(self.install, 'host_launcher.exe'),
                                'allowed_origins': [EXT]}))
        self._write(os.path.join(self.install, 'extension', 'background.js'), 'const a = 1;\n')
        self._write(os.path.join(self.install, 'extension', 'lib', 'terminal_trigger.js'), 'export const x = 1;\n')
        self.backup = os.path.join(self.work, 'backup')

    def _write(self, path, text):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(text)

    def _digests(self, base):
        out = {}
        for root, _dirs, files in os.walk(base):
            for name in files:
                path = os.path.join(root, name)
                with open(path, 'rb') as handle:
                    out[os.path.relpath(path, base)] = hashlib.sha256(handle.read()).hexdigest()
        return out

    def _audit(self, installed):
        done = subprocess.run([sys.executable, '-B', AUDIT, '--audit', '--repo-root', ROOT,
                               '--installed-root', installed,
                               '--manifest', os.path.join(installed, 'host_manifest.json'), '--json'],
                              capture_output=True, text=True)
        return json.loads(done.stdout)

    def test_backup_then_switch_then_rollback_restores_bytes_and_verdict(self):
        before_files = self._digests(self.install)
        before = self._audit(self.install)
        self.assertEqual(before['verdict']['decision'], 'NO-GO')

        shutil.copytree(self.install, self.backup)
        with open(os.path.join(self.backup, 'SHA256SUMS.txt'), 'w', encoding='utf-8') as handle:
            for rel, digest in sorted(self._digests(self.backup).items()):
                handle.write('%s  %s\n' % (digest.upper(), rel.replace('/', '\\')))

        # the switch: new host, launcher that forwards the flag, extension with the epoch binding
        self._write(os.path.join(self.install, 'host.py'), 'import sys\nOPS = ()\nRELAY = "--relay-url"\n')
        self._write(os.path.join(self.install, 'host_launcher.exe'), 'MZ launcher --state-dir --manifest --relay-url\n')
        self._write(os.path.join(self.install, 'extension', 'lib', 'terminal_trigger.js'),
                    'export function postArmUsable() {}\n')
        switched = self._audit(self.install)
        self.assertTrue(switched['launcher']['forwards_relay_flag'])

        # the rollback
        shutil.rmtree(self.install)
        shutil.copytree(self.backup, self.install)
        os.remove(os.path.join(self.install, 'SHA256SUMS.txt'))
        after_files = self._digests(self.install)
        self.assertEqual(after_files, before_files, 'rollback must restore every byte')
        after = self._audit(self.install)
        self.assertEqual(after['verdict']['blocking_failed'], before['verdict']['blocking_failed'])
        self.assertEqual(after['launcher']['forwards_relay_flag'], before['launcher']['forwards_relay_flag'])

    def test_the_drill_touches_nothing_outside_its_own_directory(self):
        outside = os.path.join(ROOT, 'docs', 'release-readiness-checklist.md')
        with open(outside, 'rb') as handle:
            before = hashlib.sha256(handle.read()).hexdigest()
        self._audit(self.install)
        with open(outside, 'rb') as handle:
            self.assertEqual(hashlib.sha256(handle.read()).hexdigest(), before)

    def test_a_failing_acceptance_item_identifies_the_layer(self):
        """The runbook's rollback is per layer; the audit must name the layer that failed."""
        report = self._audit(self.install)
        self.assertIn('launcher_passes_relay', report['verdict']['blocking_failed'])
        self.assertIn('installed_ext_epoch_bound', report['verdict']['blocking_failed'])
        self.assertIn('installed_host_reads_relay', report['verdict']['blocking_failed'])


class ArmCli(unittest.TestCase):

    def test_arm_with_relay_refuses_without_the_relay_flags(self):
        done = subprocess.run([sys.executable, '-B', ARM, '--state-dir', 'x', '--epoch', 'e'],
                              capture_output=True, text=True)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('--ledger-root', done.stderr)
        self.assertIn('--relay-url', done.stderr)
        self.assertIn('--relay-token-file', done.stderr)

    def test_arm_with_relay_refuses_an_unreachable_relay_with_a_named_code(self):
        work = tempfile.mkdtemp(prefix='t216-arm-')
        self.addCleanup(shutil.rmtree, work, True)
        state = os.path.join(work, 'state')
        os.makedirs(state)
        ledger = os.path.join(work, 'ledger', 'a' * 64)
        os.makedirs(ledger)
        with open(os.path.join(ledger, 'endpoint.json.runs.json'), 'w', encoding='utf-8') as handle:
            json.dump([], handle)
        token = os.path.join(work, 'service.token')
        with open(token, 'w', encoding='utf-8') as handle:
            handle.write('x' * 48 + '\n')
        done = subprocess.run([sys.executable, '-B', ARM, '--state-dir', state, '--ledger-root',
                               os.path.join(work, 'ledger'), '--relay-url', 'http://127.0.0.1:9',
                               '--relay-token-file', token, '--epoch', 'e1', '--json'],
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 1, done.stderr)
        report = json.loads(done.stdout)
        self.assertFalse(report['ok'])
        self.assertEqual(report['code'], 'relay_source_unavailable_for_arm')
        self.assertFalse(os.path.exists(os.path.join(state, 'terminal-arm.json')),
                         'a refused arm must not leave a snapshot behind')


if __name__ == '__main__':
    unittest.main()
