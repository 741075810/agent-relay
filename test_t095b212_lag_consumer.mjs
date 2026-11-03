// T212: the extension consumer must never see a notice authorised by a cache's emptiness.
//
// Real `host_mirror.mjs` sidecar, real service, real `intakeOnce`, real extension consumption module. The arm is taken
// while the service is empty and the old completion is mirrored afterwards -- the exact lag the audit found.
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
const OLD_RUN = 'abcd1111-1111-4222-8333-444455556666';
const NEW_RUN = 'abcd2222-1111-4222-8333-444455556666';
const OLD_START_MS = 1700000000000;
const ANCIENT_SECONDS = 1700000000.5;

const children = [];
after(() => { for (const child of children) { try { child.kill(); } catch { /* gone */ } } });

function scene() {
  const state = mkdtempSync(path.join(tmpdir(), 't212e-state-'));
  const ownRoot = mkdtempSync(path.join(tmpdir(), 't212e-own-'));
  mkdirSync(path.join(ownRoot, 'c'.repeat(64)), { recursive: true });
  writeFileSync(path.join(ownRoot, 'c'.repeat(64), 'endpoint.json.runs.json'), '[]');
  const otherRoot = mkdtempSync(path.join(tmpdir(), 't212e-other-'));
  mkdirSync(path.join(otherRoot, 'd'.repeat(64)), { recursive: true });
  const otherLedger = path.join(otherRoot, 'd'.repeat(64), 'endpoint.json.runs.json');
  const nativeRoot = path.join(state, 'native');
  mkdirSync(nativeRoot, { recursive: true });
  const manifest = path.join(state, 'host_manifest.t212e.json');
  writeFileSync(manifest, JSON.stringify({ name: 'com.dsh.notify', type: 'stdio', allowed_origins: [ORIGIN] }));
  const fixture = path.join(state, 'bridge-origin.fixture.json');
  writeFileSync(fixture, JSON.stringify({ version: 1, bridge: '*' }));
  return { state, ownRoot, otherRoot, otherLedger, nativeRoot, manifest, fixture,
    db: path.join(state, 'service.sqlite') };
}

function bridgeDatabase(dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  db.exec('create table bridge_service_tasks (task_id text primary key, status text, provider_run_id text, '
    + 'failure_code text, created_at real, updated_at real)');
  db.exec('create table bridge_service_task_events (event_id integer primary key autoincrement, task_id text, '
    + 'kind text, summary text, details text, created_at real)');
  rows.forEach(([runId, status, kind, seconds], index) => {
    db.prepare('insert into bridge_service_tasks values (?,?,?,?,?,?)')
      .run(`tsk-${index}`, status, runId, null, OLD_START_MS / 1000, (OLD_START_MS / 1000) + 30);
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

function hostCall(world, service, op, args) {
  const script = `import io, json, sys
sys.path.insert(0, ${JSON.stringify(HERE)})
import protocol as P
req = {'v': P.PROTOCOL_VERSION, 'id': 'req-1', 'op': ${JSON.stringify(op)}}
args = json.loads(${JSON.stringify(JSON.stringify(args || null))})
if args is not None:
    req['args'] = args
import subprocess
proc = subprocess.run([${JSON.stringify(PYTHON)}, '-B', ${JSON.stringify(HOST)}] + sys.argv[1:],
                      input=P.encode(req), capture_output=True)
sys.stdout.buffer.write(proc.stdout)
`;
  const result = spawnSync(PYTHON, ['-B', '-c', script, ...hostArgs(world, service)],
    { encoding: null, env: { ...process.env, PYTHON } });
  assert.equal(result.status, 0, String(result.stderr));
  // 4-byte little-endian length prefix, then JSON
  const length = result.stdout.readUInt32LE(0);
  return JSON.parse(result.stdout.slice(4, 4 + length).toString('utf8'));
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

function visit(world, service) {
  return intakeOnce({ host: { python: PYTHON, script: HOST, args: hostArgs(world, service) }, now: Date.now() });
}

test('an old completion mirrored after the arm is never offered to the consumer', async () => {
  const world = scene();
  bridgeDatabase(world.db, [[OLD_RUN, 'completed', null, null]]);
  const service = await startService(path.join(world.state, 'svc'));
  await visit(world, service);                       // activation
  const armed = hostCall(world, service, 'terminal-arm-snapshot', { epoch: 'e-t212' });
  assert.equal(armed.result.relayCovered, true, 'the arm did read the service');
  assert.equal(armed.result.relayUpstreamComplete, false, 'and it says that is all it means');
  runSidecar(world, service, [{ requestID: OLD_RUN, status: 'completed', createdAt: OLD_START_MS }]);
  const pass = await visit(world, service);
  assert.deepEqual(pass.admitted, []);
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
  assert.deepEqual(await createChromeAutoSend(chrome, {}).readCandidates(), []);
});

test('a completion after the arm still reaches the consumer', async () => {
  const world = scene();
  const service = await startService(path.join(world.state, 'svc'));
  await visit(world, service);
  hostCall(world, service, 'terminal-arm-snapshot', { epoch: 'e-t212' });
  // Anchored to the arm that was just written, not to the wall clock. `Date.now() + 2` was a fixture that raced the
  // runner: on a slow Windows worker more than two seconds could pass between writing the row and taking the arm, which
  // put the completion *before* consent and failed the admission check -- the same shape of flake T211 had.
  const armed = JSON.parse(readFileSync(path.join(world.state, 'terminal-arm.json'), 'utf8'));
  bridgeDatabase(world.db, [[NEW_RUN, 'completed', 'task.completed', Math.floor((armed.armTakenAtMs || 0) / 1000) + 5]]);
  runSidecar(world, service, [{ requestID: NEW_RUN, status: 'completed', createdAt: OLD_START_MS }]);
  const pass = await visit(world, service);
  assert.deepEqual(pass.admitted.map((item) => item.runId), [NEW_RUN]);
  assert.equal(pass.admitted[0].postArmEvidence, 'relay_completed_at');
  assert.equal(pass.admitted[0].postArmSource, 'bridge.task_events.task.completed');
});

test('a sidecar re-post cannot push an old instant past the arm', async () => {
  const world = scene();
  bridgeDatabase(world.db, [[OLD_RUN, 'completed', 'task.completed', ANCIENT_SECONDS]]);
  const service = await startService(path.join(world.state, 'svc'));
  await visit(world, service);
  hostCall(world, service, 'terminal-arm-snapshot', { epoch: 'e-t212' });
  runSidecar(world, service, [{ requestID: OLD_RUN, status: 'completed', createdAt: OLD_START_MS }]);
  const token = readFileSync(service.tokenFile, 'utf8').trim();
  await fetch(service.base + '/host/terminal-candidates', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ candidates: [{ runId: OLD_RUN, terminalStatus: 'completed',
      statusSource: 'bridge.run_facts.status', hostSource: 'native_host.terminal-mirror', origin: 'bridge',
      startedAt: Math.floor(OLD_START_MS / 1000), completedAt: Date.now() + 3600000,
      completedAtSource: 'bridge.task_events.task.completed' }] }),
  }).then((response) => response.json());
  const pass = await visit(world, service);
  assert.deepEqual(pass.admitted, [], 'the earliest instant stands');
});
