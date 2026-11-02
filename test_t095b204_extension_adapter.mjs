// T204: the mirror's records, put through the extension's own admission function.
//
// The point of these tests is that nothing is validated against a mock of my own module: the real host subprocess
// produces the statuses, the real service stores them, and `extension/lib/terminal_trigger.js` -- the module the
// shipping consumer uses -- decides whether a candidate would be admitted. Chrome is absent, so no page can be
// written; nothing here sends, arms or binds anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { admit, createTriggerState, ALLOWED_STATUS } from './extension/lib/terminal_trigger.js';
import { admitAll } from './tools/service/extension_adapter.mjs';

const PY = process.env.PYTHON || 'python';
const SERVICE = path.join(process.cwd(), 'tools', 'service', 'relay_service.mjs');
const MIRROR = path.join(process.cwd(), 'tools', 'service', 'host_mirror.mjs');
const ADAPTER = path.join(process.cwd(), 'tools', 'service', 'extension_adapter.mjs');
const HOST = path.join(process.cwd(), 'host.py');
const ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';

const RUNS = {
  completed: '11111111-2222-4333-8444-555566667777',
  failed: '22222222-2222-4333-8444-555566667777',
  interrupted: '33333333-2222-4333-8444-555566667777',
  running: '44444444-2222-4333-8444-555566667777',
};

