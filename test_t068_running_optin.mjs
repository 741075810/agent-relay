// T068: the extension half of "decide before the task ends".
//
// Three things are checked here and nothing else is allowed to soften them:
//
//   * a running opt-in has no 30-minute TTL -- a six-hour task must still keep the
//     choice the operator made at minute two;
//   * it can only authorise the turn it names, and only if it was recorded before
//     that turn's own terminal moment;
//   * it still passes through the same `admit()` gate as everything else, so pacing,
//     the hourly ceiling and the dedup journal are untouched by this feature.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// The extension's modules are plain `.js` under a Chrome context, so node will not
// load them as ESM directly. Same trick as the other suites: copy them out as `.mjs`
// and rewrite the intra-module specifiers.
const dir = mkdtempSync(join(tmpdir(), 't068-optin-'));
writeFileSync(join(dir, 'autosend.mjs'),
  readFileSync(new URL('./extension/lib/autosend.js', import.meta.url), 'utf8'));
writeFileSync(join(dir, 'terminal_trigger.mjs'),
  readFileSync(new URL('./extension/lib/terminal_trigger.js', import.meta.url), 'utf8')
    .replace(/from '\.\/([a-z_]+)\.js'/g, "from './$1.mjs'"));
const T = await import(pathToFileURL(join(dir, 'terminal_trigger.mjs')).href);

const S1 = 'session-11111111-2222-4333-8444-555555555555';
const S2 = 'session-99999999-8888-4777-8666-555555555555';
const RUN = '11111111-1111-4111-8111-111111111111';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function armedTrigger(now = 1000) {
  const result = T.configure(T.createTriggerState(), {
    binding: { manuallyConfirmed: true, conversationId: 'conv' },
  }, T.CONFIRM_PREFIX + 'conv', true, now);
  return result.state;
}

function directCandidate(extra = {}) {
  // T069: a candidate carries both forms, and `endedAt` is the one floored from the
  // other -- exactly as `terminal_source` emits them. Tests that mean "the end time is
  // unknown" have to say so explicitly, because that is now a distinct refusal.
  return Object.assign({
    runId: RUN, status: 'completed', origin: T.ORIGIN_DIRECT,
    nativeSession: S1, nativeTurn: 7,
    endedAtMs: 5_000_000_000, endedAt: 5_000_000,
  }, extra);
}

test('an opt-in survives far longer than the candidate TTL', () => {
  const armedAt = 1000;
  const state = T.armRunning(T.createOptInState(), S1, 7, armedAt).state;
  // Six hours later -- twenty times the T067 TTL -- the task finishes.
  const later = armedAt + 6 * HOUR;
  const candidate = directCandidate({ endedAtMs: later + 60_000,
    endedAt: Math.floor((later + 60_000) / 1000) });
  const entry = T.optInFor(state, candidate);
  assert.ok(entry, 'the opt-in must still be there after six hours');
  const usable = T.optInUsable(entry, candidate, later);
  assert.equal(usable.ok, true, 'six-hour task must keep its opt-in');
  assert.equal(usable.armedAt, armedAt);
});

test('a running opt-in lets admit() through while the two-hour mark is passed', () => {
  const state = armedTrigger(1000);
  const now = 1000 + 2 * HOUR;
  const verdict = T.admit(state, directCandidate({ runningArmedAt: 1000 }), now);
  assert.equal(verdict.admit, true);
  // `admit` reports the channel only on refusals, so the positive case is proven by
  // the key it returns rather than by an `origin` field that is not there.
  assert.equal(verdict.key, T.key(RUN, 'completed'));
});

test('a candidate-only opt-in still expires at thirty minutes', () => {
  const state = armedTrigger(1000);
  const expired = T.admit(state,
    directCandidate({ directArmedAt: 1000, runningArmedAt: undefined }),
    1000 + T.DIRECT_OPTIN_TTL_MS + 1);
  assert.equal(expired.admit, false);
  assert.equal(expired.code, 'direct_optin_expired');
});

test('a bridge run needs no opt-in and is never gated by this', () => {
  const state = armedTrigger(1000);
  const verdict = T.admit(state,
    { runId: RUN, status: 'completed', origin: T.ORIGIN_BRIDGE }, 2000);
  assert.equal(verdict.admit, true);
});

test('an opt-in cannot authorise a turn that already ended before it', () => {
  const state = T.armRunning(T.createOptInState(), S1, 7, 10_000).state;
  const candidate = directCandidate({ endedAtMs: 9_000, endedAt: 9 });
  const usable = T.optInUsable(T.optInFor(state, candidate), candidate, 20_000);
  assert.equal(usable.ok, false);
  assert.equal(usable.code, 'opt_in_after_terminal');
});

