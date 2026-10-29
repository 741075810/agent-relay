// T095B76: reloading the extension must not cost the operator a page refresh and a
// fresh T053 binding.
//
// Two defects, found from the live install rather than from reading the code:
//
//   01:22:12.784  reload on chrome://extensions  ->  onInstalled
//   01:22:43.497  terminal tick                  ->  blocked, `target_not_bound`
//   autosend      conversationId 6ae2fb9a…, documentInstanceId 51fac95d…   intact
//
// The grant lived in `storage.local` and survived; the binding lived in
// `storage.session` and did not. And the content script in the open tab was
// orphaned, so even a surviving binding had nothing to measure. A refresh brings a
// script back but creates a new document, which correctly invalidates the binding --
// so the refresh never helped either, it only moved the problem to the re-bind step.
//
// What this suite pins down is the replacement boundary, not just the repair:
//
//   * a binding survives the reload and is re-verified, never simply trusted;
//   * the observer is re-injected into the bound tab only, and only when a probe has
//     proven there is no receiver -- a timeout is not proof;
//   * a new document is still a new document: same URL, new time origin, binding
//     invalidated, operator asked again;
//   * a different tab is still a different tab;
//   * the binding revision and the grant are untouched by any of it, so nothing here
//     can re-authorise a write that the operator did not authorise;
//   * one document gets one writer, even if two listeners exist;
//   * and T095B75's terminal-alarm restore still works.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');

let passed = 0;
const failures = [];
function check(ok, label) {
  if (ok) { passed += 1; return; }
  failures.push(label);
  console.log('  FAIL  ' + label);
}
function section(title) { console.log('== ' + title); }

const CONV = '11111111-2222-4333-8444-555555555555';
const URL_OK = 'https://chatgpt.com/c/' + CONV;
const URL_OTHER = 'https://chatgpt.com/c/99999999-8888-4777-8666-555555555555';

const BM = await mod('./extension/lib/binding_mirror.js');
const CR = await mod('./extension/lib/content_reconnect.js');

// --------------------------------------------------------------- fakes
function fakeAreas() {
  const session = new Map();
  const local = new Map();
  const writes = { session: [], local: [] };
  const area = (map, name) => ({
    async get(defaults) {
      const out = {};
      for (const [k, v] of Object.entries(defaults || {})) {
        out[k] = map.has(k) ? JSON.parse(JSON.stringify(map.get(k))) : v;
      }
      return out;
    },
    async set(items) {
      writes[name].push(Object.keys(items || {}).slice().sort().join(','));
      for (const [k, v] of Object.entries(items || {})) {
        map.set(k, JSON.parse(JSON.stringify(v)));
      }
    },
    async remove(key) { map.delete(key); },
    put(key, value) { map.set(key, JSON.parse(JSON.stringify(value))); },
    has(key) { return map.has(key); },
    peek(key) { return map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null; },
  });
  return {
    session: area(session, 'session'), local: area(local, 'local'),
    sessionMap: session, localMap: local, writes,
  };
}

function bindingRecord(extra) {
  return Object.assign({
    version: 1, revision: 4,
    binding: {
      tabId: 7, windowId: 3, revision: 4, url: URL_OK, conversationId: CONV,
      documentInstanceId: 'doc-4a5b6c7d8e9f0a1b2c3d4e5f60718293',
      manuallyConfirmed: true, userGesture: true, confirmedAt: 5000,
    },
    candidates: [],
    candidateScannedAt: null,
  }, extra || {});
}

