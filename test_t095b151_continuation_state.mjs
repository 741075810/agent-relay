// T095B151: the continuation state machine, offline. Red first -- this file was written before
// `tools/continuation/continuation_state.mjs` existed, so the first run is a module-not-found
// failure and nothing else.
//
// What this is: the durable bookkeeping an *independent backend continuation* needs, with the
// invariants that cannot be hand-waved:
//
//   1. one completed event produces at most one dispatch, even across worker restarts, even when
//      the process dies between "I am about to dispatch" and "it was dispatched";
//   2. an invalid or stale authorisation produces no dispatch at all;
//   3. a Bridge outage delays work and loses nothing;
//   4. a failed continuation retries with backoff and then escalates -- it never silently vanishes
//      and never spins;
//   5. page state (foreground/background, focus, visibility) cannot influence any of the above,
//      because this layer is not page-bound. That is the architectural claim this prototype has to
//      demonstrate, not assert: nothing in the record or in the decision reads a tab, a window or a
//      document.
//
// What this is *not*: proof that ChatGPT replies while the screen is locked. It is a model of the
// bookkeeping around a continuation request; whether the model continues is a property of the
// site's own session and is out of this file's reach (see T151_REPORT.md, chain step 4).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = process.env.T151_MODULE
  || path.join(HERE, 'tools', 'continuation', 'continuation_state.mjs');

const CS = await import(pathToFileURL(MODULE).href + '?r=t151' + Math.random().toString(36).slice(2));

const T0 = 1793450000000;
const HOUR = 3600 * 1000;
const SESSION = 'dsh-native-session-0001';
const GRANT = { mode: 'standing', epoch: 'epoch-A', armedAt: T0 - HOUR, expiresAt: T0 + 24 * HOUR,
  sessionId: SESSION };
const RUN = { runId: 'aa11bb22-cc33-4d44-8e55-ff6677889900', status: 'completed', origin: 'bridge' };

function fresh(overrides = {}) {
  return CS.createStore(overrides);
}

test('T151: one completed event dispatches at most once, and a repeat is a duplicate', () => {
  let store = fresh();
  const a = CS.admit(store, { ...RUN, epoch: 'epoch-A', sessionId: SESSION,
    authorisation: GRANT, now: T0, bridgeUp: true });
  assert.equal(a.code, null);
  store = a.store;
  assert.equal(CS.admit(store, { ...RUN, epoch: 'epoch-A', sessionId: SESSION,
    authorisation: GRANT, now: T0 + 1000, bridgeUp: true }).code, 'duplicate_event');

  const lease = CS.lease(store, CS.key({ ...RUN, epoch: 'epoch-A' }), T0 + 2000, 60 * 1000);
  assert.equal(lease.code, null);
  store = lease.store;
  // A second lease while the first is live is refused: that is the second-dispatch guard.
  assert.equal(CS.lease(store, lease.key, T0 + 3000, 60 * 1000).code, 'lease_held');
  store = CS.complete(store, lease.key, { outcome: 'acked', at: T0 + 4000 }).store;
  assert.equal(CS.admit(store, { ...RUN, epoch: 'epoch-A', sessionId: SESSION,
    authorisation: GRANT, now: T0 + 5000, bridgeUp: true }).code, 'duplicate_event');
  const s = CS.summary(store);
  assert.equal(s.dispatched, 1, 'exactly one dispatch for one completion: ' + JSON.stringify(s));
  assert.equal(s.acked, 1);
});

test('T151: a crash between lease and completion is never re-dispatched', () => {
  let store = fresh();
  store = CS.admit(store, { ...RUN, epoch: 'epoch-A', sessionId: SESSION,
    authorisation: GRANT, now: T0, bridgeUp: true }).store;
  const key = CS.key({ ...RUN, epoch: 'epoch-A' });
  store = CS.lease(store, key, T0 + 1000, 30 * 1000).store;
  // The worker dies here. No `complete` ever arrives.
  const recovered = CS.recover(store, T0 + 1000 + 31 * 1000);
  assert.equal(recovered.store.jobs[key].state, 'escalated');
  assert.equal(recovered.store.jobs[key].lastError, 'unknown_outcome');
  assert.equal(recovered.escalated.length, 1, 'the uncertain write is escalated, not retried');
  assert.deepEqual(CS.dispatchable(recovered.store, T0 + 10 * 60 * 1000), [],
    'nothing may be dispatched for an unresolved lease');
  // And a re-admission after the escalation still does not produce a second dispatch.
  assert.equal(CS.admit(recovered.store, { ...RUN, epoch: 'epoch-A', sessionId: SESSION,
    authorisation: GRANT, now: T0 + 11 * 60 * 1000, bridgeUp: true }).code, 'duplicate_event');
});

test('T151: invalid or stale authorisation dispatches nothing', () => {
  const cases = [
    ['no grant', null, 'not_authorised'],
    ['expired grant', { ...GRANT, expiresAt: T0 - 1 }, 'not_authorised'],
    ['grant armed after now', { ...GRANT, armedAt: T0 + 1 }, 'not_authorised'],
    ['epoch mismatch', { ...GRANT, epoch: 'epoch-B' }, 'not_authorised'],
    ['bound to another session', { ...GRANT, sessionId: 'other-session' }, 'not_authorised'],
    ['unknown mode', { ...GRANT, mode: 'maybe' }, 'not_authorised'],
    ['non-terminal status', { mode: 'standing' }, 'status_not_terminal'],
  ];
  for (const [label, grant, expected] of cases) {
    const store = fresh();
    const payload = label === 'non-terminal status'
      ? { ...RUN, status: 'running', epoch: 'epoch-A', sessionId: SESSION,
        authorisation: grant, now: T0, bridgeUp: true }
      : { ...RUN, epoch: 'epoch-A', sessionId: SESSION, authorisation: grant, now: T0,
        bridgeUp: true };
    const out = CS.admit(store, payload);
    assert.equal(out.code, expected, label);
    assert.equal(Object.keys(out.store.jobs).length, 0, label + ': no record, no queue entry');
    assert.deepEqual(CS.dispatchable(out.store, T0 + 1000), [], label);
  }
});

