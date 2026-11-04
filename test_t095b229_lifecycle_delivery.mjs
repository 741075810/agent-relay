// T229: the delivery queue and the lifecycle hooks, driven by a scripted port.
//
// What this file is for: the two things that turn a working notification path into a confusing one -- the same lifecycle
// event arriving twice (`onInstalled` and `onStartup` can both run in one session, and Chrome may repeat a hook after an
// update), and an alarm that fires long after it was scheduled because the machine was asleep. Both are ordinary; neither
// may produce a second copy of a notice or a lost one.
//
// The port here is scripted, not spawned: nothing in this file starts the native host, reads a real session store, or
// touches a page. The native client's own contract (`{v,id,op,args}` in, `{id,ok,result}` out) is what is spoken.
import { checkFactory, createChrome, flush, RETRY_ALARM, TERMINAL_ALARM, POLL_ALARM } from './test_support_chrome.mjs';

const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);
const { check, section, summary } = checkFactory();

async function loadBackground(tag) {
  const chromeMock = createChrome();
  globalThis.chrome = chromeMock.api;
  const bg = await mod('./extension/background.js?t229=' + tag);
  return { chromeMock, bg };
}

// A port that answers from a table of op -> function(args) -> result. Every request is recorded, so "was polled twice"
// is observable rather than inferred.
function scriptPort(chromeMock, handlers) {
  const requests = [];
  const port = {
    onMessage: { listeners: [], addListener(fn) { this.listeners.push(fn); } },
    onDisconnect: { listeners: [], addListener(fn) { this.listeners.push(fn); } },
    postMessage(doc) {
      requests.push({ op: doc.op, args: doc.args, id: doc.id });
      const handler = handlers[doc.op];
      const reply = (payload) => {
        for (const fn of port.onMessage.listeners) fn(Object.assign({ id: doc.id }, payload));
      };
      // Async on purpose: a synchronous reply would hide ordering bugs the real host cannot produce.
      queueMicrotask(() => {
        if (!handler) { reply({ ok: false, error: { code: 'unknown_op', message: doc.op } }); return; }
        try { reply({ ok: true, result: handler(doc.args || {}) }); }
        catch (err) { reply({ ok: false, error: { code: 'host_error', message: String(err.message || err) } }); }
      });
    },
    disconnect() {},
  };
  chromeMock.api.runtime.connectNative = (name) => {
    chromeMock.hostCalls.push(name);
    return port;
  };
  return { requests, port };
}

function page(events, cursor, more) {
  return { events, cursor, more: more === true };
}

function event(eventId, runId) {
  return {
    eventId, name: 'turn_end', runId: runId || eventId, status: 'completed',
    createdAt: '2026-11-04T07:00:00.000Z', message: 'run finished', deliverable: false,
  };
}

// ---------------------------------------------------------------- 1: the same page twice
section('T229/1  the host re-offering the same page stores each event once and acknowledges idempotently');
{
  const { chromeMock } = await loadBackground('1');
  const { requests } = scriptPort(chromeMock, {
    poll: () => page([event('e1'), event('e2')], 2, false),
    ack: () => ({ acked: true }),
  });
  await chromeMock.onInstalled.fire({ reason: 'update' });
  await flush(8);
  await chromeMock.onAlarm.fire({ name: POLL_ALARM });
  await flush(8);
  await chromeMock.onAlarm.fire({ name: POLL_ALARM });
  await flush(8);

  const received = chromeMock.stores.local.get('received') || [];
  check(received.length === 2, 'two events stored, not four (' + received.length + ')');
  check(new Set(received.map((e) => e.eventId)).size === received.length, 'no duplicate eventId in the store');
  const polls = requests.filter((r) => r.op === 'poll').length;
  check(polls >= 2, 'the page was actually fetched twice (' + polls + ')');
  const acks = requests.filter((r) => r.op === 'ack');
  check(acks.length >= 2 && acks[acks.length - 1].args.acked.join(',') === 'e1,e2',
    'the second page is acknowledged too, so the host stops re-offering it ('
    + JSON.stringify(acks[acks.length - 1] && acks[acks.length - 1].args) + ')');
  check(chromeMock.stores.local.get('cursor') === 2, 'the cursor only moves forward (' + chromeMock.stores.local.get('cursor') + ')');
}

// ---------------------------------------------------------------- 2: both lifecycle hooks in one session
section('T229/2  onStartup and onInstalled in the same session do not double-deliver');
{
  const { chromeMock } = await loadBackground('2');
  let served = 0;
  const { requests } = scriptPort(chromeMock, {
    poll: () => { served += 1; return page(served === 1 ? [event('e1')] : [], 1, false); },
    ack: () => ({ acked: true }),
  });
  chromeMock.stores.local.set('retryAt', Date.now() - 60_000);
  await Promise.all([chromeMock.onStartup.fire(), chromeMock.onInstalled.fire({ reason: 'update' })]);
  await flush(10);

  const received = chromeMock.stores.local.get('received') || [];
  check(received.length === 1, 'one event stored although two hooks fired (' + received.length + ')');
  check(!chromeMock.alarmTable.get(RETRY_ALARM), 'the retry alarm is not left behind by the second hook');
  check(!chromeMock.stores.local.has('retryAt'), 'and neither is the stale instant');
  check(requests.filter((r) => r.op === 'poll').length >= 1, 'the queue was polled');
}

