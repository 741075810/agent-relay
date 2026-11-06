// T271: the hardening properties of dsh-direct -- auth, loopback-only binding, worktree refusal, restart honesty,
// and the capability probe that refuses to pretend a Host can do what it cannot.
//
// Same ground rules as the core suite: real processes, real HTTP on loopback, real stdio. The Host behind the bridge
// is the offline fake, and it says so in every result.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { createFakeHost, createSessionControllerAdapter, describeCapabilities } from './tools/dsh-direct/adapters.mjs';
import { startHostBridge, tokenMatches, readToken } from './tools/dsh-direct/host_bridge.mjs';
import { precheckWorktree } from './tools/dsh-direct/worktree.mjs';

const SERVER = path.join(process.cwd(), 'tools', 'dsh-direct', 'mcp_server.mjs');
const TOKEN = 'test-token-' + 'b'.repeat(40);
const SESSION = 'session-11111111-2222-4333-8444-555566667777';

function scene(over = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 't271h-'));
  const tokenFile = path.join(dir, 'host.token');
  writeFileSync(tokenFile, (over.token || TOKEN) + '\n', 'utf8');
  return { dir, tokenFile, configFile: path.join(dir, 'config.json'), dirs: [dir] };
}

async function bridgeFor(sc, options = {}) {
  const adapter = options.adapter || createFakeHost({
    sessions: [{ sessionId: SESSION, projectId: 'prj-alpha', title: 'alpha', status: 'idle',
      lastActivityAt: 1794000000000 }],
    turnsPerTask: options.turnsPerTask || 2,
  });
  return startHostBridge({ adapter, token: options.token || TOKEN });
}

function config(sc, bridge, extra = {}) {
  const doc = Object.assign({ hostUrl: bridge ? bridge.base : 'http://127.0.0.1:9', tokenFile: sc.tokenFile,
    stateDir: path.join(sc.dir, 'state'), boundSessionIds: [SESSION], boundProjectIds: ['prj-alpha'],
    maxPolls: 3 }, extra);
  writeFileSync(sc.configFile, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return doc;
}

function server(configFile) {
  const child = spawn(process.execPath, [SERVER, '--config', configFile], { stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true });
  const pending = new Map();
  let nextId = 1;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    const message = JSON.parse(text);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  });
  return {
    call: (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error('no answer for ' + method + ' :: ' + stderr)), 20000);
      pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    }),
    stderr: () => stderr,
    async stop() {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      });
    },
  };
}

const call = (srv, name, args) => srv.call('tools/call', { name, arguments: args })
  .then((message) => message.result.structuredContent);

