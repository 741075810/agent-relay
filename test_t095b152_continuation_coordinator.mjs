// T095B152: continuation coordinator, offline. Red first -- written before the modules exist.
//
// The point of this file: prove, in one process with no browser and no ChatGPT page, that completed
// tasks can be handed to the *same* native session round after round, at most once each, with the
// bookkeeping surviving crashes and replays -- and that every refusal path refuses.
//
// Authorisation here is a *continuation* grant (`kind: 'continuation'`): it authorises dispatching
// work to the fixed DSH session. It is deliberately not the page-notice grant the popup arms
// (T058/T059). Passing one where the other is required is a test case, not an accident.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.T152_DIR || path.join(HERE, 'tools', 'continuation');
const load = (name) => import(pathToFileURL(path.join(DIR, name)).href
  + '?r=t152' + Math.random().toString(36).slice(2));

const CO = await load('coordinator.mjs');
const ES = await load('eventsource.mjs');
const TB = await load('transport_fake_bridge.mjs');

const T0 = 1793450000000;
const MIN = 60 * 1000;
const SESSION = 'dsh-native-session-0001';
const SCOPE = 'repo:agent-relay';

function grant(over = {}) {
  return { kind: 'continuation', epoch: 'epoch-A', sessionId: SESSION,
    armedAt: T0 - 60 * MIN, expiresAt: T0 + 12 * 60 * MIN, maxTasks: 8,
    scopes: [SCOPE], ...over };
}

function tasks(n = 5) {
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    out.push({ id: 'task-' + i, scope: SCOPE, title: 'approved task ' + i });
  }
  return out;
}

function completion(n, status = 'completed') {
  return { runId: 'aa11bb22-cc33-4d44-8e55-ff6677889' + String(900 + n), status,
    epoch: 'epoch-A', sessionId: SESSION, endedAtMs: T0 + n * MIN };
}

function listReply(events, over = {}) {
  return { ok: true, armEpoch: 'epoch-A', count: events.length, truncated: false,
    candidates: events.map((e) => ({ runId: e.runId, status: e.status, origin: 'bridge',
      startedAt: (e.endedAtMs - 4000) / 1000, endedAtMs: e.endedAtMs, postArm: true })), ...over };
}

function boot(over = {}) {
  const bridge = TB.createFakeBridge();
  const mirror = ES.createMirror();
  const co = CO.createCoordinator({ bridge, mirror, tasks: tasks(), grant: grant(),
    config: { enabled: false, leaseMs: 60 * 1000, maxTasksPerRun: 8, ...(over.config || {}) },
    sessionId: SESSION, now: () => T0 });
  return { bridge, mirror, co };
}

test('T152: default disabled -- no grant, no dispatch, no transport call', async () => {
  const bridge = TB.createFakeBridge();
  const co = CO.createCoordinator({ bridge, mirror: ES.createMirror(), tasks: tasks(),
    config: { enabled: false }, sessionId: SESSION, now: () => T0 });
  const out = await co.step(T0 + 1000);
  assert.equal(out.code, 'disabled');
  assert.equal(bridge.calls.length, 0, 'a coordinator that nobody enabled never dispatches');
  assert.equal(co.status().enabled, false);
});

test('T152: three serial tasks run in-process with no browser and one fixed session', async () => {
  const { bridge, co } = boot();
  assert.equal(await co.enable(grant()), null);
  const expected = [];
  for (let round = 1; round <= 3; round += 1) {
    co.poll(listReply([completion(round)]), T0 + round * MIN);
    const out = await co.step(T0 + round * MIN + 1000);
    assert.equal(out.code, null, 'round ' + round + ': ' + JSON.stringify(out));
    assert.equal(out.dispatch.taskId, 'task-' + round);
    expected.push('task-' + round);
  }
  assert.deepEqual(bridge.calls.map((c) => c.taskId), expected, 'in approved order');
  assert.equal(new Set(bridge.calls.map((c) => c.sessionId)).size, 1, 'one session, never a new one');
  assert.equal(bridge.calls[0].sessionId, SESSION);
  const status = co.status();
  assert.equal(status.tasksDone, 3);
  assert.equal(status.dispatched, 3);
  assert.equal(status.enabled, true, 'still armed: the queue has more approved work');
});

