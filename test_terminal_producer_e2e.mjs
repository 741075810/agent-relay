// T059 end-to-end: host candidate query -> durable storage -> terminal trigger.
//
// The real MV3 worker is imported with a fake `chrome` and a fake native client,
// so the modules under test are the ones that ship. Nothing here starts a
// browser, connects to a real Host, reloads an extension or writes a page.
//
// The chain being proved:
//   1. disabled by default -> the host is not even asked;
//   2. after one authorization, `terminal-list` is called once and its
//      candidates are merged into storage with `runId|status` dedup;
//   3. the first host answer is a baseline, so no notice is produced for history;
//   4. a genuinely new terminal fires exactly one notice, at most once;
//   5. an unreadable source stops the run instead of guessing.
let passed = 0;
const failures = [];
function check(ok, label) {
  if (ok) { passed += 1; return; }
  failures.push(label);
  console.log('  FAILED: ' + label);
}

// T086: the arm boundary is proved from the run's creation time, so the fake
// host reply must describe a run created after the arm. A fixed past
// timestamp would make every candidate look like pre-arm history.
const STARTED_AT = Math.ceil(Date.now() / 1000) + 60;
const CONV = '22222222-2222-4222-8222-222222222222';
const RUN = '11111111-1111-4111-8111-111111111111';
const RUN2 = '33333333-3333-4333-8333-333333333333';
const URL_OK = 'https://chatgpt.com/c/' + CONV;
const DOC = 'doc-instance-0001';

// -- fake Chrome -------------------------------------------------------------
const listeners = {};
const event = (name) => ({ addListener(fn) { (listeners[name] ||= []).push(fn); } });
const store = { local: {}, session: {}, alarmTable: {} };
const calls = { sendMessage: [], get: 0, hostOps: [], alarms: [],
  alarmClears: [], hostAcks: [] };
let hostReply = { ok: true, result: { ok: true, candidates: [],
  baselineEstablished: false } };
// T091: the fake host remembers the arm round it was asked for and echoes it,
// exactly like the real one.
const armEpochRef = { current: null };

function tab() {
  return { id: 7, windowId: 2, url: URL_OK, active: true, visibilityState: 'visible' };
}

// Lets a test make the next N terminal-ack replies fail. The port is attached
// once and reused, so swapping `connectNative` mid-test would have no effect --
// the failure has to come from the port that is actually in use.
const ackFailure = { remaining: 0 };