test('T271: the bridge serves loopback only and requires the bearer token', async () => {
  const sc = scene();
  const bridge = await bridgeFor(sc);
  try {
    const healthy = await fetch(bridge.base + '/health').then((r) => r.json());
    assert.equal(healthy.ok, true, '/health must answer without a token so an operator can see what this is');
    assert.equal(healthy.kind, 'offline_fake');
    assert.equal(healthy.loopbackOnly, true);
    assert.deepEqual(healthy.capabilities.missing, []);

    const noToken = await fetch(bridge.base + '/sessions');
    assert.equal(noToken.status, 401);
    assert.equal((await noToken.json()).code, 'unauthenticated');

    const wrongToken = await fetch(bridge.base + '/sessions', { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrongToken.status, 401);

    const good = await fetch(bridge.base + '/sessions', { headers: { authorization: 'Bearer ' + TOKEN } });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).sessions.length, 1);

    // A non-loopback bind is refused before it can happen.
    assert.throws(() => startHostBridge({ adapter: createFakeHost({ sessions: [] }), token: TOKEN, host: '0.0.0.0' }),
      /loopback/);
    assert.equal(tokenMatches(TOKEN, TOKEN), true);
    assert.equal(tokenMatches(TOKEN, TOKEN + 'x'), false);
  } finally {
    await bridge.close();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T271: a short token file is refused at load time', () => {
  const sc = scene({ token: 'short' });
  try {
    assert.throws(() => readToken(sc.tokenFile), /fewer than 32/);
  } finally {
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T271: a session-controller object without the required methods is refused, and named', () => {
  const caps = describeCapabilities({ listSessions() {} });
  assert.deepEqual(caps.missing, ['prompt', 'getEvents']);
  assert.throws(() => createSessionControllerAdapter({ listSessions() {} }), (err) => {
    assert.equal(err.code, 'host_capability_missing');
    assert.deepEqual(err.details.missing, ['prompt', 'getEvents']);
    assert.deepEqual(err.details.required, ['listSessions', 'prompt', 'getEvents']);
    return true;
  });
});

test('T271: an adapter over a complete session-controller works through the bridge', async () => {
  const sc = scene();
  const controller = createFakeHost({
    sessions: [{ sessionId: SESSION, projectId: 'prj-alpha', title: 'alpha', status: 'idle',
      lastActivityAt: 1794000000000 }],
    turnsPerTask: 1,
  });
  const adapter = createSessionControllerAdapter(controller);
  assert.deepEqual(adapter.capabilities().missing, []);
  const bridge = await startHostBridge({ adapter, token: TOKEN });
  config(sc, bridge);
  const srv = server(sc.configFile);
  try {
    const answer = await call(srv, 'submit_task', { requestId: 't271-adapt-0001', sessionId: SESSION,
      prompt: 'through the adapter' });
    assert.equal(answer.task.state, 'succeeded');
    assert.equal(answer.host, 'cordis_session_controller',
      'the bridge must report which adapter kind answered, so a fake cannot pass for a live Host');
  } finally {
    await srv.stop();
    await bridge.close();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T271: the worktree precheck reads a repository and refuses a dirty one', async () => {
  const sc = scene();
  const repo = path.join(sc.dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args) => spawnSync('git', ['--no-optional-locks', ...args], { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n', 'utf8');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'first');

  const clean = await precheckWorktree(repo);
  assert.equal(clean.clean, true);
  assert.equal(clean.readOnly, true);
  assert.match(clean.head, /^[0-9a-f]{40}$/);

  const bridge = await bridgeFor(sc);
  config(sc, bridge, { worktreeRoot: repo });
  let srv = server(sc.configFile);
  try {
    const first = await call(srv, 'submit_task', { requestId: 't271-clean-0001', sessionId: SESSION,
      prompt: 'dirty check' });
    assert.equal(first.task.state, 'succeeded');
    assert.equal(first.worktree.clean, true);
  } finally {
    await srv.stop();
  }

  writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n', 'utf8');
  const dirty = await precheckWorktree(repo);
  assert.equal(dirty.clean, false);
  assert.equal(dirty.entryCount, 1);

  srv = server(sc.configFile);
  try {
    const refused = await call(srv, 'submit_task', { requestId: 't271-dirty-0001', sessionId: SESSION,
      prompt: 'must not touch a dirty tree' });
    assert.equal(refused.code, 'worktree_dirty');
    assert.equal(refused.details.entries.length, 1);

    const allowed = await call(srv, 'list_sessions', {});
    assert.equal(allowed.ok, true, 'reading is still allowed on a dirty tree');
  } finally {
    await srv.stop();
    await bridge.close();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T271: a task that was running when the server died comes back as unknown', async () => {
  const sc = scene();
  const bridge = await bridgeFor(sc, { turnsPerTask: 6 });
  config(sc, bridge, { maxPolls: 1 });
  let srv = server(sc.configFile);
  let taskId = null;
  try {
    const answer = await call(srv, 'submit_task', { requestId: 't271-restart-01', sessionId: SESSION,
      prompt: 'long one' });
    assert.equal(answer.task.state, 'running');
    taskId = answer.task.taskId;
  } finally {
    await srv.stop(); // the process dies with the task in flight
  }
  srv = server(sc.configFile);
  try {
    const after = await call(srv, 'get_task', { taskId });
    assert.equal(after.task.state, 'unknown', 'a restart must not upgrade an in-flight task to success');
    assert.equal(after.task.unknownReason, 'process_restart');
    assert.ok(after.task.stages.some((stage) => stage.stage === 'recovered_as_unknown'));
    const result = await call(srv, 'get_result', { taskId });
    assert.equal(result.ok, true, 'an unknown task is finished-with-unknown, not pending');
    assert.equal(result.task.result, null);
  } finally {
    await srv.stop();
    await bridge.close();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T271: an unreachable Host is refused with host_unreachable, not with a fake answer', async () => {
  const sc = scene();
  config(sc, null); // nothing listens on 127.0.0.1:9
  const srv = server(sc.configFile);
  try {
    const answer = await call(srv, 'list_sessions', {});
    assert.equal(answer.code, 'host_unreachable');
  } finally {
    await srv.stop();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T271: a prompt that never reaches the Host fails the task and frees the session', async () => {
  const sc = scene();
  const { createServer } = await import('node:http');
  // A Host that answers the session list and then drops the connection on /prompt: the worst realistic middle case.
  const flaky = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, kind: 'offline_partial', capabilities: { missing: [], available: [],
        required: [] }, loopbackOnly: true }));
      return;
    }
    if (req.url === '/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, host: 'offline_partial', sessions: [{ sessionId: SESSION,
        projectId: 'prj-alpha', title: 'alpha', status: 'idle', lastActivityAt: 1794000000000 }] }));
      return;
    }
    req.socket.destroy();
  });
  await new Promise((resolve) => flaky.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + flaky.address().port;
  config(sc, { base });
  const srv = server(sc.configFile);
  try {
    const first = await call(srv, 'submit_task', { requestId: 't271-flaky-0001', sessionId: SESSION, prompt: 'one' });
    assert.equal(first.code, 'host_unreachable');
    const second = await call(srv, 'submit_task', { requestId: 't271-flaky-0002', sessionId: SESSION, prompt: 'two' });
    assert.notEqual(second.code, 'session_busy', 'a failed prompt must not hold the session hostage');
    assert.equal(second.code, 'host_unreachable');

    const doc = JSON.parse(readFileSync(path.join(sc.dir, 'state', 'tasks.json'), 'utf8'));
    assert.equal(doc.tasks.length, 2);
    for (const task of doc.tasks) {
      assert.equal(task.state, 'failed');
      assert.equal(task.error.phase, 'host_prompt');
    }
  } finally {
    await srv.stop();
    await new Promise((resolve) => flaky.close(resolve));
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T271: the ledger is a plain JSON document that survives a restart unchanged', async () => {
  const sc = scene();
  const bridge = await bridgeFor(sc);
  config(sc, bridge);
  const srv = server(sc.configFile);
  try {
    const answer = await call(srv, 'submit_task', { requestId: 't271-ledger-01', sessionId: SESSION,
      prompt: 'persist me' });
    assert.equal(answer.task.state, 'succeeded');
    const raw = readFileSync(path.join(sc.dir, 'state', 'tasks.json'), 'utf8');
    const doc = JSON.parse(raw);
    assert.equal(doc.version, 1);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.requestIds['t271-ledger-01'], answer.task.taskId);
    assert.equal(doc.tasks[0].promptSha256.length, 64, 'the prompt is stored as a digest, not as text');
    assert.equal('prompt' in doc.tasks[0], false, 'no raw prompt field is written; only the digest and its length');
    assert.equal(doc.tasks[0].promptChars, 'persist me'.length);
  } finally {
    await srv.stop();
    await bridge.close();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});
