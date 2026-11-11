import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { admissionGate, runPreparedOwner, requestIdFor } from './tools/dsh-direct/productive_owner.mjs';
import { MANIFEST, campaignFile, expectedDocument, repositoryBaseline, verifyArtifact, verifyWithNamedTest } from './tools/dsh-direct/productive_manifest.mjs';
import { openCampaign, readControl } from './tools/dsh-direct/productive_state.mjs';

const sourceRoot = dirname(fileURLToPath(import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 't336-'));
  for (const relative of [MANIFEST.path, MANIFEST.test, 'tools/dsh-direct/schedule_after_turn.ps1', 'tools/dsh-direct/scheduler_shell.ps1']) {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    copyFileSync(join(sourceRoot, relative), join(root, relative));
  }
  writeFileSync(join(root, '.gitattributes'), '* text eol=lf\n');
  const git = args => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
  git(['init', '-q']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=NUL', 'commit', '-qm', 'fixture']);
  return root;
}

test('T336 disabled and missing deployment fence perform zero client operations', async () => {
  const client = new Proxy({}, { get() { throw Error('client touched'); } });
  assert.deepEqual(await runPreparedOwner({ client }), { code: 'disabled', submitted: false });
  assert.deepEqual(await runPreparedOwner({ enabled: true, client }), admissionGate());
  assert.equal(admissionGate().code, 'writer_fencing_unavailable');
  assert.equal(requestIdFor('session', 'campaign', 0), requestIdFor('session', 'campaign', 0));
  assert.notEqual(requestIdFor('session', 'campaign', 0), requestIdFor('session', 'campaign', 1));
});

