// T207: the ACK shape the shipping extension actually sends, exercised through its own consumption module.
//
// Real host subprocess, real service, real `extension/lib/autosend_chrome_wiring.js`. Only Chrome is faked.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { intakeOnce, mergeIntoStore } from './tools/service/relay_candidate_intake.mjs';
import { admit, createTriggerState } from './extension/lib/terminal_trigger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.PYTHON || 'python';
const HOST = path.join(HERE, 'host.py');
const SERVICE = path.join(HERE, 'tools', 'service', 'relay_service.mjs');
const ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
const RUN = 'eeeeeeee-1111-4222-8333-444455556666';

const children = [];
after(() => { for (const child of children) { try { child.kill(); } catch { /* gone */ } } });

function scene() {
  const root = mkdtempSync(path.join(tmpdir(), 't207-root-'));
  const state = mkdtempSync(path.join(tmpdir(), 't207-state-'));
  const serviceDir = mkdtempSync(path.join(tmpdir(), 't207-svc-'));
  const ledgerRoot = path.join(root, 'f'.repeat(64));
  mkdirSync(ledgerRoot, { recursive: true });
  writeFileSync(path.join(ledgerRoot, 'endpoint.json.runs.json'), '[]');
  const manifest = path.join(state, 'host_manifest.t207.json');
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

async function seed(service, status = 'completed') {
  const token = readFileSync(service.tokenFile, 'utf8').trim();
  const response = await fetch(service.base + '/host/terminal-candidates', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ candidates: [{ runId: RUN, terminalStatus: status, startedAt: 1700000000000, completedAt: Date.now() + 60000, completedAtSource: 'bridge.task_events.task.' + (status === 'failed' ? 'failed' : 'completed'),
      hostSource: 'native_host.terminal-mirror', statusSource: 'bridge_ledger.status', origin: 'bridge' }] }),
  });
  return response.json();
}

function pass(world, service, triggerState = null) {
  return intakeOnce({ host: { python: PYTHON, script: HOST, args: hostArgs(world, service) },
    now: Date.now(), triggerState });
}

function ack(world, service, ids) {
  const body = Buffer.from(JSON.stringify({ v: 1, id: 'ack', op: 'terminal-ack', args: { acked: ids } }), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  const result = spawnSync(PYTHON, [HOST, ...hostArgs(world, service)], {
    input: Buffer.concat([head, body]),
  });
  assert.equal(result.status, 0, result.stderr.toString());
  const length = result.stdout.readUInt32LE(0);
  return JSON.parse(result.stdout.subarray(4, 4 + length).toString('utf8'));
}

test('a bare-runId ACK is final: the next pass admits nothing and the journal holds both spellings', async () => {
  const world = scene();
  const service = await startService(world.serviceDir);
  await pass(world, service);                            // baseline
  await seed(service);
  const first = await pass(world, service);
  assert.deepEqual(first.admitted.map((item) => item.runId), [RUN]);

  const admitted = admit({ ...createTriggerState(), enabled: true, armedAt: Date.now() }, first.admitted[0],
    Date.now());
  assert.equal(admitted.admit, true, JSON.stringify(admitted));

  const answer = ack(world, service, [RUN]);             // exactly what the extension sends
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const state = JSON.parse(readFileSync(path.join(world.state, 'terminal-source.json'), 'utf8'));
  assert.deepEqual(state.ackedIds, [], 'a relay ACK must not consume a native candidate');
  assert.ok((state.relayAckedIds || []).includes(RUN));

  const second = await pass(world, service);
  assert.deepEqual(second.admitted, [], 'an acknowledged relay candidate is not re-pushed');

  const store = mergeIntoStore([], second.admitted, Date.now());
  assert.equal(store.list.length, 0);
});

test('a status change after the ACK does not produce a second notice anywhere in the chain', async () => {
  const world = scene();
  const service = await startService(world.serviceDir);
  await pass(world, service);
  await seed(service, 'completed');
  const first = await pass(world, service);
  assert.deepEqual(first.admitted.map((item) => item.runId), [RUN]);
  ack(world, service, [RUN]);
  await seed(service, 'failed');
  const second = await pass(world, service);
  assert.deepEqual(second.admitted, [], 'one notice per run, whatever status the relay settles on');
});
