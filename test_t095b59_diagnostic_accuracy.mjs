// T059: three diagnostic-accuracy defects in the T065 panel, proved before fixing.
//
//   1. `readCanaryReadiness` compared neither the binding revision nor the
//      conversation/document identity against the T058 grant. Bind after arming and
//      the panel read green while `decide()` was already certain to refuse
//      `binding_changed`. The new `grant_binding_match` item must catch all three
//      disagreements and must not fire when the two records genuinely agree.
//   2. `detail.delivery` did not carry `confirmedSends`, so the popup's
//      `写入: 确认 N 次` line could only ever print 0.
//   3. `triggerLayer` counted its journal twice: the same `for (const item of journal)`
//      body ran before and after the `deferred` computation, so one sent run printed
//      `journal={"sent":2,...}`.
//
// Everything below runs the real modules over a fake chrome. No page, no host, no
// extension storage, no notification. `readCanaryReadiness` is the exact function the
// popup's button calls (background.js), and `summariseChain`/`triggerLayer` are the
// exact functions the chain panel renders from.
import { readFileSync } from 'node:fs';

const ROOT = new URL('./extension/', import.meta.url);
const CS = await import(new URL('lib/chain_status.js', ROOT).href);
const AS = await import(new URL('lib/autosend.js', ROOT).href);
const TT = await import(new URL('lib/terminal_trigger.js', ROOT).href);
const P = await import(new URL('lib/target_binding.js', ROOT).href);
const C = await import(new URL('lib/target_binding_controller.js', ROOT).href);
const PRE = await import(new URL('lib/readonly_preflight.js', ROOT).href);
const WIRE = await import(new URL('lib/autosend_chrome_wiring.js', ROOT).href);

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
const RUN1 = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN2 = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = Date.now();

// ---------------------------------------------------------------- fake browser
// A minimal version of the world T057 built, kept small: only what a binding scan,
// a probe and a send decision actually touch.
function world(options = {}) {
  const w = {
    now: NOW,
    local: new Map(),
    session: new Map(),
    tabs: [{ id: 7, windowId: 2, url: options.url || URL1,
      active: false, discarded: false, frozen: false }],
    docs: new Map([[7, { documentInstanceId: options.documentInstanceId || DOC_A }]]),
    writes: [],
  };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
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
  const conversationOf = (u) => {
    const m = /^https:\/\/chatgpt\.com\/c\/([0-9a-f-]{36})$/.exec(u || '');
    return m ? m[1] : null;
  };
  w.chrome = {
    tabs: {
      async get(id) {
        const t = w.tabs.find((x) => x.id === id);
        if (!t) throw new Error('No tab with id: ' + id);
        return clone(t);
      },
      async query(filter) {
        const urls = (filter && filter.url) || [];
        return w.tabs.filter((t) => urls.some((p) => t.url.startsWith(p.slice(0, -1))))
          .map(clone);
      },
      async sendMessage(id, msg) {
        const t = w.tabs.find((x) => x.id === id);
        if (!t) throw new Error('Could not establish connection.');
        if (msg && msg.type === 'readonly-probe') {
          return {
            requestId: msg.requestId, url: t.url,
            conversationId: conversationOf(t.url),
            documentInstanceId: w.docs.get(id).documentInstanceId,
            observedAt: w.now, visibilityState: 'hidden', hasFocus: false,
            composerPresent: true, pageLoaded: true, routeStable: true,
          };
        }
        if (msg && msg.type === 't058-write-notice') {
          w.writes.push({ tabId: id, msg: clone(msg) });
          return { ok: true, result: { status: 'submitted', reason: null,
            composerTouched: true, composerWritten: true, clickPerformed: true,
            evidence: { conversationId: conversationOf(t.url) } } };
        }
        throw new Error('unexpected message type: ' + (msg && msg.type));
      },
      async update() { throw new Error('must not activate'); },
    },
    windows: { async update() { throw new Error('must not focus'); } },
    storage: { local: area(w.local), session: area(w.session) },
  };
  w.api = { tabs: w.chrome.tabs, session: w.chrome.storage.session };
  return w;
}

