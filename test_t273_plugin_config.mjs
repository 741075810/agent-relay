// T273: the plugin's listener contract. Two things are asserted here that no earlier suite covered:
//
//   * a configuration the MCP side cannot reach (no fixed port, no descriptor) is refused at start, because T272 shipped
//     `port: 0` plus a frozen URL and every Desktop restart stranded the client;
//   * unloading releases the socket, proven by binding the same port again immediately through a second `apply`.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFakeHost } from './tools/dsh-direct/adapters.mjs';
import { openBridgeCount } from './tools/dsh-direct/plugin/lib/host_bridge.mjs';
import { apply, describeListener, inspectHost } from './tools/dsh-direct/plugin/lib/index.js';
import { readEndpointFile } from './tools/dsh-direct/endpoint.mjs';

const SESSION = 'session-11111111-2222-4333-8444-555566667777';
const TOKEN = 'listener-token-' + 'q'.repeat(40);

function fakeCtx() {
  const listeners = new Map();
  const logs = [];
  return {
    sessionController: createFakeHost({ sessions: [{ sessionId: SESSION, cwd: '/work/alpha', title: 'alpha',
      running: false, blank: false, agentAvailable: true, updatedAt: 1794000000000 }], turnsPerTask: 1 }),
    logs,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    async emit(event) {
      for (const handler of listeners.get(event) || []) await handler();
    },
    logger: { info: (message) => logs.push(['info', message]), error: (message) => logs.push(['error', message]) },
  };
}

function scene() {
  const dir = mkdtempSync(path.join(tmpdir(), 't273p-'));
  const tokenFile = path.join(dir, 'host.token');
  writeFileSync(tokenFile, TOKEN + '\n', 'utf8');
  return { dir, tokenFile, endpointFile: path.join(dir, 'endpoint.json') };
}

const errorsOf = (ctx) => ctx.logs.filter((entry) => entry[0] === 'error').map((entry) => entry[1]);

test('T273: a listener the MCP side cannot find is refused, and named', () => {
  const none = describeListener({});
  assert.equal(none.ok, false);
  assert.match(none.reason, /config\.port or config\.endpointFile is required/);

  const random = describeListener({ port: 0 });
  assert.equal(random.ok, false);
  assert.match(random.reason, /picks a random port every start/);

  const privileged = describeListener({ port: 80 });
  assert.equal(privileged.ok, false);
  assert.match(privileged.reason, /1024\.\.65535/);

  const pinned = describeListener({ port: 42731 });
  assert.deepEqual(pinned, { ok: true, port: 42731, endpointFile: null });

  const described = describeListener({ endpointFile: '/tmp/endpoint.json' });
  assert.deepEqual(described, { ok: true, port: 0, endpointFile: '/tmp/endpoint.json' },
    'a descriptor makes an OS-chosen port addressable');
});