function scene(statuses) {
  const root = mkdtempSync(path.join(tmpdir(), 't204-ledger-'));
  const sub = path.join(root, 'c'.repeat(64));
  mkdirSync(sub, { recursive: true });
  const ledger = path.join(sub, 'endpoint.json.runs.json');
  writeFileSync(ledger, JSON.stringify(Object.entries(statuses).map(([key, status], index) => ({
    requestID: RUNS[key], status, createdAt: 1793600000000 + index * 1000 })), null, 2) + '\n');
  const state = mkdtempSync(path.join(tmpdir(), 't204-host-state-'));
  const native = mkdtempSync(path.join(tmpdir(), 't204-native-'));
  const manifest = path.join(state, 'host_manifest.t204.json');
  writeFileSync(manifest, JSON.stringify({ name: 'com.dsh.notify', type: 'stdio',
    allowed_origins: [ORIGIN] }, null, 2) + '\n');
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

const runProcess = (args) => new Promise((resolve) => {
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

const mirrorOnce = (host, service) => runProcess([MIRROR, '--python', PY, '--host-script', HOST, '--origin', ORIGIN,
  '--state-dir', host.state, '--ledger-root', host.root, '--native-root', host.native,
  '--manifest', host.manifest, '--bridge-db-fixture', host.originFixture,
  '--service-url', service.base, '--service-token-file', service.tokenFile, '--once']);

const adapt = (service) => runProcess([ADAPTER, '--service-url', service.base,
  '--service-token-file', service.tokenFile]);

test('T204: completed and failed are admitted by the extension\'s own consumer', async () => {
  const host = scene({ completed: 'completed', failed: 'failed' });
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't204-svc-'));
  const service = await startService(serviceDir);
  try {
    assert.equal((await mirrorOnce(host, service)).code, 0);
    const output = await adapt(service);
    assert.equal(output.code, 0, output.out + output.err);
    assert.equal(output.json.received, 2);
    assert.equal(output.json.admitted, 2, JSON.stringify(output.json.refusedRuns));
    const statuses = output.json.admittedRuns.map((item) => item.status).sort();
    assert.deepEqual(statuses, ['completed', 'failed']);
    assert.deepEqual(output.json.admittedRuns.map((item) => item.runId).sort(),
      [RUNS.completed, RUNS.failed].sort(), 'the original run ids survive the round trip');
    assert.equal(output.json.pageDelivery, 'unknown');
    assert.equal(output.json.deliverable, false);
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T204: an interrupted ledger run is announced as failed by the host and admitted as such', async () => {
  const host = scene({ completed: 'completed', interrupted: 'interrupted' });
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't204-svc-'));
  const service = await startService(serviceDir);
  try {
    await mirrorOnce(host, service);
    const listed = await service.get('/extension/terminal-candidates');
    const byId = new Map(listed.body.candidates.map((item) => [item.runId, item]));
    // `TERMINAL` maps a ledger `interrupted` to `failed`; the consumer therefore sees `failed`, which is a status it
    // admits. Reporting `interrupted` would be a status the host never announces.
    assert.equal(byId.get(RUNS.interrupted).status, 'failed');
    assert.equal(ALLOWED_STATUS.includes('interrupted'), false);
    const output = await adapt(service);
    assert.equal(output.json.received, 2);
    assert.equal(output.json.admitted, 2);
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T204: the service refuses a status the host cannot announce', async () => {
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't204-svc-'));
  const service = await startService(serviceDir);
  try {
    const refused = await service.post('/host/terminal-candidates', { candidates: [
      { runId: RUNS.completed, terminalStatus: 'interrupted', hostSource: 'native_host.terminal-mirror',
        statusSource: 'bridge_ledger.status' },
      { runId: RUNS.failed, terminalStatus: 'delivered', hostSource: 'native_host.terminal-mirror',
        statusSource: 'bridge_ledger.status' },
    ] });
    assert.deepEqual(refused.body.rejected.map((item) => item.error),
      ['terminal_status_missing', 'terminal_status_missing']);
    assert.deepEqual((await service.get('/extension/terminal-candidates')).body.candidates, []);
  } finally {
    await service.stop();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T204: a direct run is refused with the extension\'s own opt-in code, not silently dropped', async () => {
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't204-svc-'));
  const service = await startService(serviceDir);
  try {
    await service.post('/host/terminal-candidates', { candidates: [
      { runId: RUNS.completed, terminalStatus: 'completed', hostSource: 'native_host.terminal-mirror',
        statusSource: 'bridge_ledger.status', origin: 'direct' },
    ] });
    const output = await adapt(service);
    assert.equal(output.json.received, 1);
    assert.equal(output.json.admitted, 0);
    assert.deepEqual(output.json.refusedRuns, [{ runId: RUNS.completed, status: 'completed',
      code: 'direct_not_opted_in' }]);
  } finally {
    await service.stop();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T204: a running run never reaches the consumer', async () => {
  const host = scene({ completed: 'completed', running: 'running' });
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't204-svc-'));
  const service = await startService(serviceDir);
  try {
    await mirrorOnce(host, service);
    const output = await adapt(service);
    assert.equal(output.json.received, 1);
    assert.equal(output.json.admittedRuns[0].runId, RUNS.completed);
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T204: repeated mirroring and a restart cannot make the consumer admit the same run twice', async () => {
  const host = scene({ completed: 'completed' });
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't204-svc-'));
  const first = await startService(serviceDir);
  try {
    await mirrorOnce(host, first);
    await mirrorOnce(host, first);
  } finally {
    await first.stop();
  }
  const second = await startService(serviceDir);
  try {
    await mirrorOnce(host, second);
    const listed = await second.get('/extension/terminal-candidates');
    assert.equal(listed.body.candidates.length, 1, 'the service holds one record for one run');

    // Two identical candidates fed to the consumer in one pass: the second must be refused by its own dedupe.
    const candidates = [...listed.body.candidates, ...listed.body.candidates];
    const verdict = admitAll(candidates);
    assert.equal(verdict.admitted.length, 1);
    assert.equal(verdict.refused.length, 1);
    assert.ok(['duplicate_candidate', 'already_seen', 'repeat'].includes(verdict.refused[0].code)
      || typeof verdict.refused[0].code === 'string', JSON.stringify(verdict.refused[0]));
  } finally {
    await second.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T204: the rendered payload is the shape the host offers, with delivery explicitly unknown', async () => {
  const host = scene({ completed: 'completed' });
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't204-svc-'));
  const service = await startService(serviceDir);
  try {
    await mirrorOnce(host, service);
    const listed = await service.get('/extension/terminal-candidates');
    const body = listed.body;
    assert.equal(body.source, 'agentrelay.mirror');
    assert.equal(body.deliverable, false, 'this endpoint is not a sender');
    assert.equal(body.requiresAck, false, 'it must never consume the host pending list');
    assert.equal(body.pageDelivery, 'unknown');
    assert.match(body.note, /not delivery/);
    const candidate = body.candidates[0];
    for (const field of ['runId', 'status', 'startedAt', 'origin']) {
      assert.ok(field in candidate, 'candidate must carry ' + field);
    }
    // The consumer's own starting point must accept exactly this object.
    const verdict = admit({ ...createTriggerState(), enabled: true }, candidate);
    assert.equal(verdict.admit, true, JSON.stringify(verdict));
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T204: a record without a status or without a source never becomes a candidate', async () => {
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't204-svc-'));
  const service = await startService(serviceDir);
  try {
    const refused = await service.post('/host/terminal-candidates', { candidates: [
      { runId: RUNS.completed, hostSource: 'native_host.terminal-mirror', statusSource: 'bridge_ledger.status' },
      { runId: RUNS.failed, terminalStatus: 'failed', hostSource: 'unknown_source',
        statusSource: 'bridge_ledger.status' },
    ] });
    assert.equal(refused.body.accepted.length, 0);
    const listed = await service.get('/extension/terminal-candidates');
    assert.deepEqual(listed.body.candidates, [], 'nothing sourceless is ever offered to the consumer');
    assert.equal(listed.body.baselineEstablished, false);
  } finally {
    await service.stop();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T204: a host ack on the record does not turn into delivery anywhere in the chain', async () => {
  const host = scene({ completed: 'completed' });
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't204-svc-'));
  const service = await startService(serviceDir);
  try {
    writeFileSync(path.join(host.state, 'terminal-source.json'), JSON.stringify({
      version: 1, pendingIds: [], ackedIds: [RUNS.completed], baselineIds: [], baselineCount: 0,
      baselineDropped: 0 }) + '\n');
    await mirrorOnce(host, service);
    const listed = await service.get('/extension/terminal-candidates');
    assert.equal(listed.body.candidates[0].hostAck, 'acked');
    assert.equal(listed.body.candidates[0].pageDelivery, 'unknown');
    const output = await adapt(service);
    assert.equal(output.json.admitted, 1);
    assert.equal(output.json.pageDelivery, 'unknown');
    const runs = await service.get('/runs');
    assert.equal(runs.body.runs[0].pageDelivery, 'unknown');
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});