let tokenSeq = 0;
function controllerFor(w) {
  return C.createTargetBindingController(w.api, {
    now: () => w.now, timeoutMs: 5,
    makeToken: () => 'token-' + (++tokenSeq),
  });
}
async function bindOne(w, controller) {
  const ctrl = controller || controllerFor(w);
  const scan = await ctrl.scan();
  const cand = scan.candidates[0];
  if (!cand) throw new Error('no candidate: ' + JSON.stringify(scan.rejected));
  const bound = await ctrl.bind(cand.token, P.bindingConfirmation(null, {
    tabId: cand.tabId, windowId: cand.windowId, url: cand.url,
    conversationId: cand.conversationId,
  }));
  if (!bound.ok) throw new Error('bind failed: ' + bound.status);
  return { controller: ctrl, binding: bound.binding };
}

function armedGrant(binding, mode, now) {
  const phrase = (mode === 'background'
    ? AS.BACKGROUND_CONFIRM_PREFIX : AS.CONFIRM_PREFIX) + binding.conversationId;
  const r = AS.arm(AS.createAutoSendState(), { binding, deliveryMode: mode },
    phrase, true, now);
  if (!r.result.ok) throw new Error('arm failed: ' + r.result.code);
  return r.state;
}
function armedTrigger(binding, now) {
  const r = TT.configure(TT.createTriggerState(),
    { binding, minIntervalMs: 30000, maxPerHour: 100 },
    TT.CONFIRM_PREFIX + binding.conversationId, true, now);
  if (r.result.ok !== true) throw new Error('trigger arm failed: ' + r.result.code);
  return r.state;
}

// =====================================================================
section('T059/A  triggerLayer counts each journal entry exactly once');
// =====================================================================
{
  // (a) A hand-built `seen` map: this is precisely the record the layer reads, so a
  // wrong count here cannot be blamed on how the entry got there.
  const seen = {};
  for (let i = 0; i < 3; i += 1) {
    seen['sent-' + i] = { state: 'sent', runId: 'r' + i, status: 'completed' };
  }
  seen['stopped-1'] = { state: 'stopped', runId: 'r9', status: 'completed' };
  seen['blocked-1'] = { state: 'blocked', runId: 'r10', status: 'completed' };
  const hand = CS.triggerLayer({ enabled: true, seen, deferred: {} }, NOW).trigger;
  check(hand.journal.sent === 3,
    'three sent entries read as sent=3 (' + JSON.stringify(hand.journal) + ')');
  check(hand.journal.stopped === 1 && hand.journal.blocked === 1,
    'stopped/blocked are not multiplied either (' + JSON.stringify(hand.journal) + ')');
  check(hand.journal.ambiguous === 0 && hand.journal.attempting === 0,
    'absent states stay at zero (' + JSON.stringify(hand.journal) + ')');

  // (b) The real path: two runs through markAttempt/settle, one submitted and one
  // pre-write blocked. Counts must match, not double.
  let state = armedTrigger({ tabId: 7, windowId: 2, url: URL1,
    conversationId: CONV1, documentInstanceId: DOC_A, revision: 1,
    manuallyConfirmed: true }, NOW);
  const runA = { runId: RUN1, status: 'completed', startedAt: NOW };
  let marked = TT.markAttempt(state, runA, NOW);
  state = TT.settle(marked.state, marked.key, { sent: true, status: 'sent' }, NOW).state;
  const runB = { runId: RUN2, status: 'completed', startedAt: NOW };
  marked = TT.markAttempt(state, runB, NOW);
  state = TT.settle(marked.state, marked.key,
    { sent: false, pageWriteAttempted: false, code: 'binding_changed' }, NOW).state;
  const real = CS.triggerLayer(state, NOW).trigger;
  check(real.journal.sent === 1,
    'one really-sent run reads as sent=1 (' + JSON.stringify(real.journal) + ')');
  check(real.journal.blocked === 1,
    'one really-blocked run reads as blocked=1 (' + JSON.stringify(real.journal) + ')');
  check(real.journal.sent + real.journal.blocked === 2,
    'two attempts total, not four (' + JSON.stringify(real.journal) + ')');
  // The deferral is reported separately and must not have been counted as an attempt.
  check(real.deferred === 0 && real.deferredReason === null,
    'no deferral is invented (' + real.deferred + '/' + real.deferredReason + ')');
}

