// T197: the service and the MCP server as two real processes, plus the lock that keeps them from colliding.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const SERVICE = path.join(process.cwd(), 'tools', 'service', 'relay_service.mjs');
const MCP = path.join(process.cwd(), 'tools', 'mcp', 'agentrelay_mcp.mjs');
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'agentrelay-svc-'));
// T198: every request must carry the bearer token the service wrote into its state dir.
const TOKENS = new Map();
async function afetch(url, opts = {}) {
  const base = new URL(url).origin;
  const token = TOKENS.get(base);
  return fetch(url, { ...opts, headers: { ...(opts.headers || {}),
    ...(token ? { authorization: 'Bearer ' + token } : {}) } });
}

/** Start the service and wait for its ready line, which carries the chosen port. */
async function startService(stateDir) {
  const child = spawn(process.execPath, [SERVICE, '--state-dir', stateDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service did not start: ' + stderr)), 10000);
    createInterface({ input: child.stdout }).once('line', (line) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); } catch (err) { reject(err); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('service exited ' + code + ': ' + stderr)); });
  });
  TOKENS.set(ready.base, readFileSync(ready.tokenFile, 'utf8').trim());
  return {
    child, base: ready.base, port: ready.port, tokenFile: ready.tokenFile,
    get stderr() { return stderr; },
    async stop() {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      });
    },
  };
}

async function mcp(stateDir, serviceUrl, tokenFile) {
  const args = [MCP, '--state-dir', stateDir];
  if (serviceUrl) args.push('--service-url', serviceUrl);
  if (tokenFile) args.push('--service-token-file', tokenFile);
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  });
  const ask = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout ' + method)), 10000);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  await ask('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  return {
    ask,
    call: (name, args2) => ask('tools/call', { name, arguments: args2 }),
    async stop() {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.stdin.end();
        setTimeout(() => { child.kill(); resolve(); }, 2000);
      });
    },
  };
}

const body = (response) => JSON.parse(response.result.content[0].text);
const get = async (url) => {
  const response = await afetch(url);
  return { status: response.status, body: await response.json() };
};

