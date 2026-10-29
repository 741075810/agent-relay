// Offline reliability tests for the extension's durable host handoff.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = new URL('./extension/lib/queue_delivery.js', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 't048-queue-'));
const copy = join(dir, 'queue_delivery.mjs');
writeFileSync(copy, readFileSync(source));
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: (await import('node:crypto')).webcrypto,
  });
}
const { QueueDelivery } = await import(pathToFileURL(copy).href);
rmSync(dir, { recursive: true, force: true });

let pass = 0;
let fail = 0;
function check(ok, label) {
  if (ok) {
    pass += 1;
    console.log('  PASS  ' + label);
  } else {
    fail += 1;
    console.log('  FAIL  ' + label);
  }
}
function event(id) {
  return { eventId: id, name: 'task.completed', runId: id,
    status: 'completed', createdAt: '2026-10-22T00:00:00Z',
    message: '[DSH preview] ' + id, replay: true, deliverable: false };
}
function harness(request, initial, consumerId = 'test-consumer') {
  const state = Object.assign({ cursor: 0, received: [], lastError: null, consumerId }, initial || {});
  const log = [];
  const delivery = new QueueDelivery({
    consumerId,
    request: async (op, args) => { log.push(['request', op, args]); return request(op, args); },
    get: async (defaults) => Object.assign({}, defaults, state),
    set: async (values) => { log.push(['set', values]); Object.assign(state, values); },
    now: () => '2026-10-22T00:00:01.000Z',
  });
  return { state, log, delivery };
}

{
  let ackFails = true;
  const h = harness(async (op, args) => {
    if (op === 'poll') return { events: [event('e1')], cursor: 4, more: false };
    if (op === 'ack' && ackFails) { ackFails = false; throw new Error('ack interrupted'); }
    return { newlyAcked: args.acked.length };
  });
  const first = await h.delivery.poll();
  check(!first.ok && h.state.cursor === 0 && h.state.received.length === 1,
        'ack failure preserves local receipt and leaves cursor uncommitted');
  const second = await h.delivery.poll();
  check(second.ok && h.state.cursor === 4 && h.state.received.length === 1,
        'retry deduplicates display, re-acks, then commits cursor');
  check(h.log.filter((x) => x[0] === 'request' && x[1] === 'ack')
        .every((x) => x[2].consumer === 'test-consumer'),
        'poll and ack use the persisted consumer identity');
  check(h.log.filter((x) => x[0] === 'request' && x[1] === 'ack').length === 2,
        'ack is retried after an ambiguous first result');
}

{
  let failCursor = true;
  const state = { cursor: 0, received: [], lastError: null,
    consumerId: 'cursor-test', retryDelayMs: 30000 };
  const order = [];
  const retryPlan = [];
  const retryCallbacks = [];
  let cleared = 0;
  const delivery = new QueueDelivery({
    request: async (op) => {
      order.push(op);
      if (op === 'poll') return { events: [event('e2')], cursor: 9, more: false };
      return { newlyAcked: 1 };
    },
    get: async (defaults) => Object.assign({}, defaults, state),
    set: async (values) => {
      if (values.cursor !== undefined && failCursor) {
        failCursor = false;
        throw new Error('cursor commit failed');
      }
      Object.assign(state, values);
    },
    scheduleRetry: (delay, callback) => {
      retryPlan.push(delay);
      retryCallbacks.push(callback);
      return retryCallbacks.length;
    },
    clearRetry: () => { cleared += 1; },
  });
  const result = await delivery.poll();
  check(!result.ok && state.cursor === 0 && state.received.length === 1,
        'cursor storage failure leaves the cursor uncommitted after receipt');
  check(order.join(',') === 'poll,ack',
        'cursor storage failure happens only after local receipt and host ack');
  check(retryPlan[0] === 30000 && retryPlan.length === 1 && cleared === 0,
        'cursor write failure preserves one pending recovery alarm');
  check(state.retryDelayMs === 60000,
        'the next backoff level is persisted after alarm scheduling');
}

