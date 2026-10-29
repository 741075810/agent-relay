// T071: two delivery-reliability defects, reproduced before either is fixed.
//
// 1. `deliverInto()` reads the composer and counts messages *synchronously* right
//    after `button.click()`. A React page updates the DOM asynchronously, so the
//    read sees nothing yet, reports `delivery_not_confirmed`, and -- because an
//    unconfirmed outcome must disable the trigger -- a perfectly good send ends the
//    whole run. Here the DOM update is driven by an injected clock so the timing is
//    exact and repeatable rather than a sleep in the test.
// 2. `readCanaryReadiness()` claimed `host_online: true` without asking the host, and
//    judged T058 on `enabled` alone, so an expired or exhausted grant still read as
//    "ready". Readiness must distinguish ok / bad / unknown and never dress unknown
//    up as ready.
//
// No page, no browser, no ChatGPT: the DOM is a fake object, the host is the real
// local host against a temporary ledger.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'chrome-extension://t071-e2e/';
const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);
const CONV = '3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071';
const RUN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALARM = 'dsh-terminal-trigger';

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// ------------------------------------------------------------- controlled clock
function createClock(startAt = 1000) {
  let seq = 0;
  let now = startAt;
  let tasks = [];
  return {
    get now() { return now; },
    get pending() { return tasks.length; },
    setTimeout(fn, ms) {
      const id = (seq += 1);
      tasks.push({ id, at: now + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearTimeout(id) {
      const i = tasks.findIndex((t) => t.id === id);
      if (i >= 0) tasks.splice(i, 1);
    },
    // Run every task due within the next `ms`, in timestamp order, advancing the
    // clock as it goes. Nothing runs that is not due, so "never completes" is a
    // real timeout rather than an accident of the event loop.
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = tasks.filter((t) => t.at <= target).sort((a, b) => a.at - b.at);
        if (due.length === 0) break;
        const next = due[0];
        tasks = tasks.filter((t) => t.id !== next.id);
        now = Math.max(now, next.at);
        next.fn();
      }
      now = target;
    },
  };
}

function createObserverRegistry() {
  const live = new Set();
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.targets = []; }
    observe(target) { this.targets.push(target); live.add(this); }
    disconnect() { live.delete(this); this.targets = []; }
    trigger() { if (typeof this.callback === 'function') this.callback([]); }
  }
  return { FakeObserver, notify() { for (const o of [...live]) o.trigger(); }, live };
}

// ------------------------------------------------------------------- fake page
// A page whose DOM updates only when the injected clock says so, exactly like a
// framework flushing a render on a microtask/rAF tick.
function createPage(path, options = {}) {
  const {
    composerPresent = true,
    buttonPresent = true,
    draft = '',
    commitDelayMs = 120,
    composerClearDelayMs = null,   // defaults to the same tick as the commit
    messageCount = null,           // >1 to simulate a duplicate render
    navigateTo = null,             // path to jump to during the commit
    neverCommits = false,
  } = options;

  const clock = options.clock || createClock();
  const registry = options.registry || createObserverRegistry();
  const clicks = [];
  const typeHistory = [];
  const messages = [];

  const composer = {
    value: draft,
    textContent: draft,
    focus() {},
    dispatchEvent() {},
    getBoundingClientRect: () => ({ width: 400, height: 60 }),
  };
  function syncText(next) {
    composer.value = next;
    composer.textContent = next;
  }

  const button = {
    disabled: false,
    getBoundingClientRect: () => ({ width: 30, height: 30 }),
    click() {
      clicks.push(Date.now());
      if (neverCommits) return;          // accepted the click, never renders
      const typed = composer.value || composer.textContent || '';
      if (!typed) return;
      clock.setTimeout(() => {
        if (navigateTo) {
          doc.location.pathname = navigateTo;
          doc.location.href = 'https://chatgpt.com' + navigateTo;
        }
        const copies = Number.isSafeInteger(messageCount) ? messageCount : 1;
        for (let i = 0; i < copies; i += 1) messages.push(typed);
        registry.notify();
      }, commitDelayMs);
      const clearAfter = composerClearDelayMs === null
        ? commitDelayMs : composerClearDelayMs;
      clock.setTimeout(() => { syncText(''); registry.notify(); }, clearAfter);
    },
  };

  const doc = {
    location: { pathname: path, href: 'https://chatgpt.com' + path },
    body: { nodeType: 1 },
    documentElement: { nodeType: 1 },
    querySelectorAll(selector) {
      if (selector.includes('contenteditable')) {
        return composerPresent ? [composer] : [];
      }
      if (selector.includes('[data-message-author-role="user"]')) {
        return messages.map((text) => ({ textContent: text }));
      }
      if (selector === 'button[data-testid="send-button"]') {
        return buttonPresent ? [button] : [];
      }
      return [];
    },
    execCommand() { return false; },
    createEvent() { return { initEvent() {} }; },
  };

  return { doc, clock, registry, clicks, messages, composer, button,
    typeHistory, syncText };
}