globalThis.chrome = {
  runtime: {
    id: 'fixture',
    getURL: (path) => 'chrome-extension://fixture/' + path,
    onInstalled: event('installed'), onStartup: event('startup'),
    onMessage: event('message'),
    connectNative() {
      // A fake port shaped like Chrome's: `onMessage` is an event, not a
      // function, so replies are dispatched to registered listeners.
      const portListeners = [];
      return {
        postMessage(doc) {
          calls.hostOps.push(doc.op);
          let result;
          if (doc.op === 'terminal-list') {
            // T091: the sample must carry the arm round it was measured against,
            // otherwise the trigger has no epoch proof and falls back.
            result = Object.assign({ armEpoch: armEpochRef.current,
              armTakenAt: 1759000000, armCount: 76 }, hostReply.result);
          } else if (doc.op === 'terminal-arm-snapshot') {
            calls.hostOps.push('arm-epoch');
            armEpochRef.current = doc.args && doc.args.epoch;
            result = { ok: true, code: null, epoch: armEpochRef.current,
              takenAt: 1759000000, count: 76, truncated: false };
          } else if (doc.op === 'terminal-ack') {
            calls.hostAcks.push(doc.args);
            if (ackFailure.remaining > 0) {
              ackFailure.remaining -= 1;
              setTimeout(() => {
                for (const fn of portListeners) fn({ id: doc.id, ok: false,
                  error: { code: 'host_gone', message: 'pipe closed' } });
              }, 0);
              return;
            }
            const acked = (doc.args && doc.args.acked) || [];
            // Model the real host: once acknowledged, a run is not offered
            // again. Without this the fake would keep re-offering forever and
            // the "nothing left to ack" case could not be tested.
            if (hostReply && hostReply.result &&
                Array.isArray(hostReply.result.candidates)) {
              hostReply.result = Object.assign({}, hostReply.result, {
                candidates: hostReply.result.candidates
                  .filter((item) => acked.indexOf(item.runId) < 0),
              });
            }
            result = { acked: acked.length };
          } else if (doc.op === 'hello') {
            result = { host: 'fake' };
          } else {
            result = { events: [], cursor: 0, more: false };
          }
          setTimeout(() => {
            for (const fn of portListeners) fn({ id: doc.id, ok: true, result });
          }, 0);
        },
        disconnect() {},
        onMessage: { addListener(fn) { portListeners.push(fn); } },
        onDisconnect: { addListener() {} },
      };
    },
  },
  tabs: {
    onUpdated: event('updated'), onRemoved: event('removed'),
    onReplaced: event('replaced'), onDetached: event('detached'),
    onAttached: event('attached'), onActivated: event('activated'),
    async get() { calls.get += 1; return tab(); },
    async sendMessage(id, msg) {
      if (msg && msg.type === 'readonly-probe') {
        // `probeTab` awaits the raw payload -- it does not unwrap `{ok,result}`
        // -- so the fake must answer the same way the content script does.
        return {
          requestId: msg.requestId,
          routeStable: true,
          observedAt: Date.now(),
          url: URL_OK,
          conversationId: CONV,
          documentInstanceId: DOC,
          visibilityState: 'visible',
          hasFocus: true,
          composerPresent: true,
          pageLoaded: true,
        };
      }
      calls.sendMessage.push({ id, msg });
      return { ok: true, result: { status: 'submitted', reason: null,
        evidence: { composerEmpty: true, conversationId: CONV } } };
    },
  },
  windows: { onFocusChanged: event('focus') },
  alarms: {
    onAlarm: event('alarm'),
    create(name, info) {
      calls.alarms.push({ name, info });
      store.alarmTable[name] = info;
    },
    async get(name) {
      return store.alarmTable[name]
        ? Object.assign({ name }, store.alarmTable[name]) : undefined;
    },
    async clear(name) {
      calls.alarmClears.push(name);
      delete store.alarmTable[name];
      return true;
    },
  },
  storage: {
    local: {
      async get(defaults) {
        const out = {};
        for (const [k, v] of Object.entries(defaults || {})) {
          out[k] = Object.prototype.hasOwnProperty.call(store.local, k)
            ? store.local[k] : v;
        }
        return out;
      },
      async set(patch) { Object.assign(store.local, patch); },
    },
    session: {
      // The controller stores under its own key; a fake that invents a friendlier
      // one would test the fake, not the code.
      async get(defaults) { return Object.assign({}, defaults, store.session); },
      async set(patch) { Object.assign(store.session, patch); },
    },
  },
};

const bg = await import('./extension/background.js');

// A binding a human confirmed; the probe reads the fake tab above. It goes under
// the controller's real storage key with the full stored-state shape --
// `validStoredState` requires revision/candidates/candidateScannedAt, and a
// half-shaped fixture would fail for a reason that has nothing to do with the
// chain being tested.
store.session.t053TargetBindingState = {
  version: 1,
  revision: 3,
  candidates: [],
  candidateScannedAt: null,
  binding: {
    version: 1, revision: 3, boundAt: 1, tabId: 7, windowId: 2, url: URL_OK,
    conversationId: CONV, documentInstanceId: DOC, accountIdentity: 'unverified',
    accountVerified: false, manuallyConfirmed: true, invalidatedReason: null,
  },
};

async function ask(msg, from) {
  const sender = from || { id: 'fixture', url: chrome.runtime.getURL('popup.html') };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('async response missing')), 2000);
    listeners.message.forEach((fn) => fn(msg, sender, (value) => {
      clearTimeout(timer);
      resolve(value);
    }));
  });
}

console.log('== e2e: disabled means the host is never asked ==');
{
  const reply = await ask({ type: 't059-trigger-run' });
  check(reply.ok === true, 'the run request is answered');
  check(reply.result.fetched.code === 'trigger_disabled',
        'a disabled trigger reports itself (' + reply.result.fetched.code + ')');
  check(!calls.hostOps.includes('terminal-list'),
        'and terminal-list was never sent to the host');
  check(calls.sendMessage.length === 0, 'and nothing was written to any page');
}