test('T152: a repeated completion is dispatched once, even across a restart and a replay', async () => {
  const { bridge, co } = boot();
  await co.enable(grant());
  const reply = listReply([completion(1)]);
  co.poll(reply, T0 + 1000);
  const first = await co.step(T0 + 2000);
  assert.equal(first.code, null);
  const durable = co.checkpoint();
  // Same event again, plus a restart from the checkpoint.
  co.poll(reply, T0 + 3000);
  const co2 = CO.restore(durable, { bridge, tasks: tasks(), sessionId: SESSION, now: () => T0 });
  co2.poll(reply, T0 + 4000);
  const second = await co2.step(T0 + 5000);
  assert.equal(second.code, 'no_events', JSON.stringify(second));
  assert.equal(bridge.calls.length, 1, 'exactly one dispatch across replay + restart');
});

test('T152: 40+ backlog with a truncated reply is event_gap and dispatches nothing', async () => {
  const { bridge, co } = boot();
  await co.enable(grant());
  const backlog = [];
  for (let i = 1; i <= 45; i += 1) backlog.push(completion(i));
  co.poll(listReply(backlog, { truncated: true, count: 45 }), T0 + 1000);
  const blocked = await co.step(T0 + 2000);
  assert.equal(blocked.code, 'event_gap', JSON.stringify(blocked));
  assert.equal(bridge.calls.length, 0, 'a gap is never papered over by dispatching what we did see');
  // A non-truncated reply proves the source is whole again; work resumes, still once each.
  co.poll(listReply([completion(1)]), T0 + 3000);
  const out = await co.step(T0 + 4000);
  assert.equal(out.code, null, JSON.stringify(out));
  assert.equal(bridge.calls.length, 1);
});

test('T152: paged replay from the durable mirror feeds the coordinator in order', async () => {
  let mirror = ES.createMirror();
  for (let i = 1; i <= 250; i += 1) {
    mirror = ES.appendEvent(mirror, { key: 'k' + i, runId: 'run-' + i, status: 'completed',
      epoch: 'epoch-A', sessionId: SESSION, at: T0 + i }).mirror;
  }
  const pages = [];
  let cursor = 0;
  for (;;) {
    const page = ES.scan(mirror, { afterSeq: cursor, limit: ES.PAGE });
    pages.push(page.events.length);
    if (page.done) break;
    cursor = page.nextSeq;
    if (pages.length > 10) break;
  }
  assert.deepEqual(pages, [100, 100, 50], 'the whole mirror is reachable in pages, nothing skipped');
});

test('T152: the page-notice grant is not a continuation grant', async () => {
  const { bridge, co } = boot();
  const noticeGrant = { kind: 'notice', mode: 'standing', epoch: 'epoch-A', sessionId: SESSION,
    armedAt: T0 - 60 * MIN, expiresAt: T0 + 60 * MIN, maxSends: 100 };
  assert.equal(await co.enable(noticeGrant), 'wrong_authorisation_kind');
  assert.equal(co.status().enabled, false);
  co.poll(listReply([completion(1)]), T0 + 1000);
  assert.equal((await co.step(T0 + 2000)).code, 'disabled');
  assert.equal(bridge.calls.length, 0);
});

test('T152: an expired grant stops the coordinator and says so', async () => {
  const { bridge, co } = boot();
  await co.enable(grant({ expiresAt: T0 + 1000 }));
  co.poll(listReply([completion(1)]), T0 + 500);
  const out = await co.step(T0 + 5000);
  assert.equal(out.code, 'grant_expired');
  assert.equal(bridge.calls.length, 0);
  assert.equal(co.status().enabled, false, 'and it disables itself rather than trying again');
});

