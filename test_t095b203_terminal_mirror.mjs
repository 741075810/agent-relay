// T203: the real terminal-candidate mirror, end to end.
//
// These tests start the **real** Native Host subprocess (host.py over the Chrome wire protocol) against a fabricated
// bridge ledger, and the **real** AgentRelay service, then run the real sidecar between them. Only Chrome is absent.
// Every path is a fresh temp dir, so nothing here can read the operator's production state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const PY = process.env.PYTHON || 'python';
const SERVICE = path.join(process.cwd(), 'tools', 'service', 'relay_service.mjs');
const MIRROR = path.join(process.cwd(), 'tools', 'service', 'host_mirror.mjs');
const HOST = path.join(process.cwd(), 'host.py');
const ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';

const RUNS = {
  completed: '11111111-2222-4333-8444-555566667777',
  failed: '22222222-2222-4333-8444-555566667777',
  running: '33333333-2222-4333-8444-555566667777',
};

/** A ledger the real host reads, in the shape it writes: requestID / status / createdAt. */
function scene() {
  const root = mkdtempSync(path.join(tmpdir(), 't203-ledger-'));
  const sub = path.join(root, 'c'.repeat(64));
  mkdirSync(sub, { recursive: true });
  const ledger = path.join(sub, 'endpoint.json.runs.json');
  writeFileSync(ledger, JSON.stringify([
    { requestID: RUNS.completed, status: 'completed', createdAt: 1793600000000 },
    { requestID: RUNS.failed, status: 'failed', createdAt: 1793600001000 },
    { requestID: RUNS.running, status: 'running', createdAt: 1793600002000 },
  ], null, 2) + '\n');
  const state = mkdtempSync(path.join(tmpdir(), 't203-host-state-'));
  const native = mkdtempSync(path.join(tmpdir(), 't203-native-'));
  // The host refuses to serve without a manifest that allows the caller's origin, and a suite must not use the real
  // one, so it passes its own throwaway manifest explicitly.
  const manifest = path.join(state, 'host_manifest.t203.json');
  writeFileSync(manifest, JSON.stringify({ name: 'com.dsh.notify', type: 'stdio',
    allowed_origins: [ORIGIN] }, null, 2) + '\n');
  // Channel A exclusion needs the Bridge's own table; a fixture keeps this hermetic and marks every run channel A.
  const originFixture = path.join(state, 'bridge-origin.fixture.json');
  writeFileSync(originFixture, JSON.stringify({ version: 1, bridge: '*' }) + '\n');
  return { root, state, native, ledger, manifest, originFixture,
    cleanup() {
      for (const dir of [root, state, native]) rmSync(dir, { recursive: true, force: true });
    } };
}

async function startService(stateDir) {
  const child = spawn(process.execPath, [SERVICE, '--state-dir', stateDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no start: ' + stderr)), 15000);
    createInterface({ input: child.stdout }).once('line', (line) => { clearTimeout(timer); resolve(JSON.parse(line)); });
  });
  const auth = { 'content-type': 'application/json',
    authorization: 'Bearer ' + readFileSync(ready.tokenFile, 'utf8').trim() };
  return {
    base: ready.base, tokenFile: ready.tokenFile,
    get: (p) => fetch(ready.base + p, { headers: auth }).then(async (r) => ({ status: r.status, body: await r.json() })),
    post: (p, body) => fetch(ready.base + p, { method: 'POST', headers: auth, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() })),
    async stop() {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      });
    },
  };
}

function runMirror(host, service, extra = []) {
  const args = [MIRROR, '--python', PY, '--host-script', HOST, '--origin', ORIGIN,
    '--state-dir', host.state, '--ledger-root', host.root, '--native-root', host.native,
    '--manifest', host.manifest, '--bridge-db-fixture', host.originFixture,
    '--service-url', service.base, '--service-token-file', service.tokenFile, '--once', ...extra];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.once('exit', (code) => {
      let json = null;
      try { json = JSON.parse((out.trim().split('\n').pop()) || 'null'); } catch { json = null; }
      resolve({ code, json, out, err });
    });
  });
}