test('an opt-in with no provable end time fails closed', () => {
  const state = T.armRunning(T.createOptInState(), S1, 7, 10_000).state;
  // T069: a floored second is not a provable end time any more. Feeding only the old
  // field is the shape a pre-T069 stored candidate has, and re-deriving milliseconds
  // from it is precisely the guess that produced the defect.
  const candidate = directCandidate({ endedAtMs: undefined });
  const usable = T.optInUsable(T.optInFor(state, candidate), candidate, 20_000);
  assert.equal(usable.ok, false);
  assert.equal(usable.code, 'terminal_time_unknown');
});

test('a click in the same second, before the end, authorises the notice', () => {
  // Same truncated second, click genuinely earlier. T068 got this right by accident
  // (it compared against the end of the second); T069 gets it right on the real
  // instant, which is the only way the mirror case below can also be right.
  const armedAt = 1_700_000_000_600;                  // .600 of that second
  const state = T.armRunning(T.createOptInState(), S1, 7, armedAt).state;
  const candidate = directCandidate({ endedAtMs: 1_700_000_000_900,   // .900
    endedAt: 1_700_000_000 });
  const usable = T.optInUsable(T.optInFor(state, candidate), candidate,
    armedAt + 5000);
  assert.equal(usable.ok, true, 'a click 300 ms before the end must be honoured');
  assert.equal(usable.endedAtMs, 1_700_000_000_900);
});

test('a click a full second after the end is still refused', () => {
  const endedSecond = 1_700_000_000;
  const state = T.armRunning(T.createOptInState(), S1, 7,
    (endedSecond + 1) * 1000).state;
  const candidate = directCandidate({ endedAtMs: endedSecond * 1000 + 400,
    endedAt: endedSecond });
  const usable = T.optInUsable(T.optInFor(state, candidate), candidate,
    (endedSecond + 30) * 1000);
  assert.equal(usable.ok, false);
  assert.equal(usable.code, 'opt_in_after_terminal');
});

test('an opt-in names exactly one turn and does not leak to another', () => {
  const state = T.armRunning(T.createOptInState(), S1, 7, 1000).state;
  const otherTurn = directCandidate({ nativeTurn: 8 });
  const otherSession = directCandidate({ nativeSession: S2 });
  assert.equal(T.optInFor(state, otherTurn), null);
  assert.equal(T.optInFor(state, otherSession), null);
});

test('arming twice is refused rather than silently moved', () => {
  const first = T.armRunning(T.createOptInState(), S1, 7, 1000);
  assert.equal(first.ok, true);
  const second = T.armRunning(first.state, S1, 7, 2000);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'already_opted_in');
  // The original instant survives, which is what keeps the "before the end" proof.
  assert.equal(second.entry.armedAt, 1000);
});

test('revoking removes the consent and refuses a second time', () => {
  const armed = T.armRunning(T.createOptInState(), S1, 7, 1000);
  const revoked = T.revokeRunning(armed.state, S1, 7);
  assert.equal(revoked.ok, true);
  assert.equal(T.optInFor(revoked.state, directCandidate()), null);
  assert.equal(T.revokeRunning(revoked.state, S1, 7).code, 'not_opted_in');
});

test('a revoked opt-in is not admissible', () => {
  const state = armedTrigger(1000);
  const armed = T.armRunning(T.createOptInState(), S1, 7, 1000);
  const revoked = T.revokeRunning(armed.state, S1, 7);
  const candidate = directCandidate({ endedAt: 5000 });
  const entry = T.optInFor(revoked.state, candidate);
  assert.equal(entry, null);
  const verdict = T.admit(state, candidate, 6000);
  assert.equal(verdict.admit, false);
  assert.equal(verdict.code, 'direct_not_opted_in');
});

test('the store is bounded and says what it dropped', () => {
  let state = T.createOptInState();
  const now = 1000;
  for (let i = 0; i < T.MAX_OPTINS + 5; i += 1) {
    state = T.armRunning(state, S1, i, now + i).state;
  }
  const keys = Object.keys(state.entries);
  assert.equal(keys.length, T.MAX_OPTINS);
  // The oldest went, the newest stayed.
  assert.equal(state.entries[T.optInKey(S1, 0)], undefined);
  assert.ok(state.entries[T.optInKey(S1, T.MAX_OPTINS + 4)]);
});