{
  const scheduled = [];
  let cleared = false;
  let failOnce = true;
  const state = { cursor: 0, received: [], consumerId: 'backoff-test',
    retryDelayMs: 30000 };
  const delivery = new QueueDelivery({
    request: async (op) => {
      if (op === 'poll' && failOnce) {
        failOnce = false;
        throw new Error('native host unavailable');
      }
      return { events: [], cursor: state.cursor, more: false };
    },
    get: async (defaults) => Object.assign({}, defaults, state),
    set: async (values) => Object.assign(state, values),
    scheduleRetry: (delay, callback) => {
      scheduled.push({ delay, callback });
      return scheduled.length;
    },
    clearRetry: () => { cleared = true; },
  });
  const result = await delivery.poll();
  if (scheduled[0]) await delivery.retryFromAlarm();
  await delivery._pollTail;
  check(scheduled[0].delay === 30000 && state.lastError === null,
        'retry alarm callback recovers after host failure');
  check(cleared, 'retry alarm removes the persisted retry deadline');
}

{
  let active = 0;
  let maximum = 0;
  const state = { cursor: 0, received: [], lastError: null, consumerId: 'serial-test' };
  const delivery = new QueueDelivery({
    request: async (op) => {
      if (op === 'ack') return { newlyAcked: 0 };
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      const next = state.cursor + 1;
      return { events: [event('multi-' + next)], cursor: next, more: false };
    },
    get: async (defaults) => Object.assign({}, defaults, state),
    set: async (values) => Object.assign(state, values),
  });
  const results = await Promise.all([delivery.poll(), delivery.poll(), delivery.poll()]);
  check(maximum === 1 && results.every((r) => r.ok) && state.cursor === 3,
        'overlapping poll requests serialize and each commits a stable page');
  check(new Set(state.received.map((row) => row.eventId)).size === 3,
        'serialized polls persist each event once');
}

{
  const stateA = { cursor: 0, received: [], lastError: null };
  const stateB = { cursor: 0, received: [], lastError: null };
  const sharedHost = new Map([['shared', event('shared')]]);
  const hostAcks = new Map();
  const requestFor = (state) => async (op, args) => {
    if (op === 'poll') {
      const acked = new Set(hostAcks.get(args.consumer) || []);
      return { events: [...sharedHost.values()].filter((row) => !acked.has(row.eventId)),
        cursor: 1, more: false };
    }
    const acked = new Set(hostAcks.get(args.consumer) || []);
    for (const id of args.acked) acked.add(id);
    hostAcks.set(args.consumer, acked);
    return { newlyAcked: args.acked.length };
  };
  const make = (state, consumerId) => new QueueDelivery({
    consumerId,
    request: requestFor(state),
    get: async (defaults) => Object.assign({}, defaults, state),
    set: async (values) => Object.assign(state, values),
  });
  const a = await make(stateA, 'profile-a').poll();
  const b = await make(stateB, 'profile-b').poll();
  check(a.ok && b.ok && stateA.received.length === 1 && stateB.received.length === 1,
        'independent consumers recover a shared unacked event without duplication');
  check(hostAcks.get('profile-a').has('shared') &&
        hostAcks.get('profile-b').has('shared') && sharedHost.size === 1,
        'independent acks settle while the host retains bounded replay payload');
}

{
  // A lost consumer identity must not inherit the old cursor: events below it
  // were never acknowledged by this consumer and would otherwise never arrive.
  const state = { cursor: 7, received: [], lastError: null, consumerId: null };
  let pollCursor = null;
  const delivery = new QueueDelivery({
    request: async (op, args) => {
      if (op === 'poll') {
        pollCursor = args.cursor;
        return { events: [event('after-lost-id')], cursor: args.cursor + 1, more: false };
      }
      return { newlyAcked: args.acked.length };
    },
    get: async (defaults) => Object.assign({}, defaults, state),
    set: async (values) => Object.assign(state, values),
  });
  const result = await delivery.poll();
  check(result.ok && pollCursor === 0,
        'a fresh consumer identity rewinds an inherited cursor to zero');
  check(/^dsh-ext-[0-9a-f]{32}$/.test(state.consumerId || ''),
        'the rewound poll adopts the new identity in the same commit');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
