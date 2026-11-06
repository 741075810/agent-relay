// T269: the stored `hostAck` label must track the host's own bookkeeping, not freeze at first ingest.
//
// Found on the live production store: `relay.json` still says `hostAck: "unseen"` for run
// 5859fb48-8421-4590-870b-6ffceb651674 while the Native Host's own `terminal-source.json` lists that run in
// `ackedIds` -- i.e. the host was told, the page-side ACK happened, and the service's record never noticed.
//
// The sidecar re-posts every terminal candidate on every round (the host's `terminal-mirror` reader is a
// snapshot, not a queue), and the intake branch for an existing record only refreshed the status and the
// completion instant. `hostAck` is therefore a first-sight label that is never corrected -- which makes the one
// field that distinguishes "the host was told" from "nobody looked" wrong for every run acknowledged after the
// first post. Nothing here is a delivery claim: `pageDelivery` stays `unknown`, as it must.
//
// The service is the real one, on a temp state dir. Chrome, the Native Host and the Bridge are absent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const SERVICE = path.join(process.cwd(), 'tools', 'service', 'relay_service.mjs');
const RUN = '5859fb48-8421-4590-870b-6ffceb651674';
const OTHER = '5eebbb69-bc3d-4657-85a0-365eef08907a';
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

/** One mirror round, as `host_mirror.mjs` posts it. */
function candidate(over = {}) {
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

function withService(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't269-svc-'));
    const service = await startService(dir);
    try {
      await fn(service);
    } finally {
      await service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function stored(service, runId) {
  const runs = (await service.get('/runs')).body.runs;
  return runs.find((run) => run.runId === runId);
}

test('T269: a later round that reports the host ACK updates the stored label', withService(async (service) => {
  const first = await service.post('/host/terminal-candidates', { candidates: [candidate()] });
  assert.equal(first.status, 200);
  assert.equal((await stored(service, RUN)).hostAck, 'unseen');

  // The host ACKs the candidate on the next Chrome round; the sidecar's next post says so.
  const second = await service.post('/host/terminal-candidates', { candidates: [candidate({ hostAck: 'acked' })] });
  assert.equal(second.status, 200);
  assert.equal(second.body.accepted[0].duplicate, true, 'the record itself is a duplicate, the label is not');
  assert.equal((await stored(service, RUN)).hostAck, 'acked',
    'the stored label must follow the host, or the one field that separates "host was told" from "nothing looked" lies');
}));

test('T269: the label never moves backwards', withService(async (service) => {
  await service.post('/host/terminal-candidates', { candidates: [candidate({ hostAck: 'acked' })] });
  await service.post('/host/terminal-candidates', { candidates: [candidate({ hostAck: 'unseen' })] });
  assert.equal((await stored(service, RUN)).hostAck, 'acked',
    'a stale round must not be able to erase a confirmed host ACK');
  await service.post('/host/terminal-candidates', { candidates: [candidate({ hostAck: 'pending' })] });
  assert.equal((await stored(service, RUN)).hostAck, 'acked', 'pending is below acked');
}));

test('T269: an unknown label neither wins nor is invented', withService(async (service) => {
  await service.post('/host/terminal-candidates', { candidates: [candidate({ hostAck: 'pending' })] });
  await service.post('/host/terminal-candidates', { candidates: [candidate({ hostAck: 'nonsense' })] });
  assert.equal((await stored(service, RUN)).hostAck, 'pending', 'a label the contract does not define is not an upgrade');
  await service.post('/host/terminal-candidates', { candidates: [candidate({ hostAck: 'acked' })] });
  assert.equal((await stored(service, RUN)).hostAck, 'acked');
}));

test('T269: the label refresh is still not a delivery claim', withService(async (service) => {
  await service.post('/host/terminal-candidates', { candidates: [candidate()] });
  await service.post('/host/terminal-candidates', { candidates: [candidate({ hostAck: 'acked' })] });
  const run = await stored(service, RUN);
  assert.equal(run.pageDelivery, 'unknown', 'a host ACK is not a delivered page, ever');
  assert.equal(run.simulated, false);
  const listed = await service.get('/extension/terminal-candidates');
  assert.equal(listed.body.pageDelivery, 'unknown');
  assert.equal(listed.body.deliverable, false);
  assert.equal(listed.body.confirmed, false);
  assert.equal(listed.body.candidates.find((c) => c.runId === RUN).pageDelivery, 'unknown');
}));

test('T269: refreshing one record leaves the others and the completion instant alone', withService(async (service) => {
  await service.post('/host/terminal-candidates', { candidates: [
    candidate(),
    candidate({ runId: OTHER, terminalStatus: 'failed', statusSource: 'bridge.run_facts.status',
      completedAt: COMPLETED_MS - 60000, completedAtSource: 'bridge.task_events.task.interrupted', hostAck: 'acked' }),
  ] });
  await service.post('/host/terminal-candidates', { candidates: [candidate({ hostAck: 'acked' })] });
  const rows = (await service.get('/runs')).body.runs;
  const other = rows.find((run) => run.runId === OTHER);
  assert.equal(other.hostAck, 'acked', 'an unrelated record is untouched');
  assert.equal(other.completedAt, COMPLETED_MS - 60000);
  assert.equal(rows.find((run) => run.runId === RUN).completedAt, COMPLETED_MS,
    'the instant must not move when only the label changed');
}));