test('a settled opt-in is sacrificed before a live one when trimming', () => {
  let state = T.createOptInState();
  const now = 1000;
  for (let i = 0; i < T.MAX_OPTINS; i += 1) {
    state = T.armRunning(state, S1, i, now + i).state;
  }
  // The oldest entry is the one that would normally go first; mark a *newer* one
  // settled and confirm the settled one is dropped instead.
  const settledKey = T.optInKey(S1, 10);
  const settledCandidate = directCandidate({ nativeTurn: 10, endedAt: 5000 });
  state = T.settleOptIn(state, settledCandidate, 'sent', now + 500).state;
  assert.ok(state.entries[settledKey].consumedAt);
  const overflow = T.armRunning(state, S1, 999, now + 900).state;
  assert.equal(overflow.entries[settledKey], undefined);
  assert.ok(overflow.entries[T.optInKey(S1, 0)], 'a live entry must survive');
});

test('an entry older than the age cap is dropped and named', () => {
  const armed = T.armRunning(T.createOptInState(), S1, 7, 1000).state;
  const pruned = T.pruneOptIns(armed, 1000 + T.OPTIN_MAX_AGE_MS + 1);
  assert.deepEqual(Object.keys(pruned.state.entries), []);
  assert.equal(pruned.dropped.length, 1);
  assert.match(pruned.dropped[0], /:expired$/);
});

test('a corrupt store is refused, not reinterpreted', () => {
  for (const bad of [null, 42, 'x', [], { version: 99, entries: {} }]) {
    const repaired = T.normalizeOptIns(bad, 1000);
    assert.deepEqual(repaired.state.entries, {});
  }
  const wrongKey = T.normalizeOptIns({ version: T.OPTIN_VERSION, entries: {
    'nonsense': { sessionId: S1, turn: 7, armedAt: 1000 },
  } }, 1000);
  assert.deepEqual(Object.keys(wrongKey.state.entries), []);
  assert.equal(wrongKey.dropped.length, 1);
  assert.match(wrongKey.dropped[0], /:identity_mismatch$/);
});

test('an opt-in from the future is dropped rather than clamped', () => {
  const future = T.normalizeOptIns({ version: T.OPTIN_VERSION, entries: {
    [T.optInKey(S1, 7)]: { sessionId: S1, turn: 7,
      armedAt: 1000 + T.OPTIN_FUTURE_SLACK_MS + 1 },
  } }, 1000);
  assert.deepEqual(Object.keys(future.state.entries), []);
  assert.match(future.dropped.join(','), /armed_in_the_future/);
});

test('a normalized store keeps the entries it can read', () => {
  const good = { version: T.OPTIN_VERSION, entries: {
    [T.optInKey(S1, 7)]: { sessionId: S1, turn: 7, armedAt: 1000,
      consumedAt: null, settledAs: null, source: 'popup' },
  } };
  const repaired = T.normalizeOptIns(good, 2000);
  assert.deepEqual(repaired.dropped, []);
  assert.equal(repaired.state.entries[T.optInKey(S1, 7)].armedAt, 1000);
});

test('settling requires a conclusive outcome, never a rate-limit refusal', () => {
  const state = T.armRunning(T.createOptInState(), S1, 7, 1000).state;
  const candidate = directCandidate({ endedAt: 5000 });
  for (const inconclusive of ['attempting', 'deferred', 'blocked', null]) {
    const result = T.settleOptIn(state, candidate, inconclusive, 6000);
    assert.equal(result.changed, false, 'must not spend consent on ' + inconclusive);
  }
  const sent = T.settleOptIn(state, candidate, 'sent', 6000);
  assert.equal(sent.changed, true);
  assert.equal(sent.state.entries[T.optInKey(S1, 7)].settledAs, 'sent');
});

test('a spent opt-in cannot authorise a second notice', () => {
  const state = T.armRunning(T.createOptInState(), S1, 7, 1000).state;
  const candidate = directCandidate({ endedAt: 5000 });
  const spent = T.settleOptIn(state, candidate, 'sent', 6000).state;
  const usable = T.optInUsable(T.optInFor(spent, candidate), candidate, 7000);
  assert.equal(usable.ok, false);
  assert.equal(usable.code, 'already_settled');
});

test('the journal records which consent authorised a write', () => {
  const state = armedTrigger(1000);
  const running = T.markAttempt(state, directCandidate({
    runningArmedAt: 1000, endedAt: 5000 }), 5000);
  assert.equal(running.state.seen[T.key(RUN, 'completed')].consent,
    'running_opt_in');
  const clickLater = T.markAttempt(state, directCandidate({
    directArmedAt: 1000, endedAt: 5000 }), 5000);
  assert.equal(clickLater.state.seen[T.key(RUN, 'completed')].consent,
    'candidate_opt_in');
  const bridge = T.markAttempt(state, {
    runId: RUN, status: 'completed', origin: T.ORIGIN_BRIDGE }, 5000);
  assert.equal(bridge.state.seen[T.key(RUN, 'completed')].consent, 'none');
});

