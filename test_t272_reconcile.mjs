// T272: what happens when a prompt gets no answer.
//
// T271 marked that `failed` and released the session, so the next submit could send a *second* prompt into a session
// that may already be running the first one. This suite injects exactly that loss -- the fake Host admits the prompt
// and then throws on the way back -- and asserts the fixed behaviour:
//
//   * state `unsettled`, `requiresReconcile: true`, session lock still held (`session_busy` on a second submit);
//   * `get_result` refuses with `task_unsettled`;
//   * `reconcile_task` resolves it, and the Host's admission count stays at 1 (no duplicate prompt);
//   * an explicit Host refusal still fails the task and frees the session.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { createFakeHost } from './tools/dsh-direct/adapters.mjs';
import { openBridgeCount, startHostBridge } from './tools/dsh-direct/host_bridge.mjs';

const SERVER = path.join(process.cwd(), 'tools', 'dsh-direct', 'mcp_server.mjs');
const TOKEN = 'test-token-' + 'c'.repeat(40);
const SESSION = 'session-11111111-2222-4333-8444-555566667777';
const OTHER = 'session-99999999-8888-4777-8666-555544443333';

function scene() {
  const dir = mkdtempSync(path.join(tmpdir(), 't272r-'));
  const tokenFile = path.join(dir, 'host.token');
  writeFileSync(tokenFile, TOKEN + '\n', 'utf8');
  return { dir, tokenFile, configFile: path.join(dir, 'config.json') };
}

function config(sc, bridge, extra = {}) {
  const doc = Object.assign({ hostUrl: bridge.base, expectKind: 'offline_fake', tokenFile: sc.tokenFile,
    stateDir: path.join(sc.dir, 'state'), boundSessionIds: [SESSION], boundProjectIds: [], maxPolls: 3 }, extra);
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
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
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
      pending.set(id, (message) => {
        clearTimeout(timer);
        // A JSON-RPC error is an answer too; leaving it unhandled is how a harness hangs instead of failing.
        if (message.error) return reject(new Error('jsonrpc error from the server: ' + JSON.stringify(message.error)));
        resolve(message.result && message.result.structuredContent !== undefined
          ? message.result.structuredContent : message.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    }),
    stderr: () => stderr,
    async stop() {
      const finish = () => {
        reader.close();
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        child.unref();
        resolveStop();
      };
      let resolveStop = () => {};
      const stopped = new Promise((resolve) => { resolveStop = resolve; });
      if (child.exitCode !== null) {
        finish();
        return stopped;
      }
      child.once('exit', finish);
      child.kill('SIGTERM');
      setTimeout(() => { child.kill('SIGKILL'); finish(); }, 3000).unref();
      return stopped;
    },
  };
}

const call = (srv, name, args) => srv.call('tools/call', { name, arguments: args });

// Every teardown goes through here: a bridge that is merely "asked to close" leaves a listening handle behind, which
// in a test process means the suite never exits, and inside the Host means the port stays bound after unload.
async function closeBridge(bridge) {
  await bridge.close();
  assert.equal(bridge.listening(), false, 'the listener must be released: ' + bridge.base);
  assert.equal(openBridgeCount(), 0, 'no bridge may be left open: ' + bridge.base);
}

function host() {
  return createFakeHost({
    sessions: [
      { sessionId: SESSION, cwd: '/workspace/project', title: 'alpha' },
      { sessionId: OTHER, cwd: '/work/other', title: 'beta' },
    ],
  });
}