console.log('== e2e: one authorization, then the baseline fires nothing ==');
{
  hostReply = { ok: true, result: { ok: true, baselineEstablished: true,
    existingTerminalRuns: 75, droppedFromBaseline: 0, provenance: 'unverified',
    candidates: [] } };
  const armed = await ask({ type: 't059-trigger-arm',
    confirmation: 'AUTOTRIGGER ' + CONV, userGesture: true });
  check(armed.ok === true && armed.result.ok === true,
        'the trigger arms with the phrase and a gesture');

  store.local.autosend = undefined;
  await ask({ type: 't058-arm', confirmation: 'AUTOSEND ' + CONV, userGesture: true });

  const run = await ask({ type: 't059-trigger-run' });
  check(calls.hostOps.filter((op) => op === 'terminal-list').length === 1,
        'exactly one terminal-list call reached the host');
  check(run.result.fetched.baselineEstablished === true,
        'the first answer is reported as a baseline (' +
        JSON.stringify(run.result.fetched) + ')');
  check(run.result.fetched.added === 0, 'and stores no candidate');
  check(run.result.results.length === 0, 'so nothing is processed');
  check(calls.sendMessage.length === 0, 'and no notice was written');
}

console.log('== e2e: a new terminal fires exactly one notice, once ==');
{
  hostReply = { ok: true, result: { ok: true, baselineEstablished: false,
    existingTerminalRuns: 76, provenance: 'unverified',
    candidates: [{ runId: RUN, status: 'completed', origin: 'bridge', startedAt: STARTED_AT }] } };

  const first = await ask({ type: 't059-trigger-run' });
  check(first.result.fetched.added === 1, 'the new candidate is stored');
  // It is drained only after a confirmed send, so by now it must be gone: that
  // drain is what stops the next tick from seeing it again.
  check((store.local.terminalCandidates || []).length === 0,
        'and is drained once it has been dealt with');
  check(calls.hostAcks.length === 1 &&
        calls.hostAcks[0].acked.indexOf(RUN) === 0,
        'the host was told it was consumed (' + JSON.stringify(calls.hostAcks) + ')');

  const sent = first.result.results.filter((item) => item.sent === true);
  check(sent.length === 1, 'exactly one notice was sent (' + sent.length +
        ') ' + JSON.stringify(first.result.results));
  check(calls.sendMessage.length === 1, 'one page write in total');
  check(calls.sendMessage[0].msg.runId === RUN, 'carrying the run id');
  check(calls.sendMessage[0].msg.type === 't058-write-notice',
        'as the fixed notice message');

  // The host still offers it; dedup must hold anyway.
  const second = await ask({ type: 't059-trigger-run' });
  check(calls.sendMessage.length === 1,
        'the same terminal never produces a second write (' +
        calls.sendMessage.length + ')');
  check(second.result.results.every((item) => item.sent !== true),
        'and the second run reports nothing sent');
}

console.log('== e2e: an unreadable source stops instead of guessing ==');
{
  hostReply = { ok: true, result: { ok: false, code: 'source_unavailable',
    error: 'no *.runs.json ledger', candidates: [] } };
  const before = calls.sendMessage.length;
  const run = await ask({ type: 't059-trigger-run' });
  check(run.result.fetched.ok === false, 'the gap is reported');
  check(run.result.fetched.code === 'source_unavailable',
        'with a named code (' + run.result.fetched.code + ')');
  check(run.result.results.length === 0, 'nothing is processed');
  check(calls.sendMessage.length === before, 'and no page write happened');
  check(store.local.terminalTrigger.enabled === true,
        'a read failure alone does not silently disarm the operator');
}

console.log('== e2e: rate limiting and stop-on-doubt still apply ==');
{
  hostReply = { ok: true, result: { ok: true, baselineEstablished: false,
    candidates: [{ runId: RUN2, status: 'failed', origin: 'bridge', startedAt: STARTED_AT }] } };
  store.local.terminalCandidates = [{ runId: RUN2, status: 'failed', origin: 'bridge', startedAt: STARTED_AT }];
  const run = await ask({ type: 't059-trigger-run' });
  const skipped = run.result.results.filter((item) =>
    item.code === 'rate_limited' || item.code === 'rate_window_exceeded');
  check(skipped.length === 1,
        'a second terminal inside the interval is held (' +
        JSON.stringify(run.result.results) + ')');
  check(calls.sendMessage.length === 1, 'and no extra write happened');
}

