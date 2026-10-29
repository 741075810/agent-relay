// T057: what one manual T053 binding actually becomes after (a) an F5 of the
// ChatGPT tab and (b) an extension reload -- and whether any part of the panel can
// still be read as healthy.
//
// Nothing here is a hand-built probe object. The chain under test is the real one:
//
//   target_binding_controller.scan/bind/getState/health/onUpdated
//     -> readonly_preflight.probeSpecificTab        (real probe code)
//        -> fake chrome.tabs.sendMessage answering `readonly-probe` with a
//           per-document instance id -- the only thing a fake can own
//   autosend_chrome_wiring.controller.sendOnce
//     -> autosend.decide -> real per-mode gates
//     -> terminal_trigger.settle
//   background.readCanaryReadiness                  (the T065 panel, real module)
//
// The two facts a refresh changes are modelled exactly: the tab's `url` (unchanged
// by a same-URL reload), and the document instance a content script would report
// (a brand new randomUUID). No browser, no page, no host, no send.
import { readFileSync } from 'node:fs';

const ROOT = new URL('./extension/', import.meta.url);
const P = await import(new URL('lib/target_binding.js', ROOT).href);
const C = await import(new URL('lib/target_binding_controller.js', ROOT).href);
const AS = await import(new URL('lib/autosend.js', ROOT).href);
const TT = await import(new URL('lib/terminal_trigger.js', ROOT).href);
const WIRE = await import(new URL('lib/autosend_chrome_wiring.js', ROOT).href);
const PRE = await import(new URL('lib/readonly_preflight.js', ROOT).href);

let passed = 0;
const failures = [];
function check(ok, label) {
  if (ok) { passed += 1; return; }
  failures.push(label);
  console.log('  FAILED: ' + label);
}
function section(title) { console.log('== ' + title); }

const CONV1 = '11111111-1111-4111-8111-111111111111';
const CONV2 = '22222222-2222-4222-8222-222222222222';
const URL1 = 'https://chatgpt.com/c/' + CONV1;
const URL2 = 'https://chatgpt.com/c/' + CONV2;
const DOC_A = 'document-instance-aaaaaaaaa1';
const DOC_B = 'document-instance-bbbbbbbbbb2';
const RUN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

// ---------------------------------------------------------------- fake browser
// `session` is the only place a T053 binding lives, so clearing it is the whole of
// "the extension was reloaded". `local` holds T058/T059 and survives that reload,
// which is precisely why the two must not be judged by the same rule.
function world(options = {}) {
  const w = {
    // Wall clock, not a synthetic tick: `autosend_chrome_wiring.probe()` calls the
    // real `probeSpecificTab` without an injected clock, so the probe's freshness
    // window is measured against `Date.now()`. Starting anywhere else would make
    // every probe look stale and prove a defect that does not exist.
    now: options.now === undefined ? Date.now() : options.now,
    local: new Map(),
    session: new Map(options.session || []),
    tabs: (options.tabs || [{ id: 7, windowId: 2, url: URL1 }]).map((t) =>
      Object.assign({ active: false, discarded: false, frozen: false }, t)),
    docs: new Map(),
    writes: [],
    activations: [],
    probes: [],
  };
  for (const t of w.tabs) {
    w.docs.set(t.id, options.docs && options.docs[t.id]
      ? options.docs[t.id] : { documentInstanceId: DOC_A });
  }
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const found = (id) => w.tabs.find((t) => t.id === id) || null;
  const area = (map) => ({
    async get(defaults) {
      const out = {};
      for (const [k, v] of Object.entries(defaults || {})) {
        out[k] = map.has(k) ? clone(map.get(k)) : v;
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items || {})) map.set(k, clone(v));
    },
    async remove(key) { map.delete(key); },
  });
  // A Chrome `tabs.Tab` never carries a document instance; the content script
  // answers with it. Keeping that split is what makes this a probe and not a stub.
  const conversationOf = (url) => {
    const m = /^https:\/\/chatgpt\.com\/c\/([0-9a-f-]{36})$/.exec(url || '');
    return m ? m[1] : null;
  };
  w.chrome = {
    tabs: {
      async get(id) {
        const tab = found(id);
        if (!tab) throw new Error('No tab with id: ' + id);
        return clone(tab);
      },
      async query(filter) {
        const urls = (filter && filter.url) || [];
        return w.tabs.filter((t) => urls.some((p) => t.url.startsWith(p.slice(0, -1))))
          .map(clone);
      },
      async sendMessage(id, msg) {
        const tab = found(id);
        if (!tab) throw new Error('Could not establish connection.');
        if (msg && msg.type === 'readonly-probe') {
          w.probes.push({ tabId: id, documentInstanceId: w.docs.get(id).documentInstanceId });
          return {
            requestId: msg.requestId,
            url: tab.url,
            conversationId: conversationOf(tab.url),
            documentInstanceId: w.docs.get(id).documentInstanceId,
            observedAt: w.now,
            visibilityState: 'hidden',
            hasFocus: false,
            composerPresent: true,
            pageLoaded: true,
            routeStable: true,
          };
        }
        if (msg && msg.type === 't058-write-notice') {
          w.writes.push({ tabId: id, msg: clone(msg) });
          return { ok: true, result: { status: 'submitted', reason: null,
            composerTouched: true, composerWritten: true, clickPerformed: true,
            evidence: { conversationId: conversationOf(tab.url) } } };
        }
        throw new Error('unexpected message type: ' + (msg && msg.type));
      },
      async update() { w.activations.push('tabs.update'); throw new Error('must not activate'); },
      async highlight() { w.activations.push('tabs.highlight'); throw new Error('must not switch'); },
      async create() { w.activations.push('tabs.create'); throw new Error('must not open'); },
    },
    windows: {
      async update() { w.activations.push('windows.update'); throw new Error('must not focus'); },
      async create() { w.activations.push('windows.create'); throw new Error('must not open'); },
    },
    storage: { local: area(w.local), session: area(w.session) },
  };
  w.api = { tabs: w.chrome.tabs, session: w.chrome.storage.session };
  // A same-URL reload: the URL and the conversation survive, the document does not.
  w.refresh = (tabId) => {
    w.docs.set(tabId, { documentInstanceId: w.docs.get(tabId).documentInstanceId === DOC_A
      ? DOC_B : 'document-instance-cccccccccc3' });
  };
  w.grant = () => w.local.get('autosend') || null;
  return w;
}

