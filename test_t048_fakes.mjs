// T048: background-tab delivery.
//
// The user's requirement, in one line: a DSH task completes while the ChatGPT tab
// is in the background -- another app focused, the tab inactive, the document
// hidden -- and the notice must still arrive, so ChatGPT can answer and the next
// task can follow. Yesterday this worked only while the tab was in the foreground.
//
// What actually blocks it today, measured before the fix (see the first section,
// which is the fail-first reproduction and does not need the new code):
//
//   1. `autosend.decide()` requires `probe.active === true && probe.hasFocus ===
//      true && visibilityState === 'visible'`, so a background tab is refused
//      `target_not_visible_and_focused`;
//   2. `send_adapter.deliverInto()` re-checks `doc.hasFocus()` before writing and
//      refuses `target_focus_lost`;
//   3. and again before the click, where it becomes `writtenNoClick` ->
//      `unconfirmed`, which is a stop state.
//
// T076 made (1) a deferral instead of a permanent stop, which was correct and is
// not the same as delivering. Nothing in T076 ever sent from a background tab.
//
// The mode added here is *separate* from the T058 foreground grant and cannot be
// reached by it: it needs a different confirmation phrase, and every existing
// grant keeps tomorrow's semantics (absent field == foreground).
//
// Everything below is a fake page and a fake `chrome`. No browser, no ChatGPT, no
// network, no real message. The one thing not claimed here is that ChatGPT's own
// front end accepts a programmatic submit from a hidden tab -- that needs one
// real canary, and the report says so.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const CONV = 'b81e2f34-5a6b-4c7d-9e0f-1a2b3c4d5e6f';
const CONV2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const RUN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RUN2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const URL_OK = 'https://chatgpt.com/c/' + CONV;
const DOC = 'doc-instance-0001';
const FG_PHRASE = 'AUTOSEND ' + CONV;
const BG_PHRASE = 'AUTOSEND-BACKGROUND ' + CONV;

// ------------------------------------------------ real modules, loaded as .mjs
const dir = mkdtempSync(join(tmpdir(), 't048-'));
for (const name of ['send_gate', 'send_adapter', 'autosend', 'autosend_controller',
  'autosend_chrome_wiring', 'terminal_trigger', 'readonly_preflight']) {
  const source = readFileSync(
    new URL(`./extension/lib/${name}.js`, import.meta.url), 'utf8')
    .replace(/from '\.\/([a-z_]+)\.js'/g, "from './$1.mjs'")
    .replace(/from '\.\/([a-z_]+)\.js';/g, "from './$1.mjs';");
  writeFileSync(join(dir, name + '.mjs'), source);
}
const A = await import(pathToFileURL(join(dir, 'send_adapter.mjs')).href);
const AS = await import(pathToFileURL(join(dir, 'autosend.mjs')).href);
const WIRE = await import(pathToFileURL(join(dir, 'autosend_chrome_wiring.mjs')).href);
const TT = await import(pathToFileURL(join(dir, 'terminal_trigger.mjs')).href);
const PRE = await import(pathToFileURL(join(dir, 'readonly_preflight.mjs')).href);
const NOTICE = A.composeNotice(RUN, 'completed').text;

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
    constructor(callback) { this.callback = callback; }
    observe() { live.add(this); }
    disconnect() { live.delete(this); }
    trigger() { if (typeof this.callback === 'function') this.callback([]); }
  }
  return { FakeObserver, notify() { for (const o of [...live]) o.trigger(); }, live };
}

