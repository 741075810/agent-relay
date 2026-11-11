// T349: the owner's read-only `--status` path, over real campaign and ledger files.
//
// The point of the path is that an unattended caller can ask "where did this campaign
// stop, and may anything run" and get an answer that cannot be mistaken for permission.
// Every case drives the real CLI; no case mocks the modules under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCampaign } from './tools/dsh-direct/productive_state.mjs';
import { admissionGate } from './tools/dsh-direct/productive_owner.mjs';

const CLI = fileURLToPath(new URL('./tools/dsh-direct/productive_owner.mjs', import.meta.url));
const REQUEST = index => 'productive-' + String(index).repeat(64);
const TASK = 'dshd-aaaaaaaaaaaaaaaa';
const TURN = 'turn-0001';

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 't349-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function campaign(t, rows = []) {
  const dir = join(scratch(t), 'campaign');
  const journal = openCampaign(dir, { campaignId: 'fixture', sessionId: 'session-fixture',
    jobs: [{ index: 0, requestId: REQUEST(0) }, { index: 1, requestId: REQUEST(1) }] });
  for (const row of rows) journal.record(row);
  journal.close();
  return dir;
}

function settledRows() {
  return [{ stage: 'activation' },
    { stage: 'admissible', requestId: REQUEST(0) },
    { stage: 'dispatch_reserved', requestId: REQUEST(0) },
    { stage: 'receipt_observed', requestId: REQUEST(0), taskId: TASK, turnId: TURN,
      state: 'running', requiresReconcile: false },
    { stage: 'terminal', requestId: REQUEST(0), taskId: TASK, turnId: TURN,
      state: 'succeeded', admission: { seq: 41 } }];
}

function writeLedger(dir, tasks, requestIds) {
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 1, tasks, requestIds }));
  return join(dir, 'tasks.json');
}

function task(state = 'running') {
  return { taskId: TASK, requestId: REQUEST(0), sessionId: 'session-fixture', projectId: '/p',
    state, promptSha256: 'a'.repeat(64), stages: [], turnId: state === 'succeeded' ? TURN : null,
    requiresReconcile: false };
}

function status(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    return { exit: 0, view: JSON.parse(stdout.trim()) };
  } catch (error) {
    const stdout = String(error.stdout ?? '').trim();
    return { exit: error.status ?? -1, view: stdout ? JSON.parse(stdout) : null };
  }
}

function bytes(path) {
  return readFileSync(path);
}

test('T349 the default invocation is still inert', async t => {
  const cwd = scratch(t);
  const { exit, view } = status([], { cwd });
  assert.equal(exit, 0);
  assert.deepEqual(view, { code: 'disabled', submitted: false });
  assert.deepEqual(readdirSync(cwd), []);
});

test('T349 a missing campaign is named, not treated as empty', async t => {
  const { exit, view } = status(['--status', join(scratch(t), 'absent')]);
  assert.equal(exit, 2);
  assert.equal(view.code, 'plan_unreadable');
  assert.equal(view.dispatchAllowed, false);
});

test('T349 a crash between reservation and receipt fails closed', async t => {
  // No receipt row: the submit may or may not have reached the ledger.
  const dir = campaign(t, settledRows().slice(0, 3));
  const before = bytes(join(dir, 'events.jsonl'));
  const { exit, view } = status(['--status', dir]);
  assert.equal(exit, 2);
  assert.equal(view.code, 'reservation_unsettled');
  assert.equal(view.blocked.requestId, REQUEST(0));
  assert.equal(view.blocked.pending, true);
  assert.deepEqual(bytes(join(dir, 'events.jsonl')), before);
});