test('one run still gets exactly one notice whichever consent authorised it', () => {
  let state = armedTrigger(1000);
  const candidate = directCandidate({ runningArmedAt: 1000, endedAt: 5000 });
  assert.equal(T.admit(state, candidate, 6000).admit, true);
  const marked = T.markAttempt(state, candidate, 6000);
  state = T.settle(marked.state, marked.key,
    { sent: true, status: 'sent' }, 7000).state;
  const again = T.admit(state, candidate, 8000);
  assert.equal(again.admit, false);
  assert.equal(again.code, 'duplicate_event');
});

test('a run notified through one channel is not notified through the other', () => {
  let state = armedTrigger(1000);
  const bridge = { runId: RUN, status: 'completed', origin: T.ORIGIN_BRIDGE };
  const marked = T.markAttempt(state, bridge, 2000);
  state = T.settle(marked.state, marked.key,
    { sent: true, status: 'sent' }, 3000).state;
  // Same run and same status: the journal key itself catches it.
  const sameStatus = T.admit(state, directCandidate({ runningArmedAt: 1000 }), 4000);
  assert.equal(sameStatus.admit, false);
  assert.equal(sameStatus.code, 'duplicate_event');
  // Same run, different status: the per-run scan catches it, which is the case that
  // would otherwise write a second line into the conversation.
  const otherStatus = T.admit(state, directCandidate({
    status: 'failed', runningArmedAt: 1000 }), 5000);
  assert.equal(otherStatus.admit, false);
  assert.equal(otherStatus.code, 'duplicate_run');
});

test('an unknown origin is refused even with an opt-in recorded', () => {
  const state = armedTrigger(1000);
  const unproven = directCandidate({ origin: T.ORIGIN_UNKNOWN });
  const noConsent = T.admit(state, unproven, 6000);
  assert.equal(noConsent.admit, false);
  assert.equal(noConsent.code, 'origin_unproven');
});

test('optInKey refuses malformed identities', () => {
  assert.equal(T.optInKey(S1, 7), S1 + '|7');
  assert.equal(T.optInKey(S1, -1), null);
  assert.equal(T.optInKey('', 1), null);
  assert.equal(T.optInKey(null, 1), null);
  assert.equal(T.optInKey(S1, 1.5), null);
  assert.equal(T.optInKey(S1, '7'), null);
});

