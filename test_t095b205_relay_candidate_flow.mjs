// T205: Relay's real terminal candidates go through the extension's own candidate store and consumption entry.
//
// The chain exercised here is the shipping one, minus Chrome: the real host produces terminal statuses from a
// fabricated ledger, the real service stores them, the real Relay-backed host answers `terminal-list` over the real
// wire format, the intake admits candidates through the extension's own `admit()` and writes them under
// `terminalCandidates`, and then `extension/lib/autosend_chrome_wiring.js` -- the module the background script uses --
// reads and consumes them. No page is written, no arm is granted, nothing is installed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createChromeAutoSend } from '../agent-relay/extension/lib/autosend_chrome_wiring.js';
import { CANDIDATES_KEY, intakeOnce, mergeIntoStore } from '../agent-relay/tools/service/relay_candidate_intake.mjs';

const PY = process.env.PYTHON || 'python';
const SERVICE = path.join(process.cwd(), 'tools', 'service', 'relay_service.mjs');
const MIRROR = path.join(process.cwd(), 'tools', 'service', 'host_mirror.mjs');
const RELAY_HOST = path.join(process.cwd(), 'tools', 'service', 'relay_terminal_host.py');
const HOST = path.join(process.cwd(), 'host.py');
const ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';

const RUNS = {
  completed: '11111111-2222-4333-8444-555566667777',
  failed: '22222222-2222-4333-8444-555566667777',
  interrupted: '33333333-2222-4333-8444-555566667777',
};

function scene(statuses) {
  const root = mkdtempSync(path.join(tmpdir(), 't205-ledger-'));
  const sub = path.join(root, 'c'.repeat(64));
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, 'endpoint.json.runs.json'),
    JSON.stringify(Object.entries(statuses).map(([key, status], index) => ({
      requestID: RUNS[key], status, createdAt: 1793600000000 + index * 1000 })), null, 2) + '\n');
  const state = mkdtempSync(path.join(tmpdir(), 't205-host-state-'));
  const native = mkdtempSync(path.join(tmpdir(), 't205-native-'));
  const manifest = path.join(state, 'host_manifest.t205.json');
  writeFileSync(manifest, JSON.stringify({ name: 'com.dsh.notify', type: 'stdio',
    allowed_origins: [ORIGIN] }, null, 2) + '\n');
  const originFixture = path.join(state, 'bridge-origin.fixture.json');
  writeFileSync(originFixture, JSON.stringify({ version: 1, bridge: '*' }) + '\n');
  return { root, state, native, manifest, originFixture,
    cleanup() { for (const dir of [root, state, native]) rmSync(dir, { recursive: true, force: true }); } };
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

const intake = (service, storePath) => runProcess([path.join(process.cwd(), 'tools', 'service',
  'relay_candidate_intake.mjs'), '--python', PY, '--host-script', RELAY_HOST,
  '--service-url', service.base, '--service-token-file', service.tokenFile, '--store', storePath,
  '--trigger-state', storePath.replace(/\.json$/, '') + '.trigger.json']);

