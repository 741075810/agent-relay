// T211: the completion instant has to survive the deployed chain.
//
// Real `tools/service/host_mirror.mjs` sidecar -> real service -> `intakeOnce` -> real extension consumption module
// (`extension/lib/autosend_chrome_wiring.js`). The Bridge database is a real SQLite file built with the live schema;
// only Chrome is mocked, because it is not in this slice.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { intakeOnce } from './tools/service/relay_candidate_intake.mjs';
import { mergeIntoStore } from './tools/service/relay_candidate_intake.mjs';
import { createChromeAutoSend } from './extension/lib/autosend_chrome_wiring.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.PYTHON || 'python';
const HOST = path.join(HERE, 'host.py');
const SERVICE = path.join(HERE, 'tools', 'service', 'relay_service.mjs');
const SIDECAR = path.join(HERE, 'tools', 'service', 'host_mirror.mjs');
const ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
const RUN = 'eeee1111-1111-4222-8333-444455556666';
const OLD_START_MS = 1700000000000;

const children = [];
after(() => { for (const child of children) { try { child.kill(); } catch { /* gone */ } } });

function scene() {
  const state = mkdtempSync(path.join(tmpdir(), 't211e-state-'));
  const ownRoot = mkdtempSync(path.join(tmpdir(), 't211e-own-'));
  mkdirSync(path.join(ownRoot, 'c'.repeat(64)), { recursive: true });
  writeFileSync(path.join(ownRoot, 'c'.repeat(64), 'endpoint.json.runs.json'), '[]');
  const otherRoot = mkdtempSync(path.join(tmpdir(), 't211e-other-'));
  mkdirSync(path.join(otherRoot, 'd'.repeat(64)), { recursive: true });
  const otherLedger = path.join(otherRoot, 'd'.repeat(64), 'endpoint.json.runs.json');
  writeFileSync(otherLedger, JSON.stringify([{ requestID: RUN, status: 'completed', createdAt: OLD_START_MS }]));
  const nativeRoot = path.join(state, 'native');
  mkdirSync(nativeRoot, { recursive: true });
  const manifest = path.join(state, 'host_manifest.t211e.json');
  writeFileSync(manifest, JSON.stringify({ name: 'com.dsh.notify', type: 'stdio', allowed_origins: [ORIGIN] }));
  const fixture = path.join(state, 'bridge-origin.fixture.json');
  writeFileSync(fixture, JSON.stringify({ version: 1, bridge: '*' }));
  const db = path.join(state, 'service.sqlite');
  return { state, ownRoot, otherRoot, nativeRoot, manifest, fixture, db };
}

function bridgeDatabase(dbPath, kind, seconds) {
  const db = new DatabaseSync(dbPath);
  db.exec('create table bridge_service_tasks (task_id text primary key, status text, provider_run_id text, '
    + 'failure_code text, created_at real, updated_at real)');
  db.exec('create table bridge_service_task_events (event_id integer primary key autoincrement, task_id text, '
    + 'kind text, summary text, details text, created_at real)');
  db.prepare('insert into bridge_service_tasks values (?,?,?,?,?,?)')
    .run('tsk-1', 'completed', RUN, null, OLD_START_MS / 1000, (OLD_START_MS / 1000) + 60);
  if (kind) {
    db.prepare('insert into bridge_service_task_events (task_id, kind, summary, created_at) values (?,?,?,?)')
      .run('tsk-1', kind, 'fixture', seconds);
  }
  db.close();
}

