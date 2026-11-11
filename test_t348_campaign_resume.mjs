// T348: the read-only resume view of an interrupted campaign.
//
// The property under test is narrow and load-bearing: this module must be able to say
// where an interrupted campaign stopped, using only persisted immutable IDs, and must
// never make a request replayable. Every case here is a real directory and real files --
// no mocks of the module being tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCampaign } from './tools/dsh-direct/productive_state.mjs';
import { resumeCampaign, DISPATCH_GATE } from './tools/dsh-direct/productive_resume.mjs';
import { admissionGate } from './tools/dsh-direct/productive_owner.mjs';
import { sha256 } from './tools/dsh-direct/productive_manifest.mjs';

const REQUEST = index => 'productive-' + String(index).repeat(64);
const TASK = 'dshd-aaaaaaaaaaaaaaaa';
const TURN = 'turn-0001';

function campaign(t, rows = []) {
  const root = mkdtempSync(join(tmpdir(), 't348-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'campaign');
  const plan = { campaignId: 'fixture', sessionId: 'session-fixture',
    jobs: [{ index: 0, requestId: REQUEST(0) }, { index: 1, requestId: REQUEST(1) }] };
  const journal = openCampaign(dir, plan);
  for (const row of rows) journal.record(row);
  return { dir, journal, plan };
}

function settled(rows = []) {
  return [{ stage: 'activation' },
    { stage: 'admissible', requestId: REQUEST(0) },
    { stage: 'dispatch_reserved', requestId: REQUEST(0) },
    { stage: 'receipt_observed', requestId: REQUEST(0), taskId: TASK, turnId: TURN,
      state: 'running', requiresReconcile: false },
    ...rows];
}

function snapshot(dir) {
  return readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name)).toString('base64')]);
}

test('T348 a reserved dispatch without a terminal is never resumable', async t => {
  const { dir, journal } = campaign(t, settled());
  journal.close();
  const view = resumeCampaign(dir);
  assert.equal(view.code, 'reservation_unsettled');
  assert.equal(view.resumable, false);
  assert.deepEqual(view.alreadyAdmitted, [REQUEST(0)]);
  assert.equal(view.pending, true);
});

test('T348 dependent work resumes only after the exact recorded terminal', async t => {
  const { dir, journal } = campaign(t, settled([
    { stage: 'terminal', requestId: REQUEST(0), taskId: TASK, turnId: TURN,
      state: 'succeeded', admission: { seq: 41 }, terminal: { kind: 'completed' } },
    { stage: 'artifact_verified', requestId: REQUEST(0) }]));
  journal.close();
  const view = resumeCampaign(dir);
  assert.equal(view.code, 'ready');
  assert.equal(view.resumable, true);
  assert.equal(view.dispatchAllowed, false);
  assert.deepEqual(view.settled, [REQUEST(0)]);
  assert.equal(view.nextJobIndex, 1);
});

test('T348 a terminal whose turn disagrees with its receipt is refused', async t => {
  const { dir, journal } = campaign(t, settled([
    { stage: 'terminal', requestId: REQUEST(0), taskId: TASK, turnId: 'turn-other',
      state: 'succeeded', admission: { seq: 41 } }]));
  journal.close();
  const view = resumeCampaign(dir);
  assert.equal(view.code, 'terminal_identity_mismatch');
  assert.equal(view.requestId, REQUEST(0));
});

test('T348 a paused campaign reports state and admits nothing', async t => {
  const { dir, journal } = campaign(t, [{ stage: 'activation' }]);
  journal.close();
  writeFileSync(join(dir, 'control.json'), JSON.stringify({ mode: 'pause', revision: 2 }));
  const view = resumeCampaign(dir);
  assert.equal(view.code, 'paused');
  assert.equal(view.dispatchAllowed, false);
  assert.equal(view.awaiting, 'control mode run');
});

test('T348 a stop flag outranks a campaign that looks resumable', async t => {
  const { dir, journal } = campaign(t, settled([
    { stage: 'terminal', requestId: REQUEST(0), taskId: TASK, turnId: TURN,
      state: 'succeeded', admission: { seq: 41 } }]));
  journal.close();
  writeFileSync(join(dir, 'control.json'), JSON.stringify({ mode: 'stop', revision: 3 }));
  const view = resumeCampaign(dir);
  assert.equal(view.code, 'operator_stop');
  assert.equal(view.resumable, false);
});

test('T348 a finished campaign is an idempotent no-op', async t => {
  const { dir, journal } = campaign(t, settled([
    { stage: 'terminal', requestId: REQUEST(0), taskId: TASK, turnId: TURN,
      state: 'succeeded', admission: { seq: 41 } },
    { stage: 'campaign_verified' }]));
  journal.close();
  const view = resumeCampaign(dir);
  assert.equal(view.code, 'campaign_complete');
  assert.equal(view.resumable, false);
  assert.equal(view.dispatchAllowed, false);
});

test('T348 a row from another generation is not evidence', async t => {
  const { dir, journal } = campaign(t, [{ stage: 'activation' }]);
  journal.close();
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(
    { stage: 'activation', sequence: 2, at: Date.now(), planSha256: 'f'.repeat(64) }) + '\n');
  assert.equal(resumeCampaign(dir).code, 'journal_foreign_generation');
});

test('T348 a sequence gap is refused rather than skipped', async t => {
  const { dir, journal } = campaign(t, [{ stage: 'activation' }]);
  journal.close();
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(
    { stage: 'activation', sequence: 7, at: Date.now(), planSha256: sha256(JSON.stringify(plan)) }) + '\n');
  assert.equal(resumeCampaign(dir).code, 'journal_sequence_gap');
});

test('T348 reading a campaign changes no byte of it', async t => {
  const { dir, journal } = campaign(t, settled([
    { stage: 'terminal', requestId: REQUEST(0), taskId: TASK, turnId: TURN,
      state: 'succeeded', admission: { seq: 41 } },
    { stage: 'admissible', requestId: REQUEST(1) },
    { stage: 'dispatch_reserved', requestId: REQUEST(1) }]));
  journal.close();
  const before = snapshot(dir);
  assert.equal(resumeCampaign(dir).code, 'reservation_unsettled');
  assert.deepEqual(snapshot(dir), before);
});

test('T348 no resume view can dispatch while the admission gate is shut', async t => {
  const { dir, journal } = campaign(t, [{ stage: 'activation' }]);
  journal.close();
  assert.equal(DISPATCH_GATE, 'writer_fencing_unavailable');
  assert.equal(admissionGate().code, DISPATCH_GATE);
  const view = resumeCampaign(dir);
  assert.equal(view.dispatchAllowed, false);
  assert.equal(view.gate, DISPATCH_GATE);
});