let tokenSeq = 0;
async function bindOne(w) {
  const controller = C.createTargetBindingController(w.api, {
    now: () => w.now, timeoutMs: 5,
    makeToken: () => 'token-' + (++tokenSeq),
  });
  const scan = await controller.scan();
  const candidate = scan.candidates[0];
  if (!candidate) throw new Error('no candidate: ' + JSON.stringify(scan.rejected));
  const bound = await controller.bind(candidate.token, P.bindingConfirmation(null, {
    tabId: candidate.tabId, windowId: candidate.windowId,
    url: candidate.url, conversationId: candidate.conversationId,
  }));
  if (!bound.ok) throw new Error('bind failed: ' + bound.status);
  return { controller, binding: bound.binding, scan };
}

// Armed on the world's own clock. Arming at a literal 1000 while the world runs on
// `Date.now()` makes the grant look hours old, and `reconcile` then disarms it for
// expiry -- a true refusal, but not the one under test here.
function armedGrant(binding, mode, now) {
  const phrase = (mode === 'background'
    ? AS.BACKGROUND_CONFIRM_PREFIX : AS.CONFIRM_PREFIX) + binding.conversationId;
  const r = AS.arm(AS.createAutoSendState(),
    { binding, deliveryMode: mode }, phrase, true, now);
  if (!r.result.ok) throw new Error('arm failed: ' + r.result.code);
  return r.state;
}

function sendPath(w, controller) {
  return WIRE.createChromeAutoSend(w.chrome, {
    probeSpecificTab: PRE.probeSpecificTab,
    getBindingState: () => controller.getState(),
    now: () => w.now,
  });
}

function armedTrigger(binding, now) {
  const r = TT.configure(TT.createTriggerState(),
    { binding, minIntervalMs: 30000, maxPerHour: 100 },
    TT.CONFIRM_PREFIX + binding.conversationId, true, now);
  if (r.result.ok !== true) throw new Error('trigger arm failed: ' + r.result.code);
  return r.state;
}