test('T349 a ledger that knows the request still admits nothing', async t => {
  const dir = campaign(t, settledRows().slice(0, 3));
  const stateDir = scratch(t);
  const ledger = writeLedger(stateDir, [task('running')], { [REQUEST(0)]: TASK });
  const before = bytes(ledger);
  const { exit, view } = status(['--status', dir, '--state-dir', stateDir]);
  assert.equal(exit, 2);
  assert.equal(view.code, 'reservation_unsettled');
  assert.equal(view.ledger.status, 'read');
  assert.equal(view.ledger.requestKnown, true);
  assert.equal(view.ledger.observed.state, 'running');
  assert.equal(view.dispatchAllowed, false);
  assert.deepEqual(bytes(ledger), before);
});

test('T349 a ledger that does not know the request is not proof it was never admitted', async t => {
  const dir = campaign(t, settledRows().slice(0, 3));
  const stateDir = scratch(t);
  writeLedger(stateDir, [], {});
  const { exit, view } = status(['--status', dir, '--state-dir', stateDir]);
  assert.equal(exit, 2);
  assert.equal(view.ledger.status, 'read');
  assert.equal(view.ledger.requestKnown, false);
  assert.equal(view.ledger.observed, null);
  assert.equal(view.code, 'reservation_unsettled');
});

test('T349 an absent ledger and an unreadable one are different answers', async t => {
  const dir = campaign(t, settledRows().slice(0, 3));
  const missing = status(['--status', dir, '--state-dir', join(scratch(t), 'none')]);
  assert.equal(missing.view.ledger.status, 'absent');
  assert.equal(missing.view.ledger.code, 'ledger_file_absent');

  const stateDir = scratch(t);
  writeFileSync(join(stateDir, 'tasks.json'), '{ not json');
  const broken = status(['--status', dir, '--state-dir', stateDir]);
  assert.equal(broken.view.ledger.status, 'unreadable');
  assert.equal(broken.view.ledger.code, 'ledger_unreadable');
  assert.equal(broken.exit, 2);
  assert.equal(missing.exit, 2);
});

test('T349 a proven matching terminal is the only thing that advances the campaign', async t => {
  const dir = campaign(t, settledRows());
  const stateDir = scratch(t);
  writeLedger(stateDir, [task('succeeded')], { [REQUEST(0)]: TASK });
  const { exit, view } = status(['--status', dir, '--state-dir', stateDir]);
  assert.equal(exit, 0);
  assert.equal(view.code, 'ready');
  assert.deepEqual(view.settled, [REQUEST(0)]);
  assert.equal(view.nextJobIndex, 1);
  assert.equal(view.blocked, null);
  // Ready is not permission: the gate is still shut.
  assert.equal(view.dispatchAllowed, false);
  assert.equal(view.gate, admissionGate().code);
});

test('T349 a stop flag outranks a campaign whose journal looks resumable', async t => {
  const dir = campaign(t, settledRows());
  writeFileSync(join(dir, 'control.json'), JSON.stringify({ mode: 'stop', revision: 4 }));
  const { exit, view } = status(['--status', dir]);
  assert.equal(exit, 2);
  assert.equal(view.code, 'operator_stop');
  assert.equal(view.resumable, false);
});

test('T349 pause is reported and admits nothing', async t => {
  const dir = campaign(t, [{ stage: 'activation' }]);
  writeFileSync(join(dir, 'control.json'), JSON.stringify({ mode: 'pause', revision: 2 }));
  const { exit, view } = status(['--status', dir]);
  assert.equal(exit, 0);
  assert.equal(view.code, 'paused');
  assert.equal(view.dispatchAllowed, false);
  assert.equal(view.awaiting, 'control mode run');
});

test('T349 the status path never reports a submission', async t => {
  const dir = campaign(t, settledRows());
  const stateDir = scratch(t);
  writeLedger(stateDir, [task('succeeded')], { [REQUEST(0)]: TASK });
  let raw = '';
  try {
    raw = execFileSync(process.execPath, [CLI, '--status', dir, '--state-dir', stateDir],
      { encoding: 'utf8', timeout: 30000 });
  } catch (error) { raw = String(error.stdout ?? ''); }
  assert.equal(/"submitted":\s*[1-9]/.test(raw), false, raw);
  assert.equal(/"productiv[^"]*_verified"/.test(raw), false, raw);
});
