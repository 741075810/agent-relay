// T210: cross-source arm integrity, seen from the extension's consumption module.
//
// The snapshot is built by the real host from the Bridge ledger; the relay sees runs the ledger does not. Real host
// subprocess, real service, real `extension/lib/autosend_chrome_wiring.js`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
const RELAY_ONLY = 'cccc1111-1111-4222-8333-444455556666';
const LONG_RUN = 'dddd2222-1111-4222-8333-444455556666';
const OLD = 1700000000000;

const children = [];
after(() => { for (const child of children) { try { child.kill(); } catch { /* gone */ } } });

function scene() {
  const root = mkdtempSync(path.join(tmpdir(), 't210e-root-'));
  const state = mkdtempSync(path.join(tmpdir(), 't210e-state-'));
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't210e-svc-'));
  const ledgerRoot = path.join(root, 'c'.repeat(64));
  mkdirSync(ledgerRoot, { recursive: true });
  writeFileSync(path.join(ledgerRoot, 'endpoint.json.runs.json'), '[]');
  const manifest = path.join(state, 'host_manifest.t210e.json');
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

// Posts records verbatim: this suite is about what happens when the completion stamp is missing.
async function seed(service, items) {
  const token = readFileSync(service.tokenFile, 'utf8').trim();
  await fetch(service.base + '/host/terminal-candidates', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ candidates: items }),
  });
}

function pass(world, service) {
  return intakeOnce({ host: { python: PYTHON, script: HOST, args: hostArgs(world, service) }, now: Date.now() });
}

test('a relay-only run with no completion stamp never reaches the extension store, with or without an arm', async () => {
  const world = scene();
  const service = await startService(world.serviceDir);
  await pass(world, service);                                   // baseline + activation
  await seed(service, [{ runId: RELAY_ONLY, terminalStatus: 'completed', startedAt: OLD,
    hostSource: 'native_host.terminal-mirror', statusSource: 'bridge_ledger.status', origin: 'bridge' }]);
  const withoutArm = await pass(world, service);
  assert.deepEqual(withoutArm.admitted, [], 'no completion evidence means no notice');

  writeFileSync(path.join(world.state, 'terminal-arm.json'), JSON.stringify({ version: 1, epoch: 'e1',
    takenAt: 1793600000, truncated: false, ids: [], sources: ['bridge_ledger'], relayCovered: false }));
  const withArm = await pass(world, service);
  assert.deepEqual(withArm.admitted, [],
    'absence from a ledger-only snapshot is not proof that this run finished after consent');
  const store = mergeIntoStore([], withArm.admitted, Date.now());
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
  assert.deepEqual(await wiring.readCandidates(), []);
});

test('a long run that began before the arm and finished after it is delivered once', async () => {
  const world = scene();
  const service = await startService(world.serviceDir);
  await pass(world, service);
  writeFileSync(path.join(world.state, 'terminal-arm.json'), JSON.stringify({ version: 1, epoch: 'e1',
    takenAt: 1793600000, truncated: false, ids: [], sources: ['bridge_ledger'], relayCovered: false }));
  await pass(world, service);
  await seed(service, [{ runId: LONG_RUN, terminalStatus: 'completed', startedAt: OLD,
    completedAt: Date.now() + 60000,
    hostSource: 'native_host.terminal-mirror', statusSource: 'bridge_ledger.status', origin: 'bridge' }]);
  const pass1 = await pass(world, service);
  assert.deepEqual(pass1.admitted.map((item) => item.runId), [LONG_RUN]);
  assert.equal(pass1.admitted[0].postArm, true);
  const pass2 = await pass(world, service);
  assert.deepEqual(pass2.admitted.map((item) => item.runId), [LONG_RUN], 'still offered until acknowledged');
  assert.equal(pass2.admitted.length, 1, 'and never twice in one answer');
});