// =====================================================================
section('T057/A  F5 of the bound tab: the record is marked, the send refuses');
// =====================================================================
{
  const w = world({ docs: { 7: { documentInstanceId: DOC_A } } });
  const { controller, binding } = await bindOne(w);
  w.local.set('autosend', armedGrant(binding, 'background', w.now));
  const before = await controller.getState();
  check(before.status === 'bound_saved' && before.binding.documentInstanceId === DOC_A,
    'before the refresh the binding is saved and carries document A (' + before.status + ')');

  // The reload itself: new document, same URL and conversation.
  w.refresh(7);
  // `chrome.tabs.onUpdated` with status 'loading' is what a reload delivers.
  await controller.onUpdated(7, { status: 'loading' });
  const probesBefore = w.probes.length;

  const after = await controller.getState();
  check(after.status === 'binding_invalidated'
    && after.binding.invalidatedReason === 'navigation_or_redirect',
    'the refresh is recorded as navigation_or_redirect (' +
    after.status + '/' + after.binding.invalidatedReason + ')');

  const health = await controller.health();
  check(health.ok === false && health.status === 'binding_invalidated'
    && health.reason === 'navigation_or_redirect',
    'health() agrees (' + health.status + '/' + health.reason + ')');
  check(w.probes.length === probesBefore,
    'an already-invalidated binding costs no page probe (' +
    (w.probes.length - probesBefore) + ')');

  const wiring = sendPath(w, controller);
  const outcome = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
  check(outcome.sent === false && outcome.pageWriteAttempted === false,
    'the send is refused before any write (sent=' + outcome.sent +
    ' writeAttempted=' + outcome.pageWriteAttempted + ')');
  check(outcome.code === 'binding_invalidated',
    'and it names the binding as the cause (' + outcome.code + ')');
  check(w.writes.length === 0, 'no write message was sent to any tab (' + w.writes.length + ')');
  check(w.activations.length === 0,
    'nothing was activated or opened (' + w.activations.join(',') + ')');
}

// =====================================================================
section('T057/B  F5 with the listener missed: the document id alone refuses');
// =====================================================================
{
  // The pessimistic case: `tabs.onUpdated` never reached the worker (a reload, a
  // slept service worker, a dropped event). The record still says bound; the page
  // is a different document. This is the question "does a dead documentInstanceId
  // really stop the notice".
  const w = world({ docs: { 7: { documentInstanceId: DOC_A } } });
  const { controller, binding } = await bindOne(w);
  w.local.set('autosend', armedGrant(binding, 'background', w.now));
  const probesBefore = w.probes.length;

  w.refresh(7);
  const state = await controller.getState();
  check(state.status === 'bound_saved',
    'with no lifecycle event the record still reads saved (' + state.status + ')');

  const wiring = sendPath(w, controller);
  const outcome = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
  check(outcome.sent === false && outcome.pageWriteAttempted === false,
    'the send is still refused (sent=' + outcome.sent + ')');
  check(outcome.code === 'document_instance_changed',
    'refused by the document identity, not by the stale record (' + outcome.code + ')');
  check(w.probes.length === probesBefore + 1,
    'and it refused after exactly one live probe (' + w.probes.length + ')');
  check(w.writes.length === 0, 'with no write to the reloaded document');

  // The same fact through health() turns the record sticky, so the panel can say it.
  const health = await controller.health();
  check(health.ok === false && health.status === 'binding_invalidated'
    && health.reason === 'binding_identity_mismatch',
    'health() then invalidates it as binding_identity_mismatch (' + health.reason + ')');
  const sticky = await controller.getState();
  check(sticky.status === 'binding_invalidated',
    'and that verdict is persisted, not recomputed per view (' + sticky.status + ')');
  check(w.writes.length === 0, 'still nothing written');
}

// =====================================================================
section('T057/C  a broken binding never borrows another tab or conversation');
// =====================================================================
{
  // Two ChatGPT tabs: the bound one and a *different* conversation that a sloppy
  // implementation could fall back to. Nothing below may touch tab 8.
  const w = world({ tabs: [{ id: 7, windowId: 2, url: URL1 },
    { id: 8, windowId: 2, url: URL2 }], docs: { 7: { documentInstanceId: DOC_A },
    8: { documentInstanceId: DOC_B } } });
  const { controller, binding } = await bindOne(w);
  check(binding.tabId === 7 && binding.conversationId === CONV1,
    'the binding names tab 7 / conversation 1 only');
  w.local.set('autosend', armedGrant(binding, 'background', w.now));
  const probesBefore = w.probes.length;
  w.refresh(7);
  await controller.onUpdated(7, { status: 'loading' });

  const wiring = sendPath(w, controller);
  const outcome = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
  check(outcome.sent === false && outcome.code === 'binding_invalidated',
    'the send is refused (' + outcome.code + ')');
  check(w.writes.length === 0 && w.activations.length === 0,
    'and neither tab was written to or activated');
  check(w.probes.slice(probesBefore).every((p) => p.tabId === 7),
    'no probe after the binding exists went anywhere but tab 7 (' +
    w.probes.slice(probesBefore).map((p) => p.tabId).join(',') + ')');

  // Close the bound tab and leave the lookalike open: the binding must die with the
  // tab rather than adopt whatever ChatGPT page is still reachable.
  w.tabs = w.tabs.filter((t) => t.id !== 7);
  await controller.onRemoved(7);
  const closed = await controller.getState();
  check(closed.ok === false || closed.binding.invalidatedReason,
    'a removed tab still leaves the binding marked invalid (' +
    closed.binding.invalidatedReason + ')');
  const orphan = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
  check(orphan.sent === false && (orphan.code === 'binding_invalidated'
    || orphan.code === 'target_not_bound'),
    'and the surviving tab is not adopted as the target (' + orphan.code + ')');
  check(w.writes.length === 0, 'tab 8 received nothing');
}

