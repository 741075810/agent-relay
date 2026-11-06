// T271: the dsh-direct MCP server, exercised for real.
//
// Real processes and real wires: the MCP server is spawned as a child and spoken to over stdio JSON-RPC, the Host
// bridge is a real HTTP server on loopback with a real bearer token, and the adapter behind it is the offline fake.
// What is *not* here -- and cannot be here -- is a live Desktop session: the fake labels itself `offline_fake` and
// that label travels into every tool result, so no receipt from this file can be sold as a real dispatch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { createFakeHost } from './tools/dsh-direct/adapters.mjs';
import { startHostBridge } from './tools/dsh-direct/host_bridge.mjs';

const SERVER = path.join(process.cwd(), 'tools', 'dsh-direct', 'mcp_server.mjs');
const TOKEN = 'test-token-' + 'a'.repeat(40);

const SESSIONS = [
  { sessionId: 'session-11111111-2222-4333-8444-555566667777', cwd: '/work/alpha', title: 'alpha',
    running: false, blank: false, agentAvailable: true, updatedAt: 1794000000000 },
  { sessionId: 'session-99999999-8888-4777-8666-555544443333', cwd: '/work/beta', title: 'beta',
    running: false, blank: false, agentAvailable: true, updatedAt: 1794000001000 },
];
const BOUND = SESSIONS[0].sessionId;

function scene(options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 't271-'));
  const tokenFile = path.join(dir, 'host.token');
  writeFileSync(tokenFile, TOKEN + '\n', 'utf8');
  const configFile = path.join(dir, 'dsh-direct.config.json');
  return { dir, tokenFile, configFile, sessions: options.sessions || SESSIONS };
}

async function startBridge(sceneRef, options = {}) {
  const adapter = options.adapter || createFakeHost({ sessions: sceneRef.sessions, turnsPerTask: options.turnsPerTask || 2,
    failPrompt: options.failPrompt === true });
  return startHostBridge({ adapter, token: TOKEN });
}

function writeConfig(sceneRef, bridge, extra = {}) {
  const config = Object.assign({
    hostUrl: bridge.base,
    // The identity check defaults to the real `cordis_session_controller`; a suite that drives the offline fake says so
    // on purpose, which is the only way a fake is allowed to pass.
    expectKind: 'offline_fake',
    tokenFile: sceneRef.tokenFile,
    stateDir: path.join(sceneRef.dir, 'state'),
    boundSessionIds: [BOUND],
    boundCwds: ['/work/alpha'],
    maxPolls: 3,
  }, extra);
  writeFileSync(sceneRef.configFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return config;
}

function startServer(configFile) {
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
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error('no answer for ' + method + ' :: ' + stderr)), 20000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, call, stderr: () => stderr,
    async stop() {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      });
    } };
}

async function tool(server, name, args) {
  const message = await server.call('tools/call', { name, arguments: args });
  assert.ok(message.result, 'no result for ' + name + ': ' + JSON.stringify(message.error));
  return { structured: message.result.structuredContent, isError: message.result.isError === true,
    content: message.result.content };
}