test('T151: a Bridge outage delays the work and loses none of it', () => {
  let store = fresh();
  const down = CS.admit(store, { ...RUN, epoch: 'epoch-A', sessionId: SESSION,
    authorisation: GRANT, now: T0, bridgeUp: false });
  assert.equal(down.code, 'bridge_unavailable', 'the event cannot be trusted while the source is out');
  assert.equal(Object.keys(down.store.jobs).length, 0);

  // Once the Bridge is back, the same completion is admitted and dispatched once.
  store = CS.admit(down.store, { ...RUN, epoch: 'epoch-A', sessionId: SESSION,
    authorisation: GRANT, now: T0 + 5 * 60 * 1000, bridgeUp: true }).store;
  assert.equal(Object.keys(store.jobs).length, 1);
  const ready = CS.dispatchable(store, T0 + 5 * 60 * 1000);
  assert.equal(ready.length, 1);
  assert.equal(ready[0], CS.key({ ...RUN, epoch: 'epoch-A' }));
});

test('T151: a failed continuation retries with backoff, then escalates and stays on record', () => {
  let store = fresh();
  store = CS.admit(store, { ...RUN, epoch: 'epoch-A', sessionId: SESSION,
    authorisation: GRANT, now: T0, bridgeUp: true }).store;
  const key = CS.key({ ...RUN, epoch: 'epoch-A' });
  let at = T0 + 1000;
  for (let attempt = 1; attempt <= CS.MAX_ATTEMPTS; attempt += 1) {
    const lease = CS.lease(store, key, at, 60 * 1000);
    assert.equal(lease.code, null, 'attempt ' + attempt);
    store = lease.store;
    const failed = CS.complete(store, key, { outcome: 'failed', code: 'dsh_busy', at });
    store = failed.store;
    if (attempt < CS.MAX_ATTEMPTS) {
      assert.equal(store.jobs[key].state, 'failed');
      assert.ok(store.jobs[key].nextRetryAt > at, 'backoff is scheduled: '
        + JSON.stringify(store.jobs[key]));
      assert.deepEqual(CS.dispatchable(store, at + 1), [], 'not retried immediately');
      at = store.jobs[key].nextRetryAt;
    }
  }
  assert.equal(store.jobs[key].state, 'escalated', 'after the cap it escalates: '
    + JSON.stringify(store.jobs[key]));
  assert.equal(store.jobs[key].lastError, 'dsh_busy');
  assert.deepEqual(CS.dispatchable(store, at + 10 * HOUR), [], 'and never retries again');
  assert.equal(CS.summary(store).escalated, 1);
});

test('T151: a restarted process resumes from the record with no lost and no duplicate dispatch', () => {
  let store = fresh();
  store = CS.admit(store, { ...RUN, epoch: 'epoch-A', sessionId: SESSION,
    authorisation: GRANT, now: T0, bridgeUp: true }).store;
  const other = { runId: 'bb22cc33-dd44-4e55-8f66-aa7788990011', status: 'failed', origin: 'bridge' };
  store = CS.admit(store, { ...other, epoch: 'epoch-A', sessionId: SESSION,
    authorisation: GRANT, now: T0, bridgeUp: true }).store;
  const key = CS.key({ ...RUN, epoch: 'epoch-A' });
  store = CS.lease(store, key, T0 + 1000, 60 * 1000).store;
  store = CS.complete(store, key, { outcome: 'acked', at: T0 + 2000 }).store;

  // "Worker restart": persist to JSON, then rebuild from the string only.
  const durable = CS.snapshot(store);
  const revived = CS.restore(JSON.parse(durable));
  assert.deepEqual(Object.keys(revived.jobs).sort(), Object.keys(store.jobs).sort(),
    'every job survives the restart verbatim');
  const ready = CS.dispatchable(revived, T0 + 3000);
  assert.equal(ready.length, 1, 'the unfinished one is still queued: ' + JSON.stringify(ready));
  assert.equal(ready[0], CS.key({ ...other, epoch: 'epoch-A' }));
  assert.equal(CS.admit(revived, { ...RUN, epoch: 'epoch-A', sessionId: SESSION,
    authorisation: GRANT, now: T0 + 4000, bridgeUp: true }).code, 'duplicate_event',
  'and the finished one is not re-admitted after the restart');
});

test('T151: page state cannot influence the decision (the record has no page in it)', () => {
  const store = fresh();
  const admitted = CS.admit(store, { ...RUN, epoch: 'epoch-A', sessionId: SESSION,
    authorisation: GRANT, now: T0, bridgeUp: true }).store;
  const key = CS.key({ ...RUN, epoch: 'epoch-A' });
  // Whatever the browser is doing -- foreground, background, locked, frozen, discarded -- the
  // record and the eligibility answer are the same, because neither reads a tab.
  const pageStates = ['foreground', 'background', 'locked', 'frozen', 'discarded', 'no_tab'];
  for (const pageState of pageStates) {
    const ready = CS.dispatchable(admitted, T0 + 1000, { pageState });
    assert.deepEqual(ready, [key], 'dispatch eligibility is page-independent: ' + pageState);
  }
  const record = admitted.jobs[key];
  for (const field of Object.keys(record)) {
    assert.ok(!/tab|window|focus|visible|discard/i.test(field),
      'the durable record carries no page field: ' + field);
  }
});