// -------------------------------------------------------- tiny selector engine
function parseSelector(sel) {
  return String(sel).trim().split(/\s+/).map((part) => {
    const head = part.match(/^([a-zA-Z][a-zA-Z0-9]*)?(.*)$/);
    const attrs = [];
    const classes = [];
    const re = /\[([a-zA-Z-]+)(?:(\*?=)"([^"]*)")?\]|\.([A-Za-z0-9_-]+)/g;
    let hit;
    while ((hit = re.exec(head[2] || ''))) {
      if (hit[1]) attrs.push({ name: hit[1], op: hit[2] || null, value: hit[3] });
      else classes.push(hit[4]);
    }
    return { tag: head[1] || null, attrs, classes };
  });
}
function matchesPart(node, part) {
  if (part.tag && node.tag !== part.tag) return false;
  for (const c of part.classes) if (!(node.classList || []).includes(c)) return false;
  for (const a of part.attrs) {
    const value = node.getAttribute(a.name);
    if (value === null || value === undefined) return false;
    if (a.op === '=' && String(value) !== a.value) return false;
    if (a.op === '*=' && !String(value).includes(a.value)) return false;
  }
  return true;
}
function matches(node, sel) {
  const parts = parseSelector(sel);
  if (!matchesPart(node, parts[parts.length - 1])) return false;
  let cursor = node;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const found = (cursor.parents || []).find((p) => matchesPart(p, parts[i]));
    if (!found) return false;
    cursor = found;
  }
  return true;
}

function makeNode(spec) {
  const attrs = spec.attrs || {};
  const self = {
    tag: spec.tag || 'div',
    classList: spec.classes || [],
    parents: spec.parents || [],
    disabled: spec.disabled === true,
    connected: spec.connected !== false,
    rect: spec.rect || { width: 30, height: 30 },
    clicks: 0,
    focusCalls: 0,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    getBoundingClientRect() { return self.connected ? self.rect : { width: 0, height: 0 }; },
    closest(sel) {
      if (matches(self, sel)) return self;
      for (const p of self.parents || []) if (matches(p, sel)) return p;
      return null;
    },
    focus() { self.focusCalls += 1; },
    dispatchEvent(event) { if (self.onDispatch) self.onDispatch(event); return true; },
    get isConnected() { return self.connected; },
  };
  return self;
}

const KNOWN = new Set([
  'div[contenteditable="true"][data-testid="prompt-textarea"]',
  'div[contenteditable="true"].ProseMirror',
  'textarea[data-testid="prompt-textarea"]',
  'form div[contenteditable="true"]',
  'button[data-testid="send-button"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="发送"]',
  'form button[type="submit"]',
  '[data-user-message-bubble]',
  '[data-message-author-role="user"]',
  'button',
  'form button',
]);

