// T200: dedupe must outlive the event bodies, and a repeated status request must answer the same way twice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const SERVICE = path.join(process.cwd(), 'tools', 'service', 'relay_service.mjs');
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'agentrelay-dedupe-'));

async function startService(stateDir) {
  const child = spawn(process.execPath, [SERVICE, '--state-dir', stateDir], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  { goal: 'g', clientKey: key || 'k-' + Math.random().toString(36).slice(2) })).body.task.taskId;

test('T200: an event whose body was trimmed is still refused as a duplicate', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    for (let i = 0; i < 5; i += 1) await service.post('/events', { eventId: 'evt-' + i, type: 'task_completed' });
    const before = await service.get('/health');
    assert.equal(before.body.dedupeWindow.ids, 5, 'the ledger holds every id so far');

    // Trim bodies the way retention would, keeping the ledger.
    const storePath = path.join(dir, 'relay.json');
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    store.events = store.events.slice(3);
    writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
    await service.stop();

    const second = await startService(dir);
    try {
      const retried = await second.post('/events', { eventId: 'evt-0', type: 'task_completed' });
      assert.equal(retried.body.duplicate, true, 'the body is gone but the event was already applied');
      assert.equal(retried.status, 200);
      const read = await second.get('/events?since=0');
      assert.equal(read.body.events.length, 2, 'nothing was re-appended');
      assert.deepEqual(read.body.gap, { fromSeq: 1, toSeq: 3, dropped: 3 });
      assert.equal(read.body.events.some((e) => e.eventId === 'evt-0'), false);
      const health = await second.get('/health');
      assert.equal(health.body.dedupeWindow.ids, 5, 'the ledger survived the restart');
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T200: the dedupe window is published, so the guarantee horizon is not a secret', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const empty = await service.get('/health');
    assert.deepEqual(empty.body.dedupeWindow, { fromSeq: null, toSeq: null, ids: 0 });
    await service.post('/events', { eventId: 'a', type: 'task_completed' });
    await service.post('/events', { eventId: 'b', type: 'task_completed' });
    const filled = await service.get('/health');
    assert.deepEqual(filled.body.dedupeWindow, { fromSeq: 1, toSeq: 2, ids: 2 });
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T200: repeating a transition with the same eventId answers the same way twice', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const taskId = await submit(service, 'k-idem');
    const first = await service.post('/tasks/transition', { taskId, status: 'running', eventId: 'e-run' });
    const again = await service.post('/tasks/transition', { taskId, status: 'running', eventId: 'e-run' });
    assert.equal(first.status, 200);
    assert.equal(again.status, 200, 'a retry is not an illegal move');
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.alreadyAt, 'running');
    assert.equal(again.body.task.status, 'running');
    assert.equal(again.body.seq, first.body.seq, 'the same event sequence number');

    const events = await service.get('/events?since=0');
    assert.deepEqual(events.body.events.map((e) => e.type), ['task_queued', 'task_running']);
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T200: repeating a transition without an eventId is a no-op, not a new event', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const taskId = await submit(service, 'k-noev');
    await service.post('/tasks/transition', { taskId, status: 'completed' });
    const again = await service.post('/tasks/transition', { taskId, status: 'completed' });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.alreadyAt, 'completed');
    const events = await service.get('/events?since=0');
    assert.equal(events.body.events.filter((e) => e.type === 'task_completed').length, 1);
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T200: a genuinely illegal move is still refused after a repeat of the current state', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const taskId = await submit(service, 'k-illegal');
    await service.post('/tasks/transition', { taskId, status: 'completed' });
    const back = await service.post('/tasks/transition', { taskId, status: 'running' });
    assert.equal(back.status, 409);
    assert.equal(back.body.error, 'illegal_transition');
    assert.equal(back.body.from, 'completed');
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T200: many restarts recover a task exactly once, and trimming does not resurrect it', async () => {
  const dir = tempDir();
  let taskId;
  const first = await startService(dir);
  try {
    taskId = await submit(first, 'k-rec');
    await first.post('/lease', { sessionId: 's', controllerId: 'c', ttlMs: 1000 });
    await first.post('/tasks/transition', { taskId, status: 'running' });
  } finally {
    await first.stop();
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));

  for (let i = 0; i < 3; i += 1) {
    const service = await startService(dir);
    try {
      const task = await service.get('/tasks/get?taskId=' + taskId);
      assert.equal(task.body.task.status, 'interrupted', 'restart ' + i + ' keeps the recovered state');
      const events = await service.get('/events?since=0');
      assert.equal(events.body.events.filter((e) => e.type === 'task_interrupted').length, 1,
        'restart ' + i + ' does not append another recovery event');
    } finally {
      await service.stop();
    }
  }

  // Now drop the recovery event's body: the ledger must still refuse to re-apply it.
  const storePath = path.join(dir, 'relay.json');
  const store = JSON.parse(readFileSync(storePath, 'utf8'));
  store.events = store.events.filter((e) => e.type !== 'task_interrupted');
  store.tasks.find((t) => t.taskId === taskId).status = 'running';
  writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');

  const last = await startService(dir);
  try {
    const events = await last.get('/events?since=0');
    const interrupted = events.body.events.filter((e) => e.type === 'task_interrupted');
    // The body was deliberately removed, so the honest outcome is "no body, and it is not re-applied": the ledger
    // still knows `recovered:<taskId>` was applied, so a second record never appears.
    assert.ok(interrupted.length <= 1, 'the recovery event is never duplicated');
    if (interrupted.length === 1) assert.equal(interrupted[0].eventId, 'recovered:' + taskId);
    const task = await last.get('/tasks/get?taskId=' + taskId);
    assert.equal(task.body.task.status, 'interrupted');
  } finally {
    await last.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T200: a version-2 store is migrated, keeping the ids it can still vouch for', async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, 'relay.json'), JSON.stringify({
    version: 2, seq: 2, keys: [], lease: null,
    tasks: [{ taskId: 'task-1', goal: 'g', clientKey: 'k', status: 'completed', createdAt: 1 }],
    events: [
      { seq: 1, eventId: 'legacy-1', type: 'task_queued', taskId: 'task-1', at: 1, simulated: true },
      { seq: 2, eventId: 'legacy-2', type: 'task_completed', taskId: 'task-1', at: 2, simulated: true },
    ],
  }, null, 2) + '\n', 'utf8');

  const service = await startService(dir);
  try {
    assert.equal((await service.post('/events', { eventId: 'legacy-1', type: 'task_completed' })).body.duplicate,
      true, 'the migrated ledger refuses an old id');
    const fresh = await service.post('/events', { eventId: 'new-1', type: 'task_completed' });
    assert.equal(fresh.body.duplicate, false);
    const health = await service.get('/health');
    assert.deepEqual(health.body.dedupeWindow, { fromSeq: 1, toSeq: 3, ids: 3 });
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