// A browser surface for the reconnect: real tab list, real injection log.
// `clock` exists because a probe is only valid inside the freshness window, so the
// fake content script has to stamp `observedAt` from the same clock the probe compares
// against -- a wall clock here would make every probe `probe_stale` and hide whatever
// the test was actually asking about.
function fakeBrowser(tabs) {
  const log = { injected: [], tabGets: [], sendMessage: [] };
  const clock = { now: 1_700_000_000_000 };
  const live = new Map();
  for (const tab of tabs) live.set(tab.id, Object.assign({}, tab));
  return {
    log,
    clock,
    live,
    api: {
      tabs: {
        async get(id) {
          log.tabGets.push(id);
          const tab = live.get(id);
          return tab ? Object.assign({}, tab) : undefined;
        },
        async sendMessage(id, msg) {
          log.sendMessage.push({ id, type: msg && msg.type });
          const script = scriptFor(id);
          if (!script) {
            // Exactly the error Chrome raises when a content script is gone.
            throw new Error('Could not establish connection. Receiving end does not exist.');
          }
          return script(msg);
        },
      },
      scripting: {
        async executeScript(spec) {
          log.injected.push(JSON.parse(JSON.stringify(spec)));
          const id = spec.target && spec.target.tabId;
          const tab = live.get(id);
          // In a browser this would run content.js and install a listener. Here it
          // installs the fake listener that the tab's script stands for.
          if (tab) scripts.set(id, tab.makeScript ? tab.makeScript() : defaultScript(tab, clock));
          return [{ frameId: 0, result: null }];
        },
      },
    },
  };
}
const scripts = new Map();
function scriptFor(id) { return scripts.get(id) || null; }
function defaultScript(tab, clock) {
  return (msg) => {
    if (msg && msg.type === 'readonly-probe') {
      return { type: 'readonly-probe-response', requestId: msg.requestId,
        documentInstanceId: tab.documentInstanceId, url: tab.url,
        conversationId: CONV, routeStable: true, observedAt: clock.now,
        visibilityState: 'hidden', hasFocus: false, composerPresent: true,
        pageLoaded: true };
    }
    return { ok: true, result: { status: 'refused', reason: 'not_a_write_test' } };
  };
}

// =====================================================================
// 1. The binding comes back after the session area is cleared
// =====================================================================
section('T095B76/1  a reload clears the session area, and the binding comes back');
{
  const areas = fakeAreas();
  const original = bindingRecord();
  areas.session.put(BM.BINDING_KEY, original);
  areas.local.put(BM.BINDING_MIRROR_KEY, original);

  // The reload: session is gone, local is not. That is the whole defect.
  areas.sessionMap.clear();
  check(areas.session.has(BM.BINDING_KEY) === false, 'the reload really did clear session');
  check(areas.local.has(BM.BINDING_MIRROR_KEY) === true, 'while the mirror survived');

  const restored = [];
  const mirrored = BM.createMirroredSession(
    { session: areas.session, local: areas.local },
    { now: () => 7777, onRestore: (event) => restored.push(event) },
  );
  const got = await mirrored.get({ [BM.BINDING_KEY]: null });
  check(got[BM.BINDING_KEY] !== null && got[BM.BINDING_KEY] !== undefined,
    'the state read returns the binding again');
  check(got[BM.BINDING_KEY] && got[BM.BINDING_KEY].revision === 4,
    'with the same revision it had before ('
    + (got[BM.BINDING_KEY] && got[BM.BINDING_KEY].revision) + ')');
  check(JSON.stringify(got[BM.BINDING_KEY]) === JSON.stringify(original),
    'byte-identical: no field added, none dropped');
  check(areas.session.has(BM.BINDING_KEY), 'and the session copy is seeded again');
  check(got[BM.BINDING_RESTORED_AT_KEY] === 7777,
    'the read says when it was restored (' + got[BM.BINDING_RESTORED_AT_KEY] + ')');
  check(restored.length === 1 && restored[0].revision === 4,
    'and the restore event names the revision it restored');
}

// =====================================================================
// 2. Restoring a record must not restore permission
// =====================================================================
section('T095B76/2  an invalidated binding stays invalidated across the reload');
{
  const areas = fakeAreas();
  const invalid = bindingRecord();
  invalid.binding.invalidatedReason = 'navigation_or_redirect';
  invalid.binding.invalidatedAt = 6000;
  areas.local.put(BM.BINDING_MIRROR_KEY, invalid);
  const mirrored = BM.createMirroredSession(
    { session: areas.session, local: areas.local }, { now: () => 1 });
  const got = await mirrored.get({ [BM.BINDING_KEY]: null });
  const b = got[BM.BINDING_KEY] && got[BM.BINDING_KEY].binding;
  check(b && b.invalidatedReason === 'navigation_or_redirect',
    'the invalidation reason comes back with it ('
    + (b && b.invalidatedReason) + ')');
  check(b && b.invalidatedAt === 6000, 'and so does its timestamp');
}