// =====================================================================
section('T059/B  the delivery detail carries the real confirmed-send count');
// =====================================================================
{
  // Two confirmed page writes through the real autosend journal, plus one attempt
  // whose outcome is genuinely unknown. A panel may only report the first two.
  const binding = { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1,
    documentInstanceId: DOC_A, revision: 4, manuallyConfirmed: true };
  let grant = armedGrant(binding, 'background', NOW);
  const submit = { runId: RUN1, status: 'completed' };
  let rec = AS.recordAttempt(grant, submit, NOW);
  grant = AS.settle(rec.state, rec.key, { status: 'submitted' }, NOW).state;
  const submit2 = { runId: RUN2, status: 'completed' };
  rec = AS.recordAttempt(grant, submit2, NOW);
  grant = AS.settle(rec.state, rec.key, { status: 'submitted' }, NOW).state;
  const hazy = { runId: '33333333-cccc-4ccc-8ccc-cccccccccccc', status: 'failed' };
  rec = AS.recordAttempt(grant, hazy, NOW);
  grant = AS.settle(rec.state, rec.key, { status: 'click_unknown' }, NOW).state;

  const journal = Object.values(grant.journal);
  const reallySent = journal.filter((i) => i.state === 'sent').length;
  check(reallySent === 2, 'the fixture really holds two confirmed sends (' + reallySent + ')');
  check(grant.sentCount === 2, 'and the counter agrees (' + grant.sentCount + ')');

  const report = CS.summariseChain({
    autoSendState: grant,
    triggerState: armedTrigger(binding, NOW),
    bindingHealth: { ok: true, status: 'bound_healthy', binding },
    hello: { ok: true }, terminalList: { ok: true }, candidates: [],
  }, NOW);
  const detail = report.detail || {};
  const delivery = detail.delivery || {};
  check(delivery.confirmedSends === undefined || delivery.confirmedSends === null
    ? true : delivery.confirmedSends >= 0, 'delivery detail is an object (' +
    JSON.stringify(delivery) + ')');
  check('confirmedSends' in delivery && delivery.confirmedSends === reallySent,
    'detail.delivery.confirmedSends is the real number of confirmed writes (' +
    JSON.stringify(delivery.confirmedSends) + ' vs ' + reallySent + ')');
  check(delivery.ambiguousAttempts === 1,
    'and the unconfirmed attempt is reported separately (' + delivery.ambiguousAttempts + ')');
  // `authorization` (where the popup used to look) has no such field: that is why the
  // old line printed 0 forever.
  check(detail.authorization && detail.authorization.confirmedSends === undefined,
    'the authorization detail it used to read has no confirmedSends at all');
  check(detail.authorization.sentCount === 2,
    'while the honest number it does carry is sentCount=2 (' +
    (detail.authorization && detail.authorization.sentCount) + ')');

  // The popup must read the field that exists. Source-level, because popup.js is a
  // DOM script; this is the same kind of check the T059 source suite already uses.
  const popupSrc = readFileSync(new URL('popup.js', ROOT), 'utf8');
  check(!/authorization\.confirmedSends/.test(popupSrc),
    'popup.js no longer reads confirmedSends off the authorization detail');
  check(/del\.confirmedSends|delivery\.confirmedSends/.test(popupSrc),
    'popup.js reads it off the delivery detail instead');
}