test('T152: an out-of-scope task is never chosen', async () => {
  const { bridge, co } = boot();
  await co.enable(grant({ scopes: ['repo:other'] }));
  co.poll(listReply([completion(1)]), T0 + 1000);
  const out = await co.step(T0 + 2000);
  assert.equal(out.code, 'no_approved_task', JSON.stringify(out));
  assert.equal(bridge.calls.length, 0, 'authorisation scope is checked before anything is claimed');
});

test('T152: a transport failure retries with backoff and then escalates', async () => {
  const { bridge, co } = boot();
  await co.enable(grant());
  bridge.failNext(3, 'bridge_busy');
  co.poll(listReply([completion(1)]), T0 + 1000);
  let at = T0 + 2000;
  let last;
  for (let i = 0; i < 4; i += 1) {
    last = await co.step(at);
    at = co.status().nextRetryAt || at + 5 * MIN;
  }
  assert.equal(last.code === 'escalated' || co.status().escalated === 1, true,
    'after the attempt cap it escalates: ' + JSON.stringify(co.status()));
  assert.equal(bridge.calls.length, 1 + 1 + 1, 'three attempts, then no more');
  assert.equal(co.status().tasksDone, 0, 'nothing was reported done');
});

test('T152: a crash between the write-ahead lease and the reply escalates, never re-dispatches', async () => {
  const bridge = TB.createFakeBridge();
  const co = CO.createCoordinator({ bridge, mirror: ES.createMirror(), tasks: tasks(),
    grant: grant(), config: { enabled: true, leaseMs: 30 * 1000 }, sessionId: SESSION,
    now: () => T0 });
  assert.equal(await co.enable(grant()), null, 'an explicit enable is still required');
  co.poll(listReply([completion(1)]), T0 + 1000);
  bridge.hangOnce();                        // the request is sent, the reply never arrives
  const pending = await co.step(T0 + 2000);
  assert.equal(pending.code, 'in_flight', 'the lease is written before the hand-off');
  const durable = co.checkpoint();
  const revived = CO.restore(durable, { bridge, tasks: tasks(), sessionId: SESSION, now: () => T0 });
  const recovered = await revived.recover(T0 + 2000 + 31 * 1000);
  assert.equal(recovered.escalated.length, 1, 'the unknown hand-off is escalated');
  assert.equal(revived.status().jobs[recovered.escalated[0]].lastError, 'unknown_outcome');
  const after = await revived.step(T0 + 3 * MIN);
  assert.equal(bridge.calls.length, 1, 'no second dispatch');
  assert.notEqual(after.code, null);
});

test('T152: the termination conditions stop it (max tasks, empty queue, explicit stop)', async () => {
  const { bridge, co } = boot({ config: { maxTasksPerRun: 2 } });
  await co.enable(grant());
  for (let round = 1; round <= 2; round += 1) {
    co.poll(listReply([completion(round)]), T0 + round * MIN);
    assert.equal((await co.step(T0 + round * MIN + 1000)).code, null);
  }
  assert.equal(co.status().enabled, false, 'the per-run cap disables it');
  co.poll(listReply([completion(3)]), T0 + 4 * MIN);
  assert.equal((await co.step(T0 + 4 * MIN + 1000)).code, 'disabled');
  assert.equal(bridge.calls.length, 2);

  const second = boot();
  await second.co.enable(grant({ maxTasks: 1 }));
  second.co.poll(listReply([completion(1)]), T0 + 1000);
  assert.equal((await second.co.step(T0 + 2000)).code, null);
  assert.equal(second.co.status().enabled, false, 'the grant cap disables it too');
  second.co.poll(listReply([completion(2)]), T0 + 3000);
  assert.equal((await second.co.step(T0 + 4000)).code, 'disabled');

  const third = boot();
  await third.co.enable(grant());
  third.co.stop('operator');
  third.co.poll(listReply([completion(1)]), T0 + 1000);
  assert.equal((await third.co.step(T0 + 2000)).code, 'stopped');
  assert.equal(third.bridge.calls.length, 0);
});