// ------------------------------------------------------------------ popup rendering
//
// The panel's wording is a safety surface, not decoration: "nothing is running" and
// "I could not look" must never read the same, or the operator concludes their task
// vanished. These run the real popup.js against a minimal DOM.
{
  const vm = await import('node:vm');
  const fs = await import('node:fs');
  const html = fs.readFileSync('extension/popup.html', 'utf8');
  const source = fs.readFileSync('extension/popup.js', 'utf8');

  class Element {
    constructor() {
      this._text = '';
      this.value = '';
      this.disabled = false;
      this.handlers = {};
      this.children = [];
    }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    // In a real DOM, assigning `textContent = ''` removes an element's children.
    // `renderRunning` relies on exactly that to clear the select before refilling it.
    set textContent(value) { this._text = value; if (value === '') this.children = []; }
    get textContent() { return this._text; }
    replaceChildren(...items) { this.children = items; this.value = ''; }
    appendChild(item) { this.children.push(item); }
  }
  const knownIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

  // A fresh element set per boot: popup.js is a classic script that wires itself to the
  // DOM on load, so reusing one set across boots would measure the previous run's rows.
  function boot(answers) {
    const elements = new Map(knownIds.map((id) => [id, new Element()]));
    const calls = [];
    const context = {
      document: {
        getElementById(id) {
          if (!elements.has(id)) throw new Error('missing HTML id ' + id);
          return elements.get(id);
        },
        createElement() { return new Element(); },
      },
      Option: class extends Element {
        constructor(text, value) { super(); this.textContent = text; this.value = value; }
      },
      chrome: {
        storage: { local: { async get(defaults) { return defaults; } } },
        runtime: {
          id: 'test-extension',
          sendMessage(msg, done) {
            calls.push(msg);
            const answer = answers[msg.type];
            if (answer === undefined) {
              return done({ ok: false, error: 'unexpected ' + msg.type });
            }
            return done({ ok: true, result: answer });
          },
        },
      },
    };
    vm.runInNewContext(source, context);
    return { calls, elements };
  }

  const base = {
    't053-binding-state': { ok: true, binding: null },
    't054-state': { ok: true, history: [] },
    't058-state': null,
    't059-trigger-state': null,
    't067-direct-state': { originSource: null, originStale: false, ttlMs: 1800000,
      counts: { total: 0, bridge: 0, waiting: 0, armed: 0, expired: 0,
        missingOrigin: 0 }, direct: [] },
  };

  function row(extra) {
    return Object.assign({
      sessionId: S1, turn: 7, runId: 'x', startedAt: 5_000_000,
      observedSince: 5_000_000, lastActivityAt: 5_000_100, activityCount: 3,
      evidence: 'turn_start', optedIn: false, optedInAt: null, consumedAt: null,
      usableNow: 'no_opt_in',
    }, extra);
  }

  test('the popup asks what is running as soon as it opens', () => {
    const { calls } = boot(Object.assign({}, base, {
      't068-running-state': { ok: true, code: null, error: null, ledgerOk: true,
        nativeOk: true, bridgeRunning: 0, stale: 0, triggerEnabled: false, rows: [],
        counts: { running: 0, optedIn: 0 }, nothingRunning: true },
    }));
    assert.ok(calls.some((call) => call.type === 't068-running-state'),
      'opening the popup must read the running list, not wait for a refresh click');
  });

  test('an unreadable source does not read as "nothing is running"', async () => {
    // `readRunningState` sets `ok` to *whether the source could be read*, so an
    // unreadable source answers ok:false. That is the shape rendered here.
    const { elements } = boot(Object.assign({}, base, {
      't068-running-state': { ok: false, code: 'native_log_missing',
        error: 'no session log could be read', rows: [], ledgerOk: true,
        nativeOk: false, nothingRunning: false, counts: { running: 0, optedIn: 0 } },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    const shown = elements.get('runningState').textContent;
    assert.match(shown, /不可读/);
    assert.doesNotMatch(shown, /当前没有正在运行的直发任务/);
    assert.equal(elements.get('runningChoice').disabled, true);
    assert.equal(elements.get('runningArm').disabled, true);
  });

  test('a genuinely empty list says so plainly', async () => {
    const { elements } = boot(Object.assign({}, base, {
      't068-running-state': { ok: true, code: null, error: null, ledgerOk: true,
        nativeOk: true, bridgeRunning: 0, stale: 0, triggerEnabled: true, rows: [],
        counts: { running: 0, optedIn: 0 }, nothingRunning: true },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(elements.get('runningState').textContent,
      /当前没有正在运行的直发任务/);
  });

  test('a running row is listed and armed by selection only', async () => {
    const { elements } = boot(Object.assign({}, base, {
      't068-running-state': { ok: true, code: null, error: null, ledgerOk: true,
        nativeOk: true, bridgeRunning: 1, stale: 0, triggerEnabled: true,
        nothingRunning: false, rows: [row({})],
        counts: { running: 1, optedIn: 0 } },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    const choice = elements.get('runningChoice');
    assert.equal(choice.children.length, 2, 'one placeholder plus one row');
    assert.equal(choice.children[1].value, S1 + '|7');
    assert.match(choice.children[1].textContent, /第 7 轮/);
    assert.equal(choice.disabled, false);
    // The selection *is* the target, so both actions start disabled.
    assert.equal(elements.get('runningArm').disabled, true);
    assert.equal(elements.get('runningRevoke').disabled, true);
    choice.value = S1 + '|7';
    choice.handlers.change();
    assert.equal(elements.get('runningArm').disabled, false);
    assert.equal(elements.get('runningRevoke').disabled, false);
  });

  test('the panel warns when the trigger is off', async () => {
    const { elements } = boot(Object.assign({}, base, {
      't068-running-state': { ok: true, code: null, error: null, ledgerOk: true,
        nativeOk: true, bridgeRunning: 0, stale: 0, triggerEnabled: false,
        nothingRunning: false, rows: [row({})],
        counts: { running: 1, optedIn: 0 } },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(elements.get('runningState').textContent, /未启用/);
  });

  test('an opted-in row is labelled as chosen, not as waiting', async () => {
    const { elements } = boot(Object.assign({}, base, {
      't068-running-state': { ok: true, code: null, error: null, ledgerOk: true,
        nativeOk: true, bridgeRunning: 0, stale: 0, triggerEnabled: true,
        nothingRunning: false,
        rows: [row({ optedIn: true, optedInAt: 4_000_000,
          usableNow: 'terminal_time_unknown' })],
        counts: { running: 1, optedIn: 1 } },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(elements.get('runningChoice').children[1].textContent, /已选择通知/);
    assert.match(elements.get('runningState').textContent, /其中已选择通知：1 条/);
  });
}