test('T271: the tool surface is exactly five tools and none of them creates a session', async () => {
  const sc = scene();
  const bridge = await startBridge(sc);
  const config = writeConfig(sc, bridge);
  const server = startServer(sc.configFile);
  try {
    const init = await server.call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'dsh-direct');
    const listed = await server.call('tools/list', {});
    assert.deepEqual(listed.result.tools.map((t) => t.name).sort(),
      ['get_result', 'get_task', 'list_sessions', 'reconcile_task', 'submit_task']);
    for (const spec of listed.result.tools) {
      assert.equal(spec.inputSchema.type, 'object');
      assert.ok(!('createSession' in (spec.inputSchema.properties || {})), spec.name + ' must not offer a create knob');
    }
    assert.equal(config.hostUrl, bridge.base);
  } finally {
    await server.stop();
    await bridge.close();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T271: list_sessions returns only the bound session', async () => {
  const sc = scene();
  const bridge = await startBridge(sc);
  writeConfig(sc, bridge);
  const server = startServer(sc.configFile);
  try {
    const { structured } = await tool(server, 'list_sessions', {});
    assert.equal(structured.ok, true);
    assert.deepEqual(structured.sessions.map((s) => s.sessionId), [BOUND]);
    assert.equal(structured.counts.listed, 2, 'the Host listed two; only the bound one is offered');
    assert.equal(structured.host, 'offline_fake');
    const filtered = await tool(server, 'list_sessions', { projectId: '/work/beta' });
    assert.equal(filtered.structured.sessions.length, 0, 'an unbound cwd filter returns nothing');
  } finally {
    await server.stop();
    await bridge.close();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T271: submit_task delivers one turn into the existing session and records every stage', async () => {
  const sc = scene();
  const bridge = await startBridge(sc);
  writeConfig(sc, bridge);
  const server = startServer(sc.configFile);
  try {
    const submitted = await tool(server, 'submit_task', { requestId: 't271-basic-0001', sessionId: BOUND,
      prompt: 'summarise the ledger' });
    assert.equal(submitted.isError, false, JSON.stringify(submitted.structured));
    const task = submitted.structured.task;
    assert.equal(task.state, 'succeeded');
    assert.equal(task.sessionId, BOUND);
    assert.match(task.result.text, /offline fake answer/);
    const stages = task.stages.map((s) => s.stage);
    assert.deepEqual(stages, ['accepted', 'host_prompt_sent', 'state_running', 'host_events', 'host_events',
      'state_succeeded']);
    assert.equal(submitted.structured.host, 'offline_fake', 'the provenance label must reach the caller');

    const fetched = await tool(server, 'get_task', { taskId: task.taskId });
    assert.equal(fetched.structured.task.state, 'succeeded');
    const result = await tool(server, 'get_result', { taskId: task.taskId });
    assert.equal(result.isError, false);
    assert.equal(result.structured.task.result.text, task.result.text);
  } finally {
    await server.stop();
    await bridge.close();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T271: the same requestId returns the same task, a different payload is refused', async () => {
  const sc = scene();
  const bridge = await startBridge(sc);
  writeConfig(sc, bridge);
  const server = startServer(sc.configFile);
  try {
    const first = await tool(server, 'submit_task', { requestId: 't271-idem-0001', sessionId: BOUND, prompt: 'same' });
    const again = await tool(server, 'submit_task', { requestId: 't271-idem-0001', sessionId: BOUND, prompt: 'same' });
    assert.equal(again.structured.duplicate, true);
    assert.equal(again.structured.task.taskId, first.structured.task.taskId);

    const clash = await tool(server, 'submit_task', { requestId: 't271-idem-0001', sessionId: BOUND,
      prompt: 'different' });
    assert.equal(clash.isError, true);
    assert.equal(clash.structured.code, 'request_conflict');
    assert.equal(clash.structured.details.existingTaskId, first.structured.task.taskId);
  } finally {
    await server.stop();
    await bridge.close();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T271: one active task per session, and get_result refuses while it is active', async () => {
  const sc = scene();
  // The Host needs three reads to finish, the server only polls once: the task is still running afterwards.
  const bridge = await startBridge(sc, { turnsPerTask: 5 });
  writeConfig(sc, bridge, { maxPolls: 1 });
  const server = startServer(sc.configFile);
  try {
    const first = await tool(server, 'submit_task', { requestId: 't271-busy-0001', sessionId: BOUND, prompt: 'long' });
    assert.equal(first.structured.task.state, 'running');
    const second = await tool(server, 'submit_task', { requestId: 't271-busy-0002', sessionId: BOUND, prompt: 'second' });
    assert.equal(second.isError, true);
    assert.equal(second.structured.code, 'session_busy');
    assert.equal(second.structured.details.activeTaskId, first.structured.task.taskId);

    const early = await tool(server, 'get_result', { taskId: first.structured.task.taskId });
    assert.equal(early.isError, true);
    assert.equal(early.structured.code, 'task_not_finished');
    assert.equal(early.structured.details.state, 'running');
  } finally {
    await server.stop();
    await bridge.close();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T271: an unbound, unknown or project-mismatched session is refused', async () => {
  const sc = scene();
  const bridge = await startBridge(sc);
  writeConfig(sc, bridge);
  const server = startServer(sc.configFile);
  try {
    const unbound = await tool(server, 'submit_task', { requestId: 't271-unbound-01',
      sessionId: 'session-99999999-8888-4777-8666-555544443333', prompt: 'hi' });
    assert.equal(unbound.structured.code, 'not_bound');

    const unknown = await tool(server, 'submit_task', { requestId: 't271-unknown-01',
      sessionId: 'session-00000000-0000-4000-8000-000000000000', prompt: 'hi' });
    assert.equal(unknown.structured.code, 'session_not_found');

    const create = await tool(server, 'submit_task', { requestId: 't271-create-001', sessionId: BOUND, prompt: 'hi',
      createSession: true });
    assert.equal(create.structured.code, 'not_bound');
    assert.match(create.structured.message, /never creates a session/);

    const mismatch = await tool(server, 'submit_task', { requestId: 't271-mismatch-1', sessionId: BOUND,
      prompt: 'hi', projectId: '/work/somewhere-else' });
    assert.equal(mismatch.structured.code, 'project_mismatch');
  } finally {
    await server.stop();
    await bridge.close();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T271: a Host that refuses the turn is recorded as a failure, not as success', async () => {
  const sc = scene();
  const bridge = await startBridge(sc, { failPrompt: true });
  writeConfig(sc, bridge);
  const server = startServer(sc.configFile);
  try {
    const answer = await tool(server, 'submit_task', { requestId: 't271-refused-01', sessionId: BOUND, prompt: 'hi' });
    assert.equal(answer.isError, true);
    assert.equal(answer.structured.task.state, 'failed');
    assert.equal(answer.structured.task.error.code, 'host_refused');
    assert.equal(answer.structured.task.result, null);
  } finally {
    await server.stop();
    await bridge.close();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});