async function main() {
  const A = await mod('./extension/lib/send_adapter.js');
  const NOTICE = A.composeNotice(RUN, 'completed').text;

  // The adapter waits for a receipt; the clock decides when the page renders.
  const depsFor = (page, timeoutMs = 2000) => ({
    clock: () => page.clock.now,
    timers: page.clock,
    Observer: page.registry.FakeObserver,
    timeoutMs,
  });

  // Call the adapter and run the injected clock forward. Everything the adapter
  // does up to its first `await` is synchronous, so the observer and the timeout
  // are already registered by the time this returns -- which makes the sequence
  // deterministic instead of a race against a real timer.
  // T079 gave the adapter a second wait (send control readiness) *before* the
  // click, so "call then advance the clock once" no longer suffices: the clock has
  // to be stepped with the microtask queue draining between steps. Stepping in 25ms
  // slices is exact for these pages -- every timer they use is on this clock.
  const deliver = async (page, spec, timeoutMs = 2000, budgetMs = null) => {
    const promise = A.deliverInto(page.doc, spec, 1000, depsFor(page, timeoutMs));
    const budget = budgetMs === null ? timeoutMs : budgetMs;
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    for (let elapsed = 0; elapsed < budget && !settled; elapsed += 25) {
      await flush();
      page.clock.advance(25);
    }
    await flush();
    return promise;
  };

  // ------------------------------------------------- 1. asynchronous commit
  console.log('== T071: a page that renders after the click is still a success ==');
  {
    const page = createPage('/c/' + CONV, { commitDelayMs: 120 });
    const result = await deliver(page,
      { runId: RUN, status: 'completed', origin: 'bridge', expectedConversationId: CONV }, 2000);
    // Before the fix this was 'unconfirmed' / 'delivery_not_confirmed': the read
    // happened in the same tick as the click, before React had rendered anything.
    check(result.status === 'submitted',
      'an asynchronous commit is reported as submitted (' + result.status + '/'
      + result.reason + ')');
    check(page.clicks.length === 1, 'with exactly one click (' + page.clicks.length + ')');
    check(page.messages.length === 1, 'and exactly one new message (' + page.messages.length + ')');
    check(page.messages[0] === NOTICE, 'whose text is the fixed template');
    check(page.composer.value === '', 'and the composer is empty');
    check(result.evidence && result.evidence.appeared === 1,
      'evidence records one appearance (' + JSON.stringify(result.evidence) + ')');
  }

  // The same page with a commit slower than a naive microtask: still a success, and
  // the wait must be bounded rather than "until something happens".
  {
    const page = createPage('/c/' + CONV, { commitDelayMs: 1500 });
    const result = await deliver(page,
      { runId: RUN, status: 'completed', origin: 'bridge', expectedConversationId: CONV }, 2000);
    check(result.status === 'submitted',
      'a slow-but-in-budget commit still submits (' + result.status + ')');
    check(page.clock.pending === 0, 'and every timer is released (' + page.clock.pending + ')');
  }

  // ---------------------------------------------- 2. already-synchronous commit
  console.log('== T071: an immediate render keeps working ==');
  {
    const page = createPage('/c/' + CONV);
    // Replace the click with one that renders synchronously, as the old code
    // implicitly assumed every page does.
    page.button.click = () => {
      page.clicks.push(1);
      page.messages.push(NOTICE);
      page.syncText('');
    };
    const result = await deliver(page,
      { runId: RUN, status: 'completed', origin: 'bridge', expectedConversationId: CONV });
    check(result.status === 'submitted', 'a synchronous render still submits');
    check(page.clicks.length === 1, 'with one click');
    check(page.clock.pending === 0, 'and no timer left behind');
  }

  // ------------------------------------------------------ 3. never completes
  console.log('== T071: a receipt that never arrives stays unconfirmed ==');
  {
    const page = createPage('/c/' + CONV, { neverCommits: true });
    const result = await deliver(page,
      { runId: RUN, status: 'completed', origin: 'bridge', expectedConversationId: CONV }, 2000);
    check(result.status === 'unconfirmed',
      'a missing receipt is unconfirmed, never submitted (' + result.status + ')');
    check(result.reason === 'delivery_not_confirmed',
      'and names delivery_not_confirmed (' + result.reason + ')');
    check(page.clicks.length === 1, 'the click is not repeated (' + page.clicks.length + ')');
    check(page.composer.value === NOTICE,
      'and the typed text is left exactly as it was, not rewritten');
    check(page.clock.pending === 0,
      'the timeout is cleared so the worker can idle (' + page.clock.pending + ')');
    check(result.evidence && result.evidence.waitedMs === 2000,
      'evidence reports how long it waited (' +
      JSON.stringify(result.evidence && result.evidence.waitedMs) + ')');
  }

  // ------------------------------------------------ 4. navigated while waiting
  console.log('== T071: a navigation during the wait is never a success ==');
  {
    const other = '99999999-9999-4999-8999-999999999999';
    const page = createPage('/c/' + CONV, { commitDelayMs: 100, navigateTo: '/c/' + other });
    const result = await deliver(page,
      { runId: RUN, status: 'completed', origin: 'bridge', expectedConversationId: CONV }, 2000);
    check(result.status === 'unconfirmed',
      'the notice is not reported as sent (' + result.status + ')');
    check(result.reason === 'conversation_changed_during_receipt',
      'and names the conversation change (' + result.reason + ')');
    check(page.clicks.length === 1, 'with only the original click');
  }

  // ------------------------------------------------------- 5. duplicate render
  console.log('== T071: two copies of the notice are not a success ==');
  {
    const page = createPage('/c/' + CONV, { commitDelayMs: 80, messageCount: 2 });
    const result = await deliver(page,
      { runId: RUN, status: 'completed', origin: 'bridge', expectedConversationId: CONV }, 2000);
    check(result.status === 'unconfirmed',
      'a duplicated message is unconfirmed (' + result.status + ')');
    check(result.reason === 'duplicate_message_appeared',
      'and says so (' + result.reason + ')');
    check(page.clicks.length === 1, 'without a second click');
  }

  // ------------------------------------------------------- 6. pre-existing draft
  console.log('== T071: an operator draft is still never touched ==');
  {
    const page = createPage('/c/' + CONV, { draft: 'my half-written note' });
    const result = await deliver(page,
      { runId: RUN, status: 'completed', origin: 'bridge', expectedConversationId: CONV });
    check(result.status === 'refused' && result.reason === 'composer_not_empty',
      'a non-empty composer is refused (' + result.reason + ')');
    check(page.clicks.length === 0, 'no click');
    check(page.composer.value === 'my half-written note', 'and the draft survives intact');
  }

  // --------------------------------------------------------- 7. button missing
  // T079 changed which refusal this is, on purpose: a page with no identifiable
  // send control is now refused *before* the composer is touched, so the notice is
  // never left behind in a draft. The property this block cared about -- "a missing
  // button is a stop, not a success" -- is unchanged; the stop is simply earlier.
  console.log('== T071: a missing send button is a stop, not a success ==');
  {
    const page = createPage('/c/' + CONV, { buttonPresent: false });
    const result = await deliver(page,
      { runId: RUN, status: 'completed', origin: 'bridge', expectedConversationId: CONV });
    check(result.status === 'refused' && result.reason === 'send_control_missing',
      'a missing button is refused (' + result.reason + ')');
    check(page.clicks.length === 0, 'nothing was clicked');
    check(result.composerWritten === false,
      'and the composer was never written (' + result.composerWritten + ')');
    check(page.composer.value === '',
      'so no notice is stranded in the composer ("' + page.composer.value + '")');
  }

  // ------------------------------------------- 8. readiness must not lie
  //
  // Before the fix `readCanaryReadiness()` hard-coded `host_online: true` and judged
  // the send grant on `enabled` alone, so an expired grant with a healthy binding
  // produced a green checklist. Both halves are asserted here against the real
  // exported function, with the host and binding probes injected.
  console.log('== T071: readiness distinguishes ok / bad / unknown ==');
  {
    const bg = await loadBackground();
    const at = 1700000000000;
    const grant = (over) => Object.assign({
      enabled: true, armedAt: at - 60000, expiresAt: at + 86400000,
      maxSends: 1000, sentCount: 3, conversationId: CONV,
    }, over);
    const trigger = (over) => Object.assign({
      enabled: true, minIntervalMs: 30000, maxPerHour: 100, lastError: null,
      // T086: a healthy armed trigger has a recorded arm instant; without one the
      // readiness checklist is right to report the boundary as unknown.
      armedAt: at - 60000,
      // T091: and a healthy trigger armed by this release carries the snapshot
      // round it was measured against. Its absence is reported as an unknown
      // boundary, so a state that is genuinely healthy must include it.
      armEpoch: 'e2e-arm-round', armSnapshotAt: at - 60000, armSnapshotCount: 76,
      preArmCandidateKeys: [],
    }, over);
    const healthy = async () => ({ ok: true, status: 'bound_healthy',
      binding: { tabId: 7, conversationId: CONV } });
    const helloOk = async () => ({ ok: true, capabilities: { detect: 1, deliver: 1 } });
    const seed = () => {
      bg.store.local.set('terminalSourceBaseline', { established: true, at: at - 90000 });
      bg.store.local.set('terminalTrigger', trigger());
      bg.store.local.set('autosend', grant());
      bg.store.local.set('terminalCandidates', []);
      bg.alarms.set(ALARM, { periodInMinutes: 0.5 });
    };

    // (a) A probed host that answers is the only way to an `ok` host.
    seed();
    const green = await bg.mod.readCanaryReadiness(at,
      { request: helloOk, bindingHealth: healthy });
    const hostItem = green.items.find((i) => i.id === 'host_online');
    check(hostItem && hostItem.state === 'ok',
      'a host that answers hello is ok (' + JSON.stringify(hostItem) + ')');
    check(green.ok === true,
      'and with everything healthy the checklist is ready (' +
      JSON.stringify(green.blockedBy.concat(green.unknownBy)) + ')');
    check(green.realWriteConfirmed === false,
      'but it still never claims a real write');
    check(green.items.every((i) => ['ok', 'bad', 'unknown'].includes(i.state)),
      'every item carries a three-way state');

    // (b) Not probing must be `unknown`, never `true`. This is the exact defect:
    // the old code returned `ok: true` here without asking anyone.
    const unprobed = await bg.mod.readCanaryReadiness(at,
      { probeHost: false, bindingHealth: healthy });
    const unprobedItem = unprobed.items.find((i) => i.id === 'host_online');
    check(unprobedItem.state === 'unknown',
      'an unprobed host is unknown, not ok (' + JSON.stringify(unprobedItem) + ')');
    check(unprobedItem.ok === false && unprobedItem.unknown === true,
      'and it does not count as ok');
    check(unprobed.ok === false,
      'so the checklist is not ready on an unknown (' + JSON.stringify(unprobed.unknownBy) + ')');
    check(unprobed.unknownBy.includes('no_host_reply'),
      'and the unknown is listed separately from the blockers (' +
      JSON.stringify(unprobed.unknownBy) + ')');
    check((unprobed.blockedBy || []).every((c) => !String(c).includes('host')),
      'without pretending it is a blocker (' + JSON.stringify(unprobed.blockedBy) + ')');

    // (c) A host that refuses is bad, and says why.
    const down = await bg.mod.readCanaryReadiness(at,
      { request: async () => ({ ok: false, code: 'unknown_op' }),
        bindingHealth: healthy });
    const downItem = down.items.find((i) => i.id === 'host_online');
    check(downItem.state === 'bad' && downItem.code === 'unknown_op',
      'a refusing host is bad with its code (' + JSON.stringify(downItem) + ')');
    check(down.ok === false, 'and blocks readiness');

    // (d) A throwing probe is bad too, not unknown and not ok.
    const thrown = await bg.mod.readCanaryReadiness(at,
      { request: async () => { throw new Error('port closed'); },
        bindingHealth: healthy });
    const thrownItem = thrown.items.find((i) => i.id === 'host_online');
    check(thrownItem.state === 'bad' && thrownItem.code === 'host_unreachable',
      'a throwing probe is bad/host_unreachable (' + JSON.stringify(thrownItem) + ')');

    // (e) The expired grant: `enabled: true` is not authorization.
    bg.store.local.set('autosend', grant({ expiresAt: at - 1000 }));
    const expired = await bg.mod.readCanaryReadiness(at,
      { request: helloOk, bindingHealth: healthy });
    const expiredGrant = expired.items.find((i) => i.id === 't058_grant_usable');
    check(expiredGrant.state === 'bad' && expiredGrant.code === 'authorization_expired',
      'an expired grant is bad/authorization_expired (' + JSON.stringify(expiredGrant) + ')');
    check(expired.ok === false, 'so the checklist is not ready (' +
      JSON.stringify(expired.blockedBy) + ')');
    check(expired.items.find((i) => i.id === 't058_authorized').state !== 'ok',
      'and the authorization item is not ok either, even though enabled is true');

    // (f) The exhausted grant.
    bg.store.local.set('autosend', grant({ maxSends: 1000, sentCount: 1000 }));
    const spent = await bg.mod.readCanaryReadiness(at,
      { request: helloOk, bindingHealth: healthy });
    const spentItem = spent.items.find((i) => i.id === 't058_grant_usable');
    check(spentItem.state === 'bad' && spentItem.code === 'authorization_exhausted',
      'a used-up grant is bad/authorization_exhausted (' + JSON.stringify(spentItem) + ')');
    check(spent.ok === false, 'so it is not ready');

    // (g) A missing grant stays the same code callers already handle.
    bg.store.local.set('autosend', null);
    const none = await bg.mod.readCanaryReadiness(at,
      { request: helloOk, bindingHealth: healthy });
    check(none.blockedBy.includes('authorization_inactive'),
      'no grant at all is still authorization_inactive (' +
      JSON.stringify(none.blockedBy) + ')');

    // (h) A dead binding cannot be papered over.
    bg.store.local.set('autosend', grant());
    const unbound = await bg.mod.readCanaryReadiness(at,
      { request: helloOk, bindingHealth: async () => ({ ok: false,
        status: 'binding_invalidated' }) });
    const bindItem = unbound.items.find((i) => i.id === 'binding_healthy');
    check(bindItem.state === 'bad' && bindItem.code === 'binding_invalidated',
      'a broken binding is bad (' + JSON.stringify(bindItem) + ')');
    check(unbound.ok === false, 'and the checklist is not ready');

    // (i) The alarm must be really scheduled, not assumed.
    bg.alarms.delete(ALARM);
    const noAlarm = await bg.mod.readCanaryReadiness(at,
      { request: helloOk, bindingHealth: healthy });
    check(noAlarm.items.find((i) => i.id === 't059_alarm_scheduled').state === 'bad'
      && noAlarm.blockedBy.includes('alarm_missing'),
      'a missing alarm blocks readiness (' + JSON.stringify(noAlarm.blockedBy) + ')');
  }

  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

// A chrome mock just large enough to import the real background module, plus the
// two read seams readiness exposes. Nothing here can send, open a tab or reach a
// page: `connectNative` throws and `tabs.query` always returns nothing.
async function loadBackground() {
  const stores = { local: new Map(), session: new Map() };
  const area = (map) => ({
    async get(defaults) {
      const out = {};
      if (defaults && typeof defaults === 'object') {
        for (const [k, v] of Object.entries(defaults)) {
          out[k] = map.has(k) ? clone(map.get(k)) : v;
        }
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items || {})) map.set(k, clone(v));
    },
    async remove(key) { map.delete(key); },
  });
  const alarms = new Map();
  const event = () => ({ addListener() {}, removeListener() {} });
  const chrome = {
    runtime: {
      id: 'test-extension',
      getURL: (p) => 'chrome-extension://test-extension/' + p,
      connectNative: () => { throw new Error('native host unavailable in tests'); },
      onMessage: event(), onInstalled: event(), onStartup: event(),
      lastError: undefined,
    },
    storage: { local: area(stores.local), session: area(stores.session) },
    alarms: {
      async get(name) {
        const found = alarms.get(name);
        return found ? clone(found) : undefined;
      },
      async create(name, info) { alarms.set(name, clone(info)); },
      async clear(name) { return alarms.delete(name); },
      onAlarm: event(),
    },
    tabs: {
      async query() { return []; },
      async get() { return undefined; },
      async sendMessage() { throw new Error('no tab in tests'); },
      onActivated: event(), onUpdated: event(), onRemoved: event(),
      onAttached: event(), onDetached: event(), onReplaced: event(),
    },
    windows: { onFocusChanged: event() },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    scripting: { async executeScript() { return []; } },
    permissions: { async contains() { return false; } },
  };
  globalThis.chrome = chrome;
  const mod = await import(new URL('./extension/background.js?t071=' + Date.now(),
    ROOT).href);
  return { mod, store: { local: stores.local, session: stores.session }, alarms };
}

main().catch((err) => {
  console.error('FATAL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