// =====================================================================
section('T059/C  the self-check exposes grant/binding disagreement');
// =====================================================================
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
      async query() { return []; }, async get() { return undefined; },
      async sendMessage() { throw new Error('no tab in tests'); },
      onActivated: event(), onUpdated: event(), onRemoved: event(),
      onAttached: event(), onDetached: event(), onReplaced: event(),
    },
    windows: { onFocusChanged: event() },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    scripting: { async executeScript() { return []; } },
    permissions: { async contains() { return false; } },
  };
  const mod = await import(new URL('background.js', ROOT).href + '?t059=' + Date.now());
  return { mod, local: stores.local, session: stores.session };
}

const bg = await loadBackground();
const helloOk = async () => ({ ok: true, capabilities: { 'terminal-list': true } });
const item = (report, id) => report.items.find((i) => i.id === id) || {};
const ask = (health, opts) => bg.mod.readCanaryReadiness(NOW, Object.assign(
  { request: helloOk, bindingHealth: async () => health, probeHost: false }, opts || {}));
const MATCH_CODES = ['binding_changed', 'conversation_changed', 'document_instance_changed'];

// One healthy binding over a real scan + probe, so `health.binding` is a real record.
const w = world();
const bound = await bindOne(w);
const binding = bound.binding;
const healthy = await bound.controller.health();
check(healthy.status === 'bound_healthy',
  'the fixture binding is genuinely healthy (' + healthy.status + ')');
check(Number.isSafeInteger(binding.revision) && binding.revision === 1,
  'and carries a real revision (' + binding.revision + ')');

// --- happy path: grant armed against exactly this binding
let happyBlocked = null;
{
  bg.local.set('autosend', armedGrant(binding, 'background', NOW));
  bg.local.set('terminalTrigger', armedTrigger(binding, NOW));
  const report = await ask(healthy);
  const match = item(report, 'grant_binding_match');
  happyBlocked = (report.blockedBy || []).slice();
  check(match.id === 'grant_binding_match',
    'the self-check now reports a grant/binding match item');
  check(match.state === 'ok' && match.code === null,
    'a grant armed against this very binding is ok (' + match.state + '/' +
    match.code + ')');
  check(String(match.detail).includes(String(binding.revision)),
    'and the detail names the revision that matched (' + match.detail + ')');
  const falseAlarm = MATCH_CODES.filter((c) => (report.blockedBy || []).includes(c));
  check(falseAlarm.length === 0,
    'no mismatch code is invented for a matching pair (' + JSON.stringify(falseAlarm) + ')');
  check(!(report.unknownBy || []).includes('grant_binding_match'),
    'and it is not parked in unknown either (' + JSON.stringify(report.unknownBy) + ')');
  check(happyBlocked.length === 2
    && happyBlocked.includes('baseline_not_established')
    && happyBlocked.includes('alarm_missing'),
    'the only blockers on a matching pair are the two fixture gaps (' +
    JSON.stringify(happyBlocked) + ')');
}

// --- revision drift: bind happened after the grant was armed
{
  const stale = armedGrant(binding, 'background', NOW);
  stale.bindingRevision = binding.revision - 1;   // exact shape of "armed, then rebound"
  bg.local.set('autosend', stale);
  const report = await ask(healthy);
  const match = item(report, 'grant_binding_match');
  check(match.state === 'bad' && match.code === 'binding_changed',
    'an older grant revision is a bad binding_changed item (' + match.state + '/' +
    match.code + ')');
  check((report.blockedBy || []).includes('binding_changed'),
    'and the panel as a whole is blocked (' + JSON.stringify(report.blockedBy) + ')');
  check(report.ok === false, 'so it can no longer read as a false green');
  // The decisive comparison: the mismatch must add exactly one blocker to the very
  // same report that was clean a moment ago. Nothing else may move.
  const extra = (report.blockedBy || []).filter((c) => !happyBlocked.includes(c));
  check(extra.length === 1 && extra[0] === 'binding_changed',
    'and it is the *only* thing that changed versus the matching pair (' +
    JSON.stringify(extra) + ')');
  check(item(report, 't058_authorized').state === 'ok',
    'even though the grant itself is still active -- which is exactly the trap');
  check(item(report, 'binding_healthy').state === 'ok',
    'and the binding itself is still healthy -- the second half of the trap');
}