// =====================================================================
// 3. A malformed mirror is ignored, never repaired
// =====================================================================
section('T095B76/3  a mirror that does not validate is not used');
{
  const shapes = [
    ['no version', { revision: 1, binding: null, candidates: [], candidateScannedAt: null }],
    ['negative revision', { version: 1, revision: -1, binding: null, candidates: [],
      candidateScannedAt: null }],
    ['candidates not a list', { version: 1, revision: 1, binding: null,
      candidates: {}, candidateScannedAt: null }],
    ['binding missing tabId', { version: 1, revision: 1,
      binding: { windowId: 1, revision: 1, url: URL_OK, conversationId: CONV,
        documentInstanceId: 'doc-x' }, candidates: [], candidateScannedAt: null }],
    ['binding is a string', { version: 1, revision: 1, binding: 'nope',
      candidates: [], candidateScannedAt: null }],
    ['not an object', 'nope'],
  ];
  for (const [label, value] of shapes) {
    check(BM.isMirrorableState(value) === false, 'rejected: ' + label);
  }
  const areas = fakeAreas();
  areas.local.put(BM.BINDING_MIRROR_KEY, { version: 1, revision: 'x' });
  const mirrored = BM.createMirroredSession(
    { session: areas.session, local: areas.local }, { now: () => 1 });
  const got = await mirrored.get({ [BM.BINDING_KEY]: null });
  check(got[BM.BINDING_KEY] === null,
    'an invalid mirror leaves the state unbound rather than half-restored');
  check(areas.local.has(BM.BINDING_MIRROR_KEY), 'and it is left in place, not deleted');
}

// =====================================================================
// 4. Writes go to both areas; clearing clears both
// =====================================================================
section('T095B76/4  the mirror follows the controller, and clearing clears both');
{
  const areas = fakeAreas();
  const mirrored = BM.createMirroredSession(
    { session: areas.session, local: areas.local }, { now: () => 1 });
  const fresh = bindingRecord();
  await mirrored.set({ [BM.BINDING_KEY]: fresh });
  check(JSON.stringify(areas.local.peek(BM.BINDING_MIRROR_KEY)) === JSON.stringify(fresh),
    'a confirm writes the mirror as well as the session copy');
  const cleared = Object.assign({}, fresh, { revision: 5, binding: null });
  await mirrored.set({ [BM.BINDING_KEY]: cleared });
  // The controller clears by storing a state whose `binding` is null, not by removing
  // the key. The mirror has to copy that as it is: a mirror that turned "cleared" into
  // "absent" would resurrect the previous binding the next time local was read.
  const stored = areas.local.peek(BM.BINDING_MIRROR_KEY);
  check(stored && stored.binding === null && stored.revision === 5,
    'the cleared state is mirrored as cleared, revision 5 ('
    + JSON.stringify(stored && { binding: stored.binding, revision: stored.revision }) + ')');
  const got = await mirrored.get({ [BM.BINDING_KEY]: null });
  check(got[BM.BINDING_KEY] && got[BM.BINDING_KEY].binding === null,
    'a read after the reload returns the cleared state, not the old binding');
  // `remove` is the other way a state can disappear, and it must clear both copies.
  await mirrored.remove(BM.BINDING_KEY);
  check(areas.local.has(BM.BINDING_MIRROR_KEY) === false &&
    areas.session.has(BM.BINDING_KEY) === false,
    'an explicit remove clears the session copy and the mirror together');
  const afterRemove = await mirrored.get({ [BM.BINDING_KEY]: null });
  check(afterRemove[BM.BINDING_KEY] === null, 'and nothing comes back afterwards');
  // A key that is not the binding is passed straight through and never mirrored.
  await mirrored.set({ someOtherKey: 1 });
  check(areas.localMap.size === 0 || !areas.local.has('someOtherKey'),
    'other session keys are not copied into local');
}

// =====================================================================
// 5. The observer is put back into the bound tab, and only that tab
// =====================================================================
section('T095B76/5  reconnection targets the bound tab and nothing else');
{
  scripts.clear();
  const browser = fakeBrowser([
    { id: 7, windowId: 3, url: URL_OK, documentInstanceId: 'doc-7aaaaaaaaaaaaaaaaaaa' },
    { id: 8, windowId: 3, url: URL_OK, documentInstanceId: 'doc-8bbbbbbbbbbbbbbbbbbb' },
    { id: 9, windowId: 3, url: URL_OTHER, documentInstanceId: 'doc-9ccccccccccccccccccc' },
  ]);
  const target = { tabId: 7, url: URL_OK, conversationId: CONV };
  const out = await CR.ensureContentScript(browser.api, target);
  check(out.ok === true && out.code === CR.RECONNECT_CODES.injected,
    'the bound tab is re-injected (' + out.code + ')');
  check(browser.log.injected.length === 1, 'exactly one injection happened');
  check(browser.log.injected[0].target.tabId === 7,
    'and it named tab 7, not another one (' + browser.log.injected[0].target.tabId + ')');
  check(JSON.stringify(browser.log.injected[0].files) === JSON.stringify(['content.js']),
    'by re-running the shipped file rather than arbitrary code ('
    + JSON.stringify(browser.log.injected[0]) + ')');
  check(!('func' in browser.log.injected[0]) && !('world' in browser.log.injected[0]),
    'no injected function and no main-world switch');
}

