// T230: does the 100-entry `received` window let an event be consumed twice, and if so, does that reach a page?
//
// The reported risk: `received` is both the display list and the dedupe set, and it keeps only the last 100 entries. An
// event whose acknowledgement keeps failing is re-offered by the host forever; once a hundred newer events have arrived,
// its id is no longer in the window, so the next offer is accepted again.
//
// This file answers the two questions separately, because they have different consequences:
//   * is the event **accepted into storage a second time**? (display, badge, received-review)
//   * does that turn into a **second page delivery**? (the thing a person would notice)
//
// Everything runs against the real modules with an in-memory store and a scripted host. No port, no browser, no page.
import { QueueDelivery } from './extension/lib/queue_delivery.js';
import * as trigger from './extension/lib/terminal_trigger.js';
import { checkFactory } from './test_support_chrome.mjs';

const { check, section, summary } = checkFactory();

function makeStore(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    map,
    async get(defaults) {
      const out = {};
      for (const [k, v] of Object.entries(defaults || {})) out[k] = map.has(k) ? JSON.parse(JSON.stringify(map.get(k))) : v;
      return out;
    },
    async set(items) { for (const [k, v] of Object.entries(items || {})) map.set(k, JSON.parse(JSON.stringify(v))); },
    async remove(k) { map.delete(k); },
    raw(k) { return map.get(k); },
  };
}

let clock = 1_800_000_000_000;
const tick = () => { clock += 1_000; return clock; };

function event(eventId, extra) {
  return Object.assign({
    eventId, name: 'turn_end', runId: 'run-' + eventId, status: 'completed',
    createdAt: '2026-11-04T07:00:00.000Z', message: 'finished', deliverable: false,
  }, extra || {});
}

function makeQueue(store, pages) {
  let index = 0;
  const acks = [];
  const q = new QueueDelivery({
    get: (d) => store.get(d),
    set: (v) => store.set(v),
    now: () => new Date(tick()).toISOString(),
    scheduleRetry: async () => 'retry-alarm',
    clearRetry: async () => {},
    request: async (op, args) => {
      if (op === 'poll') {
        const page = pages[Math.min(index, pages.length - 1)];
        index += 1;
        return page(args);
      }
      if (op === 'ack') { acks.push(args.acked.slice()); return { acked: args.acked.length, newlyAcked: 0 }; }
      throw new Error('unexpected op ' + op);
    },
  });
  return { q, acks, polled: () => index };
}