test('T336 real git diff and fixed named test establish artifact acceptance, not prose', { skip: process.platform !== 'win32' }, () => {
  const root = fixture();
  try {
    const baseline = repositoryBaseline(root);
    verifyArtifact(baseline, { pristine: true });
    assert.throws(() => verifyArtifact(baseline), /diff_outside_manifest/);
    const file = join(root, MANIFEST.path), original = readFileSync(file, 'utf8');
    const expected = expectedDocument(original);
    writeFileSync(file, expected);
    assert.equal(verifyArtifact(baseline).sha256, baseline.expectedSha256);
    const verified = verifyWithNamedTest(baseline);
    assert.equal(verified.testExitCode, 0); assert.equal(verified.exactDiff, true);
    writeFileSync(join(root, 'unapproved.txt'), 'no');
    assert.throws(() => verifyArtifact(baseline), /diff_outside_manifest/);
    rmSync(join(root, 'unapproved.txt'));
    writeFileSync(file, expected + '\nextra');
    assert.throws(() => verifyArtifact(baseline), /artifact_content_mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T336 named-test launch fails closed before subprocesses when SystemRoot is unavailable', { skip: process.platform !== 'win32' }, () => {
  const original = process.env.SystemRoot;
  try {
    for (const value of [undefined, '', ' ', '.', '/relative', '\\relative', 'X:relative', ' ' + original]) {
      if (value === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = value;
      // A null baseline would fail in verifyArtifact: this proves the environment guard runs first.
      assert.throws(() => verifyWithNamedTest(null), { message: 'system_root_unavailable' });
    }
  } finally {
    if (original === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = original;
  }
});

// Run 42992116493 published `Error: repository_root_mismatch` from
// `productive_manifest.mjs:33` on the Windows runner while the same fixture was green here.
// The cause was spelling, not location: `realpathSync()` returns the case it was handed and
// `git rev-parse --show-toplevel` returns the volume's, so one directory was two strings.
// The strict half of this case matters as much as the forgiving half: a subdirectory is still
// not the repository root.
test('T336 a root spelled with another case is the same repository, a subdirectory is not', { skip: process.platform !== 'win32' }, () => {
  const root = fixture();
  try {
    const baseline = repositoryBaseline(root);
    const recased = root.toUpperCase();
    assert.notEqual(recased, root, 'the fixture path must contain a letter to recase');
    const again = repositoryBaseline(recased);
    assert.equal(again.head, baseline.head);
    // `repoRoot` is reported as the caller spelled it -- `realpathSync()` does not recase a
    // path it is handed -- so the same directory is asserted here, not the same string.
    assert.equal(again.repoRoot.toLowerCase(), baseline.repoRoot.toLowerCase());
    assert.throws(() => repositoryBaseline(join(root, 'tools')), /repository_root_mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Run 42995856154 published `Error: non_regular_campaign_file` from `productive_manifest.mjs:47`
// for a plain file in a clean fixture repository, because the fixture root reached it in 8.3 form
// and the check compared a native-expanded path against a lexically resolved one. Both sides are
// physical now, so a short name or a junction is a spelling; a symlinked leaf, a detour inside the
// repository and a path that lands outside it are still refusals.
test('T336 an aliased root spelling is accepted, a symlinked leaf and an escape are not', { skip: process.platform !== 'win32' }, t => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), 't336-outside-'));
  const junctionRoot = join(mkdtempSync(join(tmpdir(), 't336-junction-')), 'linked');
  try {
    const baseline = repositoryBaseline(root);
    const shortName = value => {
      try {
        const command = `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${value}').ShortPath`;
        const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command],
          { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim();
        return out === '' ? null : out;
      } catch { return null; }
    };
    // 1. The form the Windows runner hands out: an 8.3 component in the fixture root.
    const short = shortName(root);
    if (short === null || short === root) t.diagnostic('no 8.3 spelling for the fixture root; skipped');
    else {
      const again = repositoryBaseline(short);
      assert.equal(again.head, baseline.head);
      assert.equal(verifyArtifact(again, { pristine: true }).sha256, baseline.originalSha256);
      assert.equal(campaignFile(short, MANIFEST.path), readFileSync(join(root, MANIFEST.path), 'utf8'));
    }
    // 2. A junction onto the same repository is the same repository.
    symlinkSync(root, junctionRoot, 'junction');
    assert.equal(repositoryBaseline(junctionRoot).head, baseline.head);
    assert.equal(campaignFile(junctionRoot, MANIFEST.path), campaignFile(root, MANIFEST.path));

    // 3. Names are not paths: traversal and absolute spellings are refused lexically.
    assert.throws(() => campaignFile(root, '../outside.md'), /campaign_path_invalid/);
    assert.throws(() => campaignFile(root, join(root, MANIFEST.path)), /campaign_path_invalid/);
    // 4. Missing, a directory and a symlinked leaf are not campaign files.
    assert.throws(() => campaignFile(root, 'tools/dsh-direct/absent.md'), /non_regular_campaign_file/);
    assert.throws(() => campaignFile(root, 'tools'), /non_regular_campaign_file/);
    const leaf = join(root, MANIFEST.path), body = readFileSync(leaf, 'utf8');
    writeFileSync(join(outside, 'body.md'), body);
    rmSync(leaf);
    try {
      symlinkSync(join(outside, 'body.md'), leaf, 'file');
      assert.throws(() => campaignFile(root, MANIFEST.path), /non_regular_campaign_file/);
      // ... even when the link itself is committed, so only the leaf check can refuse it.
      const git = args => execFileSync('git', ['-c', 'core.autocrlf=false', ...args],
        { cwd: root, encoding: 'utf8', timeout: 10000 });
      git(['add', '-A']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'core.hooksPath=NUL', 'commit', '-qm', 'link']);
      assert.throws(() => repositoryBaseline(root), /non_regular_campaign_file/);
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'UNKNOWN') throw error;
      t.diagnostic('file symlinks unavailable here: ' + error.code);
    }
    // Put the ordinary file back: the detour case below must fail on the detour, not on a link.
    rmSync(leaf, { force: true });
    writeFileSync(leaf, body);
    // 5. An ancestor that leaves the repository is an escape, one that stays inside is a detour.
    mkdirSync(join(outside, 'nested'));
    writeFileSync(join(outside, 'nested', 'extra.md'), 'outside');
    symlinkSync(join(outside, 'nested'), join(root, 'escape'), 'junction');
    assert.throws(() => campaignFile(root, 'escape/extra.md'), /outside_repository_root/);
    symlinkSync(join(root, 'tools'), join(root, 'detour'), 'junction');
    assert.throws(() => campaignFile(root, 'detour/dsh-direct/AFTER_TURN_ONCE.md'), /campaign_file_detour/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(dirname(junctionRoot), { recursive: true, force: true });
  }
});

test('T336 durable controls and evidence never overwrite an existing campaign', () => {
  const root = mkdtempSync(join(tmpdir(), 't336-state-')), directory = join(root, 'campaign');
  try {
    const journal = openCampaign(directory, { id: 'fixture' });
    journal.record({ stage: 'dispatch_reserved', requestId: 'fixture-request' });
    assert.equal(journal.control().mode, 'run');
    writeFileSync(join(directory, 'control.json'), JSON.stringify({ mode: 'pause', revision: 2 }));
    assert.equal(readControl(join(directory, 'control.json')).mode, 'pause');
    writeFileSync(join(directory, 'control.json'), JSON.stringify({ mode: 'stop', revision: 3 }));
    assert.equal(journal.control().mode, 'stop');
    journal.close();
    const before = readFileSync(join(directory, 'events.jsonl'), 'utf8');
    assert.throws(() => openCampaign(directory, { id: 'different' }), /EEXIST/);
    assert.equal(readFileSync(join(directory, 'events.jsonl'), 'utf8'), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