test('T272: a lost prompt answer leaves the task unsettled, keeps the lock, and never says failed', async () => {
  const sc = scene();
  const fake = host();
  const bridge = await startHostBridge({ adapter: fake, token: TOKEN });
  config(sc, bridge);
  const srv = server(sc.configFile);
  try {
    fake.control.loseNextResponse(true);
    const first = await call(srv, 'submit_task', { requestId: 't272-lost-0001', sessionId: SESSION,
      prompt: 'the exact original text' });
    assert.equal(first.ok, false);
    assert.equal(first.code, 'task_unsettled');
    assert.equal(first.requiresReconcile, true);
    assert.equal(first.task.state, 'unsettled');
    assert.equal(first.task.requiresReconcile, true);
    assert.equal(fake.control.admissions().length, 1, 'the Host did admit it before the response was lost');

    // The lock must still be held: a second prompt here is how duplicates get created.
    const second = await call(srv, 'submit_task', { requestId: 't272-lost-0002', sessionId: SESSION,
      prompt: 'a second prompt that must not be sent' });
    assert.equal(second.code, 'session_busy');
    assert.equal(second.details.activeTaskId, first.task.taskId);
    assert.equal(fake.control.admissions().length, 1);

    const early = await call(srv, 'get_result', { taskId: first.task.taskId });
    assert.equal(early.code, 'task_unsettled', 'an unsettled task is not a result');

    const settled = await call(srv, 'reconcile_task', { taskId: first.task.taskId });
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.equal(settled.reconciledBy, 'durable_log', 'the log already held the rpcId, so no second call was needed');
    assert.equal(settled.task.state, 'succeeded');
    assert.equal(fake.control.admissions().length, 1, 'exactly one admission for the whole episode');
    const stages = settled.task.stages.map((stage) => stage.stage);
    assert.ok(stages.includes('admission_found_in_log'));
  } finally {
    await srv.stop();
    await closeBridge(bridge);
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T272: reconcile without log evidence needs the original text, and re-sending it stays a single admission',
  async () => {
    const sc = scene();
    const fake = host();
    const bridge = await startHostBridge({ adapter: fake, token: TOKEN });
    config(sc, bridge);
    const srv = server(sc.configFile);
    try {
      fake.control.hideAdmission(true);
      fake.control.loseNextResponse(true);
      const first = await call(srv, 'submit_task', { requestId: 't272-rep-00001', sessionId: SESSION,
        prompt: 'original text' });
      assert.equal(first.task.state, 'unsettled');

      const blind = await call(srv, 'reconcile_task', { taskId: first.task.taskId });
      assert.equal(blind.code, 'not_reconcilable', JSON.stringify(blind));
      assert.equal(blind.details.reason, 'reconcile_needs_prompt');

      const wrong = await call(srv, 'reconcile_task', { taskId: first.task.taskId, prompt: 'different text' });
      assert.equal(wrong.code, 'invalid_arguments', 'the digest is the guard against reconciling with other content');

      const fixed = await call(srv, 'reconcile_task', { taskId: first.task.taskId, prompt: 'original text' });
      assert.equal(fixed.ok, true, JSON.stringify(fixed));
      assert.equal(fixed.reconciledBy, 'idempotent_reprompt');
      assert.equal(fixed.task.requestId, 't272-rep-00001', 'the retry reuses the original requestId');
      assert.equal(fake.control.admissions().length, 1, 'the Host deduped on requestId: no second message');
    } finally {
      await srv.stop();
      await closeBridge(bridge);
      rmSync(sc.dir, { recursive: true, force: true });
    }
  }
);

test('T272: an explicit Host refusal fails the task and frees the session', async () => {
  const sc = scene();
  const fake = host();
  const bridge = await startHostBridge({ adapter: fake, token: TOKEN });
  config(sc, bridge);
  const srv = server(sc.configFile);
  try {
    fake.control.refuseAs('session/writer-held');
    const refused = await call(srv, 'submit_task', { requestId: 't272-held-0001', sessionId: SESSION,
      prompt: 'blocked by a writer' });
    assert.equal(refused.ok, false, 'a refusal is an error payload, not a task result');
    assert.equal(refused.code, 'session_writer_held');
    assert.equal(fake.control.admissions().length, 0);

    // A refusal is not an unknown: the session is free again immediately.
    const after = await call(srv, 'submit_task', { requestId: 't272-held-0002', sessionId: SESSION, prompt: 'now ok' });
    assert.equal(after.ok, true, JSON.stringify(after));
    assert.equal(after.task.state, 'succeeded');
  } finally {
    await srv.stop();
    await closeBridge(bridge);
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T272: an unsettled task survives a server restart and still holds the session', async () => {
  const sc = scene();
  const fake = host();
  const bridge = await startHostBridge({ adapter: fake, token: TOKEN });
  config(sc, bridge);
  let srv = server(sc.configFile);
  let taskId = null;
  try {
    fake.control.hideAdmission(true);
    fake.control.loseNextResponse(true);
    const first = await call(srv, 'submit_task', { requestId: 't272-rest-0001', sessionId: SESSION, prompt: 'linger' });
    assert.equal(first.task.state, 'unsettled');
    taskId = first.task.taskId;
  } finally {
    await srv.stop(); // the operator restarts the MCP server; the Host may still hold the prompt
  }
  srv = server(sc.configFile);
  try {
    const after = await call(srv, 'get_task', { taskId });
    assert.equal(after.task.state, 'unsettled', 'unsettled is not silently downgraded to unknown on restart');
    assert.equal(after.task.requiresReconcile, true);
    const blocked = await call(srv, 'submit_task', { requestId: 't272-rest-0002', sessionId: SESSION, prompt: 'again' });
    assert.equal(blocked.code, 'session_busy', 'the lock survives the restart too');

    const settled = await call(srv, 'reconcile_task', { taskId, prompt: 'linger' });
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.equal(fake.control.admissions().length, 1);
  } finally {
    await srv.stop();
    await closeBridge(bridge);
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T272: an unbound session is still refused before any prompt is sent', async () => {
  const sc = scene();
  const fake = host();
  const bridge = await startHostBridge({ adapter: fake, token: TOKEN });
  config(sc, bridge);
  const srv = server(sc.configFile);
  try {
    const refused = await call(srv, 'submit_task', { requestId: 't272-unbound-01', sessionId: OTHER, prompt: 'hi' });
    assert.equal(refused.code, 'not_bound');
    assert.equal(fake.control.admissions().length, 0);
    const listed = await call(srv, 'list_sessions', {});
    assert.deepEqual(listed.sessions.map((session) => session.sessionId), [SESSION]);
    assert.equal(listed.protocol, 'dsh-api-session-controller@0.2.0-rc.2',
      'the receipt records which protocol answered');
  } finally {
    await srv.stop();
    await closeBridge(bridge);
    rmSync(sc.dir, { recursive: true, force: true });
  }
});