test('T203: real host terminal statuses reach the service, completed and failed kept apart', async () => {
  const host = scene();
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't203-svc-'));
  const service = await startService(serviceDir);
  try {
    const pushed = await runMirror(host, service);
    assert.equal(pushed.code, 0, pushed.out + pushed.err);
    assert.equal(pushed.json.ok, true);
    assert.equal(pushed.json.candidates, 2, 'the still-running run is not a terminal candidate');

    const runs = await service.get('/runs');
    const byId = new Map(runs.body.runs.map((run) => [run.runId, run]));
    assert.equal(byId.get(RUNS.completed).terminalStatus, 'completed');
    assert.equal(byId.get(RUNS.failed).terminalStatus, 'failed');
    assert.equal(byId.has(RUNS.running), false, 'a running task is never reported as finished');
    for (const run of runs.body.runs) {
      assert.equal(run.pageDelivery, 'unknown', 'an ack is not a delivered page');
      assert.equal(run.reportedBy, 'native_host');
      assert.equal(run.simulated, false);
      assert.ok(['bridge.run_facts.status', 'bridge_ledger.status'].includes(run.statusSource));
    }
    // The relay did not invent work: a notification is not a task.
    assert.equal((await service.get('/tasks')).body.tasks.length, 0);
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T203: the mirror op writes no host state, so it cannot disturb the send path', async () => {
  const host = scene();
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't203-svc-'));
  const service = await startService(serviceDir);
  try {
    const sourcePath = path.join(host.state, 'terminal-source.json');
    await runMirror(host, service);
    let exists = true;
    try { readFileSync(sourcePath); } catch { exists = false; }
    assert.equal(exists, false, 'terminal-mirror must not create terminal-source.json (that is terminal-list)');

    await runMirror(host, service);
    exists = true;
    try { readFileSync(sourcePath); } catch { exists = false; }
    assert.equal(exists, false, 'repeated mirroring still writes nothing');
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T203: a restart replays the same candidates without duplicating records', async () => {
  const host = scene();
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't203-svc-'));
  const first = await startService(serviceDir);
  try {
    await runMirror(host, first);
  } finally {
    await first.stop();
  }
  const second = await startService(serviceDir);
  try {
    const again = await runMirror(host, second);
    assert.equal(again.code, 0, again.out + again.err);
    assert.equal(again.json.candidates, 2, 'the replay offers the same two finished runs');
    const runs = await second.get('/runs');
    assert.equal(runs.body.runs.length, 2, 'and the service still holds two records, not four');
  } finally {
    await second.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T203: a status change is carried through on one record', async () => {
  const host = scene();
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't203-svc-'));
  const service = await startService(serviceDir);
  try {
    await runMirror(host, service);
    writeFileSync(host.ledger, JSON.stringify([
      { requestID: RUNS.completed, status: 'failed', createdAt: 1793600003000 },
      { requestID: RUNS.failed, status: 'failed', createdAt: 1793600001000 },
    ]) + '\n');
    const second = await runMirror(host, service);
    assert.equal(second.code, 0, second.out + second.err);
    const runs = await service.get('/runs');
    assert.equal(runs.body.runs.length, 2);
    assert.equal(runs.body.runs.find((r) => r.runId === RUNS.completed).terminalStatus, 'failed');
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T203: a candidate without a status or without a named source is refused', async () => {
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't203-svc-'));
  const service = await startService(serviceDir);
  try {
    const result = await service.post('/host/terminal-candidates', { candidates: [
      { runId: RUNS.completed, hostSource: 'native_host.terminal-mirror', statusSource: 'bridge_ledger.status' },
      { runId: RUNS.failed, terminalStatus: 'failed', hostSource: 'native_host.terminal-mirror' },
      { runId: RUNS.running, terminalStatus: 'completed', hostSource: 'made_up_source',
        statusSource: 'bridge_ledger.status' },
      { runId: RUNS.completed, terminalStatus: 'completed', hostSource: 'native_host.terminal-mirror',
        statusSource: 'bridge_ledger.status' },
    ] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.rejected.map((r) => r.error),
      ['terminal_status_missing', 'status_source_missing', 'host_source_unknown']);
    assert.equal(result.body.accepted.length, 1);
    assert.equal(result.body.pageDelivery, 'unknown');
    assert.match(result.body.note, /not a delivered page/);
  } finally {
    await service.stop();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T203: an unreadable ledger is reported by the host and nothing is invented', async () => {
  const host = scene();
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't203-svc-'));
  const service = await startService(serviceDir);
  try {
    writeFileSync(host.ledger, '{ not json at all', 'utf8');
    const pushed = await runMirror(host, service);
    assert.equal(pushed.code, 4, pushed.out + pushed.err);
    assert.equal(pushed.json.ok, false);
    assert.equal(pushed.json.code, 'source_unavailable');
    assert.equal((await service.get('/runs')).body.runs.length, 0);
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T203: the ACK flag from the host is surfaced but never turned into delivery', async () => {
  const host = scene();
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't203-svc-'));
  const service = await startService(serviceDir);
  try {
    // The host's own bookkeeping: this run was offered and acknowledged by Chrome's storage layer.
    writeFileSync(path.join(host.state, 'terminal-source.json'), JSON.stringify({
      version: 1, pendingIds: [], ackedIds: [RUNS.completed], baselineIds: [], baselineCount: 0,
      baselineDropped: 0 }) + '\n');
    const pushed = await runMirror(host, service);
    assert.equal(pushed.code, 0, pushed.out + pushed.err);
    const runs = await service.get('/runs');
    const acked = runs.body.runs.find((r) => r.runId === RUNS.completed);
    assert.equal(acked.hostAck, 'acked');
    assert.equal(acked.pageDelivery, 'unknown', 'host ack is not page delivery and not ChatGPT consumption');
    const other = runs.body.runs.find((r) => r.runId === RUNS.failed);
    assert.equal(other.hostAck, 'unseen');
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});