/** A `chrome.storage.local` fake over a JSON file, plus the minimum the wiring touches when reading candidates. */
function fakeChrome(storePath) {
  const read = () => {
    try { return JSON.parse(readFileSync(storePath, 'utf8')); } catch { return {}; }
  };
  const write = (doc) => writeFileSync(storePath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return {
    storage: { local: {
      get: async (defaults) => {
        const doc = read();
        const out = {};
        for (const key of Object.keys(defaults)) out[key] = key in doc ? doc[key] : defaults[key];
        return out;
      },
      set: async (values) => { const doc = read(); write({ ...doc, ...values }); },
    } },
    tabs: { get: async () => { throw new Error('no tabs in this test'); } },
  };
}

function wiringFor(storePath) {
  const chromeApi = fakeChrome(storePath);
  return createChromeAutoSend(chromeApi, {
    probeSpecificTab: async () => null,
    getBindingState: async () => ({ binding: null }),
    writeMessage: async () => { throw new Error('no page writes in this test'); },
    now: () => Date.now(),
  });
}

test('T205: completed and failed reach the extension store and are consumed by the real wiring', async () => {
  const host = scene({ completed: 'completed', failed: 'failed' });
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't205-svc-'));
  const storePath = path.join(mkdtempSync(path.join(tmpdir(), 't205-store-')), 'storage.local.json');
  writeFileSync(storePath, JSON.stringify({ [CANDIDATES_KEY]: [] }) + '\n');
  const service = await startService(serviceDir);
  try {
    assert.equal((await mirrorOnce(host, service)).code, 0);
    const pass = await intake(service, storePath);
    assert.equal(pass.code, 0, pass.out + pass.err);
    assert.equal(pass.json.received, 2);
    assert.equal(pass.json.admitted, 2);
    assert.equal(pass.json.stored, 2);
    assert.equal(pass.json.pageDelivery, 'unknown');

    // The existing consumption entry, not a new one.
    const wiring = wiringFor(storePath);
    const candidates = await wiring.readCandidates();
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates.map((item) => item.runId).sort(), [RUNS.completed, RUNS.failed].sort());
    assert.deepEqual(candidates.map((item) => item.status).sort(), ['completed', 'failed']);

    await wiring.consumeCandidate((item) => item.runId === RUNS.completed);
    const left = await wiring.readCandidates();
    assert.equal(left.length, 1);
    assert.equal(left[0].runId, RUNS.failed);
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T205: a replay after a restart adds nothing and does not resurrect a consumed candidate', async () => {
  const host = scene({ completed: 'completed' });
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't205-svc-'));
  const storePath = path.join(mkdtempSync(path.join(tmpdir(), 't205-store-')), 'storage.local.json');
  writeFileSync(storePath, JSON.stringify({ [CANDIDATES_KEY]: [] }) + '\n');
  const first = await startService(serviceDir);
  try {
    await mirrorOnce(host, first);
    await intake(first, storePath);
  } finally {
    await first.stop();
  }
  const second = await startService(serviceDir);
  try {
    const again = await intake(second, storePath);
    assert.equal(again.code, 0, again.out + again.err);
    assert.equal(again.json.added, 0, 'the same run|status does not become a second candidate');
    const wiring = wiringFor(storePath);
    assert.equal((await wiring.readCandidates()).length, 1);
    await wiring.consumeCandidate((item) => item.runId === RUNS.completed);
    const third = await intake(second, storePath);
    assert.equal(third.json.added, 0, 'a consumed candidate is not re-queued by a later pass');
    assert.deepEqual(third.json.refused.map((item) => item.code), ['duplicate_event'],
      'the extension\'s own journal refuses it, one notice per task');
    assert.equal((await wiringFor(storePath).readCandidates()).length, 0);
  } finally {
    await second.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T205: an interrupted ledger run arrives as failed, and nothing claims delivery', async () => {
  const host = scene({ completed: 'completed', interrupted: 'interrupted' });
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't205-svc-'));
  const storePath = path.join(mkdtempSync(path.join(tmpdir(), 't205-store-')), 'storage.local.json');
  writeFileSync(storePath, JSON.stringify({ [CANDIDATES_KEY]: [] }) + '\n');
  const service = await startService(serviceDir);
  try {
    await mirrorOnce(host, service);
    const pass = await intake(service, storePath);
    assert.equal(pass.json.admitted, 2);
    const stored = (await wiringFor(storePath).readCandidates());
    const interrupted = stored.find((item) => item.runId === RUNS.interrupted);
    assert.equal(interrupted.status, 'failed', 'the host announces interrupted as failed');
    for (const item of stored) {
      assert.equal(item.pageDelivery, 'unknown');
      assert.equal(item.source, 'native_host.terminal-mirror');
    }
  } finally {
    await service.stop();
    host.cleanup();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T205: a candidate without a source never reaches the store', async () => {
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't205-svc-'));
  const storePath = path.join(mkdtempSync(path.join(tmpdir(), 't205-store-')), 'storage.local.json');
  writeFileSync(storePath, JSON.stringify({ [CANDIDATES_KEY]: [] }) + '\n');
  const service = await startService(serviceDir);
  try {
    const refused = await service.post('/host/terminal-candidates', { candidates: [
      { runId: RUNS.completed, terminalStatus: 'completed', hostSource: 'relay_unverified',
        statusSource: 'bridge_ledger.status' },
      { runId: RUNS.failed, terminalStatus: 'completed', hostSource: 'native_host.terminal-mirror' },
    ] });
    assert.equal(refused.body.accepted.length, 0);
    const pass = await intake(service, storePath);
    assert.equal(pass.json.received, 0);
    assert.equal(pass.json.stored, 0);
    assert.deepEqual(await wiringFor(storePath).readCandidates(), []);
  } finally {
    await service.stop();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T205: a relay that is down is reported as such, not as "nothing finished"', async () => {
  const storePath = path.join(mkdtempSync(path.join(tmpdir(), 't205-store-')), 'storage.local.json');
  writeFileSync(storePath, JSON.stringify({ [CANDIDATES_KEY]: [] }) + '\n');
  const dead = { base: 'http://127.0.0.1:1', tokenFile: storePath };
  const pass = await intake(dead, storePath);
  assert.equal(pass.code, 4, pass.out + pass.err);
  assert.equal(pass.json.ok, false);
  assert.equal(pass.json.code, 'relay_unavailable');
});

test('T205: the relay host refuses an ACK, because that list is not its to consume', async () => {
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't205-svc-'));
  const service = await startService(serviceDir);
  try {
    const child = spawn(PY, [RELAY_HOST, '--service-url', service.base,
      '--service-token-file', service.tokenFile], { stdio: ['pipe', 'pipe', 'pipe'] });
    const frame = (message) => {
      const body = Buffer.from(JSON.stringify(message), 'utf8');
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(body.length, 0);
      return Buffer.concat([prefix, body]);
    };
    const reply = await new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error('no reply')), 10000);
      child.stdout.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4) return;
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        clearTimeout(timer);
        resolve(JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')));
      });
      child.stdin.write(frame({ v: 1, id: 'ack-1', op: 'terminal-ack', args: { acked: [RUNS.completed + '|completed'] } }));
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'ack_not_supported');
    // Closing the wire is what makes this process exit; leaving it open would keep the test runner alive.
    child.stdin.end();
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(() => { child.kill(); resolve(); }, 2000);
    });
  } finally {
    await service.stop();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T205: the store merge is what makes replay safe, and it keeps one entry per run and status', () => {
  const candidate = { runId: RUNS.completed, status: 'completed', source: 'native_host.terminal-mirror' };
  const first = mergeIntoStore([], [candidate], 1);
  assert.equal(first.added, 1);
  const again = mergeIntoStore(first.list, [candidate], 2);
  assert.equal(again.added, 0);
  const changed = mergeIntoStore(first.list, [{ ...candidate, status: 'failed' }], 3);
  assert.equal(changed.added, 1);
  assert.equal(changed.list.length, 2, 'a different status is a different key, as the host defines one per run');
});
