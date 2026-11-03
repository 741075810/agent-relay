// T214: the millisecond boundary and the provenance gate, seen from the extension consumer.
//
// Real `host_mirror.mjs` sidecar, real service, real `intakeOnce`, real extension consumption module, real SQLite with
// the live Bridge schema. Chrome is the only mock, because it is not in this slice.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { intakeOnce, mergeIntoStore } from './tools/service/relay_candidate_intake.mjs';
import { createChromeAutoSend } from './extension/lib/autosend_chrome_wiring.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.PYTHON || 'python';
const HOST = path.join(HERE, 'host.py');
const SERVICE = path.join(HERE, 'tools', 'service', 'relay_service.mjs');
const SIDECAR = path.join(HERE, 'tools', 'service', 'host_mirror.mjs');
const ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
const EARLY = 'cafe1111-1111-4222-8333-444455556666';
const LATE = 'cafe2222-1111-4222-8333-444455556666';
const UNSOURCED = 'cafe3333-1111-4222-8333-444455556666';
const OLD_START_MS = 1700000000000;

const children = [];
after(() => { for (const child of children) { try { child.kill(); } catch { /* gone */ } } });

function scene() {
  const state = mkdtempSync(path.join(tmpdir(), 't214e-state-'));
  const ownRoot = mkdtempSync(path.join(tmpdir(), 't214e-own-'));
  mkdirSync(path.join(ownRoot, 'c'.repeat(64)), { recursive: true });
  writeFileSync(path.join(ownRoot, 'c'.repeat(64), 'endpoint.json.runs.json'), '[]');
  const otherRoot = mkdtempSync(path.join(tmpdir(), 't214e-other-'));
  mkdirSync(path.join(otherRoot, 'd'.repeat(64)), { recursive: true });
  const otherLedger = path.join(otherRoot, 'd'.repeat(64), 'endpoint.json.runs.json');
  writeFileSync(otherLedger, '[]');
  const nativeRoot = path.join(state, 'native');
  mkdirSync(nativeRoot, { recursive: true });
  const manifest = path.join(state, 'host_manifest.t214e.json');
  writeFileSync(manifest, JSON.stringify({ name: 'com.dsh.notify', type: 'stdio', allowed_origins: [ORIGIN] }));
  const fixture = path.join(state, 'bridge-origin.fixture.json');
  writeFileSync(fixture, JSON.stringify({ version: 1, bridge: '*' }));
  return { state, ownRoot, otherRoot, otherLedger, nativeRoot, manifest, fixture,
    db: path.join(state, 'service.sqlite') };
}

function database(world, rows) {
  const db = new DatabaseSync(world.db);
  db.exec('create table bridge_service_tasks (task_id text primary key, status text, provider_run_id text, '
    + 'failure_code text, created_at real, updated_at real)');
  db.exec('create table bridge_service_task_events (event_id integer primary key autoincrement, task_id text, '
    + 'kind text, summary text, details text, created_at real)');
  rows.forEach(([runId, kind, seconds], index) => {
    db.prepare('insert into bridge_service_tasks values (?,?,?,?,?,?)')
      .run(`tsk-${index}`, 'completed', runId, null, OLD_START_MS / 1000, OLD_START_MS / 1000 + 30);
    if (kind) {
      db.prepare('insert into bridge_service_task_events (task_id, kind, summary, created_at) values (?,?,?,?)')
        .run(`tsk-${index}`, kind, 'fixture', seconds);
    }
  });
  db.close();
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
  return [ORIGIN, '--state-dir', world.state, '--ledger-root', world.ownRoot, '--manifest', world.manifest,
    '--bridge-db', world.db, '--bridge-db-fixture', world.fixture, '--native-root', world.nativeRoot,
    '--relay-url', service.base, '--relay-token-file', service.tokenFile];
}

function visit(world, service) {
  return intakeOnce({ host: { python: PYTHON, script: HOST, args: hostArgs(world, service) }, now: Date.now() });
}

function runSidecar(world, service, runs) {
  writeFileSync(world.otherLedger, JSON.stringify(runs));
  const result = spawnSync(process.execPath, [SIDECAR,
    '--host-script', HOST, '--python', PYTHON, '--origin', ORIGIN,
    '--state-dir', world.state, '--ledger-root', world.otherRoot, '--bridge-db', world.db,
    '--native-root', world.nativeRoot, '--manifest', world.manifest, '--bridge-db-fixture', world.fixture,
    '--service-url', service.base, '--service-token-file', service.tokenFile, '--once'],
  { encoding: 'utf8', env: { ...process.env, PYTHON } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function writeArm(world, takenAt, armMs) {
  const doc = { version: 1, epoch: 'e-t214', takenAt, truncated: false, ids: [], sources: ['bridge_ledger'],
    relayCovered: false, relayUpstreamComplete: false };
  if (armMs !== undefined) doc.armTakenAtMs = armMs;
  writeFileSync(path.join(world.state, 'terminal-arm.json'), JSON.stringify(doc));
}

function consumer(admitted) {
  const store = mergeIntoStore([], admitted, Date.now());
  store.__data = { terminalCandidates: store.list };
  const chrome = { storage: { local: {
    get(keys, done) {
      const out = {};
      for (const [key, fallback] of Object.entries(keys || {})) out[key] = key in store.__data ? store.__data[key] : fallback;
      if (typeof done === 'function') { done(out); return undefined; }
      return Promise.resolve(out);
    },
    set(items, done) { Object.assign(store.__data, items); if (typeof done === 'function') done(); },
  } } };
  return createChromeAutoSend(chrome, {});
}

test('a run that finished 400 ms before the arm never reaches the consumer, one that finished after does', async () => {
  const second = Math.floor(Date.now() / 1000);
  const world = scene();
  database(world, [[EARLY, 'task.completed', second + 0.5], [LATE, 'task.completed', second + 0.95]]);
  const service = await startService(path.join(world.state, 'svc'));
  await visit(world, service);                                  // activation, relay empty
  writeArm(world, second, second * 1000 + 900);                 // the operator consented at .900
  runSidecar(world, service, [{ requestID: EARLY, status: 'completed', createdAt: OLD_START_MS },
    { requestID: LATE, status: 'completed', createdAt: OLD_START_MS }]);
  const pass = await visit(world, service);
  assert.deepEqual(pass.admitted.map((item) => item.runId), [LATE]);
  const seen = await consumer(pass.admitted).readCandidates();
  assert.deepEqual(seen.map((item) => item.runId), [LATE]);
});

test('a number with no provenance never reaches the consumer', async () => {
  const world = scene();
  database(world, [[UNSOURCED, null, null]]);
  const service = await startService(path.join(world.state, 'svc'));
  await visit(world, service);
  const token = readFileSync(service.tokenFile, 'utf8').trim();
  await fetch(service.base + '/host/terminal-candidates', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ candidates: [{ runId: UNSOURCED, terminalStatus: 'completed',
      statusSource: 'bridge.run_facts.status', hostSource: 'native_host.terminal-mirror', origin: 'bridge',
      startedAt: Math.floor(OLD_START_MS / 1000), completedAt: Date.now() + 60000 }] }),
  });
  const pass = await visit(world, service);
  assert.deepEqual(pass.admitted, []);
  assert.deepEqual(await consumer(pass.admitted).readCandidates(), []);
});