// ---------------------------------------------------------------- 3: an alarm that fires hours late
section('T229/3  an alarm that fires hours after it was scheduled still does its job, once');
{
  const { chromeMock } = await loadBackground('3');
  const { requests } = scriptPort(chromeMock, {
    poll: () => page([event('late-1')], 1, false),
    ack: () => ({ acked: true }),
  });
  // six hours late, as if the machine had been asleep
  chromeMock.stores.local.set('retryAt', Date.now() - 6 * 3600 * 1000);
  await chromeMock.onAlarm.fire({ name: RETRY_ALARM });
  await flush(8);
  const received = chromeMock.stores.local.get('received') || [];
  check(received.length === 1, 'the overdue delivery is taken now, not dropped (' + received.length + ')');
  check(!chromeMock.stores.local.has('retryAt'), 'the stale instant is cleared rather than kept as a promise');
  check(requests.some((r) => r.op === 'poll'), 'a poll really happened');
}

// ---------------------------------------------------------------- 4: persisted delivery state across a restart
section('T229/4  a restart continues from the stored cursor and keeps the consumer identity');
{
  const first = await loadBackground('4a');
  const consumer = 'dsh-ext-0123456789abcdef0123456789abcdef';
  first.chromeMock.stores.local.set('cursor', 7);
  first.chromeMock.stores.local.set('consumerId', consumer);
  scriptPort(first.chromeMock, { poll: (args) => page([], args.cursor, false), ack: () => ({ acked: true }) });
  await first.chromeMock.onInstalled.fire({ reason: 'update' });
  await flush(8);
  await first.chromeMock.onAlarm.fire({ name: POLL_ALARM });
  await flush(8);
  const polled = [];

  // a fresh worker: same storage, new module instance
  const second = await loadBackground('4b');
  for (const [k, v] of first.chromeMock.stores.local.entries()) second.chromeMock.stores.local.set(k, v);
  const { requests } = scriptPort(second.chromeMock, {
    poll: (a) => { polled.push(a); return page([], a.cursor, false); },
    ack: () => ({ acked: true }),
  });
  await second.chromeMock.onInstalled.fire({ reason: 'update' });
  await flush(8);
  await second.chromeMock.onAlarm.fire({ name: POLL_ALARM });
  await flush(8);
  check(polled.length >= 1, 'the restarted worker polls at all (' + polled.length + ')');
  check(polled[0] && polled[0].cursor === 7,
    'from the stored cursor, not from zero (' + JSON.stringify(polled[0] && polled[0].cursor) + ')');
  check(polled[0] && polled[0].consumer === consumer,
    'with the same consumer id, so the host does not resend what it already acknowledged ('
    + (polled[0] && polled[0].consumer) + ')');
  check(requests.length >= 1, 'the requests reached the scripted port');
}

// ---------------------------------------------------------------- 5: the terminal tick on a late alarm
section('T229/5  a late terminal tick with nothing to send contacts no page');
{
  const { chromeMock } = await loadBackground('5');
  chromeMock.stores.local.set('terminalTrigger', {
    version: 1, enabled: true, armedAt: Date.now() - 6 * 3600 * 1000,
    minIntervalMs: 30000, maxPerHour: 100, windowStartedAt: Date.now() - 6 * 3600 * 1000,
    windowCount: 0, seen: {}, deferred: {}, preArmCandidateKeys: [],
    armEpoch: '6c2fc3dd-f11b-467d-a2e6-31ee13308297',
    armSnapshotAt: Date.now() - 6 * 3600 * 1000, armSnapshotCount: 0,
    lastSentAt: null, disabledAt: null,
  });
  chromeMock.stores.local.set('terminalCandidates', []);
  scriptPort(chromeMock, { poll: () => page([], 0, false), ack: () => ({ acked: true }) });
  await chromeMock.onAlarm.fire({ name: TERMINAL_ALARM });
  await flush(8);
  check(chromeMock.tabMessages.length === 0, 'no page was written to');
  const stored = chromeMock.stores.local.get('terminalTrigger');
  check(stored && stored.enabled === true, 'the arm survives a tick with nothing to do');
  check(stored && stored.armEpoch === '6c2fc3dd-f11b-467d-a2e6-31ee13308297', 'and the epoch is unchanged');
}

const { passed, failed } = summary();
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