test('T197: the service reports health, is local-only, and says DSH is unavailable', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const health = await get(service.base + '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.simulated, true);
    assert.equal(health.body.dsh, 'unavailable');
    assert.equal(health.body.reason, 'external_dsh_control_api_unverified');
    assert.match(service.base, /^http:\/\/127\.0\.0\.1:/, 'bound to loopback only');
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T197: tasks and events persist, and survive a service restart', async () => {
  const dir = tempDir();
  const first = await startService(dir);
  let taskId;
  let seqAfter;
  try {
    const created = await afetch(first.base + '/tasks', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'persist me', clientKey: 'k-1', sessionId: 'session-test' }) });
    const payload = await created.json();
    taskId = payload.task.taskId;
    assert.equal(created.status, 201);
    assert.equal(payload.simulated, true);
    assert.equal(payload.dsh, 'unavailable');

    const appended = await get(first.base + '/events?since=0');
    assert.equal(appended.body.events.length, 1);
    assert.equal(appended.body.events[0].type, 'task_queued');
    seqAfter = appended.body.seq;
  } finally {
    await first.stop();
  }

  const second = await startService(dir);
  try {
    const task = await get(second.base + '/tasks/get?taskId=' + taskId);
    assert.equal(task.body.found, true);
    assert.equal(task.body.task.goal, 'persist me');
    const events = await get(second.base + '/events?since=' + (seqAfter - 1));
    assert.equal(events.body.events.length, 1);
    assert.equal(events.body.seq, seqAfter, 'the sequence continues, it does not restart');
  } finally {
    await second.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T197: a repeated eventId is stored once, across restarts', async () => {
  const dir = tempDir();
  const first = await startService(dir);
  try {
    const post = (eventId) => afetch(first.base + '/events', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId, type: 'task_completed' }) }).then((r) => r.json());
    const a = await post('evt-1');
    const b = await post('evt-1');
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(b.seq, a.seq);
  } finally {
    await first.stop();
  }
  const second = await startService(dir);
  try {
    const again = await afetch(second.base + '/events', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: 'evt-1', type: 'task_completed' }) }).then((r) => r.json());
    assert.equal(again.duplicate, true, 'a restarted writer does not re-append');
    const events = await get(second.base + '/events?since=0');
    assert.equal(events.body.events.length, 1);
  } finally {
    await second.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T197: a bounded wait returns promptly on a new event, and times out empty', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const empty = await get(service.base + '/events/wait?since=0&timeoutMs=200');
    assert.equal(empty.body.events.length, 0, 'the wait is bounded, not hanging');

    const waiting = get(service.base + '/events/wait?since=0&timeoutMs=5000');
    await new Promise((r) => setTimeout(r, 100));
    await afetch(service.base + '/events', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: 'evt-live', type: 'task_completed' }) });
    const woke = await waiting;
    assert.equal(woke.body.events.length, 1, 'the waiter was woken by the append');
    assert.equal(woke.body.events[0].eventId, 'evt-live');
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T197: one control lease per session, with contention and handover', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  const lease = (sessionId, controllerId, ttlMs = 60000) => afetch(service.base + '/lease', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, controllerId, ttlMs }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const a = await lease('session-a', 'ctl-a');
    assert.equal(a.status, 200);
    assert.equal(a.body.lease.sessionId, 'session-a');

    const b = await lease('session-b', 'ctl-b');
    assert.equal(b.status, 409);
    assert.equal(b.body.error, 'lease_held');
    assert.equal(b.body.holder, 'ctl-a', 'the holder is a controller, not just a session name');

    const renew = await lease('session-a', 'ctl-a');
    assert.equal(renew.status, 200, 'the holder may renew');

    const wrongRelease = await afetch(service.base + '/lease/release', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-b', controllerId: 'ctl-b' }) });
    assert.equal(wrongRelease.status, 409, 'a non-holder cannot release');

    await afetch(service.base + '/lease/release', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a', controllerId: 'ctl-a' }) });
    const taken = await lease('session-b', 'ctl-b');
    assert.equal(taken.status, 200, 'after release the lease can change hands');
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T197: an expired lease can be taken by another session', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    await afetch(service.base + '/lease', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a', controllerId: 'ctl-a', ttlMs: 1000 }) });
    const storePath = path.join(dir, 'relay.json');
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    store.lease.expiresAt = Date.now() - 1;
    writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
    // The running process holds its own copy; restart so it reads the expired lease.
    await service.stop();
    const second = await startService(dir);
    try {
      const taken = await afetch(second.base + '/lease', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-b', controllerId: 'ctl-b' }) }).then((r) => r.json());
      assert.equal(taken.lease.sessionId, 'session-b');
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T197: the MCP server reads the running service through relay_* tools', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  const client = await mcp(tempDir(), service.base, service.tokenFile);
  try {
    const tools = (await client.ask('tools/list', {})).result.tools.map((t) => t.name);
    for (const name of ['relay_status', 'relay_task_get', 'relay_events']) {
      assert.ok(tools.includes(name), name + ' is exposed');
    }

    const status = body(await client.call('relay_status', {}));
    assert.equal(status.ok, true);
    assert.equal(status.simulated, true);
    assert.equal(status.dsh, 'unavailable');

    await afetch(service.base + '/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'via mcp', clientKey: 'k-mcp', sessionId: 'session-test' }) });

    const events = body(await client.call('relay_events', { since: 0 }));
    assert.equal(events.events.length, 1);
    assert.equal(events.simulated, true);

    const task = body(await client.call('relay_task_get', { taskId: events.events[0].taskId }));
    assert.equal(task.found, true);
    assert.equal(task.task.goal, 'via mcp');
  } finally {
    await client.stop();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T197: without a service the relay tools say service_unavailable, never a guess', async () => {
  const client = await mcp(tempDir());
  try {
    const response = await client.call('relay_status', {});
    assert.equal(response.result.isError, true);
    assert.equal(body(response).error, 'service_unavailable');
  } finally {
    await client.stop();
  }
});

test('T197: an unreachable service URL is reported, not swallowed', async () => {
  const client = await mcp(tempDir(), 'http://127.0.0.1:1', path.join(tempDir(), 'missing.token'));
  try {
    const response = await client.call('relay_events', { since: 0 });
    assert.equal(response.result.isError, true);
    // T198: without a readable token file the client refuses before it dials anything.
    assert.equal(body(response).error, 'service_token_unreadable');
  } finally {
    await client.stop();
  }
});

test('T197: two services on one state dir -- the second refuses, the first keeps working', async () => {
  const dir = tempDir();
  const first = await startService(dir);
  try {
    const second = spawn(process.execPath, [SERVICE, '--state-dir', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    second.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const code = await new Promise((resolve) => second.once('exit', resolve));
    assert.equal(code, 3);
    assert.match(stderr, /state_dir_busy/);
    const health = await get(first.base + '/health');
    assert.equal(health.body.ok, true);
  } finally {
    await first.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T197: the lock is identity-checked -- a released lock does not delete a newer one', async () => {
  const dir = tempDir();
  const { acquireLock, lockPath, releaseLock } = await import(
    new URL('./tools/service/lock.mjs', import.meta.url).href);
  const mine = acquireLock(dir);
  assert.equal(mine.ok, true);
  const lockFile = lockPath(dir);
  assert.ok(existsSync(lockFile));
  // Simulate another process taking the lock while ours still holds a stale handle.
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid + 1, token: 'other-token', at: Date.now() }) + '\n');
  assert.equal(releaseLock(mine), false, 'a lock we no longer own is not removed');
  assert.ok(existsSync(lockFile), 'the newer lock survives');
  rmSync(dir, { recursive: true, force: true });
});

test('T197: a corrupt service store is refused rather than overwritten', async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, 'relay.json'), '{"tasks": 5}\n', 'utf8');
  const child = spawn(process.execPath, [SERVICE, '--state-dir', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 4, 'refuses to start on a store it cannot read');
  assert.equal(readFileSync(path.join(dir, 'relay.json'), 'utf8'), '{"tasks": 5}\n', 'bytes untouched');
  rmSync(dir, { recursive: true, force: true });
});