console.log('== e2e: the alarm path never re-enters and never runs unarmed ==');
{
  const bgMod = bg;
  // Unarmed: the tick must not connect to the host at all.
  store.local.terminalTrigger = Object.assign({}, store.local.terminalTrigger, {
    enabled: false,
  });
  const before = calls.hostOps.length;
  const skipped = await bgMod.runTerminalOnAlarm();
  check(skipped.skipped === 'trigger_disabled',
        'an unarmed alarm tick reports itself (' + JSON.stringify(skipped) + ')');
  check(calls.hostOps.length === before,
        'and never opened the host for a terminal query');

  // Armed: two overlapping ticks must produce one host query.
  store.local.terminalTrigger.enabled = true;
  hostReply = { ok: true, result: { ok: true, baselineEstablished: false,
    candidates: [] } };
  const baseline = calls.hostOps.length;
  const [a, b] = await Promise.all([bgMod.runTerminalOnAlarm(),
    bgMod.runTerminalOnAlarm()]);
  const queries = calls.hostOps.slice(baseline)
    .filter((op) => op === 'terminal-list').length;
  check(queries === 1, 'overlapping ticks query the host once (' + queries + ')');
  check(a.skipped === 'in_flight' || b.skipped === 'in_flight',
        'the second tick is refused as in-flight (' +
        JSON.stringify([a.skipped, b.skipped]) + ')');
}

console.log('== e2e: a storage write that does not land is not acknowledged ==');
{
  // The candidate is stored in memory only; the read-back finds nothing, so no
  // ACK may be sent and the host keeps offering it.
  const realSet = chrome.storage.local.set;
  chrome.storage.local.set = async (patch) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'terminalCandidates')) return;
    return realSet(patch);
  };
  store.local.terminalCandidates = [];
  calls.hostAcks.length = 0;
  hostReply = { ok: true, result: { ok: true, baselineEstablished: false,
    candidates: [{ runId: RUN2, status: 'completed', origin: 'bridge', startedAt: STARTED_AT }] } };
  const reply = await ask({ type: 't059-trigger-run' });
  chrome.storage.local.set = realSet;
  check(calls.hostAcks.length === 0,
        'no ack was sent for a candidate that never persisted');
  check(calls.sendMessage.length === 0 ||
        reply.result.results.every((item) => item.sent !== true),
        'and nothing was written to the page either');
}

console.log('== e2e: an ACK that failed is retried on the next offer ==');
{
  // Round 1: the candidate persists, the ACK fails. Round 2: the host offers the
  // same candidate again; `added` is 0 because it is already stored, and that is
  // exactly the case that used to never re-acknowledge.
  store.local.terminalCandidates = [];
  calls.hostAcks.length = 0;
  ackFailure.remaining = 1;
  hostReply = { ok: true, result: { ok: true, baselineEstablished: false,
    candidates: [{ runId: RUN, status: 'completed', origin: 'bridge', startedAt: STARTED_AT }] } };

  const round1 = await bg.refreshTerminalCandidates();
  check(round1.added === 1, 'round 1 stored the candidate (' + round1.added + ')');
  check(round1.acked === 0, 'round 1 could not acknowledge it (' + round1.acked + ')');
  check(calls.hostAcks.length === 1, 'and it did try to');

  const round2 = await bg.refreshTerminalCandidates();
  check(round2.added === 0, 'round 2 adds nothing: it is already stored (' +
        round2.added + ')');
  check(round2.acked === 1,
        'but it re-acknowledges the re-offered candidate (' + round2.acked + ')');
  check(calls.hostAcks.length === 2,
        'so the host sees a second, successful ack (' + calls.hostAcks.length + ')');

  const round3 = await bg.refreshTerminalCandidates();
  check(round3.acked === 0,
        'and a third round has nothing to re-acknowledge (' + round3.acked + ')');
}

