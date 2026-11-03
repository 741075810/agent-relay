// T208: history is not news, and an ACK cannot cancel a run nobody was given -- checked through the extension's own
// consumption module. Real host subprocess, real service, real `extension/lib/autosend_chrome_wiring.js`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { intakeOnce, mergeIntoStore } from './tools/service/relay_candidate_intake.mjs';
import { createChromeAutoSend } from './extension/lib/autosend_chrome_wiring.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.PYTHON || 'python';
const HOST = path.join(HERE, 'host.py');
const SERVICE = path.join(HERE, 'tools', 'service', 'relay_service.mjs');
const ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
const OLD_RUN = '11111111-1111-4222-8333-444455556666';
const NEW_RUN = '22222222-1111-4222-8333-444455556666';

const children = [];
after(() => { for (const child of children) { try { child.kill(); } catch { /* gone */ } } });

function scene() {
  const root = mkdtempSync(path.join(tmpdir(), 't208e-root-'));
  const state = mkdtempSync(path.join(tmpdir(), 't208e-state-'));
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't208e-svc-'));
  const ledgerRoot = path.join(root, 'a'.repeat(64));
  mkdirSync(ledgerRoot, { recursive: true });
  writeFileSync(path.join(ledgerRoot, 'endpoint.json.runs.json'), '[]');
  const manifest = path.join(state, 'host_manifest.t208e.json');
  writeFileSync(manifest, JSON.stringify({ name: 'com.dsh.notify', type: 'stdio', allowed_origins: [ORIGIN] }));
  const fixture = path.join(state, 'bridge-origin.fixture.json');
  writeFileSync(fixture, JSON.stringify({ version: 1, bridge: '*' }));
  const nativeRoot = path.join(state, 'native');
  mkdirSync(nativeRoot, { recursive: true });
  return { root, state, serviceDir, manifest, fixture, nativeRoot };
}

async function startService(dir) {
  const child = spawn(process.execPath, [SERVICE, '--state-dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const ready = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const line = buffer.split('\n')[0];
      if (line && line.trim().startsWith('{')) resolve(JSON.parse(line));
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error('service exited ' + code)));
  });
  return { child, base: ready.base, tokenFile: ready.tokenFile };
}

function hostArgs(world, service) {
  return [ORIGIN, '--state-dir', world.state, '--ledger-root', world.root, '--manifest', world.manifest,
    '--bridge-db-fixture', world.fixture, '--native-root', world.nativeRoot,
    '--relay-url', service.base, '--relay-token-file', service.tokenFile];
}

async function seed(service, runIds) {
  const token = readFileSync(service.tokenFile, 'utf8').trim();
  // OLD_RUN finished before any activation; everything else is a later completion. The host decides from these stamps,
  // so the fixture has to state the fact rather than imply it with the order of calls.
  const stamp = (runId) => (runId === OLD_RUN ? 1700000000000 : Date.now() + 60000);
  await fetch(service.base + '/host/terminal-candidates', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ candidates: runIds.map((runId) => ({ runId, terminalStatus: 'completed',
      startedAt: 1700000000000,
      completedAt: stamp(runId), completedAtSource: 'bridge.task_events.task.completed',
      hostSource: 'native_host.terminal-mirror', statusSource: 'bridge_ledger.status', origin: 'bridge' })) }),
  });
}

function pass(world, service) {
  return intakeOnce({ host: { python: PYTHON, script: HOST, args: hostArgs(world, service) }, now: Date.now() });
}

function ack(world, service, ids) {
  const body = Buffer.from(JSON.stringify({ v: 1, id: 'ack', op: 'terminal-ack', args: { acked: ids } }), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  const result = spawnSync(PYTHON, [HOST, ...hostArgs(world, service)], { input: Buffer.concat([head, body]) });
  assert.equal(result.status, 0, result.stderr.toString());
  const length = result.stdout.readUInt32LE(0);
  return JSON.parse(result.stdout.subarray(4, 4 + length).toString('utf8'));
}

test('a run that finished before the relay was enabled is absorbed, not announced', async () => {
  const world = scene();
  const service = await startService(world.serviceDir);
  await seed(service, [OLD_RUN]);
  const first = await pass(world, service);
  assert.deepEqual(first.admitted, [], 'enabling the relay must not replay finished history');
  const second = await pass(world, service);
  assert.deepEqual(second.admitted, []);
  await seed(service, [OLD_RUN, NEW_RUN]);
  const third = await pass(world, service);
  assert.deepEqual(third.admitted.map((item) => item.runId), [NEW_RUN], 'only the new completion is a candidate');
  const store = mergeIntoStore([], third.admitted, Date.now());
  const chrome = { storage: { local: {
    get(keys, done) {
      const out = {};
      if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
        for (const [key, fallback] of Object.entries(keys)) out[key] = key in store.__data ? store.__data[key] : fallback;
      }
      if (typeof done === 'function') { done(out); return undefined; }
      return Promise.resolve(out);
    },
    set(items, done) { Object.assign(store.__data, items); if (typeof done === 'function') done(); },
  } } };
  store.__data = { terminalCandidates: store.list };
  const wiring = createChromeAutoSend(chrome, {});
  assert.deepEqual((await wiring.readCandidates()).map((item) => item.runId), [NEW_RUN]);
});

test('an ACK for a run that was never offered does not cancel its later completion', async () => {
  const world = scene();
  const service = await startService(world.serviceDir);
  await seed(service, []);
  assert.deepEqual((await pass(world, service)).admitted, []);       // baseline
  const early = ack(world, service, [NEW_RUN]);
  assert.equal(early.ok, true, JSON.stringify(early));
  const state = JSON.parse(readFileSync(path.join(world.state, 'terminal-source.json'), 'utf8'));
  assert.deepEqual(state.relayAckedIds || [], [], 'an id nobody was given must not be journalled');

  await seed(service, [NEW_RUN]);
  const later = await pass(world, service);
  assert.deepEqual(later.admitted.map((item) => item.runId), [NEW_RUN],
    'the run is still announced when it really finishes');
  ack(world, service, [NEW_RUN]);
  assert.deepEqual((await pass(world, service)).admitted, [], 'and a real ACK is still final');
});
