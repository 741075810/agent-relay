// T270 end to end: real Host mirror -> real sidecar -> real service, with a per-fact sampler journal.
//
// The unit cases pin `terminal_source.ack_label`; this one pins the chain the sidecar actually runs, because the
// defect was invisible from either end alone: the Host said `acked` (bare id), the service had just been taught to
// keep `acked` (T269), and the corrected completion arrived pre-confirmed. Only Chrome is absent here -- `host.py`
// is spawned as the real subprocess and `host_mirror.mjs` is the real sidecar.

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

const RUN = '11111111-2222-4333-8444-555566667777';
const OTHER = '22222222-2222-4333-8444-555566667777';
const COMPLETED_MS = 1793968186202;

function scene() {
  const root = mkdtempSync(path.join(tmpdir(), 't270-ledger-'));
  const sub = path.join(root, 'c'.repeat(64));
  mkdirSync(sub, { recursive: true });
  const ledger = path.join(sub, 'endpoint.json.runs.json');
  writeFileSync(ledger, JSON.stringify([
    { requestID: RUN, status: 'completed', createdAt: 1793965592000 },
    { requestID: OTHER, status: 'failed', createdAt: 1793958534000 },
  ], null, 2) + '\n');
  const state = mkdtempSync(path.join(tmpdir(), 't270-host-state-'));
  const native = mkdtempSync(path.join(tmpdir(), 't270-native-'));
  const manifest = path.join(state, 'host_manifest.t270.json');
  writeFileSync(manifest, JSON.stringify({ name: 'com.dsh.notify', type: 'stdio',
    allowed_origins: [ORIGIN] }, null, 2) + '\n');
  const bridgeDb = path.join(state, 'absent-bridge.sqlite');
  const originFixture = path.join(state, 'bridge-origin.fixture.json');
  writeFileSync(originFixture, JSON.stringify({ version: 1, bridge: '*' }) + '\n');
  return { root, state, native, ledger, manifest, originFixture, bridgeDb, sub,
    sampler(doc) {
      writeFileSync(path.join(state, 'terminal-source.json'), JSON.stringify(Object.assign({
        version: 1, baselineIds: [], baselineCount: 0, baselineDropped: 0,
        pendingIds: [], pendingForms: [], ackedIds: [], ackedForms: [],
        relayActivatedAt: null, relayActivation: null, relayBaselineIds: [],
        relayOfferedIds: [], relayAckedIds: [], relayDeferredIds: [],
      }, doc), null, 2) + '\n');
    },
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
    async stop() {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      });
    },
  };
}

function runMirror(host, service) {
  const args = [MIRROR, '--python', PY, '--host-script', HOST, '--origin', ORIGIN,
    '--state-dir', host.state, '--ledger-root', host.root, '--native-root', host.native,
    '--manifest', host.manifest, '--bridge-db', host.bridgeDb, '--bridge-db-fixture', host.originFixture,
    '--service-url', service.base, '--service-token-file', service.tokenFile, '--once'];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.once('exit', (code) => {
      let json = null;
      try { json = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); } catch { json = null; }
      resolve({ code, out, err, json });
    });
  });
}

async function stored(service, runId) {
  return (await service.get('/runs')).body.runs.find((run) => run.runId === runId);
}

test('T270 e2e: a failed ACK does not reach the service as an acked completion', async () => {
  const host = scene();
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't270-svc-'));
  const service = await startService(serviceDir);
  try {
    // The run was announced `failed` and acknowledged as such; the ledger now says it completed.
    host.sampler({ ackedIds: [RUN, OTHER], ackedForms: [RUN + '|failed', OTHER + '|failed'] });
    const pushed = await runMirror(host, service);
    assert.equal(pushed.code, 0, pushed.out + pushed.err);

    const run = await stored(service, RUN);
    assert.equal(run.terminalStatus, 'completed');
    assert.equal(run.hostAck, 'unseen',
      'the service stored the completion as already consumed by the host: ' + JSON.stringify(run));
    assert.equal(run.pageDelivery, 'unknown');

    // A run that really was acknowledged keeps its own fact's label.
    const other = await stored(service, OTHER);
    assert.deepEqual({ terminalStatus: other.terminalStatus, hostAck: other.hostAck },
      { terminalStatus: 'failed', hostAck: 'acked' });
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T270 e2e: once the completion is acked the label follows it', async () => {
  const host = scene();
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't270-svc-'));
  const service = await startService(serviceDir);
  try {
    host.sampler({ ackedIds: [RUN], ackedForms: [RUN + '|failed', RUN + '|completed'] });
    const pushed = await runMirror(host, service);
    assert.equal(pushed.code, 0, pushed.out + pushed.err);
    const run = await stored(service, RUN);
    assert.deepEqual({ terminalStatus: run.terminalStatus, hostAck: run.hostAck },
      { terminalStatus: 'completed', hostAck: 'acked' });
    assert.equal(run.pageDelivery, 'unknown', 'an ACK is still not a delivered page');

    const listed = await service.get('/extension/terminal-candidates');
    assert.equal(listed.body.pageDelivery, 'unknown');
    assert.equal(listed.body.deliverable, false);
    assert.equal(listed.body.confirmed, false);
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T270 e2e: a pre-journal state file keeps the label it really had', async () => {
  const host = scene();
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't270-svc-'));
  const service = await startService(serviceDir);
  try {
    // Version-1 file from before the per-fact journal: one bare id, no forms.
    host.sampler({ ackedIds: [RUN] });
    const pushed = await runMirror(host, service);
    assert.equal(pushed.code, 0, pushed.out + pushed.err);
    const run = await stored(service, RUN);
    assert.equal(run.hostAck, 'acked', 'an upgraded host must not lose a genuine ACK');
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});
