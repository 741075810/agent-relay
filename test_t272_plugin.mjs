// T272: the installable Cordis plugin, tested without a Desktop Host.
//
// What this proves (acceptance level A): the plugin shell is correct — it injects `sessionController`, it refuses to
// half-start when the Host cannot do the job, it serves only the bound sessions, and unloading it releases the port.
// What it does NOT prove: that the real Desktop loads it (level B) or that a prompt reached an existing session
// (level C). Both need a human install, which this round does not perform.
//
// The drifted-copy check at the bottom matters because a Cordis plugin cannot import outside its own directory: the
// four runtime modules under `plugin/lib` are byte copies, and a copy that silently differs from its source is worse
// than no copy at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createSessionControllerAdapter } from './tools/dsh-direct/adapters.mjs';
// The plugin loads its own copies from plugin/lib, which are separate module instances with their own listener
// registry, so the count that matters here comes from the plugin's copy.
import { openBridgeCount } from './tools/dsh-direct/plugin/lib/host_bridge.mjs';
import { apply, inspectHost, name as pluginName, inject } from './tools/dsh-direct/plugin/lib/index.js';
import { SYNCED } from './tools/dsh-direct/plugin/sync.mjs';

const SESSION = 'session-11111111-2222-4333-8444-555566667777';
const OTHER = 'session-99999999-8888-4777-8666-555544443333';
const TOKEN = 'plugin-token-' + 'p'.repeat(40);

/** The rc.2 surface, as small as the plugin needs it. */
function controller() {
  const state = { prompts: [], pages: 0, running: false, lastText: null, requestIds: [] };
  return {
    state,
    async list() {
      return { items: [
        { sessionId: SESSION, cwd: '/workspace/project', agentAvailable: true, updatedAt: 1, running: state.running,
          blank: false },
        { sessionId: OTHER, cwd: '/work/other', agentAvailable: true, updatedAt: 1, running: false, blank: false },
      ] };
    },
    async prompt(request, signal) {
      assert.equal(signal, undefined, 'the plugin must not pass a signal the Host does not expect');
      assert.equal(request.mode, 'queue');
      state.requestIds.push(request.requestId);
      state.lastText = request.content.map((part) => part.text).join('');
      state.prompts.push(request);
      state.running = true;
      return { accepted: true };
    },
    async page() {
      state.pages += 1;
      return { records: [
        { type: 'event', event: { type: 'turn/start', seq: 1, time: 0, data: { turn: 0 } } },
        { type: 'event', event: { type: 'user/message', seq: 2, time: 0, data: { message: {
          content: [{ type: 'text', text: state.lastText }],
          source: { kind: 'user', rpcId: state.requestIds[state.requestIds.length - 1] } } } } },
        { type: 'event', event: { type: 'assistant/message', seq: 3, time: 0, data: { turn: 0, step: 1, message: {
          content: [{ type: 'text', text: 'final answer' }] } } } },
      ], hasMore: false };
    },
  };
}

/** Just enough Cordis: `inject`-style services, `on('dispose')`, and a logger that records. */
function fakeCtx(services = {}) {
  const listeners = new Map();
  const logs = [];
  return {
    ...services,
    logs,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    async emit(event) {
      for (const handler of listeners.get(event) || []) await handler();
    },
    logger: {
      info: (message) => logs.push(['info', message]),
      error: (message) => logs.push(['error', message]),
    },
  };
}

function scene() {
  const dir = mkdtempSync(path.join(tmpdir(), 't272p-'));
  const tokenFile = path.join(dir, 'host.token');
  writeFileSync(tokenFile, TOKEN + '\n', 'utf8');
  return { dir, tokenFile };
}

async function health(base) {
  const response = await fetch(base + '/health');
  return { status: response.status, body: await response.json() };
}

test('T272: the plugin declares the Cordis shape the installed plugins use', () => {
  assert.equal(pluginName, 'dsh-direct');
  assert.deepEqual(inject, ['sessionController'],
    'it injects the Host service it reads, and nothing else');
});