function eventAfterActivation(world, kind, deltaMs = 5000) {
  const state = JSON.parse(readFileSync(path.join(world.state, 'terminal-source.json'), 'utf8'));
  assert.equal(typeof state.relayActivatedAt, 'number', 'the activation instant must be on disk');
  const db = new DatabaseSync(world.db);
  db.prepare('insert into bridge_service_task_events (task_id, kind, summary, created_at) values (?,?,?,?)')
    .run('tsk-1', kind, 'after activation', (state.relayActivatedAt + deltaMs) / 1000);
  db.close();
  return state.relayActivatedAt;
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

function runSidecar(world, service) {
  const result = spawnSync(process.execPath, [SIDECAR,
    '--host-script', HOST, '--python', PYTHON, '--origin', ORIGIN,
    '--state-dir', world.state, '--ledger-root', world.otherRoot, '--bridge-db', world.db,
    '--native-root', world.nativeRoot, '--manifest', world.manifest, '--bridge-db-fixture', world.fixture,
    '--service-url', service.base, '--service-token-file', service.tokenFile, '--once'],
  { encoding: 'utf8', env: { ...process.env, PYTHON } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n')[0]);
}

function hostArgs(world, service) {
  return [ORIGIN, '--state-dir', world.state, '--ledger-root', world.ownRoot, '--manifest', world.manifest,
    '--bridge-db', world.db, '--bridge-db-fixture', world.fixture, '--native-root', world.nativeRoot,
    '--relay-url', service.base, '--relay-token-file', service.tokenFile];
}

function visit(world, service) {
  return intakeOnce({ host: { python: PYTHON, script: HOST, args: hostArgs(world, service) }, now: Date.now() });
}

function serviceRecords(service, token) {
  const response = spawnSync(process.execPath, ['-e', `
    const [base, token] = process.argv.slice(1);
    fetch(base + '/runs', { headers: { authorization: 'Bearer ' + token } })
      .then((r) => r.json()).then((body) => process.stdout.write(JSON.stringify(body)));
  `, service.base, token], { encoding: 'utf8' });
  return JSON.parse(response.stdout);
}

test('the sidecar carries a real completion instant into the service', async () => {
  const world = scene();
  bridgeDatabase(world.db, 'task.completed', 1793453704.945753);
  const service = await startService(path.join(world.state, 'svc'));
  const pushed = runSidecar(world, service);
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.equal(pushed.candidates, 1);
  const token = readFileSync(service.tokenFile, 'utf8').trim();
  const records = serviceRecords(service, token).runs || [];
  assert.equal(records.length, 1);
  assert.equal(records[0].completedAt, 1793453704946, 'seconds converted to milliseconds');
  assert.equal(records[0].completedAtSource, 'bridge.task_events.task.completed');
});

test('a run with no terminal event reaches the service as unknown, not as a guess', async () => {
  const world = scene();
  bridgeDatabase(world.db, null, null);
  const service = await startService(path.join(world.state, 'svc'));
  runSidecar(world, service);
  const token = readFileSync(service.tokenFile, 'utf8').trim();
  const records = serviceRecords(service, token).runs || [];
  assert.equal(records[0].completedAt, null);
  assert.equal(records[0].completedAtSource, 'unknown');
});

test('the extension consumer receives the run the real chain authorised', async () => {
  const world = scene();
  bridgeDatabase(world.db, null, null);
  const service = await startService(path.join(world.state, 'svc'));
  await visit(world, service);                       // activation with an empty relay
  eventAfterActivation(world, 'task.completed');     // and only then does the Bridge commit its event
  runSidecar(world, service);
  const pass = await visit(world, service);
  assert.deepEqual(pass.admitted.map((item) => item.runId), [RUN]);
  const store = mergeIntoStore([], pass.admitted, Date.now());
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
  const wiring = createChromeAutoSend(chrome, {});
  const listed = await wiring.readCandidates();
  assert.deepEqual(listed.map((item) => item.runId), [RUN]);
});

test('that same run is invisible when the host could not prove when it finished', async () => {
  const world = scene();
  bridgeDatabase(world.db, null, null);
  const service = await startService(path.join(world.state, 'svc'));
  await visit(world, service);
  runSidecar(world, service);
  const pass = await visit(world, service);
  assert.deepEqual(pass.admitted, [], 'no instant and no complete snapshot: withheld');
});