// --- conversation drift: rebound to a different conversation
{
  const other = armedGrant(binding, 'background', NOW);
  other.bindingRevision = binding.revision;
  other.conversationId = CONV2;
  bg.local.set('autosend', other);
  const report = await ask(healthy);
  const match = item(report, 'grant_binding_match');
  check(match.state === 'bad' && match.code === 'conversation_changed',
    'a grant for another conversation is a bad conversation_changed item (' +
    match.state + '/' + match.code + ')');
  check((report.blockedBy || []).includes('conversation_changed'),
    'and it is named in blockedBy (' + JSON.stringify(report.blockedBy) + ')');
  check(String(match.detail).includes(CONV1) && String(match.detail).includes(CONV2),
    'its detail names both conversations (' + match.detail + ')');
}

// --- document drift: same URL, same conversation, a different document instance
{
  const other = armedGrant(binding, 'background', NOW);
  other.bindingRevision = binding.revision;
  other.conversationId = binding.conversationId;
  other.documentInstanceId = DOC_B;
  bg.local.set('autosend', other);
  const report = await ask(healthy);
  const match = item(report, 'grant_binding_match');
  check(match.state === 'bad' && match.code === 'document_instance_changed',
    'a grant pinned to another document is a bad document_instance_changed item (' +
    match.state + '/' + match.code + ')');
  check((report.blockedBy || []).includes('document_instance_changed'),
    'and it is named in blockedBy (' + JSON.stringify(report.blockedBy) + ')');
}

// --- the read failing must never be reported as ok
{
  bg.local.set('autosend', armedGrant(binding, 'background', NOW));
  const thrown = await ask(null, {
    bindingHealth: async () => { throw new Error('probe exploded'); },
  });
  const match = item(thrown, 'grant_binding_match');
  check(match.state !== 'ok',
    'an unreadable binding is never ok in the match item (' + match.state + ')');
  check(item(thrown, 'binding_healthy').state === 'bad',
    'and the binding row itself reports the failure (' +
    item(thrown, 'binding_healthy').code + ')');

  const unknownHealth = await ask({ ok: false, status: 'binding_unavailable',
    reason: 'probe_timeout' });
  const noRecord = item(unknownHealth, 'grant_binding_match');
  check(noRecord.state !== 'ok',
    'a verdict with no binding record is never ok either (' + noRecord.state + ')');

  const unbound = await ask({ ok: false, status: 'not_bound', binding: null });
  const none = item(unbound, 'grant_binding_match');
  check(none.state !== 'ok', 'and "never bound" is not ok (' + none.state + ')');
}

// --- no grant at all: the existing rows carry the verdict, the match item must not lie
{
  bg.local.delete('autosend');
  const report = await ask(healthy);
  const match = item(report, 'grant_binding_match');
  check(match.id === undefined || match.state !== 'ok',
    'with no grant the match item is absent or not-ok (' + match.state + ')');
  check(item(report, 't058_authorized').state === 'bad',
    'and T058 is the row that says so (' + item(report, 't058_authorized').code + ')');
}