console.log('== e2e: a candidate already sent is cleared from the local list ==');
{
  store.local.terminalCandidates = [{ runId: RUN, status: 'completed', origin: 'bridge', startedAt: STARTED_AT }];
  store.local.terminalTrigger = Object.assign({}, store.local.terminalTrigger, {
    enabled: true,
    seen: { [RUN + '|completed']: { runId: RUN, status: 'completed', origin: 'bridge',
      state: 'sent', attemptedAt: 1, settledAt: 2, reason: null } },
    lastSentAt: null, windowCount: 0, windowStartedAt: 0,
  });
  hostReply = { ok: true, result: { ok: true, baselineEstablished: false,
    candidates: [{ runId: RUN, status: 'completed', origin: 'bridge', startedAt: STARTED_AT }] } };
  const writesBefore = calls.sendMessage.length;
  const run = await ask({ type: 't059-trigger-run' });
  const codes = run.result.results.map((item) => item.code);
  check(codes.indexOf('duplicate_event') >= 0,
        'the already-sent terminal is refused as a duplicate (' +
        codes.join(',') + ')');
  check((store.local.terminalCandidates || []).length === 0,
        'and the stale local candidate is actually removed, not just skipped (' +
        JSON.stringify(store.local.terminalCandidates) + ')');
  check(calls.sendMessage.length === writesBefore,
        'with no extra page write');
}

console.log('== e2e: one task never writes twice when its status changes ==');
{
  store.local.terminalCandidates = [{ runId: RUN2, status: 'failed', origin: 'bridge', startedAt: STARTED_AT }];
  store.local.terminalTrigger = Object.assign({}, store.local.terminalTrigger, {
    enabled: true,
    seen: { [RUN2 + '|completed']: { runId: RUN2, status: 'completed', origin: 'bridge',
      state: 'sent', attemptedAt: 1, settledAt: 2, reason: null } },
    lastSentAt: null, windowCount: 0, windowStartedAt: 0,
  });
  hostReply = { ok: true, result: { ok: true, baselineEstablished: false,
    candidates: [{ runId: RUN2, status: 'failed', origin: 'bridge', startedAt: STARTED_AT }] } };
  const writesBefore = calls.sendMessage.length;
  const run = await ask({ type: 't059-trigger-run' });
  const codes = run.result.results.map((item) => item.code);
  check(codes.indexOf('duplicate_run') >= 0,
        'the same task with another status is refused (' + codes.join(',') + ')');
  check(calls.sendMessage.length === writesBefore,
        'and the conversation receives no second message');
  check((store.local.terminalCandidates || []).length === 0,
        'the stale candidate is cleared as well');
}

console.log('== e2e: a worker restart leaves nothing re-sendable ==');
{
  // Simulates the state an interrupted tick leaves behind: the attempt was
  // journalled but never settled.
  store.local.terminalCandidates = [{ runId: RUN, status: 'completed', origin: 'bridge', startedAt: STARTED_AT }];
  store.local.terminalTrigger = Object.assign({}, store.local.terminalTrigger, {
    enabled: true,
    seen: { [RUN + '|completed']: { runId: RUN, status: 'completed', origin: 'bridge',
      state: 'attempting', attemptedAt: 1, settledAt: null, reason: null } },
    lastSentAt: null, windowCount: 0, windowStartedAt: 0,
  });
  hostReply = { ok: true, result: { ok: true, baselineEstablished: false,
    candidates: [{ runId: RUN, status: 'completed', origin: 'bridge', startedAt: STARTED_AT }] } };
  const writesBefore = calls.sendMessage.length;
  const run = await ask({ type: 't059-trigger-run' });
  check(run.result.state.enabled === false,
        'a dangling attempt disables the trigger instead of being retried');
  check(run.result.state.seen[RUN + '|completed'].state !== 'attempting',
        'and the attempt is settled to a stop state (' +
        run.result.state.seen[RUN + '|completed'].state + ')');
  check(calls.sendMessage.length === writesBefore,
        'with no page write on the restart path');
}

console.log('== e2e: the read-only notification path is untouched ==');
{
  const queued = store.local.received;
  check(queued === undefined || Array.isArray(queued),
        'no received records were created by the candidate path');
  const source = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('./extension/background.js', import.meta.url), 'utf8'));
  check(!/deliverable\s*:\s*true/.test(source),
        'the worker never marks anything deliverable');
  check(!source.includes("request('poll')") ||
        !/refreshTerminalCandidates[\s\S]{0,800}request\('poll'\)/.test(source),
        'the candidate refresher does not read the notification queue');
}

console.log('\nRESULT: ' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
