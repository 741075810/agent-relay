import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { admissionGate, runPreparedOwner, requestIdFor } from './tools/dsh-direct/productive_owner.mjs';
import { MANIFEST, expectedDocument, repositoryBaseline, verifyArtifact, verifyWithNamedTest } from './tools/dsh-direct/productive_manifest.mjs';
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