test('T152: a Bridge outage loses no event and dispatches once when it returns', async () => {
  const { bridge, co } = boot();
  await co.enable(grant());
  bridge.down = true;
  co.poll(listReply([completion(1)]), T0 + 1000);
  const offline = await co.step(T0 + 2000);
  assert.equal(offline.code, 'bridge_unavailable', JSON.stringify(offline));
  assert.equal(co.status().jobs ? Object.keys(co.status().jobs).length : 0, 0,
    'nothing is claimed while the transport is down');
  bridge.down = false;
  co.poll(listReply([completion(1)]), T0 + 3000);
  const back = await co.step(T0 + 4000);
  assert.equal(back.code, null, JSON.stringify(back));
  assert.equal(bridge.calls.length, 1);
});

// T262: fake transport + owned in-memory state only; no browser or live task service.
test('T262 coordinator immediate checkpoint after restore preserves acknowledged work', async () => {
  const { bridge, co } = boot(); await co.enable(grant());
  co.poll(listReply([completion(1)]), T0 + 1000); await co.step(T0 + 2000);
  const restored = CO.restore(co.checkpoint(), { bridge, tasks: tasks(), sessionId: SESSION, now: () => T0 });
  assert.deepEqual(JSON.parse(restored.checkpoint()).store, JSON.parse(co.checkpoint()).store);
  const twice = CO.restore(restored.checkpoint(), { bridge, tasks: tasks(), sessionId: SESSION, now: () => T0 });
  await twice.enable(grant()); twice.poll(listReply([completion(1)]), T0 + 3000);
  assert.equal((await twice.step(T0 + 4000)).code, 'no_events');
  assert.equal(bridge.calls.length, 1);
});
for (const [name, reply] of [['absent', undefined], ['null', null], ['empty', {}], ['bad-case', { outcome: 'ACK' }],
  ['error', { outcome: 'error', code: 'quota-fixture' }], ['unknown', { outcome: 'unknown' }]]) {
  test(`T262 coordinator ${name} callback is sticky UNKNOWN even with backlog`, async () => {
    const { co } = boot(); const calls = [];
    co.bridge.request = async payload => { calls.push(payload); return reply; };
    await co.enable(grant()); co.poll(listReply([completion(1), completion(2)]), T0 + 1000);
    assert.equal((await co.step(T0 + 2000)).code, 'in_flight');
    assert.equal(co.status().nextRetryAt, null);
    assert.equal((await co.step(T0 + 3 * MIN)).code, 'in_flight');
    assert.equal(calls.length, 1);
    await co.recover(T0 + 3 * MIN);
    const restored = CO.restore(co.checkpoint(), { bridge: co.bridge, tasks: tasks(), sessionId: SESSION, now: () => T0 });
    assert.equal((await restored.step(T0 + 4 * MIN)).code, 'unknown_outcome');
    assert.equal(calls.length, 1); assert.equal(restored.status().tasksDone, 0);
  });
}
test('T262 coordinator concurrent calls preserve one in-flight slot and grant cap', async () => {
  const { co } = boot(); const calls = [], resolvers = [];
  co.bridge.request = payload => { calls.push(payload); return new Promise(resolve => resolvers.push(resolve)); };
  await co.enable(grant({ maxTasks: 1 })); co.poll(listReply([completion(1), completion(2)]), T0 + 1000);
  const first = co.step(T0 + 2000), second = co.step(T0 + 2001);
  try { assert.equal(calls.length, 1); }
  finally { for (const resolve of resolvers) resolve({ outcome: 'ack' }); await Promise.allSettled([first, second]); }
  assert.equal((await second).code, 'in_flight'); assert.equal(co.status().tasksDone, 1);
  assert.deepEqual(co.status().jobs[calls[0].key].taskId, calls[0].taskId);
});
test('T262 coordinator failed retry waits and backlog cannot reset the attempt budget', async () => {
  const { co } = boot(); const calls = [];
  co.bridge.request = async payload => { calls.push(payload); return { outcome: 'failed', code: 'busy-fixture' }; };
  await co.enable(grant()); co.poll(listReply([completion(1), completion(2)]), T0 + 1000);
  assert.equal((await co.step(T0 + 2000)).code, 'retry_scheduled');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt < 3) {
      const due = co.status().nextRetryAt;
      const waiting = await co.step(due - 1);
      assert.equal(waiting.code, 'retry_wait'); assert.equal(waiting.nextRetryAt, due);
      assert.equal(calls.length, attempt); await co.step(due);
    }
  }
  assert.equal((await co.step(T0 + 10 * MIN)).code, 'escalated');
  assert.equal(calls.length, 3); assert.equal(new Set(calls.map(x => x.key)).size, 1);
  assert.equal(new Set(calls.map(x => x.taskId)).size, 1);
  assert.deepEqual(calls.map(x => x.attempt), [1, 2, 3]);
});
test('T262 coordinator reservation survives snapshot and retry without copying task text', async () => {
  const { co } = boot(); const calls = []; let active = co;
  co.bridge.request = async payload => {
    const saved = JSON.parse(active.checkpoint()).store.jobs[payload.key];
    assert.equal(saved.taskId, payload.taskId); assert.match(saved.taskDigest, /^[0-9a-f]{64}$/);
    assert.equal(saved.attempts, payload.attempt); assert.equal(saved.title, undefined);
    calls.push(payload); return calls.length === 1 ? { outcome: 'failed', code: 'busy-fixture' } : { outcome: 'ack' };
  };
  await co.enable(grant()); co.poll(listReply([completion(1)]), T0 + 1000);
  await co.step(T0 + 2000); const due = co.status().nextRetryAt;
  const restored = CO.restore(co.checkpoint(), { bridge: co.bridge, tasks: tasks(), sessionId: SESSION, now: () => T0 });
  active = restored;
  assert.equal((await restored.step(due)).code, null);
  assert.equal(calls.length, 2); assert.equal(calls[0].key, calls[1].key); assert.equal(calls[0].taskId, calls[1].taskId);
});
for (const mode of ['changed', 'missing']) {
  test(`T262 coordinator reserved intent ${mode} stops without overwriting state`, async () => {
    const { co } = boot(); const calls = [];
    co.bridge.request = async payload => { calls.push(payload); return { outcome: 'failed', code: 'busy-fixture' }; };
    await co.enable(grant()); co.poll(listReply([completion(1)]), T0 + 1000); await co.step(T0 + 2000);
    const due = co.status().nextRetryAt, before = structuredClone(co.status().jobs);
    const altered = tasks(); if (mode === 'changed') altered[0].title = 'unsubmitted edited work fixture'; else altered.shift();
    const restored = CO.restore(co.checkpoint(), { bridge: co.bridge, tasks: altered, sessionId: SESSION, now: () => T0 });
    assert.equal((await restored.step(due)).code, mode === 'changed' ? 'task_intent_changed' : 'reserved_task_unavailable');
    assert.equal(calls.length, 1); assert.deepEqual(restored.status().jobs, before);
    if (mode === 'changed') assert.equal(altered[0].title, 'unsubmitted edited work fixture');
  });
}
test('T262 coordinator late ACK after recovery never reports successful handoff', async () => {
  const { co } = boot(); let resolveReply;
  co.bridge.request = () => new Promise(resolve => { resolveReply = resolve; });
  await co.enable(grant()); co.poll(listReply([completion(1)]), T0 + 1000);
  const pending = co.step(T0 + 2000);
  await co.recover(T0 + 3 * MIN); resolveReply({ outcome: 'ack' });
  assert.equal((await pending).code, 'not_dispatchable');
  assert.equal(co.status().tasksDone, 0); assert.deepEqual(co.state.used, []);
  assert.equal(Object.values(co.status().jobs)[0].lastError, 'unknown_outcome');
});
for (const mode of ['legacy', 'partial', 'bad-digest', 'duplicate', 'epoch-drift']) {
  test(`T262 coordinator ${mode} reservation refuses without reset or inference`, async () => {
    const { co } = boot(); const calls = [];
    co.bridge.request = async payload => { calls.push(payload); return { outcome: 'failed', code: 'busy-fixture' }; };
    await co.enable(grant()); co.poll(listReply([completion(1)]), T0 + 1000); await co.step(T0 + 2000);
    const raw = JSON.parse(co.checkpoint()), job = Object.values(raw.store.jobs)[0], altered = tasks();
    if (mode === 'legacy') { delete job.taskId; delete job.taskDigest; }
    if (mode === 'partial') delete job.taskDigest;
    if (mode === 'bad-digest') job.taskDigest = 'invalid-fixture';
    if (mode === 'duplicate') altered.push({ ...altered[0] });
    if (mode === 'epoch-drift') raw.state.grant.epoch = 'epoch-B';
    const restored = CO.restore(raw, { bridge: co.bridge, tasks: altered, sessionId: SESSION, now: () => T0 });
    const before = structuredClone(restored.status().jobs);
    const expected = mode === 'duplicate' ? 'task_identity_ambiguous' : mode === 'epoch-drift' ? 'task_binding_changed' : 'reservation_unverified';
    assert.equal((await restored.step(job.nextRetryAt)).code, expected);
    assert.equal(calls.length, 1); assert.deepEqual(restored.status().jobs, before);
  });
}
test('T262 coordinator failure backoff starts at injected reply-recording time', async () => {
  let clock = T0, resolveReply;
  const bridge = { request: () => new Promise(resolve => { resolveReply = resolve; }) };
  const co = CO.createCoordinator({ bridge, tasks: tasks(), sessionId: SESSION, now: () => clock,
    config: { leaseMs: 2 * MIN } });
  await co.enable(grant()); co.poll(listReply([completion(1)]), T0);
  const pending = co.step(T0 + 1000);
  clock = T0 + MIN; resolveReply({ outcome: 'failed', code: 'busy-fixture' });
  assert.equal((await pending).code, 'retry_scheduled');
  assert.equal(co.status().nextRetryAt, clock + 30000);
  assert.equal((await co.step(clock + 1)).code, 'retry_wait');
});
test('T262 coordinator captures task and session identity before awaited ACK', async () => {
  const { co } = boot(); let resolveReply;
  co.bridge.request = () => new Promise(resolve => { resolveReply = resolve; });
  await co.enable(grant()); co.poll(listReply([completion(1)]), T0 + 1000);
  const pending = co.step(T0 + 2000);
  co.tasks[0].id = 'edited-unsubmitted-task-fixture'; co.state.grant.sessionId = 'edited-session-fixture';
  resolveReply({ outcome: 'ack' }); const out = await pending;
  assert.equal(out.dispatch.taskId, 'task-1'); assert.equal(out.dispatch.sessionId, SESSION);
  assert.deepEqual(co.state.used, ['task-1']); assert.equal(co.tasks[0].id, 'edited-unsubmitted-task-fixture');
});
test('T314: configured fake response has no authoritative identity fields', async () => {
  const bridge = TB.createFakeBridge();
  const request = { sessionId: SESSION, taskId: 'task-1', key: 'synthetic-key',
    title: 'synthetic handoff', epoch: 'epoch-A', attempt: 1 };
  bridge.script.push({ outcome: 'ack', sessionId: 'other-session', taskId: 'other-task',
    key: 'other-key', attempt: 99 });
  const reply = await bridge.request(request);
  assert.deepEqual(reply, { outcome: 'ack', code: undefined });
  for (const field of ['sessionId', 'taskId', 'key', 'attempt', 'epoch']) {
    assert.equal(Object.hasOwn(reply, field), false, field + ' is not returned by configured fake');
  }
  assert.equal(bridge.calls[0].sessionId, SESSION);
  assert.equal(bridge.calls[0].taskId, 'task-1');
  assert.equal(bridge.calls[0].attempt, 1);
});