// ------------------------------------------------------------- the fake page
//
// `options.visibilityState` and `options.focused` are the two facts that decide
// foreground vs background. Everything else mirrors the layout T081 measured: an
// empty composer plus four input-area controls, and a single send button that the
// page creates only once the composer has text.
function createPage(options = {}) {
  const clock = options.clock || createClock();
  const registry = options.registry || createObserverRegistry();
  const path = options.path || '/c/' + CONV;
  const all = [];
  const clicks = [];
  const messages = [];
  let focused = options.focused !== false;
  let visibility = options.visibilityState || 'visible';
  let focusCalls = 0;

  const form = makeNode({ tag: 'form', parents: [] });
  all.push(form);
  const composer = makeNode({
    tag: 'div', classes: ['ProseMirror'],
    attrs: { contenteditable: 'true', 'data-testid': 'prompt-textarea' },
    parents: [form], rect: { width: 600, height: 80 },
  });
  let text = options.draft || '';
  // A controlled React input only accepts text it believes a user typed. When the
  // page is told to ignore synthetic input, assigning `value` must not stick --
  // otherwise the fake would prove a write that the real front end would drop.
  Object.defineProperty(composer, 'value',
    { get() { return text; },
      set(v) { if (!options.ignoreSyntheticInput) text = String(v); } });
  Object.defineProperty(composer, 'textContent',
    { get() { return text; },
      set(v) { if (!options.ignoreSyntheticInput) text = String(v); } });
  all.push(composer);

  for (const attrs of [{ 'aria-label': '添加文件等内容' }, { 'aria-label': '选择 ChatGPT 模型' },
    { 'aria-label': '听写' }, { 'aria-label': '开始语音' }]) {
    all.push(makeNode({ tag: 'button', attrs, parents: [form], rect: { width: 28, height: 28 } }));
  }

  const send = { node: null };
  function commit() {
    if (options.neverCommits) return;
    const typed = composer.value || '';
    clock.setTimeout(() => {
      messages.push(typed);
      if (options.clearComposerAfterCommit !== false) composer.value = '';
      registry.notify();
    }, options.commitDelayMs === undefined ? 60 : options.commitDelayMs);
  }
  function showSend() {
    if (send.node) return send.node;
    const node = makeNode({ tag: 'button', attrs: { type: 'submit', 'aria-label': '发送' },
      parents: [form], rect: { width: 32, height: 32 } });
    node.click = () => {
      node.clicks += 1;
      clicks.push(node);
      commit();
    };
    all.push(node);
    send.node = node;
    registry.notify();
    return node;
  }
  if (options.send !== 'none') showSend();
  // `execCommand` returns false unless the page is told to accept it, so the
  // background writer has to fall through its strategies like a real refusal.
  const execAccepts = options.execCommandAccepts === true;
  composer.onDispatch = () => {
    if (options.modalOpen) return;                 // a dialog swallows the input
    if (options.ignoreSyntheticInput) return;      // a front end that refuses it
    // A deterministic route change *during* the write, which is the window a
    // background delivery actually has to survive: the notice is in the box and
    // the operator's page moves underneath it.
    if (options.navigateOnInput) {
      doc.location.pathname = options.navigateTo || '/c/' + CONV2;
      doc.location.href = 'https://chatgpt.com' + doc.location.pathname;
    }
    if (options.send === 'dynamic') clock.setTimeout(showSend, 0);
  };

  const doc = {
    location: { pathname: path, href: 'https://chatgpt.com' + path },
    body: makeNode({ tag: 'body' }),
    documentElement: makeNode({ tag: 'html' }),
    visibilityState: visibility,
    // `focusFlipAfter` makes the loss of focus deterministic: after N calls the
    // document reports itself unfocused. A timer would race the adapter's promise
    // continuations and could fire after the click, which proves nothing.
    hasFocus() {
      focusCalls += 1;
      if (Number.isSafeInteger(options.focusFlipAfter)
          && focusCalls > options.focusFlipAfter) return false;
      return focused;
    },
    querySelectorAll(selector) {
      if (!KNOWN.has(selector)) return [];
      if (selector === '[data-message-author-role="user"]') {
        // T084 measured this selector at 0 on the page we actually get served;
        // the bubble attribute below is what matches. Returning both would make
        // one message count twice and be reported as a duplicate.
        return [];
      }
      if (selector === '[data-user-message-bubble]') {
        return messages.map((t) => ({ textContent: t, getBoundingClientRect() {
          return { width: 200, height: 40 }; } }));
      }
      return all.filter((node) => node.isConnected && matches(node, selector));
    },
    execCommand(command, _ui, value) {
      if (command !== 'insertText' || !execAccepts) return false;
      composer.value = String(value);
      if (composer.onDispatch) composer.onDispatch();
      return true;
    },
    createEvent() {
      const event = { type: null, initEvent(type) { event.type = type; } };
      return event;
    },
    createRange() {
      return { selectNodeContents() { return undefined; } };
    },
    getSelection() {
      return { removeAllRanges() {}, addRange() {} };
    },
  };

  return { doc, clock, registry, all, clicks, messages, composer, send,
    focusCalls: () => composer.focusCalls,
    setFocus(v) { focused = v; },
    setVisibility(v) { visibility = v; doc.visibilityState = v; },
    navigate(to) {
      doc.location.pathname = to;
      doc.location.href = 'https://chatgpt.com' + to;
    },
    get text() { return composer.value; } };
}