test('T273: apply refuses to start without a discoverable listener, and binds nothing', async () => {
  const sc = scene();
  try {
    const ctx = fakeCtx();
    const dispose = apply(ctx, { tokenFile: sc.tokenFile, boundSessionIds: [SESSION] });
    assert.equal(dispose, null, 'apply returns null when it refuses');
    const errors = errorsOf(ctx);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /refusing to start: config\.port or config\.endpointFile is required/);
    assert.equal(openBridgeCount(), 0);
    assert.equal(existsSync(sc.endpointFile), false);
  } finally {
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T273: dispose releases the socket and its descriptor, and the port rebinds immediately', async () => {
  const sc = scene();
  const config = { tokenFile: sc.tokenFile, boundSessionIds: [SESSION], endpointFile: sc.endpointFile };
  try {
    const first = fakeCtx();
    const disposeFirst = apply(first, config);
    assert.equal(typeof disposeFirst, 'function');
    const started = await disposeFirst.ready;
    assert.ok(started, 'the bridge must start when a descriptor is configured: ' + errorsOf(first).join('; '));
    assert.equal(openBridgeCount(), 1);

    const written = readEndpointFile(sc.endpointFile);
    assert.equal(written.base, started.base);
    assert.equal(written.endpointId, started.endpointId);
    const health = await (await fetch(started.base + '/health')).json();
    assert.equal(health.endpointId, started.endpointId);

    await disposeFirst();
    assert.equal(openBridgeCount(), 0, 'unloading must leave no listener behind');
    assert.equal(existsSync(sc.endpointFile), false, 'the descriptor goes with the listener');

    // The same fixed port, immediately: this is what "released" means in practice.
    const second = fakeCtx();
    const disposeSecond = apply(second, { ...config, endpointFile: null, port: written.port });
    const restarted = await disposeSecond.ready;
    assert.ok(restarted, 'the freed port must be usable at once: ' + errorsOf(second).join('; '));
    assert.equal(restarted.port, written.port);
    await disposeSecond();
    assert.equal(openBridgeCount(), 0);
  } finally {
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T273: the dispose event tears down as well, and the bridge is gone before it resolves', async () => {
  const sc = scene();
  try {
    const ctx = fakeCtx();
    const dispose = apply(ctx, { tokenFile: sc.tokenFile, boundSessionIds: [SESSION], endpointFile: sc.endpointFile });
    const started = await dispose.ready;
    assert.ok(started);
    await ctx.emit('dispose');
    assert.equal(openBridgeCount(), 0);
    assert.equal(existsSync(sc.endpointFile), false);
    const reachable = await fetch(started.base + '/health').then(() => true).catch(() => false);
    assert.equal(reachable, false, 'a /health answer after dispose would mean the socket survived');
  } finally {
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T273: a taken port fails the plugin closed instead of crashing the Host', async () => {
  const sc = scene();
  const holder = fakeCtx();
  let holderDispose = null;
  try {
    holderDispose = apply(holder, { tokenFile: sc.tokenFile, boundSessionIds: [SESSION], port: 42751 });
    const holderStarted = await holderDispose.ready;
    assert.ok(holderStarted, errorsOf(holder).join('; '));

    const blocked = fakeCtx();
    const disposeBlocked = apply(blocked, { tokenFile: sc.tokenFile, boundSessionIds: [SESSION], port: 42751 });
    const result = await disposeBlocked.ready;
    assert.equal(result, null, 'the second instance must not pretend to serve');
    const errors = errorsOf(blocked);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /bind_failed/);
    assert.match(errors[0], /could not bind 127\.0\.0\.1:42751/);
    assert.equal(typeof disposeBlocked, 'function', 'a deferred disposer is still returned, so unload is safe');
    await disposeBlocked();

    // The first instance is untouched and still serving.
    const health = await (await fetch(holderStarted.base + '/health')).json();
    assert.equal(health.ok, true);
    assert.equal(openBridgeCount(), 1);
  } finally {
    if (holderDispose) await holderDispose();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T273: inspectHost reports whether the configured listener is discoverable', () => {
  const sc = scene();
  try {
    const blind = inspectHost(fakeCtx(), { tokenFile: sc.tokenFile, boundSessionIds: [SESSION] });
    assert.equal(blind.listener.discoverable, false);
    assert.match(blind.listener.reason, /endpointFile is required/);

    const described = inspectHost(fakeCtx(), { tokenFile: sc.tokenFile, boundSessionIds: [SESSION],
      endpointFile: sc.endpointFile });
    assert.equal(described.listener.discoverable, true);
    assert.equal(described.listener.endpointFile, sc.endpointFile);

    const pinned = inspectHost(fakeCtx(), { tokenFile: sc.tokenFile, boundSessionIds: [SESSION], port: 42761 });
    assert.deepEqual(pinned.listener, { port: 42761, endpointFile: null, discoverable: true });
  } finally {
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T273: apply writes nothing onto the host context (Cordis 4 refuses undeclared properties)', async () => {
  // The first real Desktop load failed with `cannot set property "dshDirect" without provide`: Cordis 4 turns an
  // assignment to an undeclared context property into a thrown error *inside* apply, so the row never activates. This
  // ctx reproduces that rule, so the suite fails if the plugin ever publishes itself onto ctx again.
  const sc = scene();
  const allowed = new Set(['sessionController', 'on', 'emit', 'logger', 'logs']);
  const ctx = new Proxy(fakeCtx(), {
    set(target, key, value) {
      if (typeof key === 'string' && !allowed.has(key)) {
        throw new Error('cannot set property "' + key + '" without provide');
      }
      target[key] = value;
      return true;
    },
  });
  try {
    const dispose = apply(ctx, { tokenFile: sc.tokenFile, boundSessionIds: [SESSION], endpointFile: sc.endpointFile });
    assert.equal(typeof dispose, 'function', 'a strict host context must not make apply throw');
    const started = await dispose.ready;
    assert.ok(started, 'the bridge must still start under a strict context: ' + errorsOf(ctx).join('; '));
    assert.deepEqual(dispose.boundSessionIds, [SESSION]);
    assert.equal(dispose.endpointFile, sc.endpointFile);
    await dispose();
    assert.equal(openBridgeCount(), 0);
  } finally {
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T273: the plugin copies stay byte-identical to their sources', () => {
  const dir = path.join(process.cwd(), 'tools', 'dsh-direct');
  for (const name of ['protocol.mjs', 'session_api.mjs', 'endpoint.mjs', 'adapters.mjs', 'host_bridge.mjs']) {
    const source = readFileSync(path.join(dir, name), 'utf8');
    const copy = readFileSync(path.join(dir, 'plugin', 'lib', name), 'utf8');
    assert.equal(copy, source, name + ' drifted; run node tools/dsh-direct/plugin/sync.mjs');
  }
});