// =====================================================================
// 6. Refusals: a moved tab, a non-conversation URL, a missing tab
// =====================================================================
section('T095B76/6  the reconnect refuses every case it cannot prove');
{
  scripts.clear();
  const browser = fakeBrowser([
    { id: 7, windowId: 3, url: URL_OTHER, documentInstanceId: 'doc-7aaaaaaaaaaaaaaaaaaa' },
    { id: 11, windowId: 3, url: 'https://chatgpt.com/', documentInstanceId: 'doc-dddddddddddddddddddd' },
  ]);
  const moved = await CR.ensureContentScript(browser.api,
    { tabId: 7, url: URL_OK, conversationId: CONV });
  check(moved.ok === false && moved.code === CR.RECONNECT_CODES.urlChanged,
    'a tab that moved is not re-injected (' + moved.code + ')');
  const notConversation = await CR.ensureContentScript(browser.api,
    { tabId: 11, url: 'https://chatgpt.com/', conversationId: CONV });
  check(notConversation.ok === false &&
    notConversation.code === CR.RECONNECT_CODES.notConversation,
    'a non-conversation URL is not re-injected (' + notConversation.code + ')');
  const gone = await CR.ensureContentScript(browser.api,
    { tabId: 404, url: URL_OK, conversationId: CONV });
  check(gone.ok === false && gone.code === CR.RECONNECT_CODES.tabGone,
    'a tab that no longer exists is not re-injected (' + gone.code + ')');
  const noScripting = await CR.ensureContentScript({ tabs: browser.api.tabs },
    { tabId: 7, url: URL_OTHER });
  check(noScripting.ok === false &&
    noScripting.code === CR.RECONNECT_CODES.unsupported,
    'and without the scripting surface it refuses rather than throwing ('
    + noScripting.code + ')');
  check(browser.log.injected.length === 0, 'no injection happened in any of those cases');
}

// =====================================================================
// 7. Only a proven "no receiver" triggers the retry
// =====================================================================
section('T095B76/7  a timeout is not proof that the script is gone');
{
  const calls = [];
  const events = [];
  const probe = CR.createResilientProbe({
    probeSpecificTab: async (api, target) => {
      calls.push('probe');
      return { status: 'probe_timeout', tabId: target.tabId };
    },
    reconnect: async () => { calls.push('reconnect'); return { ok: true, attempted: true }; },
    onEvent: (event) => events.push(event),
    now: () => 1,
  });
  const out = await probe({}, { tabId: 7, url: URL_OK, conversationId: CONV });
  check(out.status === 'probe_timeout', 'the timeout is reported as a timeout');
  check(calls.length === 1 && calls[0] === 'probe',
    'and nothing was injected on the strength of it (' + JSON.stringify(calls) + ')');
  check(events.length === 0, 'no reconnect event was recorded');
}

// =====================================================================
// 8. The retry happens once, then the tab is measured again
// =====================================================================
section('T095B76/8  a proven lost script is repaired and re-measured');
{
  scripts.clear();
  const browser = fakeBrowser([
    { id: 7, windowId: 3, url: URL_OK, documentInstanceId: 'doc-7aaaaaaaaaaaaaaaaaaa' },
  ]);
  const preflight = await mod('./extension/lib/readonly_preflight.js');
  const target = { tabId: 7, windowId: 3, url: URL_OK, conversationId: CONV };
  const clock = () => browser.clock.now;
  const before = await preflight.probeSpecificTab(browser.api, target, { now: clock });
  check(before.status === 'content_unavailable',
    'the pre-reload state really is "no receiving end" (' + before.status + ')');

  const events = [];
  const resilient = CR.createResilientProbe({
    probeSpecificTab: preflight.probeSpecificTab,
    reconnect: (api, t) => CR.ensureContentScript(api, t),
    onEvent: (event) => events.push(event),
    now: clock,
  });
  const after = await resilient(browser.api, target, { now: clock });
  check(browser.log.injected.length === 1, 'one injection was made');
  check(after.reconnected === true, 'the result is marked as re-measured');
  check(after.status === 'background_observable',
    'and the tab answers with a complete measurement (' + after.status + ')');
  check(after.documentInstanceId === 'doc-7aaaaaaaaaaaaaaaaaaa',
    'reporting the same document it did before the reload ('
    + after.documentInstanceId + ')');
  check(after.sendEligible === false, 'the probe is still observation only');
  check(events.length === 1 && events[0].attempt.ok === true,
    'the repair is recorded once');
  const again = await resilient(browser.api, target, { now: clock });
  check(again.status === 'background_observable' &&
    browser.log.injected.length === 1,
    'a second probe does not inject again (' + browser.log.injected.length + ')');
}