// --------------------------------------------------------------- fake chrome
function createChrome(options = {}) {
  const opts = Object.assign({
    active: false, focused: false, visibilityState: 'hidden',
    composerPresent: true, composerEmpty: true, discarded: false, frozen: false,
    sendReply: null,
  }, options);
  const calls = [];
  const store = { local: {}, session: {} };
  const tabNow = () => ({
    id: 7, windowId: 2, url: URL_OK, active: opts.active,
    discarded: opts.discarded, frozen: opts.frozen,
  });
  const chrome = {
    tabs: {
      get: async (id) => { calls.push(['tabs.get', id]); return Object.assign(tabNow(), { id }); },
      sendMessage: async (id, msg) => {
        calls.push(['tabs.sendMessage', id, msg.type, msg.deliveryMode]);
        if (opts.sendReply) return opts.sendReply;
        return { ok: true, result: { status: 'submitted', reason: null,
          evidence: { conversationId: CONV } } };
      },
      update: async () => { calls.push(['tabs.update']); throw new Error('must not activate'); },
      highlight: async () => { calls.push(['tabs.highlight']); throw new Error('must not switch'); },
      create: async () => { calls.push(['tabs.create']); throw new Error('must not open a tab'); },
    },
    windows: {
      update: async () => { calls.push(['windows.update']); throw new Error('must not focus'); },
      create: async () => { calls.push(['windows.create']); throw new Error('must not open'); },
    },
    storage: {
      local: {
        get: async (defaults) => {
          const out = {};
          for (const [k, v] of Object.entries(defaults || {})) {
            out[k] = Object.prototype.hasOwnProperty.call(store.local, k) ? store.local[k] : v;
          }
          return out;
        },
        set: async (patch) => { Object.assign(store.local, patch); },
      },
    },
  };
  const probeSpecificTab = async (api, target) => {
    calls.push(['probe', target && target.tabId]);
    if (opts.discarded) {
      return { status: 'discarded', tabId: target.tabId, reason: 'content_unloaded_until_activation' };
    }
    if (opts.frozen) {
      return { status: 'frozen', tabId: target.tabId, reason: 'frozen_tabs_cannot_execute_tasks' };
    }
    if (opts.probeFails) {
      return { status: opts.probeFails, tabId: target.tabId };
    }
    return {
      status: 'background_observable', tabId: target.tabId, windowId: target.windowId,
      url: URL_OK, conversationId: CONV, documentInstanceId: DOC, observedAt: 5000,
      visibilityState: opts.visibilityState, hasFocus: opts.focused,
      composerPresent: opts.composerPresent, composerEmpty: opts.composerEmpty,
    };
  };
  const binding = {
    version: 1, revision: 3, boundAt: 1, tabId: 7, windowId: 2, url: URL_OK,
    conversationId: CONV, documentInstanceId: DOC, accountIdentity: 'unverified',
    accountVerified: false, manuallyConfirmed: true, invalidatedReason: null,
  };
  return { chrome, store, calls, probeSpecificTab, binding,
    getBindingState: async () => ({ ok: true, binding: opts.noBinding ? null : binding }) };
}

function build(options) {
  const env = createChrome(options);
  const wiring = WIRE.createChromeAutoSend(env.chrome, {
    probeSpecificTab: env.probeSpecificTab,
    getBindingState: env.getBindingState,
    now: () => 5000,
  });
  return { env, wiring };
}

// Advance the fake clock so a promise chain of waits can settle.
async function drive(page, promise, budgetMs) {
  let settled = false;
  let value;
  let failure = null;
  promise.then((v) => { settled = true; value = v; }, (e) => { settled = true; failure = e; });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  for (let elapsed = 0; elapsed < budgetMs && !settled; elapsed += 25) {
    await flush();
    page.clock.advance(25);
  }
  await flush();
  if (failure) throw failure;
  if (!settled) throw new Error('adapter never settled within ' + budgetMs + 'ms');
  return value;
}

const deps = (page, over) => Object.assign({
  clock: () => page.clock.now,
  timers: page.clock,
  Observer: page.registry.FakeObserver,
  timeoutMs: 1000,
  readyTimeoutMs: 800,
}, over || {});

export {
  A, AS, WIRE, TT, PRE, NOTICE, CONV, CONV2, RUN, RUN2, URL_OK, DOC, FG_PHRASE,
  BG_PHRASE, createClock, createObserverRegistry, createPage, createChrome,
  build, drive, deps, makeNode, matches,
};