{
  // The same removal on an otherwise-healty binding, so the reason is the tab and
  // not the earlier navigation: the first reason is sticky by design.
  const w = world({ docs: { 7: { documentInstanceId: DOC_A } } });
  const { controller, binding } = await bindOne(w);
  w.local.set('autosend', armedGrant(binding, 'background', w.now));
  w.tabs = w.tabs.filter((t) => t.id !== 7);
  await controller.onRemoved(7);
  const closed = await controller.health();
  check(closed.ok === false && closed.status === 'binding_invalidated'
    && closed.reason === 'tab_closed',
    'closing the bound tab invalidates it with tab_closed (' + closed.reason + ')');
  const outcome = await sendPath(w, controller).controller.sendOnce(
    { runId: RUN, status: 'completed' });
  check(outcome.sent === false && outcome.code === 'binding_invalidated',
    'and the send refuses on that cause (' + outcome.code + ')');
  check(w.writes.length === 0, 'nothing was written');
}

// =====================================================================
section('T057/D  extension reload: the binding is gone, the grant is not');
// =====================================================================
{
  const w = world({ docs: { 7: { documentInstanceId: DOC_A } } });
  const { controller, binding } = await bindOne(w);
  const grant = armedGrant(binding, 'background', w.now);
  w.local.set('autosend', grant);
  w.local.set('terminalTrigger', armedTrigger(binding, w.now));
  check((await controller.getState()).status === 'bound_saved',
    'before the reload the binding exists');

  // Reloading the extension clears `chrome.storage.session` and nothing else.
  w.session.clear();
  const reloaded = C.createTargetBindingController(w.api, {
    now: () => w.now, timeoutMs: 5,
  });
  const state = await reloaded.getState();
  check(state.ok === true && state.status === 'not_bound' && state.binding === null,
    'after the reload the same session storage reports not_bound (' + state.status + ')');
  const health = await reloaded.health();
  check(health.ok === false && health.status === 'not_bound',
    'and health() says not_bound, not "unavailable" (' + health.status + ')');

  const outcome = await sendPath(w, reloaded).controller.sendOnce(
    { runId: RUN, status: 'completed' });
  check(outcome.sent === false && outcome.pageWriteAttempted === false,
    'the send is refused before any write');
  check(outcome.code === 'target_not_bound',
    'and the cause is the missing binding, not the page (' + outcome.code + ')');
  check(w.writes.length === 0, 'no tab was written to');

  // The T058 grant survives the reload and is *not* disarmed by this refusal: it is
  // an authorization, not a target. What it needs is a binding to authorise.
  const kept = w.grant();
  check(kept && kept.enabled === true,
    'the standing grant survives the reload and stays enabled (' +
    (kept && kept.enabled) + ')');

  // T059 is where the doubt lands: `target_not_bound` is a pre-write *block*, so the
  // trigger stops instead of waiting, and the operator has to arm it again.
  check(AS.classifyRefusal('target_not_bound') === 'blocked',
    'target_not_bound is classified blocked, not deferred');
  const cand = { runId: RUN, status: 'completed', startedAt: 2 };
  const marked = TT.markAttempt(w.local.get('terminalTrigger'), cand, w.now);
  const settled = TT.settle(marked.state, marked.key, outcome, w.now);
  check(settled.result.code === 'blocked' && settled.result.reason === 'target_not_bound',
    'the trigger settles it as blocked (' + settled.result.code + '/' +
    settled.result.reason + ')');
  check(settled.state.enabled === false
    && settled.state.lastError === 'blocked:target_not_bound',
    'and disarms itself with an audible reason (' + settled.state.lastError + ')');
}