test('T314: legacy ACK settles captured request only and duplicate step does not submit', async () => {
  const { co, bridge } = boot();
  const requestFake = bridge.request.bind(bridge);
  let captured;
  co.bridge.request = async request => {
    captured = request;
    assert.equal(Object.isFrozen(request), true);
    return requestFake(request); // actual configured response shape, no invented receipt fields
  };
  await co.enable(grant());
  co.poll(listReply([completion(1)]), T0 + 1000);
  const out = await co.step(T0 + 2000);
  assert.equal(out.code, null);
  const job = co.status().jobs[captured.key];
  assert.equal(out.dispatch.sessionId, captured.sessionId);
  assert.equal(out.dispatch.taskId, captured.taskId);
  assert.equal(job.attempts, captured.attempt);
  assert.equal(job.state, 'acked');
  assert.deepEqual(co.state.used, [captured.taskId]);
  assert.equal(co.status().tasksDone, 1, 'accepted handoffs, not upstream completed tasks');
  assert.equal((await co.step(T0 + 3000)).code, 'no_events');
  assert.equal(bridge.calls.length, 1);
});

test('T315: opt-in bound receipt adapter rejects incomplete and conflicting evidence', async () => {
  const { createOfflineBoundReceiptAdapter: adapter, assessBoundReceipt } =
    await import('./tools/continuation/offline_bound_receipt.mjs');
  const request = { sessionId: 'synthetic-session', taskId: 'synthetic-task', key: 'key-one',
    epoch: 'synthetic-epoch', attempt: 1, title: 'synthetic request' };
  // Caller-supplied synthetic receipt; equality here is NOT authentication.
  const reply = { outcome: 'ack', receipt: { version: 1, receiptId: 'receipt-one',
    sessionId: 'synthetic-session', taskId: 'synthetic-task', key: 'key-one',
    epoch: 'synthetic-epoch', attempt: 1 } };
  assert.deepEqual(assessBoundReceipt(request, reply), { outcome: 'ack' });
  const negatives = [null, { outcome: 'ack' }, { outcome: 'failed' },
    { ...reply, receipt: { ...reply.receipt, version: 2 } },
    { ...reply, receipt: { ...reply.receipt, receiptId: '' } }];
  for (const field of ['sessionId', 'taskId', 'key', 'epoch', 'attempt']) {
    negatives.push({ ...reply, receipt: { ...reply.receipt, [field]: field === 'attempt' ? 2 : 'other' } });
    const missing = structuredClone(reply); delete missing.receipt[field]; negatives.push(missing);
  }
  let disabledCalls = 0;
  const off = adapter({ transport: { request: async () => { disabledCalls += 1; return reply; } } });
  assert.equal((await off.request(request)).outcome, 'unknown'); assert.equal(disabledCalls, 0);
  for (const response of negatives) {
    let calls = 0;
    const bound = adapter({ enabled: true, transport: { request: async sent => {
      assert.equal(Object.isFrozen(sent), true); calls += 1; return response;
    } } });
    assert.equal((await bound.request(request)).outcome, 'unknown');
    assert.equal((await bound.request({ ...request, attempt: 2 })).code, 'duplicate_or_conflicting_request');
    assert.equal(calls, 1, 'unknown receipt never triggers a second submission');
  }
  let resolve;
  let calls = 0;
  const bound = adapter({ enabled: true, transport: { request: () => {
    calls += 1; return new Promise(done => { resolve = done; });
  } } });
  const pending = bound.request(request);
  assert.equal((await bound.request(request)).code, 'duplicate_or_conflicting_request');
  resolve(reply); assert.equal((await pending).outcome, 'ack');
  assert.equal((await bound.request({ ...request, taskId: 'other' })).outcome, 'unknown');
  assert.equal(calls, 1);
  const reused = adapter({ enabled: true, transport: { request: async sent => ({ outcome: 'ack',
    receipt: { version: 1, receiptId: 'same-receipt', ...sent } }) } });
  assert.equal((await reused.request(request)).outcome, 'ack');
  assert.equal((await reused.request({ ...request, key: 'second-key' })).code, 'duplicate_receipt');
  const thrown = adapter({ enabled: true, transport: { request: async () => { throw new Error('fixture'); } } });
  assert.equal((await thrown.request(request)).outcome, 'unknown');
  assert.equal((await thrown.request(request)).code, 'duplicate_or_conflicting_request');
});

