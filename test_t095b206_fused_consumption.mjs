// T206: the extension's own consumption path, fed by the real host with the relay fused in.
//
// Nothing here mocks the host, the service or the extension modules: the host is the shipping `host.py` subprocess
// (given a temp state dir, a throwaway manifest and an empty native root), the service is the real Node process, and
// the consumer is `extension/lib/autosend_chrome_wiring.js` reading a `chrome.storage.local` fake.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const RELAY_RUN = 'cccccccc-1111-4222-8333-444455556666';
const NATIVE_RUN = 'dddddddd-1111-4222-8333-444455556666';

const children = [];
after(() => { for (const child of children) { try { child.kill(); } catch { /* gone */ } } });

function scene() {
  const root = mkdtempSync(path.join(tmpdir(), 't206e-root-'));
  const state = mkdtempSync(path.join(tmpdir(), 't206e-state-'));
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't206e-svc-'));
  const ledgerRoot = path.join(root, 'e'.repeat(64));
  mkdirSync(ledgerRoot, { recursive: true });
  const ledger = path.join(ledgerRoot, 'endpoint.json.runs.json');
  writeFileSync(ledger, '[]');
  const manifest = path.join(state, 'host_manifest.t206e.json');
  writeFileSync(manifest, JSON.stringify({ name: 'com.dsh.notify', type: 'stdio', allowed_origins: [ORIGIN] }));
  const fixture = path.join(state, 'bridge-origin.fixture.json');
  writeFileSync(fixture, JSON.stringify({ version: 1, bridge: '*' }));
  const nativeRoot = path.join(state, 'native');
  mkdirSync(nativeRoot, { recursive: true });
  return { root, state, serviceDir, ledger, ledgerRoot, manifest, fixture, nativeRoot };
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

async function relayThink(world, service) {
  const token = readFileSync(service.tokenFile, 'utf8').trim();
  const response = await fetch(service.base + '/host/terminal-candidates', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ candidates: [{ runId: RELAY_RUN, terminalStatus: 'completed', startedAt: 1700000000000, completedAt: Date.now() + 60000,
      hostSource: 'native_host.terminal-mirror', statusSource: 'bridge_ledger.status', origin: 'bridge' }] }),
  });
  return response.json();
}

// The host answers with a baseline first: a run that existed before the baseline is deliberately never offered.
async function baseline(world, service) {
  return intakeOnce({ host: { python: PYTHON, script: HOST, args: hostArgs(world, service) }, now: Date.now() });
}

function fakeChrome(store) {
  const data = { ...store };
  // The wiring calls `storage.local.get(key)` in both styles: with a callback in the older path and awaiting the
  // returned promise in `readCandidates`. A fake that supports only one of them fails where Chrome would not.
  return {
    storage: { local: {
      get(keys, done) {
        // Chrome also accepts a defaults object: `get({ key: fallback })`. The wiring uses that form, so the fake does.
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
      remove(key, done) { delete data[key]; if (typeof done === 'function') done(); },
    } },
    __data: data,
  };
}

test('a relay candidate reaches the extension store through the real host, and an ACK does not double-store it',
  async () => {
    const world = scene();
    const service = await startService(world.serviceDir);
    const first = await baseline(world, service);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.admitted.length, 0, 'the baseline offers nothing');

    await relayThink(world, service);
    const pass = await intakeOnce({ host: { python: PYTHON, script: HOST, args: hostArgs(world, service) },
      now: Date.now() });
    assert.equal(pass.ok, true, JSON.stringify(pass));
    assert.deepEqual(pass.admitted.map((item) => item.runId), [RELAY_RUN]);
    assert.equal(pass.admitted[0].source, 'relay');
    assert.equal(pass.admitted[0].origin, 'bridge');
    assert.equal(pass.pageDelivery, 'unknown', 'nothing here may claim delivery');

    const store = mergeIntoStore([], pass.admitted, Date.now());
    assert.equal(store.list.length, 1);
    const chrome = fakeChrome({ terminalCandidates: store.list });
    const wiring = createChromeAutoSend(chrome, {});
    const stored = await wiring.readCandidates();
    assert.deepEqual(stored.map((item) => item.runId), [RELAY_RUN]);
    assert.equal(stored[0].pageDelivery, 'unknown', 'nothing here may claim delivery');
    // `consumeCandidate` drains and returns what is left; an empty list means the entry was taken up by the existing
    // consumption path rather than sitting unread.
    const kept = await wiring.consumeCandidate((item) => item.runId === RELAY_RUN);
    assert.deepEqual(kept, []);
    assert.deepEqual(await wiring.readCandidates(), []);
  });

test('the ACK that follows keeps the native queue and the relay journal apart', async () => {
  const world = scene();
  const service = await startService(world.serviceDir);
  await baseline(world, service);
  writeFileSync(world.ledger, JSON.stringify([{ requestID: NATIVE_RUN, status: 'completed',
    createdAt: 1793600000000 }]));
  await relayThink(world, service);
  const pass = await intakeOnce({ host: { python: PYTHON, script: HOST, args: hostArgs(world, service) },
    now: Date.now() });
  assert.deepEqual(pass.admitted.map((item) => item.runId).sort(), [RELAY_RUN, NATIVE_RUN].sort());

  const ack = spawnSync(PYTHON, [HOST, ...hostArgs(world, service)], {
    input: frame({ v: 1, id: 'ack-1', op: 'terminal-ack', args: { acked: [RELAY_RUN + '|completed'] } }),
  });
  assert.equal(ack.status, 0, ack.stderr.toString());
  const answer = unframe(ack.stdout);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const state = JSON.parse(readFileSync(path.join(world.state, 'terminal-source.json'), 'utf8'));
  assert.deepEqual(state.ackedIds, [], 'a relay ACK must not consume a native candidate');
  assert.ok((state.relayAckedIds || []).includes(RELAY_RUN), 'it is journalled as a relay id');

  const again = await intakeOnce({ host: { python: PYTHON, script: HOST, args: hostArgs(world, service) },
    now: Date.now(), triggerState: { ...pass.triggerState } });
  assert.ok(!again.admitted.some((item) => item.runId === RELAY_RUN), 'the journalled relay candidate is not re-offered');
});

test('without the relay flags the real host behaves exactly as before', async () => {
  const world = scene();
  const service = await startService(world.serviceDir);
  const plain = [ORIGIN, '--state-dir', world.state, '--ledger-root', world.root, '--manifest', world.manifest,
    '--bridge-db-fixture', world.fixture, '--native-root', world.nativeRoot];
  const before = await intakeOnce({ host: { python: PYTHON, script: HOST, args: plain }, now: Date.now() });
  assert.equal(before.ok, true, JSON.stringify(before));
  await relayThink(world, service);
  const after = await intakeOnce({ host: { python: PYTHON, script: HOST, args: plain }, now: Date.now() });
  assert.deepEqual(after.admitted, [], 'no relay candidate appears when the relay is not configured');
  assert.equal(existsSync(path.join(world.state, 'relayAckedIds')), false);
});

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

function unframe(buffer) {
  const length = buffer.readUInt32LE(0);
  return JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
}

createRequire(import.meta.url);
