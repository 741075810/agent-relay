// T195: the MCP prototype, driven by a real client process over stdio.
//
// The server is spawned, not imported: the handshake, the framing and the restart behaviour are what this test is
// about, and importing the module would test none of them. Every state directory is a fresh temp directory, so a
// run cannot read or write anything belonging to the Bridge.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const SERVER = path.join(process.cwd(), 'tools', 'mcp', 'agentrelay_mcp.mjs');

/** A minimal MCP client: newline-delimited JSON over the child's stdio. */
function connect(stateDir) {
  const child = spawn(process.execPath, [SERVER, '--state-dir', stateDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  });
  let nextId = 1;
  return {
    child,
    request(method, params) {
      const id = nextId++;
      const payload = { jsonrpc: '2.0', id, method, params };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout on ' + method)), 5000);
        pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
        child.stdin.write(JSON.stringify(payload) + '\n');
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    raw(text) { child.stdin.write(text + '\n'); },
    close() {
      return new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.stdin.end();
        setTimeout(() => { child.kill(); resolve(); }, 2000);
      });
    },
  };
}

const call = (client, name, args) => client.request('tools/call', { name, args });
const parse = (response) => JSON.parse(response.result.content[0].text);

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'agentrelay-mcp-'));
}

test('T195: initialize, tool discovery and a read-only status call work over stdio', async () => {
  const dir = tempDir();
  const client = connect(dir);
  try {
    const init = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 't195', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'agentrelay-mcp');
    assert.equal(init.result.capabilities.tools.listChanged, false);
    assert.match(init.result.instructions, /Bridge still carries the live loop/);
    client.notify('notifications/initialized', {});

    const list = await client.request('tools/list', {});
    const names = list.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['agentrelay_status', 'agentrelay_submit', 'agentrelay_task_get']);
    for (const tool of list.result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.description);
    }

    const status = await call(client, 'agentrelay_status', {});
    const summary = parse(status);
    assert.equal(summary.tasks, 0);
    assert.match(summary.note, /nothing here proves a DSH run or a delivered notice/);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T195: a submitted task is persisted and survives a process restart', async () => {
  const dir = tempDir();
  const first = connect(dir);
  let taskId;
  try {
    await first.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const submitted = parse(await call(first, 'agentrelay_submit',
      { goal: 'prove persistence', idempotencyKey: 'k-1', providerSessionId: 'session-test' }));
    taskId = submitted.taskId;
    assert.equal(submitted.duplicate, false);
    assert.ok(existsSync(path.join(dir, 'tasks.json')), 'the store is on disk');
  } finally {
    await first.close();
  }

  const second = connect(dir);
  try {
    await second.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const fetched = parse(await call(second, 'agentrelay_task_get', { taskId }));
    assert.equal(fetched.found, true);
    assert.equal(fetched.task.goal, 'prove persistence');
    assert.equal(fetched.task.status, 'queued');
    const summary = parse(await call(second, 'agentrelay_status', {}));
    assert.equal(summary.tasks, 1);
    assert.equal(summary.counts.queued, 1);
    assert.equal(summary.lastTaskId, taskId);
  } finally {
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T195: the same idempotency key never creates a second task -- across a restart too', async () => {
  const dir = tempDir();
  const first = connect(dir);
  let taskId;
  try {
    const a = parse(await call(first, 'agentrelay_submit', { goal: 'once', idempotencyKey: 'dup' }));
    const b = parse(await call(first, 'agentrelay_submit', { goal: 'once', idempotencyKey: 'dup' }));
    taskId = a.taskId;
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(b.taskId, taskId);
  } finally {
    await first.close();
  }

  const second = connect(dir);
  try {
    const c = parse(await call(second, 'agentrelay_submit', { goal: 'once', idempotencyKey: 'dup' }));
    assert.equal(c.duplicate, true);
    assert.equal(c.taskId, taskId);
    const summary = parse(await call(second, 'agentrelay_status', {}));
    assert.equal(summary.tasks, 1, 'the store still holds exactly one task');
  } finally {
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T195: a replayed JSON-RPC id is answered identically, not executed twice', async () => {
  const dir = tempDir();
  const client = connect(dir);
  try {
    const payload = { jsonrpc: '2.0', id: 77, method: 'tools/call',
      params: { name: 'agentrelay_submit', args: { goal: 'replay', idempotencyKey: 'r-1' } } };
    const seen = [];
    const collect = new Promise((resolve) => {
      const reader = createInterface({ input: client.child.stdout });
      reader.on('line', (line) => { seen.push(JSON.parse(line)); if (seen.length === 2) resolve(); });
    });
    client.raw(JSON.stringify(payload));
    client.raw(JSON.stringify(payload));
    await collect;
    assert.equal(seen[0].result.content[0].text, seen[1].result.content[0].text,
      'the replayed id returns the first answer');
    const summary = parse(await call(client, 'agentrelay_status', {}));
    assert.equal(summary.tasks, 1);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T195: protocol errors are reported, not guessed at', async () => {
  const dir = tempDir();
  const client = connect(dir);
  try {
    const missing = await client.request('tools/does-not-exist', {});
    assert.equal(missing.error.code, -32601);

    const unknownTool = await call(client, 'agentrelay_nope', {});
    assert.equal(unknownTool.result.isError, true);
    assert.match(unknownTool.result.content[0].text, /unknown_tool:agentrelay_nope/);

    const badArgs = await call(client, 'agentrelay_submit', { goal: 'x' });
    assert.equal(badArgs.result.isError, true);
    assert.match(badArgs.result.content[0].text, /idempotencyKey are required/);

    const notFound = parse(await call(client, 'agentrelay_task_get', { taskId: 'nope' }));
    assert.equal(notFound.found, false);
    assert.equal(notFound.task, null);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T195: a malformed line yields a parse error and the server keeps serving', async () => {
  const dir = tempDir();
  const client = connect(dir);
  try {
    const seen = [];
    const reader = createInterface({ input: client.child.stdout });
    reader.on('line', (line) => seen.push(JSON.parse(line)));
    client.raw('{not json');
    for (let i = 0; i < 40 && seen.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(seen[0].error.code, -32700);
    const after = await client.request('tools/list', {});
    assert.equal(after.result.tools.length, 3, 'the process survived the bad line');
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T195: the store is bounded and never touches anything outside its state dir', async () => {
  const dir = tempDir();
  const client = connect(dir);
  try {
    for (let i = 0; i < 205; i += 1) {
      await call(client, 'agentrelay_submit', { goal: 'g' + i, idempotencyKey: 'k' + i });
    }
    const summary = parse(await call(client, 'agentrelay_status', {}));
    assert.equal(summary.tasks, 200, 'bounded retention');
    const store = JSON.parse(readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
    assert.equal(store.tasks.length, 200);
    assert.equal(Object.keys(store.requests).length, 205, 'idempotency keys outlive pruning');
    // Nothing was written outside the directory the client named.
    assert.equal(existsSync(path.join(process.cwd(), 'tasks.json')), false);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T195: the server refuses to start without a state dir', async () => {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 2);
  assert.match(stderr, /--state-dir/);
});