test('T272: apply serves only the bound session and dispose releases the port', async () => {
  const sc = scene();
  const host = controller();
  const ctx = fakeCtx({ sessionController: host });
  try {
    const dispose = apply(ctx, { tokenFile: sc.tokenFile, boundSessionIds: [SESSION] });
    assert.equal(typeof dispose, 'function', 'apply must hand back a disposer');
    const bridge = await ctx.dshDirect.ready;
    assert.ok(bridge && bridge.base, 'the bridge must be listening after apply');

    const listed = await fetch(bridge.base + '/sessions', { headers: { authorization: 'Bearer ' + TOKEN } })
      .then((response) => response.json());
    assert.deepEqual(listed.sessions.map((row) => row.sessionId), [SESSION],
      'the unbound session must not even be listed');

    const unbound = await fetch(bridge.base + '/prompt', { method: 'POST', headers: {
      authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: OTHER, text: 'not for you', requestId: 'plugin-0001' }) })
      .then((response) => response.json());
    assert.equal(unbound.accepted, false);
    assert.equal(unbound.reason, 'session_not_bound');
    assert.equal(host.state.prompts.length, 0, 'the Host must never see a prompt for an unbound session');

    const accepted = await fetch(bridge.base + '/prompt', { method: 'POST', headers: {
      authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION, text: 'real work', requestId: 'plugin-0002' }) })
      .then((response) => response.json());
    assert.equal(accepted.accepted, true);
    assert.equal(host.state.prompts.length, 1);
    assert.equal(host.state.prompts[0].content[0].text, 'real work',
      'the plugin hands the Host an rc.2 PromptContentPart, not its own wording');
    assert.equal(host.state.prompts[0].requestId, 'plugin-0002');

    const page = await fetch(bridge.base + '/events?sessionId=' + SESSION + '&requestId=plugin-0002',
      { headers: { authorization: 'Bearer ' + TOKEN } }).then((response) => response.json());
    assert.equal(page.assistantText, 'final answer');
    assert.equal(page.admission.found, true);

    const before = openBridgeCount();
    assert.equal(before, 1);
    await dispose();
    assert.equal(openBridgeCount(), 0, 'the disposer must release the listener');
    assert.equal((await fetch(bridge.base + '/health').catch(() => null)), null,
      'the port must be closed, not merely idle');
  } finally {
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T272: the dispose lifecycle event closes the bridge even if the disposer is ignored', async () => {
  const sc = scene();
  const ctx = fakeCtx({ sessionController: controller() });
  try {
    apply(ctx, { tokenFile: sc.tokenFile, boundSessionIds: [SESSION] });
    const bridge = await ctx.dshDirect.ready;
    assert.equal((await health(bridge.base)).status, 200);
    await ctx.emit('dispose');
    assert.equal(openBridgeCount(), 0);
    assert.equal(await fetch(bridge.base + '/health').then(() => 'up').catch(() => 'down'), 'down');
  } finally {
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T272: a Host without the rc.2 methods makes the plugin refuse to start', async () => {
  const sc = scene();
  const ctx = fakeCtx({ sessionController: { listSessions() {}, getEvents() {}, prompt() {} } });
  try {
    const dispose = apply(ctx, { tokenFile: sc.tokenFile, boundSessionIds: [SESSION] });
    assert.equal(dispose, null, 'apply must not hand back a disposer for a service it never started');
    assert.equal(openBridgeCount(), 0, 'nothing may be listening');
    const errors = ctx.logs.filter((entry) => entry[0] === 'error').map((entry) => entry[1]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /refusing to start/);
    assert.match(errors[0], /list, page/, 'the message must name what is missing');
    assert.match(errors[0], /T271-guessed/, 'and name the names this build does have');
  } finally {
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T272: missing token, missing binding and a short token all refuse to start', async () => {
  const sc = scene();
  const shortFile = path.join(sc.dir, 'short.token');
  writeFileSync(shortFile, 'too-short\n', 'utf8');
  const cases = [
    [{ boundSessionIds: [SESSION] }, /tokenFile is required/],
    [{ tokenFile: sc.tokenFile }, /boundSessionIds is empty/],
    [{ tokenFile: shortFile, boundSessionIds: [SESSION] }, /fewer than 32 characters/],
    [{ tokenFile: path.join(sc.dir, 'absent.token'), boundSessionIds: [SESSION] }, /refusing to start/],
  ];
  try {
    for (const [config, pattern] of cases) {
      const ctx = fakeCtx({ sessionController: controller() });
      assert.equal(apply(ctx, config), null, JSON.stringify(config));
      const errors = ctx.logs.filter((entry) => entry[0] === 'error').map((entry) => entry[1]);
      assert.equal(errors.length, 1);
      assert.match(errors[0], pattern);
      assert.equal(openBridgeCount(), 0);
    }
  } finally {
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T272: inspectHost reports capabilities without starting anything', async () => {
  const ctx = fakeCtx({ sessionController: controller() });
  const report = inspectHost(ctx, { tokenFile: '<TOKEN_DIR>/host.token', boundSessionIds: [SESSION] });
  assert.equal(report.name, 'dsh-direct');
  assert.deepEqual(report.capabilities.missing, []);
  assert.deepEqual(report.capabilities.available, ['list', 'prompt', 'page']);
  assert.deepEqual(report.boundSessionIds, [SESSION]);
  assert.equal(openBridgeCount(), 0, 'a report must not bind a port');
});

test('T272: the plugin copies are byte-identical to their sources', () => {
  const root = path.join(process.cwd(), 'tools', 'dsh-direct');
  for (const file of SYNCED) {
    const source = readFileSync(path.join(root, file), 'utf8');
    const copy = readFileSync(path.join(root, 'plugin', 'lib', file), 'utf8');
    assert.ok(source === copy,
      'plugin/lib/' + file + ' has drifted from tools/dsh-direct/' + file + '; run node tools/dsh-direct/plugin/sync.mjs');
  }
});

test('T272: the adapter over a raw controller is what the bridge wraps when handed one', async () => {
  const adapter = createSessionControllerAdapter(controller());
  assert.equal(adapter.protocol, 'dsh-api-session-controller@0.2.0-rc.2');
  const rows = await adapter.listSessions();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cwd, '/workspace/project');
});