// --- a corrupt grant revision is reported as the refusal decide() would produce
{
  const broken = armedGrant(binding, 'background', NOW);
  broken.bindingRevision = null;
  bg.local.set('autosend', broken);
  const report = await ask(healthy);
  const match = item(report, 'grant_binding_match');
  // `null !== 1`, so `decide()` refuses `binding_changed`. The row must predict that
  // refusal, not soften it into a pass: "unreadable" is not "matching".
  check(match.state === 'bad' && match.code === 'binding_changed',
    'a grant with no readable revision is a bad binding_changed (' + match.state +
    '/' + match.code + ')');
  check(match.ok === false, 'and it is never counted as ready');
}
// --- a legacy grant that pinned no document: decide() falls back, and so does the row
{
  const legacy = armedGrant(binding, 'background', NOW);
  legacy.bindingRevision = binding.revision;
  legacy.documentInstanceId = null;      // `autosend.js:211` stores null when absent
  bg.local.set('autosend', legacy);
  const report = await ask(healthy);
  const match = item(report, 'grant_binding_match');
  check(match.state === 'ok',
    'a grant that pinned no document is not a mismatch (' + match.state + '/' +
    match.code + ')');
  check(String(match.detail).includes('document=未固定'),
    'and the row says the document was not pinned (' + match.detail + ')');
}

// =====================================================================
section('T059/D  the two candidate lists are different things');
// =====================================================================
{
  // `target_binding_controller` clears *its own* scan candidates, which live in
  // session storage. The notification queue is `storage.local.terminalCandidates`.
  // Proving that mapping is the whole point: T058 claimed the rebind drained the
  // notification queue, and it does not.
  check(WIRE.TRIGGER_CANDIDATES_KEY === 'terminalCandidates',
    'the notification queue key is terminalCandidates (' + WIRE.TRIGGER_CANDIDATES_KEY + ')');
  const w2 = world();
  const first = await bindOne(w2);
  const scanCandidatesAfterBind = (w2.session.get('t053TargetBindingState') || {})
    .candidates;
  check(Array.isArray(scanCandidatesAfterBind) && scanCandidatesAfterBind.length === 0,
    'a confirmed bind empties the scan candidates in session storage (' +
    JSON.stringify(scanCandidatesAfterBind) + ')');
  // A queued notification candidate, sitting in local storage where the trigger reads it.
  w2.local.set('terminalCandidates', [{ runId: RUN1, status: 'completed', startedAt: 1 }]);
  const wire = WIRE.createChromeAutoSend(w2.chrome, {
    probeSpecificTab: PRE.probeSpecificTab,
    getBindingState: () => first.controller.getState(),
    now: () => w2.now,
  });
  check((await wire.readCandidates()).length === 1,
    'the notification queue is readable through the wiring');
  // Rebind: same tab, same conversation, another confirmed bind.
  const again = await first.controller.scan();
  const cand = again.candidates[0];
  check(Boolean(cand), 'the tab is still scannable for a second bind');
  // A second bind over an existing record needs the REPLACE phrase, which is what
  // `bindingConfirmation(previous, candidate)` builds -- the same call the popup's
  // confirmation line comes from.
  const previous = first.binding;
  const rebound = await first.controller.bind(cand.token,
    P.bindingConfirmation(previous, {
      tabId: cand.tabId, windowId: cand.windowId, url: cand.url,
      conversationId: cand.conversationId,
    }));
  check(rebound.ok === true, 'the second bind succeeds (' + rebound.status + ')');
  check(rebound.binding.revision === 2,
    'and it bumps the binding revision (' + rebound.binding.revision + ')');
  const survivors = await wire.readCandidates();
  check(survivors.length === 1 && survivors[0].runId === RUN1,
    'the notification queue survives a rebind untouched (' + JSON.stringify(survivors) + ')');
  // And the grant armed before that rebind is now stale -- the pair the panel missed.
  const beforeRebind = armedGrant(first.binding, 'background', NOW);
  check(beforeRebind.bindingRevision === 1 && rebound.binding.revision === 2,
    'a grant armed before the rebind is pinned to the old revision (' +
    beforeRebind.bindingRevision + ' vs ' + rebound.binding.revision + ')');
}

console.log('');
console.log('T059: ' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length > 0) {
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
