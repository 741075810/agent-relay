// T095B151: runnable scenario for the continuation state machine.
//
//   node tools/continuation/scenario.mjs
//
// No environment beyond Node is needed; the repository suites set PYTHON themselves.
//
// It prints one line per step so the behaviour can be read without a debugger: a normal
// dispatch, a crash between lease and completion, a Bridge outage, an invalid authorisation, and a
// restart in the middle. Nothing here touches Chrome, the host, or a page -- it is the bookkeeping
// layer only.

import {
  admit, complete, createStore, dispatchable, lease, key, recover, restore, snapshot, summary,
} from './continuation_state.mjs';

const T0 = 1793450000000;
const MIN = 60 * 1000;
const SESSION = 'dsh-native-session-0001';
const GRANT = { mode: 'standing', epoch: 'epoch-A', armedAt: T0 - 60 * MIN,
  expiresAt: T0 + 24 * 60 * MIN, sessionId: SESSION };

const runs = [
  { runId: 'aa11bb22-cc33-4d44-8e55-ff6677889900', status: 'completed', origin: 'bridge' },
  { runId: 'bb22cc33-dd44-4e55-8f66-aa7788990011', status: 'completed', origin: 'bridge' },
  { runId: 'cc33dd44-ee55-4f66-9067-bb8899001122', status: 'completed', origin: 'bridge' },
];

function show(step, store) {
  const rows = Object.entries(store.jobs).map(([k, job]) =>
    k.split('|')[0].slice(0, 8) + ':' + job.state + (job.lastError ? '(' + job.lastError + ')' : ''));
  console.log(String(step).padEnd(46), rows.join(' ') || '(empty)', JSON.stringify(summary(store)));
}

let store = createStore();

// 1. Normal path: admitted, leased, acknowledged.
const first = admit(store, { ...runs[0], epoch: 'epoch-A', sessionId: SESSION,
  authorisation: GRANT, now: T0, bridgeUp: true });
store = first.store;
show('1 admit run #1 (bridge up, grant ok)', store);
const k1 = key({ ...runs[0], epoch: 'epoch-A' });
const firstLease = lease(store, k1, T0 + 1000);
store = firstLease.store;
show('2 lease run #1 (write-ahead)', store);
store = complete(store, k1, { outcome: 'acked', attempt: firstLease.attempt, at: T0 + 2000 }).store;
show('3 ack run #1', store);

// 2. Crash: leased, then the process disappears; recovery must escalate, not retry.
const second = admit(store, { ...runs[1], epoch: 'epoch-A', sessionId: SESSION,
  authorisation: GRANT, now: T0 + 3000, bridgeUp: true });
store = second.store;
const k2 = key({ ...runs[1], epoch: 'epoch-A' });
store = lease(store, k2, T0 + 4000, 30 * 1000).store;
show('4 lease run #2 then lose the process', store);
const recovered = recover(store, T0 + 40 * 1000);
store = recovered.store;
show('5 recover after the lease deadline', store);
console.log('   escalated:', recovered.escalated.map((k) => k.split('|')[0].slice(0, 8)).join(','),
  ' dispatchable now:', JSON.stringify(dispatchable(store, T0 + 41 * 1000)));

// 3. Bridge outage: no record, then the same completion is admitted when it comes back.
const down = admit(store, { ...runs[2], epoch: 'epoch-A', sessionId: SESSION,
  authorisation: GRANT, now: T0 + 50 * 1000, bridgeUp: false });
store = down.store;
console.log('6 admit run #3 while the bridge is down ->', down.code,
  'jobs:', Object.keys(store.jobs).length);
const up = admit(store, { ...runs[2], epoch: 'epoch-A', sessionId: SESSION,
  authorisation: GRANT, now: T0 + 60 * 1000, bridgeUp: true });
store = up.store;
show('7 bridge back: run #3 admitted once', store);

// 4. Invalid authorisation: an expired grant for a fresh run must not create anything.
const expired = admit(store, { runId: 'dd44ee55-ff66-4077-8108-cc9900112233', status: 'completed',
  epoch: 'epoch-A', sessionId: SESSION, now: T0 + 70 * 1000, bridgeUp: true,
  authorisation: { ...GRANT, expiresAt: T0 - 1 } });
store = expired.store;
console.log('8 admit run #4 with an expired grant ->', expired.code,
  'jobs:', Object.keys(store.jobs).length);

// 5. Restart: persist, rebuild from the string, and confirm nothing is lost or duplicated.
const durable = snapshot(store);
const revived = restore(JSON.parse(durable));
show('9 restored from provided JSON snapshot', revived);
const dup = admit(revived, { ...runs[0], epoch: 'epoch-A', sessionId: SESSION,
  authorisation: GRANT, now: T0 + 80 * 1000, bridgeUp: true });
console.log('10 re-admit the acknowledged run ->', dup.code,
  ' dispatchable:', JSON.stringify(dispatchable(dup.store, T0 + 81 * 1000)));
