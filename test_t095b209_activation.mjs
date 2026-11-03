// T209: the relay's own activation, seen from the extension's consumption module.
//
// Real host subprocess, real service, real `extension/lib/autosend_chrome_wiring.js`. The relay is switched on after the
// native baseline already exists -- the deployment case T208 did not cover.
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
const OLD_RUN = '66666666-1111-4222-8333-444455556666';
const NEW_RUN = '77777777-1111-4222-8333-444455556666';

const children = [];
after(() => { for (const child of children) { try { child.kill(); } catch { /* gone */ } } });

function scene() {
  const root = mkdtempSync(path.join(tmpdir(), 't209e-root-'));
  const state = mkdtempSync(path.join(tmpdir(), 't209e-state-'));
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't209e-svc-'));
  const ledgerRoot = path.join(root, 'b'.repeat(64));
  mkdirSync(ledgerRoot, { recursive: true });
  writeFileSync(path.join(ledgerRoot, 'endpoint.json.runs.json'), '[]');
  const manifest = path.join(state, 'host_manifest.t209e.json');
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

async function seed(service, items) {
  const token = readFileSync(service.tokenFile, 'utf8').trim();
  await fetch(service.base + '/host/terminal-candidates', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    // `startedAt` says when the run began; the host decides consent from `completedAt`, computed here so a literal
    // cannot drift into the past while the suite runs.
    body: JSON.stringify({ candidates: items.map(([runId, startedAt, completedAt]) => ({ runId,
      terminalStatus: 'completed', startedAt,
      completedAt: completedAt ?? (Date.now() + 60000), completedAtSource: 'bridge.task_events.task.completed',
      hostSource: 'native_host.terminal-mirror', statusSource: 'bridge_ledger.status', origin: 'bridge' })) }),
  });
}

function pass(world, service) {
  return intakeOnce({ host: { python: PYTHON, script: HOST, args: hostArgs(world, service) }, now: Date.now() });
}

function chromeWith(list) {
  const data = { terminalCandidates: list };
  return { storage: { local: {
    get(keys, done) {
      const out = {};
      if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
        for (const [key, fallback] of Object.entries(keys)) out[key] = key in data ? data[key] : fallback;
      } else {
        for (const key of [].concat(keys || [])) if (key in data) out[key] = data[key];
      }
      if (typeof done === 'function') { done(out); return undefined; }
      return Promise.resolve(out);
    },
    set(items, done) { Object.assign(data, items); if (typeof done === 'function') done(); },
  } }, __data: data };
}

test('a relay switched on after the native baseline never delivers its old completions', async () => {
  const world = scene();
  const service = await startService(world.serviceDir);
  await pass(world, service);                              // native + relay baseline, both empty
  await seed(service, [[OLD_RUN, 1700000000000, 1700000000000]]);
  const enabling = await pass(world, service);
  assert.deepEqual(enabling.admitted, [], 'enabling the relay is not a reason to announce old work');
  const store = mergeIntoStore([], enabling.admitted, Date.now());
  const wiring = createChromeAutoSend(chromeWith(store.list), {});
  assert.deepEqual(await wiring.readCandidates(), [], 'nothing reaches the extension store');

  await seed(service, [[OLD_RUN, 1700000000000, 1700000000000], [NEW_RUN, 1700000000000, Date.now() + 60000]]);
  const later = await pass(world, service);
  assert.deepEqual(later.admitted.map((item) => item.runId), [NEW_RUN]);
  const second = mergeIntoStore(store.list, later.admitted, Date.now());
  const consumer = createChromeAutoSend(chromeWith(second.list), {});
  assert.deepEqual((await consumer.readCandidates()).map((item) => item.runId), [NEW_RUN]);
});

test('with an arm snapshot the old run stays silent and the post-arm run is delivered', async () => {
  const world = scene();
  const service = await startService(world.serviceDir);
  await pass(world, service);
  const armPath = path.join(world.state, 'terminal-arm.json');
  writeFileSync(armPath, JSON.stringify({ version: 1, epoch: 'e1', takenAt: 1793600000, truncated: false,
    ids: [OLD_RUN] }));
  await seed(service, [[OLD_RUN, 1700000000000, 1700000000000], [NEW_RUN, 1700000000000, Date.now() + 60000]]);
  const first = await pass(world, service);
  assert.deepEqual(first.admitted.map((item) => item.runId), [NEW_RUN],
    'the arm snapshot proves the first was already terminal when consent was recorded');
  assert.equal(first.admitted[0].postArm, true);
});