// ---------------------------------------------------------------- 1: the boundary, exactly
section('T230/1  an event still inside the 100-entry window is refused; the same event after the window slides is not');
{
  const seed = [];
  for (let i = 1; i <= 100; i += 1) seed.push({ eventId: 'e' + i, runId: 'run-e' + i, status: 'completed', receivedAt: 'seed' });
  const store = makeStore({ received: seed, cursor: 100, consumerId: 'dsh-ext-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });

  // The host offers the stuck event (its ack has failed since) together with one new event.
  const { q } = makeQueue(store, [() => ({ events: [event('e1'), event('e101')], cursor: 101, more: false })]);
  const first = await q.poll();
  check(first.ok === true, 'the poll succeeded');
  check(first.added === 1, 'only the new event is added (' + first.added + ')');
  let received = store.raw('received');
  check(received.length === 100, 'the window is still 100 entries (' + received.length + ')');
  check(!received.some((e) => e.eventId === 'e1'), 'and the stuck event has just slid out of it');
  check(received.filter((e) => e.eventId === 'e101').length === 1, 'the new one is at the end');

  // Now the host offers the same stuck event again.
  const { q: q2 } = makeQueue(store, [() => ({ events: [event('e1')], cursor: 102, more: false })]);
  const second = await q2.poll();
  check(second.ok === true, 'the second poll succeeded');
  check(second.added === 1, 'the event is accepted a second time -- the display list has no memory beyond its window ('
    + second.added + ')');
  received = store.raw('received');
  const copies = received.filter((e) => e.eventId === 'e1');
  check(copies.length === 1, 'but it appears once, because the first copy had already aged out (' + copies.length + ')');
  check(copies[0] && copies[0].receivedAt !== 'seed',
    'which is visible in the record: the stored copy is the new one (' + (copies[0] && copies[0].receivedAt) + ')');
}

// ---------------------------------------------------------------- 2: what it must not reach
section('T230/2  the second acceptance does not reach the page: the write barrier is the journal, not the display list');
{
  const RUN = 'c0ffee00-1000-4000-8000-0000000000e1';
  const key = RUN + '|completed';
  const state = {
    version: 1, enabled: true, armedAt: clock - 3_600_000, minIntervalMs: 30_000, maxPerHour: 100,
    windowStartedAt: clock - 3_600_000, windowCount: 1,
    seen: { [key]: { runId: RUN, status: 'completed', state: 'sent', consent: 'running_opt_in',
      origin: 'direct', attemptedAt: clock - 60_000, settledAt: clock - 59_000, reason: null } },
    deferred: {}, preArmCandidateKeys: [],
    armEpoch: '6c2fc3dd-f11b-467d-a2e6-31ee13308297',
    armSnapshotAt: clock - 3_600_000, armSnapshotCount: 80, lastSentAt: clock - 59_000, disabledAt: null,
  };
  const verdict = trigger.admit(state, { runId: RUN, status: 'completed' }, clock);
  check(verdict.admit === false, 'a re-offered run is refused at admission');
  check(verdict.code === 'duplicate_event', 'by name, not silently (' + verdict.code + ')');
  const again = trigger.admit(state, { runId: RUN, status: 'failed' }, clock);
  check(again.admit === false, 'and a different status for the same run does not open a second path (' + again.code + ')');
}

// ---------------------------------------------------------------- 3: the journal cannot be aged out by volume
section('T230/3  the journal refuses at capacity instead of forgetting, so volume cannot reopen a sent run');
{
  const seen = {};
  for (let i = 0; i < trigger.MAX_SEEN_ENTRIES; i += 1) {
    seen['run-' + i + '|completed'] = {
      runId: 'run-' + i, status: 'completed', state: 'sent', consent: 'running_opt_in',
      origin: 'direct', attemptedAt: clock - 1000, settledAt: clock - 900, reason: null,
    };
  }
  const full = {
    version: 1, enabled: true, armedAt: clock - 3_600_000, minIntervalMs: 30_000, maxPerHour: 100,
    windowStartedAt: clock - 3_600_000, windowCount: 0, seen, deferred: {}, preArmCandidateKeys: [],
    armEpoch: '6c2fc3dd-f11b-467d-a2e6-31ee13308297',
    armSnapshotAt: clock - 3_600_000, armSnapshotCount: 0, lastSentAt: null, disabledAt: null,
  };
  const marked = trigger.markAttempt(full, { runId: 'run-new', status: 'completed' }, clock);
  const compacted = trigger.compactJournal(marked.state);
  check(compacted.overflow === true, 'one entry past the bound is reported as an overflow');
  check(compacted.state.lastError === trigger.JOURNAL_OVERFLOW_CODE,
    'and named in the state the popup reads (' + compacted.state.lastError + ')');
  check(compacted.remaining === trigger.MAX_SEEN_ENTRIES + 1,
    'nothing was trimmed to make room (' + compacted.remaining + ')');
  check(compacted.state.seen['run-0|completed'] !== undefined, 'the oldest entry is still there');
  check(compacted.state.enabled === false, 'and the trigger stops rather than forgetting a sent run');
}

// ---------------------------------------------------------------- 4: restart, cursor, consumer
section('T230/4  a restart keeps the cursor and consumer, and the display list is not a delivery record');
{
  const store = makeStore({ cursor: 41, consumerId: 'dsh-ext-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', received: [] });
  const seen = [];
  const { q } = makeQueue(store, [(args) => { seen.push(args); return { events: [], cursor: 41, more: false }; }]);
  await q.poll();
  check(seen[0] && seen[0].cursor === 41, 'polls from the stored cursor (' + (seen[0] && seen[0].cursor) + ')');
  check(seen[0] && seen[0].consumer === 'dsh-ext-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'with the stored consumer id');

  // A fresh instance over the same storage: nothing rewinds, nothing is replayed.
  const { q: q2 } = makeQueue(store, [(args) => ({ events: [], cursor: args.cursor, more: false })]);
  const after = await q2.poll();
  check(after.ok === true && after.added === 0, 'the restarted worker adds nothing');
  check(store.raw('cursor') === 41, 'and the cursor did not move backwards (' + store.raw('cursor') + ')');
}

// ---------------------------------------------------------------- 5: history filtering is separate again
section('T230/5  history and the consent boundary are decided by their own predicates, not by the display list');
{
  const armedAt = clock;
  const state = {
    version: 1, enabled: true, armedAt, minIntervalMs: 30_000, maxPerHour: 100,
    windowStartedAt: armedAt, windowCount: 0, seen: {}, deferred: {}, preArmCandidateKeys: [],
    armEpoch: '6c2fc3dd-f11b-467d-a2e6-31ee13308297',
    armSnapshotAt: armedAt, armSnapshotCount: 0, lastSentAt: null, disabledAt: null,
  };
  // a run that started before the arm cannot be proven to have finished after it
  const startedBefore = trigger.completionAfterArm(state, { runId: 'x', startedAt: (armedAt - 5_000) / 1000 });
  check(startedBefore.proven === false && startedBefore.reason === 'started_before_arm',
    'a run that started before the arm is refused by name (' + startedBefore.reason + ')');
  const startedAfter = trigger.completionAfterArm(state, { runId: 'x', startedAt: armedAt / 1000 });
  check(startedAfter.proven === true, 'a run that started at or after it is proven');
  const noTime = trigger.completionAfterArm(state, { runId: 'x' });
  check(noTime.proven === false && noTime.reason === 'candidate_time_missing',
    'a candidate with no creation time is refused, not assumed fresh (' + noTime.reason + ')');
  const noArm = trigger.completionAfterArm({ armedAt: null }, { startedAt: 1 });
  check(noArm.proven === false && noArm.reason === 'arm_boundary_missing',
    'and no arm boundary is fatal for the candidate (' + noArm.reason + ')');

  // the strict rule: consent must be recorded strictly before the run ended
  const optIn = { runId: 'c0ffee00-1000-4000-8000-0000000000a1', armedAt: armedAt - 1_000, consumedAt: null };
  const ok = trigger.optInUsable(optIn, { runId: optIn.runId, endedAtMs: armedAt }, armedAt + 5_000);
  check(ok.ok === true, 'consent recorded before the end authorises the notice');
  const sameMs = trigger.optInUsable({ armedAt: armedAt, consumedAt: null }, { endedAtMs: armedAt }, armedAt + 5_000);
  check(sameMs.ok === false && sameMs.code === 'opt_in_after_terminal',
    'the same millisecond is refused (' + sameMs.code + ')');
  const unknown = trigger.optInUsable({ armedAt: armedAt - 1_000, consumedAt: null }, { endedAtMs: null }, armedAt + 5_000);
  check(unknown.ok === false && unknown.code === 'terminal_time_unknown',
    'an unreadable terminal instant is refused by name (' + unknown.code + ')');
  const otherRun = trigger.optInUsable(optIn, { runId: 'c0ffee00-1000-4000-8000-0000000000a9', endedAtMs: armedAt },
    armedAt + 5_000);
  check(otherRun.ok === false && otherRun.code === 'opt_in_run_mismatch',
    'and consent for one run does not authorise another (' + otherRun.code + ')');

  // none of this reads the display list: what the popup shows cannot authorise anything
  check(state.seen && Object.keys(state.seen).length === 0,
    'the trigger state was not modified by any of these predicates');
}

const { passed, failed } = summary();
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
