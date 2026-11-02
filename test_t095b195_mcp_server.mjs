// T196: the MCP prototype driven as a real client would drive it.
//
// Two rules this file exists to enforce:
//   * tool arguments go in `params.arguments` -- the MCP field -- and a call using anything else is refused, because a
//     prototype that only passes its own non-standard tests is not interoperable;
//   * durability is checked against the real files on disk: a corrupt store must be refused, not replaced, and a
//     second writer on the same directory must be turned away instead of racing the first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const SERVER = path.join(process.cwd(), 'tools', 'mcp', 'agentrelay_mcp.mjs');

function connect(stateDir) {
  const child = spawn(process.execPath, [SERVER, '--state-dir', stateDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const lines = [];
  const waiters = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    lines.push(message);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
    for (const w of waiters.slice()) if (w.test(message)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(message); }
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let nextId = 1;
  return {
    child,
    get stderr() { return stderr; },
    get lines() { return lines; },
    ask(method, params, id) {
      const rid = id === undefined ? nextId++ : id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout on ' + method)), 5000);
        pending.set(rid, (message) => { clearTimeout(timer); resolve(message); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    raw(text) { child.stdin.write(text + '\n'); },
    /** Standard MCP call: tool arguments in `arguments`. */
    call(name, args, id) { return this.ask('tools/call', { name, arguments: args }, id); },
    waitFor(predicate) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no matching line')), 5000);
        waiters.push({ test: predicate, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    async close() {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.stdin.end();
        setTimeout(() => { child.kill(); resolve(); }, 2000);
      });
    },
  };
}

const body = (response) => JSON.parse(response.result.content[0].text);
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'agentrelay-mcp-'));

async function session(fn, dir) {
  const own = dir === undefined;
  const stateDir = own ? tempDir() : dir;
  const client = connect(stateDir);
  try {
    const init = await client.ask('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 't196', version: '2' } });
    assert.equal(init.result.serverInfo.name, 'agentrelay-mcp');
    client.notify('notifications/initialized', {});
    return await fn(client, stateDir);
  } finally {
    await client.close();
    if (own) rmSync(stateDir, { recursive: true, force: true });
  }
}

test('T196: standard tools/call `arguments` reaches the tool', async () => {
  await session(async (client) => {
    const list = await client.ask('tools/list', {});
    // T197 added the three relay_* tools that read the separate local service.
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(),
      ['agentrelay_status', 'agentrelay_submit', 'agentrelay_task_get',
        'relay_events', 'relay_status', 'relay_task_get']);

    const submitted = await client.call('agentrelay_submit',
      { goal: 'standard field', idempotencyKey: 'k-std', providerSessionId: 'session-test' });
    const summary = body(submitted);
    assert.equal(summary.duplicate, false);
    assert.ok(summary.taskId);
    assert.equal(summary.localOnly, true);
    assert.equal(summary.executes, false);
    assert.match(summary.note, /no DSH run was started/);

    const got = body(await client.call('agentrelay_task_get', { taskId: summary.taskId }));
    assert.equal(got.found, true);
    assert.equal(got.task.goal, 'standard field');
  });
});

test('T196: the non-standard `args` field is refused, and is not silently accepted', async () => {
  await session(async (client) => {
    const response = await client.ask('tools/call', { name: 'agentrelay_submit',
      args: { goal: 'legacy field', idempotencyKey: 'k-args' } });
    assert.equal(response.result.isError, true);
    assert.equal(body(response).error, 'unknown_parameter_args');
    const status = body(await client.call('agentrelay_status', {}));
    assert.equal(status.tasks, 0, 'nothing was stored from the refused call');
  });
});

test('T196: bad arguments are refused with their own codes', async () => {
  await session(async (client) => {
    assert.equal(body(await client.call('agentrelay_submit', { goal: 'x' })).error,
      'goal_and_idempotencyKey_required');
    assert.equal(body(await client.call('agentrelay_submit', { goal: '', idempotencyKey: 'k' })).error,
      'goal_and_idempotencyKey_required');
    assert.equal(body(await client.call('agentrelay_submit',
      { goal: 'x', idempotencyKey: 'y'.repeat(201) })).error, 'idempotencyKey_too_long');
    assert.equal(body(await client.call('agentrelay_nope', {})).error, 'unknown_tool');
    assert.equal(body(await client.ask('tools/call', { name: 'agentrelay_status', arguments: [] })).error,
      'arguments_must_be_object');
  });
});

test('T196: a corrupt store is refused, left untouched, and never overwritten', async () => {
  const dir = tempDir();
  const brokenPath = path.join(dir, 'tasks.json');
  writeFileSync(brokenPath, '{"tasks": "not an array"}\n', 'utf8');
  const original = readFileSync(brokenPath, 'utf8');
  try {
    await session(async (client) => {
      const refused = await client.call('agentrelay_submit', { goal: 'must not land', idempotencyKey: 'k' });
      assert.equal(refused.result.isError, true);
      assert.equal(body(refused).error, 'state_state_shape');
      assert.equal(readFileSync(brokenPath, 'utf8'), original, 'the bytes on disk are unchanged');
    }, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T196: an unparseable store is refused with its own code', async () => {
  const dir = tempDir();
  const brokenPath = path.join(dir, 'tasks.json');
  writeFileSync(brokenPath, '{ this is not json', 'utf8');
  try {
    await session(async (client) => {
      assert.equal(body(await client.call('agentrelay_submit', { goal: 'g', idempotencyKey: 'k' })).error,
        'state_state_unreadable');
      assert.equal(readFileSync(brokenPath, 'utf8'), '{ this is not json');
    }, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T196: reusing a JSON-RPC id for a different call reaches the tool', async () => {
  await session(async (client) => {
    const first = await client.call('agentrelay_submit', { goal: 'a', idempotencyKey: 'k-a' }, 42);
    const second = await client.call('agentrelay_status', {}, 42);
    assert.notEqual(JSON.stringify(first), JSON.stringify(second));
    assert.equal(body(second).tasks, 1, 'the second call under id 42 really ran');
    const third = await client.call('agentrelay_submit', { goal: 'b', idempotencyKey: 'k-b' }, 42);
    assert.equal(body(third).duplicate, false);
    assert.equal(body(await client.call('agentrelay_status', {})).tasks, 2);
  });
});

test('T196: a duplicate idempotency key returns the same task, across a restart', async () => {
  const dir = tempDir();
  let taskId;
  await session(async (client) => {
    const a = body(await client.call('agentrelay_submit', { goal: 'once', idempotencyKey: 'dup' }));
    const b = body(await client.call('agentrelay_submit', { goal: 'once', idempotencyKey: 'dup' }));
    taskId = a.taskId;
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(b.taskId, taskId);
  }, dir);
  await session(async (client) => {
    const c = body(await client.call('agentrelay_submit', { goal: 'once', idempotencyKey: 'dup' }));
    assert.equal(c.duplicate, true);
    assert.equal(c.taskId, taskId);
    assert.equal(body(await client.call('agentrelay_status', {})).tasks, 1);
  }, dir);
  rmSync(dir, { recursive: true, force: true });
});

test('T196: the same key with a different goal or session is a conflict, not an alias', async () => {
  await session(async (client) => {
    await client.call('agentrelay_submit', { goal: 'first intent', idempotencyKey: 'shared' });
    const otherGoal = await client.call('agentrelay_submit', { goal: 'second intent', idempotencyKey: 'shared' });
    assert.equal(body(otherGoal).error, 'idempotency_conflict');
    const otherSession = await client.call('agentrelay_submit',
      { goal: 'first intent', idempotencyKey: 'shared', providerSessionId: 'session-x' });
    assert.equal(body(otherSession).error, 'idempotency_conflict');
    assert.equal(body(await client.call('agentrelay_status', {})).tasks, 1);
  });
});

test('T196: prototype-shaped keys are ordinary data, not inherited properties', async () => {
  await session(async (client) => {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const submitted = body(await client.call('agentrelay_submit', { goal: 'g-' + key, idempotencyKey: key }));
      assert.equal(submitted.duplicate, false, key + ' is a fresh key');
      assert.ok(submitted.taskId, key);
      const again = body(await client.call('agentrelay_submit', { goal: 'g-' + key, idempotencyKey: key }));
      assert.equal(again.duplicate, true, key + ' is idempotent');
      assert.equal(again.taskId, submitted.taskId);
    }
    const status = body(await client.call('agentrelay_status', {}));
    assert.equal(status.tasks, 4);
    assert.equal(status.keys, 4);
  });
});

test('T196: at capacity, unfinished tasks are never dropped -- the store refuses instead', async () => {
  const dir = tempDir();
  try {
    await session(async (client) => {
      const first = body(await client.call('agentrelay_submit', { goal: 'oldest', idempotencyKey: 'k0' }));
      for (let i = 1; i < 200; i += 1) {
        await client.call('agentrelay_submit', { goal: 'g' + i, idempotencyKey: 'k' + i });
      }
      const full = await client.call('agentrelay_submit', { goal: 'overflow', idempotencyKey: 'k200' });
      assert.ok(full && full.result, 'unexpected response: ' + JSON.stringify(full));
      assert.equal(full.result.isError, true);
      assert.equal(body(full).error, 'store_full');
      assert.match(body(full).detail.reason, /finish or clear tasks/);
      const status = body(await client.call('agentrelay_status', {}));
      assert.equal(status.tasks, 200, 'nothing was forgotten');
      const rawOldest = await client.call('agentrelay_task_get', { taskId: first.taskId });
      assert.ok(rawOldest && rawOldest.result, 'task_get response: ' + JSON.stringify(rawOldest));
      const oldest = body(rawOldest);
      assert.equal(oldest.found, true, 'the oldest queued task is still there');
      assert.equal(oldest.task.goal, 'oldest');
      assert.equal(oldest.task.status, 'queued');
    }, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T196: finished tasks are pruned before unfinished ones, and the older submission survives', async () => {
  const dir = tempDir();
  try {
    // Seed a store at capacity where one task is already finished: it must be the one dropped.
    await session(async (client) => {
      for (let i = 0; i < 200; i += 1) {
        await client.call('agentrelay_submit', { goal: 'g' + i, idempotencyKey: 'k' + i });
      }
    }, dir);
    const storePath = path.join(dir, 'tasks.json');
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    store.tasks[0].status = 'completed';
    writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');

    await session(async (client) => {
      const accepted = body(await client.call('agentrelay_submit', { goal: 'new', idempotencyKey: 'k-new' }));
      assert.equal(accepted.duplicate, false, 'room was made by dropping a finished task');
      const status = body(await client.call('agentrelay_status', {}));
      assert.equal(status.tasks, 200);
      assert.equal(status.counts.completed, 0, 'the finished task was the one pruned');
      assert.equal(status.counts.queued, 200);
    }, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T196: a second writer on the same state dir is refused, and the first keeps its tasks', async () => {
  const dir = tempDir();
  const first = connect(dir);
  try {
    await first.ask('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    const stored = body(await first.call('agentrelay_submit', { goal: 'held', idempotencyKey: 'k1' }));
    assert.ok(stored.taskId);

    const second = spawn(process.execPath, [SERVER, '--state-dir', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    second.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const code = await new Promise((resolve) => second.once('exit', resolve));
    assert.equal(code, 3);
    assert.match(stderr, /refusing to start: state_dir_busy/);

    const stillThere = body(await first.call('agentrelay_task_get', { taskId: stored.taskId }));
    assert.equal(stillThere.found, true, 'the first writer still owns the store');
  } finally {
    await first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T196: the lock is released on exit, so a later process can take the directory', async () => {
  const dir = tempDir();
  const first = connect(dir);
  await first.ask('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  await first.close();
  assert.equal(existsSync(path.join(dir, 'writer.lock')), false, 'the lock file is gone after exit');
  await session(async (client) => {
    assert.equal(body(await client.call('agentrelay_status', {})).tasks, 0);
  }, dir);
  rmSync(dir, { recursive: true, force: true });
});

test('T196: protocol errors are reported and the process keeps serving', async () => {
  await session(async (client) => {
    assert.equal((await client.ask('tools/nope', {})).error.code, -32601);
    const parseError = client.waitFor((m) => m.error && m.error.code === -32700);
    client.raw('{not json');
    assert.equal((await parseError).error.code, -32700);
    assert.equal((await client.ask('tools/list', {})).result.tools.length, 6);
    assert.equal(existsSync(path.join(process.cwd(), 'tasks.json')), false, 'nothing written outside the state dir');
  });
});

test('T196: the server refuses to start without a state dir', async () => {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 2);
  assert.match(stderr, /--state-dir/);
});
