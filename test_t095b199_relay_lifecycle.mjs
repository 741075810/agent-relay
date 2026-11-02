// T199: task lifecycle and crash recovery, against the real process.
//
// Two defect classes this covers:
//   * tasks had no lifecycle at all -- a record was born `queued` and stayed that way, so "recovered" and "finished"
//     were indistinguishable from "never started";
//   * dedupe kept an unbounded id list separate from the event log it was trimming, so the two could disagree about
//     what had been seen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const SERVICE = path.join(process.cwd(), 'tools', 'service', 'relay_service.mjs');
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'agentrelay-life-'));

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
    child, base: ready.base, stderr,
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

async function submit(service, key = 'k-' + Math.random().toString(36).slice(2)) {
  const created = await service.post('/tasks', { goal: 'lifecycle', clientKey: key, sessionId: 'session-x' });
  return created.body.task.taskId;
}

test('T199: a task moves queued -> running -> completed, and the moves are recorded as events', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const taskId = await submit(service);
    const running = await service.post('/tasks/transition', { taskId, status: 'running' });
    assert.equal(running.status, 200);
    assert.equal(running.body.task.status, 'running');

    const done = await service.post('/tasks/transition', { taskId, status: 'completed' });
    assert.equal(done.body.task.status, 'completed');

    const events = await service.get('/events?since=0');
    assert.deepEqual(events.body.events.map((e) => e.type),
      ['task_queued', 'task_running', 'task_completed']);
    assert.deepEqual(events.body.events.map((e) => e.seq), [1, 2, 3], 'ordered, no gaps');
    for (const event of events.body.events) assert.equal(event.simulated, true);
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T199: illegal transitions are refused with the state they came from', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const taskId = await submit(service);
    await service.post('/tasks/transition', { taskId, status: 'completed' });

    const afterTerminal = await service.post('/tasks/transition', { taskId, status: 'running' });
    assert.equal(afterTerminal.status, 409);
    assert.equal(afterTerminal.body.error, 'illegal_transition');
    assert.equal(afterTerminal.body.from, 'completed');
    assert.deepEqual(afterTerminal.body.allowed, [], 'a terminal task has no legal moves');

    const missing = await service.post('/tasks/transition', { taskId: 'task-nope', status: 'running' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'no_such_task');

    const noStatus = await service.post('/tasks/transition', { taskId });
    assert.equal(noStatus.status, 400);
    assert.equal(noStatus.body.error, 'taskId_and_status_required');

    const unchanged = await service.get('/tasks/get?taskId=' + taskId);
    assert.equal(unchanged.body.task.status, 'completed', 'a refused move changes nothing');
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T199: replaying a transition with the same eventId does not append a second event', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const taskId = await submit(service);
    const first = await service.post('/tasks/transition', { taskId, status: 'running', eventId: 'e-run' });
    assert.equal(first.body.duplicate, false);
    // Simulate a caller that lost the response and retried. T200 made this idempotent rather than illegal.
    const again = await service.post('/tasks/transition', { taskId, status: 'running', eventId: 'e-run' });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    const events = await service.get('/events?since=0');
    assert.equal(events.body.events.filter((e) => e.eventId === 'e-run').length, 1);
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T199: a task left running with no live lease is recovered as interrupted on restart', async () => {
  const dir = tempDir();
  const first = await startService(dir);
  let taskId;
  try {
    taskId = await submit(first);
    await first.post('/lease', { sessionId: 'session-x', controllerId: 'ctl-1', ttlMs: 1000 });
    await first.post('/tasks/transition', { taskId, status: 'running' });
  } finally {
    await first.stop(); // crash stand-in: the owner is gone
  }
  // The lease must be expired, not merely abandoned: recovery keys on "no live lease", and a 1s TTL may still be live.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const second = await startService(dir);
  try {
    const task = await second.get('/tasks/get?taskId=' + taskId);
    assert.equal(task.body.task.status, 'interrupted', 'a dead owner does not leave a task looking alive');
    const events = await second.get('/events?since=0');
    const last = events.body.events[events.body.events.length - 1];
    assert.equal(last.type, 'task_interrupted');
    assert.equal(last.eventId, 'recovered:' + taskId + ':1',
      'T201: the recovery id carries its attempt number, so a later interruption is not swallowed');

    // And a second restart does not append it twice.
    await second.stop();
    const third = await startService(dir);
    try {
      const events2 = await third.get('/events?since=0');
      assert.equal(events2.body.events.filter((e) => e.type === 'task_interrupted').length, 1);
    } finally {
      await third.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T199: a running task whose lease is still live is not recovered', async () => {
  const dir = tempDir();
  const first = await startService(dir);
  let taskId;
  try {
    taskId = await submit(first);
    await first.post('/lease', { sessionId: 'session-x', controllerId: 'ctl-1', ttlMs: 600000 });
    await first.post('/tasks/transition', { taskId, status: 'running' });
  } finally {
    await first.stop();
  }
  const second = await startService(dir);
  try {
    const task = await second.get('/tasks/get?taskId=' + taskId);
    assert.equal(task.body.task.status, 'running', 'a live lease means someone may still be working');
  } finally {
    await second.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T199: dedupe outlives the retained event log (superseded by the T200 ledger)', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    for (let i = 0; i < 5; i += 1) {
      await service.post('/events', { eventId: 'evt-' + i, type: 'task_completed' });
    }
    const storePath = path.join(dir, 'relay.json');
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    assert.equal(store.eventIds, undefined, 'the unbounded id list is gone from the format');
    assert.ok(Array.isArray(store.seen), 'a bounded ledger replaced it');
    store.events = store.events.slice(2);
    writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
    await service.stop();

    const second = await startService(dir);
    try {
      const dropped = await second.post('/events', { eventId: 'evt-0', type: 'task_completed' });
      assert.equal(dropped.body.duplicate, true, 'T200: the ledger remembers it even with the body gone');
      const kept = await second.post('/events', { eventId: 'evt-3', type: 'task_completed' });
      assert.equal(kept.body.duplicate, true, 'a retained event is still deduped');
      const read = await second.get('/events?since=0');
      assert.deepEqual(read.body.gap, { fromSeq: 1, toSeq: 2, dropped: 2 },
        'and the reader is still told what it lost');
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T199: a transition survives a restart together with its event', async () => {
  const dir = tempDir();
  const first = await startService(dir);
  let taskId;
  try {
    taskId = await submit(first);
    await first.post('/tasks/transition', { taskId, status: 'failed' });
  } finally {
    await first.stop();
  }
  const second = await startService(dir);
  try {
    const task = await second.get('/tasks/get?taskId=' + taskId);
    assert.equal(task.body.task.status, 'failed');
    const events = await second.get('/events?since=0');
    assert.deepEqual(events.body.events.map((e) => e.type), ['task_queued', 'task_failed']);
    // Recovery must not touch a task that already reached a terminal state.
    assert.equal(events.body.events.filter((e) => e.type === 'task_interrupted').length, 0);
  } finally {
    await second.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