// =====================================================================
section('T057/E  the T065 panel tells the truth about a dead binding');
// =====================================================================
// The real background module, loaded against a chrome mock: the same module the
// popup's message handler calls, so this is the panel and not a paraphrase of it.
async function loadBackground() {
  const stores = { local: new Map(), session: new Map() };
  const area = (map) => ({
    async get(defaults) {
      const out = {};
      for (const [k, v] of Object.entries(defaults || {})) {
        out[k] = map.has(k) ? JSON.parse(JSON.stringify(map.get(k))) : v;
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items || {})) {
        map.set(k, JSON.parse(JSON.stringify(v)));
      }
    },
    async remove(key) { map.delete(key); },
  });
  const alarms = new Map();
  const event = () => ({ addListener() {}, removeListener() {} });
  globalThis.chrome = {
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
        return found ? JSON.parse(JSON.stringify(found)) : undefined;
      },
      async create(name, info) { alarms.set(name, JSON.parse(JSON.stringify(info))); },
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
  const mod = await import(new URL('background.js', ROOT).href + '?t057=' + Date.now());
  return { mod, local: stores.local, session: stores.session, alarms };
}

const bg = await loadBackground();
const helloOk = async () => ({ ok: true, capabilities: { 'terminal-list': true } });
const NOW = Date.now();

// Three real health verdicts, each produced by the real controller over a real probe.
async function healthFor(kind) {
  const w = world({ docs: { 7: { documentInstanceId: DOC_A } } });
  if (kind === 'unbound') {
    const bare = C.createTargetBindingController(w.api, { now: () => w.now });
    return bare.health();
  }
  const { controller, binding } = await bindOne(w);
  if (kind === 'invalidated') {
    w.refresh(7);
    await controller.onUpdated(7, { status: 'loading' });
  } else {
    // A live grant and trigger too, so T058/T059 can be judged next to the binding.
    bg.local.set('autosend', armedGrant(binding, 'background', NOW));
    bg.local.set('terminalTrigger', armedTrigger(binding, NOW));
  }
  return controller.health();
}

const healthy = await healthFor('healthy');
const broken = await healthFor('invalidated');
const unbound = await healthFor('unbound');
check(healthy.status === 'bound_healthy',
  'the healthy case really is healthy (' + healthy.status + ')');
check(broken.status === 'binding_invalidated',
  'the refreshed case really is invalidated (' + broken.status + '/' + broken.reason + ')');
check(unbound.status === 'not_bound',
  'the reloaded case really is unbound (' + unbound.status + ')');

const item = (report, id) => report.items.find((i) => i.id === id) || {};
const ask = (health) => bg.mod.readCanaryReadiness(NOW,
  { request: helloOk, bindingHealth: async () => health, probeHost: false });

const healthyReport = await ask(healthy);
const okItem = item(healthyReport, 'binding_healthy');
check(okItem.state === 'ok' && okItem.code === null,
  'a healthy binding is an ok item (' + okItem.state + '/' + okItem.code + ')');
check(String(okItem.detail).includes(CONV1),
  'and its detail names the bound conversation (' + okItem.detail + ')');

const brokenReport = await ask(broken);
const badItem = item(brokenReport, 'binding_healthy');
check(badItem.state === 'bad' && badItem.code === 'binding_invalidated',
  'an invalidated binding is a bad item (' + badItem.state + '/' + badItem.code + ')');
check(brokenReport.blockedBy.includes('binding_invalidated'),
  'and it is in blockedBy (' + JSON.stringify(brokenReport.blockedBy) + ')');
check(String(badItem.detail).includes('navigation_or_redirect'),
  'its detail says what actually happened (' + badItem.detail + ')');

const unboundReport = await ask(unbound);
const noneItem = item(unboundReport, 'binding_healthy');
check(noneItem.state === 'bad' && noneItem.code === 'not_bound',
  'no binding is a bad item with its own code (' + noneItem.state + '/' +
  noneItem.code + ')');
check(noneItem.detail !== badItem.detail,
  '"never bound" must not read like "was bound, page changed" (' +
  noneItem.detail + ' vs ' + badItem.detail + ')');

// T058/T059 are judged on their own layer and are NOT disarmed by a refresh. That is
// correct -- an authorization and a switch, not a target -- but the weakest-link
// headline is then the only thing between "T058 ok / T059 ok" and a false green.
check(item(brokenReport, 't058_authorized').state === 'ok',
  'T058 still reads ok after a refresh: the grant is intact');
check(item(brokenReport, 't059_enabled').state === 'ok',
  'T059 still reads ok after a refresh: the switch is intact');
check(brokenReport.ok === false, 'but the panel as a whole is not ready');

console.log('');
console.log('T057: ' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length > 0) {
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}