// =====================================================================
// 9. Two documents at one URL: the identity still separates them
// =====================================================================
section('T095B76/9  a new document at the same URL is still a new document');
{
  const content = read('extension/content.js');
  // The derivation is a function of the document's clock and nothing else, so two
  // time origins must give two ids and one time origin one id. Evaluated for real,
  // from the shipped file, with the page's globals supplied.
  const load = (timeOrigin) => {
    let id = null;
    const chrome = {
      runtime: {
        id: 't', getURL: () => 'chrome-extension://t/lib/send_adapter.js',
        onMessage: { addListener: (fn) => { id = fn; } },
        sendMessage: () => {},
      },
    };
    const doc = {
      querySelectorAll: () => [], addEventListener: () => {},
      visibilityState: 'hidden', hasFocus: () => false, readyState: 'complete',
    };
    // eslint-disable-next-line no-new-func
    const run = new Function('chrome', 'document', 'location', 'URL', 'crypto', 'Date',
      'performance', content);
    run(chrome, doc, { href: URL_OK, pathname: '/c/' + CONV }, URL,
      { randomUUID: () => 'random-' + Math.random() }, Date,
      timeOrigin === null ? {} : { timeOrigin });
    let answer = null;
    id({ type: 'readonly-probe', requestId: 'r1' }, {}, (reply) => { answer = reply; });
    return answer;
  };
  const first = load(1.6e12);
  const sameDocument = load(1.6e12);
  const newDocument = load(1.6e12 + 0.001);
  check(typeof first.documentInstanceId === 'string' &&
    first.documentInstanceId.length >= 16,
    'a document reports a usable id (' + first.documentInstanceId + ')');
  check(first.documentInstanceId === sameDocument.documentInstanceId,
    're-evaluating in the same document reproduces it exactly -- this is what makes a '
    + 'reconnect keep the binding');
  check(first.documentInstanceId !== newDocument.documentInstanceId,
    'a document created a millisecond later gets its own id ('
    + first.documentInstanceId + ' vs ' + newDocument.documentInstanceId + ')');
  check(!/^\d+$/.test(first.documentInstanceId.replace(/^doc-/, '')),
    'the id is mixed, not the raw time origin');
  const noClock = load(null);
  check(typeof noClock.documentInstanceId === 'string',
    'without a time origin it still answers, falling back to a per-instance id');
  check(noClock.documentInstanceId.startsWith('random-'),
    'and that fallback is visibly per-instance, not a guess dressed as a document ('
    + noClock.documentInstanceId + ')');
}

