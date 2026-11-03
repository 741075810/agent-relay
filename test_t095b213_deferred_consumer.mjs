// T213: a deferred run must be recoverable all the way to the extension consumer, and only once.
//
// Real `host_mirror.mjs` sidecar, real service, real `intakeOnce`, real extension consumption module, real SQLite with
// the live Bridge schema -- the failure the audit found was that a terminal run with no event row was written out of
// reach, so the late, legitimate completion could never reach this consumer.
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
const LATE_RUN = 'beef1111-1111-4222-8333-444455556666';
const OLD_RUN = 'beef2222-1111-4222-8333-444455556666';
const OLD_START_MS = 1700000000000;

const children = [];
after(() => { for (const child of children) { try { child.kill(); } catch { /* gone */ } } });

function scene() {
  const state = mkdtempSync(path.join(tmpdir(), 't213e-state-'));
  const ownRoot = mkdtempSync(path.join(tmpdir(), 't213e-own-'));
  mkdirSync(path.join(ownRoot, 'c'.repeat(64)), { recursive: true });
  writeFileSync(path.join(ownRoot, 'c'.repeat(64), 'endpoint.json.runs.json'), '[]');
  const otherRoot = mkdtempSync(path.join(tmpdir(), 't213e-other-'));
  mkdirSync(path.join(otherRoot, 'd'.repeat(64)), { recursive: true });
  const otherLedger = path.join(otherRoot, 'd'.repeat(64), 'endpoint.json.runs.json');
  writeFileSync(otherLedger, '[]');
  const nativeRoot = path.join(state, 'native');
  mkdirSync(nativeRoot, { recursive: true });
  const manifest = path.join(state, 'host_manifest.t213e.json');
  writeFileSync(manifest, JSON.stringify({ name: 'com.dsh.notify', type: 'stdio', allowed_origins: [ORIGIN] }));
  const fixture = path.join(state, 'bridge-origin.fixture.json');
  writeFileSync(fixture, JSON.stringify({ version: 1, bridge: '*' }));
  return { state, ownRoot, otherRoot, otherLedger, nativeRoot, manifest, fixture,
    db: path.join(state, 'service.sqlite') };
}

function database(world) {
  const db = new DatabaseSync(world.db);
  db.exec('create table bridge_service_tasks (task_id text primary key, status text, provider_run_id text, '
    + 'failure_code text, created_at real, updated_at real)');
  db.exec('create table bridge_service_task_events (event_id integer primary key autoincrement, task_id text, '
    + 'kind text, summary text, details text, created_at real)');
  return db;
}

function taskRow(world, runId, status = 'completed') {
  const db = database(world);
  db.prepare('insert into bridge_service_tasks values (?,?,?,?,?,?)')
    .run('tsk-' + runId.slice(0, 8), status, runId, null, OLD_START_MS / 1000, OLD_START_MS / 1000 + 30);
  db.close();
}

function eventRow(world, runId, kind, seconds) {
  const db = new DatabaseSync(world.db);
  db.prepare('insert into bridge_service_task_events (task_id, kind, summary, created_at) values (?,?,?,?)')
    .run('tsk-' + runId.slice(0, 8), kind, 'late event', seconds);
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
  return JSON.parse(result.stdout.trim().split('\n')[0]);
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

test('the late event reaches the consumer exactly once', async () => {
  const world = scene();
  taskRow(world, LATE_RUN);
  const service = await startService(path.join(world.state, 'svc'));
  await visit(world, service);
  runSidecar(world, service, [{ requestID: LATE_RUN, status: 'completed', createdAt: OLD_START_MS }]);
  assert.deepEqual((await visit(world, service)).admitted, [], 'no instant yet: nothing to the consumer');

  eventRow(world, LATE_RUN, 'task.completed', Math.floor(Date.now() / 1000) + 2);
  runSidecar(world, service, [{ requestID: LATE_RUN, status: 'completed', createdAt: OLD_START_MS }]);
  const pass = await visit(world, service);
  assert.deepEqual(pass.admitted.map((item) => item.runId), [LATE_RUN]);
  const seen = await consumer(pass.admitted).readCandidates();
  assert.deepEqual(seen.map((item) => item.runId), [LATE_RUN]);

  const ack = spawnSync(PYTHON, ['-B', '-c', `
import io, json, sys
sys.path.insert(0, ${JSON.stringify(HERE)})
import protocol as P, subprocess
req = {'v': P.PROTOCOL_VERSION, 'id': 'r1', 'op': 'terminal-ack', 'args': {'acked': [${JSON.stringify(LATE_RUN)}]}}
proc = subprocess.run([${JSON.stringify(PYTHON)}, '-B', ${JSON.stringify(HOST)}] + sys.argv[1:],
                      input=P.encode(req), capture_output=True)
sys.stdout.buffer.write(proc.stdout)
`, ...hostArgs(world, service)], { encoding: null, env: { ...process.env, PYTHON } });
  assert.equal(ack.status, 0, String(ack.stderr));
  const after = await visit(world, service);
  assert.deepEqual(after.admitted, [], 'acknowledged: finished, not re-offered');
});

test('an event that proves it finished before consent never reaches the consumer', async () => {
  const world = scene();
  taskRow(world, OLD_RUN);
  const service = await startService(path.join(world.state, 'svc'));
  await visit(world, service);
  runSidecar(world, service, [{ requestID: OLD_RUN, status: 'completed', createdAt: OLD_START_MS }]);
  assert.deepEqual((await visit(world, service)).admitted, []);
  eventRow(world, OLD_RUN, 'task.completed', 1700000000.5);
  runSidecar(world, service, [{ requestID: OLD_RUN, status: 'completed', createdAt: OLD_START_MS }]);
  const pass = await visit(world, service);
  assert.deepEqual(pass.admitted, [], 'proven history: absorbed for good');
});

test('a restart between deferral and evidence still delivers once', async () => {
  const world = scene();
  taskRow(world, LATE_RUN);
  const first = await startService(path.join(world.state, 'svc'));
  await visit(world, first);
  runSidecar(world, first, [{ requestID: LATE_RUN, status: 'completed', createdAt: OLD_START_MS }]);
  assert.deepEqual((await visit(world, first)).admitted, []);
  first.child.kill();
  await new Promise((resolve) => first.child.once('exit', resolve));
  const second = await startService(path.join(world.state, 'svc'));
  eventRow(world, LATE_RUN, 'task.completed', Math.floor(Date.now() / 1000) + 2);
  runSidecar(world, second, [{ requestID: LATE_RUN, status: 'completed', createdAt: OLD_START_MS }]);
  const pass = await visit(world, second);
  assert.deepEqual(pass.admitted.map((item) => item.runId), [LATE_RUN]);
  const token = readFileSync(second.tokenFile, 'utf8').trim();
  assert.ok(token.length > 0);
});
