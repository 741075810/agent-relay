// T201: event identity must bind id -> (task, kind), the horizon must refuse what it cannot prove, and a second
// interruption must not reuse the first recovery id.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const SERVICE = path.join(process.cwd(), 'tools', 'service', 'relay_service.mjs');
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'agentrelay-ident-'));

async function startService(stateDir, extraArgs = []) {
  const child = spawn(process.execPath, [SERVICE, '--state-dir', stateDir, ...extraArgs],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no start: ' + stderr)), 10000);
    createInterface({ input: child.stdout }).once('line', (line) => { clearTimeout(timer); resolve(JSON.parse(line)); });
  });
  const auth = { 'content-type': 'application/json',
    authorization: 'Bearer ' + readFileSync(ready.tokenFile, 'utf8').trim() };
  return {
    base: ready.base, stderr,
    get: (p) => fetch(ready.base + p, { headers: auth }).then(async (r) => ({ status: r.status, body: await r.json() })),
    post: (p, body) => fetch(ready.base + p, { method: 'POST', headers: auth, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() })),
    async stop() {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      });
    },
  };
}

const submit = async (service, key) => (await service.post('/tasks',
  { goal: 'g', clientKey: key })).body.task.taskId;

test('T201: an event id reused for another task is a conflict, not a retry', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const a = await submit(service, 'k-a');
    const b = await submit(service, 'k-b');
    const first = await service.post('/tasks/transition', { taskId: a, status: 'running', eventId: 'e-shared' });
    assert.equal(first.status, 200);

    const other = await service.post('/tasks/transition', { taskId: b, status: 'running', eventId: 'e-shared' });
    assert.equal(other.status, 409);
    assert.equal(other.body.error, 'event_id_conflict');
    assert.equal(other.body.detail.knownTaskId, a);
    assert.equal(other.body.detail.taskId, b);

    const untouched = await service.get('/tasks/get?taskId=' + b);
    assert.equal(untouched.body.task.status, 'queued', 'the conflicting request changed nothing');
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T201: an event id reused for a different kind of move is a conflict', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const taskId = await submit(service, 'k-kind');
    await service.post('/tasks/transition', { taskId, status: 'running', eventId: 'e-move' });
    const wrongKind = await service.post('/tasks/transition', { taskId, status: 'completed', eventId: 'e-move' });
    assert.equal(wrongKind.status, 409);
    assert.equal(wrongKind.body.error, 'event_id_conflict');
    assert.equal(wrongKind.body.detail.knownType, 'task_running');
    assert.equal(wrongKind.body.detail.type, 'task_completed');
    const task = await service.get('/tasks/get?taskId=' + taskId);
    assert.equal(task.body.task.status, 'running', 'the refusal left the task where it was');
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T201: the same id and the same intent is still a clean duplicate', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const taskId = await submit(service, 'k-dup');
    const first = await service.post('/tasks/transition', { taskId, status: 'running', eventId: 'e-dup' });
    const again = await service.post('/tasks/transition', { taskId, status: 'running', eventId: 'e-dup' });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.seq, first.body.seq);
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T201: a free-form event id reused with a different type or task is a conflict', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    await service.post('/events', { eventId: 'x-1', type: 'task_completed', taskId: 'task-a' });
    const sameType = await service.post('/events', { eventId: 'x-1', type: 'task_completed', taskId: 'task-a' });
    assert.equal(sameType.body.duplicate, true);
    const otherTask = await service.post('/events', { eventId: 'x-1', type: 'task_completed', taskId: 'task-b' });
    assert.equal(otherTask.status, 409);
    assert.equal(otherTask.body.error, 'event_id_conflict');
    const otherType = await service.post('/events', { eventId: 'x-1', type: 'task_failed', taskId: 'task-a' });
    assert.equal(otherType.status, 409);
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T201: past the ledger horizon a new id is refused unless the caller asserts it is new', async () => {
  const dir = tempDir();
  const service = await startService(dir, ['--seen-cap', '4']);
  try {
    for (let i = 0; i < 4; i += 1) {
      const r = await service.post('/events', { eventId: 'h-' + i, type: 'task_completed' });
      assert.equal(r.body.duplicate, false);
    }
    const full = await service.get('/health');
    assert.equal(full.body.dedupeWindow.evicted, 0);

    await service.post('/events', { eventId: 'h-4', type: 'task_completed' });
    const evicted = await service.get('/health');
    assert.equal(evicted.body.dedupeWindow.evicted, 1, 'the horizon is reported once something fell out of it');

    const blind = await service.post('/events', { eventId: 'h-unknown', type: 'task_completed' });
    assert.equal(blind.status, 409);
    assert.equal(blind.body.error, 'dedupe_unverifiable', 'an unverifiable id is not silently accepted');
    assert.equal(blind.body.detail.evicted, 1);

    const declared = await service.post('/events',
      { eventId: 'h-unknown', type: 'task_completed', expectNew: true });
    assert.equal(declared.status, 201);
    assert.equal(declared.body.duplicate, false);

    const known = await service.post('/events', { eventId: 'h-4', type: 'task_completed' });
    assert.equal(known.body.duplicate, true, 'ids still inside the window stay deduped');
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T201: the horizon survives a restart and keeps refusing', async () => {
  const dir = tempDir();
  const first = await startService(dir, ['--seen-cap', '2']);
  try {
    await first.post('/events', { eventId: 'r-1', type: 'task_completed' });
    await first.post('/events', { eventId: 'r-2', type: 'task_completed' });
    await first.post('/events', { eventId: 'r-3', type: 'task_completed' });
  } finally {
    await first.stop();
  }
  const second = await startService(dir, ['--seen-cap', '2']);
  try {
    const health = await second.get('/health');
    assert.equal(health.body.dedupeWindow.evicted, 1);
    const blind = await second.post('/events', { eventId: 'r-new', type: 'task_completed' });
    assert.equal(blind.status, 409);
    assert.equal(blind.body.error, 'dedupe_unverifiable');
  } finally {
    await second.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T201: a second interruption after requeue gets its own event id', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  let taskId;
  try {
    taskId = await submit(service, 'k-twice');
    await service.post('/lease', { sessionId: 's', controllerId: 'c', ttlMs: 1000 });
    await service.post('/tasks/transition', { taskId, status: 'running' });
  } finally {
    await service.stop();
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const second = await startService(dir);
  try {
    const recovered = await second.get('/events?since=0');
    assert.deepEqual(recovered.body.events.filter((e) => e.type === 'task_interrupted').map((e) => e.eventId),
      ['recovered:' + taskId + ':1']);

    // Requeue, run again, crash again.
    await second.post('/tasks/transition', { taskId, status: 'queued' });
    await second.post('/lease', { sessionId: 's', controllerId: 'c', ttlMs: 1000 });
    await second.post('/tasks/transition', { taskId, status: 'running' });
  } finally {
    await second.stop();
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const third = await startService(dir);
  try {
    const events = await third.get('/events?since=0');
    const interruptions = events.body.events.filter((e) => e.type === 'task_interrupted');
    assert.deepEqual(interruptions.map((e) => e.eventId),
      ['recovered:' + taskId + ':1', 'recovered:' + taskId + ':2'],
      'the second recovery is recorded, not swallowed as a duplicate of the first');
    const task = await third.get('/tasks/get?taskId=' + taskId);
    assert.equal(task.body.task.status, 'interrupted');
  } finally {
    await third.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T201: a restart in the middle does not change any of it', async () => {
  const dir = tempDir();
  const first = await startService(dir);
  let taskId;
  try {
    taskId = await submit(first, 'k-restart');
    // Complete it rather than leave it running: a `running` task with no live lease is *supposed* to be recovered as
    // interrupted on restart, and this test is about the ledger, not about recovery.
    await first.post('/tasks/transition', { taskId, status: 'completed', eventId: 'e-once' });
  } finally {
    await first.stop();
  }
  const second = await startService(dir);
  try {
    const dup = await second.post('/tasks/transition', { taskId, status: 'completed', eventId: 'e-once' });
    assert.equal(dup.body.duplicate, true, 'the typed ledger survives the restart');
    const otherTask = await submit(second, 'k-restart-2');
    const conflict = await second.post('/tasks/transition',
      { taskId: otherTask, status: 'completed', eventId: 'e-once' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'event_id_conflict');
    const events = await second.get('/events?since=0');
    assert.equal(events.body.events.filter((e) => e.eventId === 'e-once').length, 1);
  } finally {
    await second.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