// =====================================================================
// 10. One document, one writer
// =====================================================================
section('T095B76/10  a second listener in the same document cannot write');
{
  const content = read('extension/content.js');
  const listeners = [];
  const chrome = {
    runtime: {
      id: 't', getURL: () => 'chrome-extension://t/lib/send_adapter.js',
      onMessage: { addListener: (fn) => { listeners.push(fn); } },
      sendMessage: () => {},
    },
  };
  const doc = {
    querySelectorAll: () => [], addEventListener: () => {},
    visibilityState: 'hidden', hasFocus: () => false, readyState: 'complete',
  };
  const world = {};
  // A fresh value per evaluation, exactly like `crypto.randomUUID()`. With a constant
  // here, two listeners would agree on the id no matter how the id was derived, and
  // the agreement check below would prove nothing.
  let uuidCalls = 0;
  // eslint-disable-next-line no-new-func
  const run = new Function('chrome', 'document', 'location', 'URL', 'crypto', 'Date',
    'performance', 'globalThis', content);
  const load = () => run(chrome, doc, { href: URL_OK, pathname: '/c/' + CONV }, URL,
    { randomUUID: () => 'random-' + (uuidCalls += 1) }, Date, { timeOrigin: 1.6e12 }, world);
  load();
  load();                                  // the second listener, same isolated world
  check(listeners.length === 2, 'the rig really did install two listeners');

  // Both listeners are in one document, so they must report one id. Asking each for a
  // probe is also how the test learns the id it has to name in the write message --
  // the document check runs before the latch, so a wrong id would be refused for the
  // wrong reason and prove nothing about the latch.
  const ask = (fn) => new Promise((resolve) => {
    fn({ type: 'readonly-probe', requestId: 'p1' }, {}, resolve);
  });
  const idA = (await ask(listeners[0])).documentInstanceId;
  const idB = (await ask(listeners[1])).documentInstanceId;
  check(idA === idB && typeof idA === 'string',
    'two listeners in one document agree on the document id (' + idA + ')');

  // The first write is in flight and has not returned: the latch is what a second
  // listener would have to pass to write a second notice.
  world.__dshWriteInFlight = true;
  let refused = null;
  listeners[1]({ type: 't058-write-notice', runId: 'r', status: 'completed',
    expectedConversationId: CONV, expectedDocumentInstanceId: idA,
    deliveryMode: 'background' }, {}, (reply) => { refused = reply; });
  check(refused && refused.result && refused.result.reason === 'concurrent_write_in_flight',
    'the second one refuses with a named reason ('
    + (refused && refused.result && refused.result.reason) + ')');
  check(refused.result.composerTouched === false &&
    refused.result.composerWritten === false &&
    refused.result.clickPerformed === false,
    'and it did none of the three things that would matter');
  // The latch is per document, not a permanent wedge: once the first write finishes,
  // the next one is allowed through to the ordinary checks.
  world.__dshWriteInFlight = false;
  let afterRelease = null;
  listeners[1]({ type: 't058-write-notice', runId: 'r', status: 'completed',
    expectedConversationId: CONV, expectedDocumentInstanceId: 'a-different-document-id',
    deliveryMode: 'background' }, {}, (reply) => { afterRelease = reply; });
  check(afterRelease && afterRelease.result &&
    afterRelease.result.reason === 'document_instance_changed',
    'and once released, the ordinary identity check is what refuses ('
    + (afterRelease && afterRelease.result && afterRelease.result.reason) + ')');
}

// =====================================================================
// 11. The reload still restores the terminal timer, and the binding state
//     the grant points at is the one that was confirmed
// =====================================================================
section('T095B76/11  reload: timer restored, revision and grant untouched');
{
  const background = read('extension/background.js');
  check(background.includes('await restoreTerminalAlarm();'),
    'T095B75\'s awaited restore is still in onInstalled');
  check(background.includes('restoreTerminalAlarm().catch(() => {});'),
    'and still in onStartup');
  check(background.includes('createMirroredSession'),
    'the binding area is the mirrored one');
  check(/session: bindingSession,/.test(background),
    'and the controller is given it, not the raw session area');
  check(background.includes('probeHealth: resilientProbe'),
    'health uses the reconnect-aware probe');
  check(/probeSpecificTab: resilientProbe/.test(background),
    'and so does the send path');
  check(!background.includes('chrome.tabs.update') &&
    !background.includes('executeScript'),
    'while nothing in the background navigates a tab or injects directly');

  const controller = read('extension/lib/target_binding_controller.js');
  check(/const probeHealth = typeof options\.probeHealth === 'function'/
    .test(controller), 'the controller takes the health probe as a seam');
  check(/snapshot = await probeHealth\(api, binding, probeOptions\)/
    .test(controller), 'and uses it for health');
  check(/snapshot = await probeSpecificTab\(api, candidate, probeOptions\)/
    .test(controller),
    'while a candidate bind uses the plain probe: nobody confirmed that tab yet');
  check(!/revision = .*\+ 1/.test(controller.slice(controller.indexOf('async function health'),
    controller.indexOf('async function health') + 400)),
    'health does not bump the revision, so a restored binding still matches its grant');

  const policy = read('extension/lib/target_binding.js');
  check(/probe\.documentInstanceId !== binding\.documentInstanceId/.test(policy),
    'the document comparison that invalidates on a real reload is untouched');
  check(/'content_unavailable'/.test(policy) === false,
    'and "no receiver" is not an invalidating state, so a lost script is recoverable');
}

console.log('');
console.log('RESULT: ' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