test('T315: missing bound receipt leaves real coordinator leased, never done or retried', async () => {
  const { createOfflineBoundReceiptAdapter } = await import('./tools/continuation/offline_bound_receipt.mjs');
  const { co } = boot(); let calls = 0;
  const bound = createOfflineBoundReceiptAdapter({ enabled: true, transport: { request: async () => {
    calls += 1; return { outcome: 'ack' }; // legacy shape intentionally insufficient for opt-in contract
  } } });
  co.bridge.request = request => bound.request(request);
  await co.enable(grant()); co.poll(listReply([completion(1)]), T0 + 1000);
  assert.equal((await co.step(T0 + 2000)).code, 'in_flight');
  assert.equal(co.status().tasksDone, 0); assert.deepEqual(co.state.used, []);
  assert.equal(Object.values(co.status().jobs)[0].state, 'leased');
  assert.equal((await co.step(T0 + 3000)).code, 'in_flight');
  await co.recover(T0 + 3 * MIN);
  assert.equal((await co.step(T0 + 3 * MIN)).code, 'unknown_outcome');
  assert.equal(calls, 1);
});

test('T262 coordinator invalid clock retains source without any request', async () => {
  const { bridge, co } = boot(); await co.enable(grant()); co.poll(listReply([completion(1)]), T0);
  const before = co.checkpoint(); assert.equal((await co.step(NaN)).code, 'clock_unverified');
  assert.equal(co.checkpoint(), before); assert.equal(bridge.calls.length, 0);
});
test('T262 coordinator recovered queued retry retains priority across repeated restarts', async () => {
  const { co } = boot(); const calls = [];
  co.bridge.request = async payload => { calls.push(payload); return { outcome: 'failed', code: 'busy-fixture' }; };
  await co.enable(grant()); co.poll(listReply([completion(2)]), T0 + 1000);
  await co.step(T0 + 2000); const originalKey = calls[0].key;
  co.poll(listReply([completion(1)]), T0 + 3000); let active = co;
  for (let attempt = 2; attempt <= 3; attempt += 1) {
    const due = active.status().nextRetryAt; await active.recover(due);
    assert.equal(active.status().jobs[originalKey].state, 'queued');
    active = CO.restore(active.checkpoint(), { bridge: co.bridge, tasks: tasks(), sessionId: SESSION, now: () => T0 });
    await active.step(due);
    assert.equal(calls.at(-1).key, originalKey); assert.equal(calls.at(-1).attempt, attempt);
    assert.equal(calls.at(-1).taskId, 'task-1');
  }
  assert.equal((await active.step(T0 + 10 * MIN)).code, 'escalated'); assert.equal(calls.length, 3);
});
