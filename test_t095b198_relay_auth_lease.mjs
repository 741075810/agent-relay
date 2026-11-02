// T198: the service must refuse unknown callers, and a lease must belong to a controller rather than to a name.
//
// The threat this closes: any process on the machine could read or rewrite task state, and two controllers typing the
// same DSH session id could both hold -- and both release -- the same lease, so "one controller" was a label with
// nothing behind it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const SERVICE = path.join(process.cwd(), 'tools', 'service', 'relay_service.mjs');
const MCP = path.join(process.cwd(), 'tools', 'mcp', 'agentrelay_mcp.mjs');
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'agentrelay-auth-'));

async function startService(stateDir) {
  const child = spawn(process.execPath, [SERVICE, '--state-dir', stateDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service did not start: ' + stderr)), 10000);
    createInterface({ input: child.stdout }).once('line', (line) => {
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
  });
  const token = readFileSync(ready.tokenFile, 'utf8').trim();
  const auth = { 'content-type': 'application/json', authorization: 'Bearer ' + token };
  return {
    child, base: ready.base, token, tokenFile: ready.tokenFile, readyLine: JSON.stringify(ready), stderr,
    async get(p) {
      const r = await fetch(ready.base + p, { headers: auth });
      return { status: r.status, body: await r.json() };
    },
    async post(p, body) {
      const r = await fetch(ready.base + p, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    },
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
  let stdoutText = '';
  createInterface({ input: child.stdout }).on('line', (line) => {
    stdoutText += line + '\n';
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
    get stdout() { return stdoutText; },
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

test('T198: an unauthenticated caller can read nothing and change nothing', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    for (const [method, p] of [['GET', '/health'], ['GET', '/tasks'], ['GET', '/events?since=0']]) {
      const r = await fetch(service.base + p, { method });
      assert.equal(r.status, 401, method + ' ' + p + ' is refused');
      assert.deepEqual(await r.json(), { error: 'unauthorized' }, 'and says nothing else');
    }
    const write = await fetch(service.base + '/tasks', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'injected', clientKey: 'k-attack' }) });
    assert.equal(write.status, 401);
    const wrong = await fetch(service.base + '/health', { headers: { authorization: 'Bearer ' + 'x'.repeat(48) } });
    assert.equal(wrong.status, 401, 'a wrong token is not a token');

    const state = await service.get('/tasks');
    assert.equal(state.body.tasks.length, 0, 'nothing was written by the refused caller');
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T198: the token never appears in the ready line, a body or the client output', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    assert.equal(service.readyLine.includes(service.token), false, 'the ready line names the file, not the secret');
    const health = await service.get('/health');
    assert.equal(JSON.stringify(health.body).includes(service.token), false);

    const client = await mcp(tempDir(), service.base, service.tokenFile);
    try {
      const status = body(await client.call('relay_status', {}));
      assert.equal(status.ok, true);
      assert.equal(client.stdout.includes(service.token), false, 'the token is not echoed to the MCP client');
      assert.equal(JSON.stringify(status).includes(service.token), false);
    } finally {
      await client.stop();
    }
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T198: without a token the relay tools refuse with their own code, and never dial', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  const client = await mcp(tempDir(), service.base);
  try {
    const response = await client.call('relay_status', {});
    assert.equal(response.result.isError, true);
    assert.equal(body(response).error, 'service_token_missing');
  } finally {
    await client.stop();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T198: two controllers claiming the same session cannot both hold the lease', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const first = await service.post('/lease', { sessionId: 'session-x', controllerId: 'ctl-1' });
    assert.equal(first.status, 200);
    const leaseId = first.body.lease.leaseId;
    assert.ok(leaseId);

    const second = await service.post('/lease', { sessionId: 'session-x', controllerId: 'ctl-2' });
    assert.equal(second.status, 409, 'the same session name does not make a second controller the holder');
    assert.equal(second.body.holder, 'ctl-1');

    const renewByOther = await service.post('/lease',
      { sessionId: 'session-x', controllerId: 'ctl-2', leaseId });
    assert.equal(renewByOther.status, 409, 'and it cannot renew with the old handle either');

    const releaseByOther = await service.post('/lease/release',
      { sessionId: 'session-x', controllerId: 'ctl-2', leaseId });
    assert.equal(releaseByOther.status, 409, 'nor release it');

    const renewByOwner = await service.post('/lease', { sessionId: 'session-x', controllerId: 'ctl-1', leaseId });
    assert.equal(renewByOwner.status, 200);
    assert.equal(renewByOwner.body.renewed, true);
    assert.equal(renewByOwner.body.lease.leaseId, leaseId, 'the handle survives renewal');
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T198: a controller without a controllerId is refused outright', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const noController = await service.post('/lease', { sessionId: 'session-x' });
    assert.equal(noController.status, 400);
    assert.equal(noController.body.error, 'controllerId_required');
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T198: lease ownership and the token survive a restart', async () => {
  const dir = tempDir();
  const first = await startService(dir);
  let leaseId;
  try {
    const held = await first.post('/lease', { sessionId: 'session-x', controllerId: 'ctl-1', ttlMs: 120000 });
    leaseId = held.body.lease.leaseId;
  } finally {
    await first.stop();
  }
  const second = await startService(dir);
  try {
    assert.equal(second.token, readFileSync(path.join(dir, 'service.token'), 'utf8').trim(),
      'the same state dir reuses its token, so a stored client keeps working');
    const stolen = await second.post('/lease', { sessionId: 'session-x', controllerId: 'ctl-2' });
    assert.equal(stolen.status, 409, 'a restart does not hand the lease to whoever asks next');
    const owner = await second.post('/lease', { sessionId: 'session-x', controllerId: 'ctl-1', leaseId });
    assert.equal(owner.status, 200, 'the original holder still owns it across the restart');
  } finally {
    await second.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T198: an expired lease can be taken, and the old handle no longer works', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    const held = await service.post('/lease', { sessionId: 'session-x', controllerId: 'ctl-1' });
    const leaseId = held.body.lease.leaseId;
    const storePath = path.join(dir, 'relay.json');
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    store.lease.expiresAt = Date.now() - 1;
    writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
    await service.stop();
    const second = await startService(dir);
    try {
      const taken = await second.post('/lease', { sessionId: 'session-x', controllerId: 'ctl-2' });
      assert.equal(taken.status, 200, 'an expired lease is available');
      assert.notEqual(taken.body.lease.leaseId, leaseId, 'and the new holder gets its own handle');
      const oldHandle = await second.post('/lease/release',
        { sessionId: 'session-x', controllerId: 'ctl-1', leaseId });
      assert.equal(oldHandle.status, 409, 'the stale handle cannot release the new lease');
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T198: a trimmed event log reports an explicit gap instead of pretending continuity', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    for (let i = 0; i < 6; i += 1) {
      const r = await service.post('/events', { eventId: 'evt-' + i, type: 'task_completed' });
      assert.equal(r.body.duplicate, false);
    }
    const all = await service.get('/events?since=0');
    assert.equal(all.body.events.length, 6);
    assert.equal(all.body.gap, null, 'nothing was dropped yet');

    // Drop the first three the way retention would, keeping the file otherwise valid.
    const storePath = path.join(dir, 'relay.json');
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    store.events = store.events.slice(3);
    writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
    await service.stop();
    const second = await startService(dir);
    try {
      const partial = await second.get('/events?since=0');
      assert.equal(partial.body.events.length, 3);
      assert.deepEqual(partial.body.gap, { fromSeq: 1, toSeq: 3, dropped: 3 },
        'the reader is told which sequence numbers it will never see');
      const precise = await second.get('/events?since=3');
      assert.equal(precise.body.gap, null, 'a reader that is already current sees no gap');
      const dup = await second.post('/events', { eventId: 'evt-5', type: 'task_completed' });
      assert.equal(dup.body.duplicate, true, 'dedup still works after a restart and a trim');
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T198: the full read path through MCP needs the token, and works with it', async () => {
  const dir = tempDir();
  const service = await startService(dir);
  try {
    await service.post('/tasks', { goal: 'via mcp', clientKey: 'k-1', sessionId: 'session-x' });

    const good = await mcp(tempDir(), service.base, service.tokenFile);
    try {
      const events = body(await good.call('relay_events', { since: 0 }));
      assert.equal(events.events.length, 1);
      assert.equal(events.simulated, true);
      assert.equal(events.dsh, 'unavailable', 'the service never claims a DSH run');
      assert.equal(events.events[0].type, 'task_queued');
    } finally {
      await good.stop();
    }

    const badFile = path.join(dir, 'wrong.token');
    writeFileSync(badFile, 'not-the-token\n', 'utf8');
    const bad = await mcp(tempDir(), service.base, badFile);
    try {
      const refused = await bad.call('relay_status', {});
      assert.equal(refused.result.isError, true);
      assert.equal(body(refused).error, 'service_unauthorized');
    } finally {
      await bad.stop();
    }
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
