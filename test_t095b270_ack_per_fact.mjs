// T270: the host ACK label belongs to a *fact* (runId + status), so a status change must not inherit it.
//
// T268 changed the Native Host to record ACKs per (runId, status): `acknowledge()` journals `ackedForms` and only
// the offered fact is consumed. T269 then made the service refresh `hostAck` -- but monotonically over the whole
// record, which is right inside one fact and wrong across a status change: a run that was announced `failed` and
// acknowledged as `failed` (label `acked`) then really completes, and the service stored the *new* fact with the
// *old* fact's confirmation. The record then says `completed` + `acked` while nobody has seen the completion --
// the one field that separates "the host was told" from "nobody looked", claiming the wrong thing.
//
// The rule this pins: the label travels with the status it was reported for. Inside one status the label still only
// moves forward (a stale round cannot erase a confirmed ACK). Across a status change the label is whatever the
// report said for that new status -- or `unseen` when the report carried no usable label, because an absent label is
// not evidence of an ACK. `pageDelivery` stays `unknown` throughout: a host ACK is never a delivered page.
//
// Out-of-order snapshots are NOT distinguishable here: the payload carries no per-post ordering token, so the
// service cannot know whether a `failed` report is older or newer than the `completed` one. What is asserted is
// weaker and honest -- the stored (status, label) pair is always one the host actually reported together, never a
// cross-product of two different posts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const SERVICE = path.join(process.cwd(), 'tools', 'service', 'relay_service.mjs');
const RUN = '5859fb48-8421-4590-870b-6ffceb651674';
const FAILED_MS = 1793968186202 - 60000;
const COMPLETED_MS = 1793968186202;

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
    base: ready.base,
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

function fact(over = {}) {
  return {
    runId: RUN,
    terminalStatus: 'completed',
    statusSource: 'bridge.run_facts.status',
    hostSource: 'native_host.terminal-mirror',
    hostAck: 'unseen',
    origin: 'bridge',
    startedAt: 1793965592,
    completedAt: COMPLETED_MS,
    completedAtSource: 'bridge.task_events.task.completed',
    ...over,
  };
}

function failedFact(over = {}) {
  return fact({ terminalStatus: 'failed', completedAt: FAILED_MS,
    completedAtSource: 'bridge.task_events.task.interrupted', ...over });
}

function withService(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't270-svc-'));
    await fn(dir);
    rmSync(dir, { recursive: true, force: true });
  };
}

async function stored(service, runId = RUN) {
  return (await service.get('/runs')).body.runs.find((run) => run.runId === runId);
}

async function post(service, item) {
  const result = await service.post('/host/terminal-candidates', { candidates: [item] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

test('T270: an acknowledged failure does not become an acknowledged completion', withService(async (dir) => {
  const service = await startService(dir);
  try {
    await post(service, failedFact({ hostAck: 'acked' }));
    assert.deepEqual(pick(await stored(service)), { terminalStatus: 'failed', hostAck: 'acked' });

    // The run really completed; the host has not been told about *this* fact yet.
    await post(service, fact({ hostAck: 'unseen' }));
    assert.deepEqual(pick(await stored(service)), { terminalStatus: 'completed', hostAck: 'unseen' },
      'the new fact must carry its own label, not the previous fact\'s confirmation');
  } finally {
    await service.stop();
  }
}));

test('T270: a pending failure does not become a pending completion either', withService(async (dir) => {
  const service = await startService(dir);
  try {
    await post(service, failedFact({ hostAck: 'pending' }));
    await post(service, fact({ hostAck: 'unseen' }));
    assert.deepEqual(pick(await stored(service)), { terminalStatus: 'completed', hostAck: 'unseen' });
  } finally {
    await service.stop();
  }
}));

test('T270: a report with no usable label does not inherit the old one', withService(async (dir) => {
  const service = await startService(dir);
  try {
    await post(service, failedFact({ hostAck: 'acked' }));
    const bare = fact();
    delete bare.hostAck;
    await post(service, bare);
    assert.deepEqual(pick(await stored(service)), { terminalStatus: 'completed', hostAck: 'unseen' },
      'an absent label is not evidence of an ACK');

    await post(service, failedFact({ hostAck: 'acked' }));
    await post(service, fact({ hostAck: 'nonsense' }));
    assert.deepEqual(pick(await stored(service)), { terminalStatus: 'completed', hostAck: 'unseen' },
      'a label outside the contract is not an upgrade either');
  } finally {
    await service.stop();
  }
}));

test('T270: inside one status the label still only moves forward', withService(async (dir) => {
  const service = await startService(dir);
  try {
    await post(service, fact({ hostAck: 'acked' }));
    await post(service, fact({ hostAck: 'unseen' }));
    assert.equal((await stored(service)).hostAck, 'acked', 'a stale round cannot erase a confirmed ACK');
    await post(service, fact({ hostAck: 'pending' }));
    assert.equal((await stored(service)).hostAck, 'acked');
  } finally {
    await service.stop();
  }
}));

test('T270: the stored pair is always one the host reported together', withService(async (dir) => {
  // Out-of-order snapshots cannot be told apart from fresh ones -- there is no ordering token in the payload. What
  // can be guaranteed is that the record never ends up with a status from one post and a label from another.
  const posted = [];
  const service = await startService(dir);
  try {
    for (const item of [fact({ hostAck: 'unseen' }), failedFact({ hostAck: 'acked' }), fact({ hostAck: 'acked' })]) {
      await post(service, item);
      posted.push({ terminalStatus: item.terminalStatus, hostAck: item.hostAck });
      const now = pick(await stored(service));
      assert.ok(posted.some((pair) => pair.terminalStatus === now.terminalStatus
        && (pair.hostAck === now.hostAck || now.hostAck === 'unseen')),
      'stored ' + JSON.stringify(now) + ' was never reported as a pair');
    }
  } finally {
    await service.stop();
  }
}));

test('T270: the corrected pair survives a restart, with no migration of the old store', withService(async (dir) => {
  let service = await startService(dir);
  try {
    await post(service, failedFact({ hostAck: 'acked' }));
    await post(service, fact({ hostAck: 'unseen' }));
  } finally {
    await service.stop();
  }
  service = await startService(dir);
  try {
    const run = await stored(service);
    assert.deepEqual(pick(run), { terminalStatus: 'completed', hostAck: 'unseen' },
      'a restart must not resurrect the failure label');
    assert.equal(run.completedAt, COMPLETED_MS, 'and the instant stays the completion\'s');
  } finally {
    await service.stop();
  }
}));

test('T270: none of this is a delivery claim', withService(async (dir) => {
  const service = await startService(dir);
  try {
    await post(service, failedFact({ hostAck: 'acked' }));
    await post(service, fact({ hostAck: 'acked' }));
    const run = await stored(service);
    assert.equal(run.pageDelivery, 'unknown');
    assert.equal(run.simulated, false);
    const listed = await service.get('/extension/terminal-candidates');
    assert.equal(listed.body.pageDelivery, 'unknown');
    assert.equal(listed.body.deliverable, false);
    assert.equal(listed.body.requiresAck, false);
    assert.equal(listed.body.confirmed, false);
    assert.equal(listed.body.candidates.find((c) => c.runId === RUN).pageDelivery, 'unknown');
  } finally {
    await service.stop();
  }
}));

function pick(run) {
  return { terminalStatus: run.terminalStatus, hostAck: run.hostAck };
}
