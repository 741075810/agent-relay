// T079: `stopped:send_button_unavailable` in the live T078 build.
//
// The code path is unambiguous in the source: `deliverInto()` types the notice and
// *then* calls `findSendButton(doc)` in the same tick. `findSendButton` only accepts
// a node that is visible and `disabled !== true`, so a React composer that enables
// the send button one render after the input event yields no button at all -- and
// the adapter reports `unconfirmed / send_button_unavailable` *after* the draft has
// already been written.
//
// Two hypotheses, and this suite does not presume which one the live page is:
//   A. the button exists but is enabled asynchronously  -> must wait, bounded
//   B. no recognisable send control exists at all       -> must refuse before typing
//
// Everything here is a fake page driven by an injected clock and a fake
// MutationObserver. No browser, no ChatGPT, no real DOM.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);
const CONV = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}

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
    constructor(callback) { this.callback = callback; this.targets = []; }
    observe(target) { this.targets.push(target); live.add(this); }
    disconnect() { live.delete(this); this.targets = []; }
    trigger() { if (typeof this.callback === 'function') this.callback([]); }
  }
  return { FakeObserver, notify() { for (const o of [...live]) o.trigger(); }, live };
}

// ------------------------------------------------------- tiny selector engine
// Only the selectors the adapter actually uses are supported. An unknown selector
// returns no nodes and is recorded, so adding a selector to the adapter shows up
// here instead of silently passing.
function parseSelector(sel) {
  return String(sel).trim().split(/\s+/).map((part) => {
    const head = part.match(/^([a-zA-Z][a-zA-Z0-9]*)?(.*)$/);
    const tag = head[1] || null;
    const attrs = [];
    const classes = [];
    const re = /\[([a-zA-Z-]+)(?:(\*?=)"([^"]*)")?\]|\.([A-Za-z0-9_-]+)/g;
    let hit;
    while ((hit = re.exec(head[2] || ''))) {
      if (hit[1]) attrs.push({ name: hit[1], op: hit[2] || null, value: hit[3] });
      else classes.push(hit[4]);
    }
    return { tag, attrs, classes };
  });
}

function matchesPart(node, part) {
  if (part.tag && node.tag !== part.tag) return false;
  for (const c of part.classes) {
    if (!(node.classList || []).includes(c)) return false;
  }
  for (const a of part.attrs) {
    const value = node.getAttribute(a.name);
    if (value === null || value === undefined) return false;
    if (a.op === '=' && String(value) !== a.value) return false;
    if (a.op === '*=' && !String(value).includes(a.value)) return false;
    if (a.op === null && value === null) return false;
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
    focused: false,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    getBoundingClientRect() {
      return self.connected ? self.rect : { width: 0, height: 0 };
    },
    matches(sel) { return matches(self, sel); },
    matchesSelector(sel) { return matches(self, sel); },
    closest(sel) {
      if (matches(self, sel)) return self;
      const parents = self.parents || [];
      for (const p of parents) {
        if (matches(p, sel)) return p;
      }
      return null;
    },
    focus() { self.focused = true; },
    dispatchEvent(event) {
      if (self.onDispatch) self.onDispatch(event);
      return true;
    },
    get isConnected() { return self.connected; },
  };
  return self;
}

const KNOWN_SELECTORS = new Set([
  'div[contenteditable="true"][data-testid="prompt-textarea"]',
  'div[contenteditable="true"].ProseMirror',
  'textarea[data-testid="prompt-textarea"]',
  'form div[contenteditable="true"]',
  'button[data-testid="send-button"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="发送"]',
  'form button[type="submit"]',
  '[data-message-author-role="user"]',
]);

// ------------------------------------------------------------------- fake page
function createPage(options = {}) {
  const clock = options.clock || createClock();
  const registry = options.registry || createObserverRegistry();
  const path = options.path || '/c/' + CONV;
  const unknown = new Set();
  const all = [];
  const clicks = [];
  const messages = [];

  const form = options.formInside === false
    ? null : makeNode({ tag: 'form', parents: [] });
  if (form) all.push(form);

  const composer = makeNode({
    tag: 'div',
    classes: ['ProseMirror'],
    attrs: { contenteditable: 'true', 'data-testid': 'prompt-textarea' },
    parents: form ? [form] : [],
    rect: { width: 600, height: 80 },
  });
  let text = options.draft || '';
  Object.defineProperty(composer, 'value',
    { get() { return text; }, set(v) { text = String(v); } });
  Object.defineProperty(composer, 'textContent',
    { get() { return text; }, set(v) { text = String(v); } });
  all.push(composer);

  function addButton(spec) {
    const node = makeNode({
      tag: 'button',
      attrs: spec.attrs || { 'data-testid': 'send-button', type: 'submit' },
      parents: spec.parents || (form ? [form] : []),
      disabled: spec.disabled === true,
      connected: spec.connected !== false,
      rect: spec.rect || { width: 32, height: 32 },
    });
    node.click = () => {
      node.clicks += 1;
      clicks.push(node);
      if (spec.onClick) spec.onClick(node);
    };
    all.push(node);
    return node;
  }

  // `send`: absent | disabled-late | never | hidden | disappears
  const mode = options.send || 'ready';
  const send = mode === 'absent' || mode === 'stop-only'
    ? null
    : addButton({
      disabled: mode !== 'ready' && mode !== 'hidden',
      connected: true,
      rect: mode === 'hidden' ? { width: 0, height: 0 } : undefined,
    });
  if (options.extraSubmit) addButton({ attrs: { type: 'submit' } });
  if (options.foreignSubmit) {
    const otherForm = makeNode({ tag: 'form', parents: [] });
    all.push(otherForm);
    addButton({ attrs: { type: 'submit' }, parents: [otherForm],
      onClick: options.onForeignClick });
  }
  if (mode === 'stop-only' || options.stopButton) {
    addButton({ attrs: { 'data-testid': 'stop-button', type: 'submit',
      'aria-label': 'Stop streaming' } });
  }

  function onInput() {
    if (mode === 'disabled-late' && send) {
      clock.setTimeout(() => {
        send.disabled = false;
        registry.notify();
      }, options.enableAfterMs === undefined ? 200 : options.enableAfterMs);
    }
    if (mode === 'disappears' && send) {
      clock.setTimeout(() => {
        send.connected = false;
        registry.notify();
      }, options.removeAfterMs === undefined ? 100 : options.removeAfterMs);
    }
    if (options.navigateAfterMs !== undefined) {
      clock.setTimeout(() => {
        doc.location.pathname = options.navigateTo || '/c/ffffffff-ffff-4fff-8fff-ffffffffffff';
        doc.location.href = 'https://chatgpt.com' + doc.location.pathname;
        registry.notify();
      }, options.navigateAfterMs);
    }
  }
  composer.onDispatch = onInput;

  if (send) {
    send.onClickHook = () => {
      if (options.neverCommits) return;
      const typed = composer.value || '';
      clock.setTimeout(() => {
        const copies = Number.isSafeInteger(options.messageCount)
          ? options.messageCount : 1;
        for (let i = 0; i < copies; i += 1) messages.push(typed);
        registry.notify();
      }, options.commitDelayMs === undefined ? 60 : options.commitDelayMs);
      clock.setTimeout(() => {
        composer.value = '';
        registry.notify();
      }, options.commitDelayMs === undefined ? 60 : options.commitDelayMs);
    };
    send.click = () => {
      send.clicks += 1;
      clicks.push(send);
      send.onClickHook();
    };
  }

  const doc = {
    location: { pathname: path, href: 'https://chatgpt.com' + path },
    body: makeNode({ tag: 'body' }),
    documentElement: makeNode({ tag: 'html' }),
    querySelectorAll(selector) {
      if (!KNOWN_SELECTORS.has(selector)) unknown.add(selector);
      if (selector === '[data-message-author-role="user"]') {
        return messages.map((t) => ({ textContent: t }));
      }
      return all.filter((node) => node.isConnected && matches(node, selector));
    },
    execCommand() { return false; },
    createEvent() { return { initEvent() {} }; },
  };

  return { doc, clock, registry, all, clicks, messages, composer, send, unknown,
    get text() { return composer.value; } };
}

// Advance the fake clock in slices, letting promise continuations run between
// slices, so a chain of waits (button ready, then receipt) can both complete.
async function drive(page, promise, budgetMs) {
  let settled = false;
  let value;
  let failure = null;
  promise.then((v) => { settled = true; value = v; },
    (e) => { settled = true; failure = e; });
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

async function main() {
  const A = await mod('./extension/lib/send_adapter.js');
  const NOTICE = A.composeNotice(RUN, 'completed').text;

  const deps = (page, over) => Object.assign({
    clock: () => page.clock.now,
    timers: page.clock,
    Observer: page.registry.FakeObserver,
    timeoutMs: 1000,
    readyTimeoutMs: 600,
  }, over || {});
  const spec = { runId: RUN, status: 'completed', expectedConversationId: CONV };
  const run = (page, over, budget = 3000) => drive(page,
    A.deliverInto(page.doc, spec, 1000, deps(page, over)), budget);
  const clean = (page) => page.registry.live.size === 0 && page.clock.pending === 0;

  // ------------------------------------------- 1. the reported failure, verbatim
  console.log('== T079: the button enables one render after the input ==');
  {
    const page = createPage({ send: 'disabled-late', enableAfterMs: 200 });
    check(page.send.disabled === true, 'the send button starts disabled');
    const r = await run(page);
    // Before the fix this was 'unconfirmed' / 'send_button_unavailable' with the
    // notice already sitting in the composer.
    check(r.status === 'submitted',
      'a button that enables asynchronously still submits (' + r.status + '/'
      + r.reason + ')');
    check(page.clicks.length === 1, 'with exactly one click (' + page.clicks.length + ')');
    check(page.messages.length === 1, 'and one message (' + page.messages.length + ')');
    check(page.messages[0] === NOTICE, 'carrying the fixed template');
    check(r.evidence && r.evidence.readyWaitedMs > 0,
      'and the wait is recorded (' + (r.evidence && r.evidence.readyWaitedMs) + 'ms)');
    check(clean(page), 'no observer and no timer left behind');
  }

  console.log('== T079: no send control at all is refused before typing ==');
  {
    const page = createPage({ send: 'absent' });
    const r = await run(page);
    check(r.status === 'refused' && r.reason === 'send_control_missing',
      'a page with no send control is refused (' + r.status + '/' + r.reason + ')');
    check(page.text === '', 'the composer was never written ("' + page.text + '")');
    check(r.composerWritten === false, 'and the result says so (' + r.composerWritten + ')');
    check(r.clickPerformed === false, 'with no click (' + r.clickPerformed + ')');
    check(page.clicks.length === 0, 'and nothing was clicked');
    check(clean(page), 'and nothing is left running');
  }

  // -------------------------------------------------- 2. present but never ready
  console.log('== T079: a button that never enables is bounded and stops ==');
  {
    const page = createPage({ send: 'never' });
    const r = await run(page);
    check(r.status === 'unconfirmed' && r.reason === 'send_button_not_ready',
      'a permanently disabled button is unconfirmed (' + r.status + '/'
      + r.reason + ')');
    check(r.composerWritten === true, 'and it admits the composer was written');
    check(r.clickPerformed === false, 'but no click happened');
    check(page.clicks.length === 0, 'the button was never clicked');
    check(r.evidence && r.evidence.readyWaitedMs >= 600,
      'the wait was bounded, not endless (' +
      (r.evidence && r.evidence.readyWaitedMs) + 'ms)');
    check(clean(page), 'and released its observer and timer');
  }

  console.log('== T079: a button that vanishes mid-wait is not clicked ==');
  {
    const page = createPage({ send: 'disappears', removeAfterMs: 100 });
    const r = await run(page);
    check(r.status === 'unconfirmed'
      && (r.reason === 'send_button_missing_after_write'
        || r.reason === 'send_button_not_ready'),
      'the disappearance is reported (' + r.status + '/' + r.reason + ')');
    check(page.clicks.length === 0, 'and nothing was clicked (' + page.clicks.length + ')');
    check(r.clickPerformed === false, 'with clickPerformed false');
  }

  console.log('== T079: a hidden button is not a send control ==');
  {
    const page = createPage({ send: 'hidden' });
    const r = await run(page);
    check(r.status === 'refused' && r.reason === 'send_control_missing',
      'an invisible button counts as missing (' + r.status + '/' + r.reason + ')');
    check(page.text === '', 'and nothing was typed');
    check(page.clicks.length === 0, 'and nothing was clicked');
  }

  // -------------------------------------------------- 3. ambiguity blocks writing
  console.log('== T079: two candidate controls are refused, never guessed at ==');
  {
    const page = createPage({ send: 'ready', extraSubmit: true });
    const r = await run(page);
    check(r.status === 'refused' && r.reason === 'send_control_ambiguous',
      'two submit buttons in one form are ambiguous (' + r.status + '/'
      + r.reason + ')');
    check(page.text === '', 'and the draft stays untouched');
    check(page.clicks.length === 0, 'with no click');
    check(r.evidence && r.evidence.candidates === 2,
      'the candidate count is reported (' + JSON.stringify(r.evidence) + ')');
  }

  console.log('== T079: another form submit button is not ours ==');
  {
    let foreignClicks = 0;
    const page = createPage({ send: 'ready', foreignSubmit: true,
      onForeignClick: () => { foreignClicks += 1; } });
    const r = await run(page);
    check(r.status === 'submitted', 'the real send button still works (' +
      r.status + '/' + r.reason + ')');
    check(foreignClicks === 0, 'and the other form was never clicked (' +
      foreignClicks + ')');
    check(page.clicks.length === 1 && page.clicks[0] === page.send,
      'the click landed on the owned control');
  }

  console.log('== T079: a stop button is never used as a send button ==');
  {
    const page = createPage({ send: 'stop-only' });
    const r = await run(page);
    check(r.status === 'refused' && r.reason === 'send_control_missing',
      'a stop control is not a send control (' + r.status + '/' + r.reason + ')');
    check(page.clicks.length === 0, 'so it is not clicked (' + page.clicks.length + ')');
    check(page.text === '', 'and no draft is typed');
  }

  // ------------------------------------------- 4. navigation and drafts keep guarding
  console.log('== T079: navigation during the ready wait stops the click ==');
  {
    const page = createPage({ send: 'disabled-late', enableAfterMs: 400,
      navigateAfterMs: 100 });
    const r = await run(page);
    check(r.status === 'unconfirmed'
      && r.reason === 'conversation_changed_before_click',
      'a route change before the click is reported (' + r.status + '/'
      + r.reason + ')');
    check(page.clicks.length === 0, 'and the stale page is never clicked');
    check(r.clickPerformed === false, 'clickPerformed stays false');
  }

  console.log('== T079: an existing draft is still refused untouched ==');
  {
    const page = createPage({ draft: 'my half-written thought' });
    const r = await run(page);
    check(r.status === 'refused' && r.reason === 'composer_not_empty',
      'a non-empty composer is refused (' + r.reason + ')');
    check(page.text === 'my half-written thought', 'and the draft is untouched');
    check(page.clicks.length === 0, 'with no click');
  }

  // ---------------------------------------- 5. the receipt half is unchanged
  console.log('== T079: receipt outcomes keep their old meaning ==');
  {
    const page = createPage({ send: 'ready', messageCount: 2 });
    const r = await run(page);
    check(r.status === 'unconfirmed' && r.reason === 'duplicate_message_appeared',
      'two rendered copies are unconfirmed (' + r.reason + ')');
    check(r.clickPerformed === true, 'and it did click exactly once');
    check(page.clicks.length === 1, 'with one click (' + page.clicks.length + ')');
  }
  {
    const page = createPage({ send: 'ready', neverCommits: true });
    const r = await run(page);
    check(r.status === 'unconfirmed' && r.reason === 'delivery_not_confirmed',
      'a click that never renders is unconfirmed (' + r.reason + ')');
    check(r.clickPerformed === true && r.composerWritten === true,
      'and it is reported as clicked, not as untouched');
    check(page.clicks.length === 1, 'one click, never retried (' + page.clicks.length + ')');
    check(clean(page), 'and every timer released');
  }

  console.log('== T079: a retry after an unconfirmed write cannot double-click ==');
  {
    const page = createPage({ send: 'ready', neverCommits: true });
    const first = await run(page);
    check(first.status === 'unconfirmed', 'the first call is unconfirmed');
    // The notice is still in the composer, which is itself the guard.
    const second = await run(page);
    check(second.status === 'refused' && second.reason === 'composer_not_empty',
      'a second call refuses on the leftover draft (' + second.reason + ')');
    check(page.clicks.length === 1, 'so the page still saw exactly one click (' +
      page.clicks.length + ')');
  }

  console.log('== T079: a restart mid-wait leaves the page alone ==');
  {
    // The content script dying and re-running is modelled as: the wait never
    // completes, the promise is abandoned, and a fresh call starts over. The fake
    // clock keeps running, so the abandoned wait must not fire a click later.
    const page = createPage({ send: 'never' });
    const promise = A.deliverInto(page.doc, spec, 1000, deps(page));
    page.clock.advance(100);
    const abandoned = await run(page);
    check(abandoned.status === 'refused'
      && abandoned.reason === 'composer_not_empty',
      'the restarted call refuses the leftover draft (' + abandoned.reason + ')');
    page.clock.advance(5000);
    check((await promise).status === 'unconfirmed',
      'and the abandoned wait ends unconfirmed, not submitted');
    check(page.clicks.length === 0, 'nothing was ever clicked (' + page.clicks.length + ')');
    check(clean(page), 'and both waits released their resources');
  }

  // --------------------------------- 6. no alternative write path exists
  console.log('== T079: there is still exactly one way to send ==');
  {
    const source = readFileSync(
      new URL('./extension/lib/send_adapter.js', ROOT), 'utf8');
    // Strip comments: the prose explains why Enter is refused, and that is not a
    // use of it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    check(!/Enter/.test(code), 'no Enter-key path');
    check(!/KeyboardEvent|keyCode|keypress|keydown/.test(code),
      'no synthetic key dispatch');
    check(!/\.submit\s*\(/.test(code), 'no form.submit()');
    check(!/requestSubmit/.test(code), 'no requestSubmit()');
    const clicks = code.match(/\.click\s*\(/g) || [];
    check(clicks.length === 1,
      'exactly one click call in the module (' + clicks.length + ')');
    // No selector was added or loosened: the send list is still exactly these four.
    const quoted = code.match(/'((?:form )?button\[[^']*)'/g) || [];
    const sendSelectors = [...new Set(quoted.map((q) => q.slice(1, -1)))].sort();
    check(JSON.stringify(sendSelectors) === JSON.stringify([
      'button[aria-label*="Send"]', 'button[aria-label*="发送"]',
      'button[data-testid="send-button"]', 'form button[type="submit"]',
    ]), 'the send selector list is unchanged (' + JSON.stringify(sendSelectors) + ')');
  }

  // ---------------------- 7. how the layers above classify each outcome
  console.log('== T079: pre-write vs written vs clicked are not conflated ==');
  {
    const T = await mod('./extension/lib/terminal_trigger.js');
    const S = await mod('./extension/lib/autosend.js');
    const C = await mod('./extension/lib/autosend_controller.js');
    const BINDING = {
      version: 1, tabId: 41, windowId: 8, url: 'https://chatgpt.com/c/' + CONV,
      conversationId: CONV, documentInstanceId: 'doc-79', manuallyConfirmed: true,
      revision: 11,
    };
    const probe = (now) => ({
      observedAt: now - 10, tabId: 41, windowId: 8, url: BINDING.url,
      conversationId: CONV, documentInstanceId: 'doc-79', active: true,
      hasFocus: true, visibilityState: 'visible', composerPresent: true,
      composerEmpty: true,
    });

    const controller = async (adapterResult) => {
      const S2 = await mod('./extension/lib/autosend.js');
      const C2 = await mod('./extension/lib/autosend_controller.js');
      const armed = S2.arm(S2.createAutoSendState(), { binding: BINDING },
        'AUTOSEND ' + CONV, true, 1000);
      let state = armed.state;
      const c = C2.createAutoSendController({
        now: () => 1100,
        load: async () => JSON.parse(JSON.stringify(state)),
        save: async (next) => { state = JSON.parse(JSON.stringify(next)); },
        readBinding: async () => JSON.parse(JSON.stringify(BINDING)),
        probe: async () => probe(1100),
        write: async () => adapterResult,
      });
      const r = await c.sendOnce({ runId: RUN, status: 'completed' });
      return { r, state: () => state };
    };

    const preWrite = await controller({ status: 'refused',
      reason: 'send_control_missing', composerTouched: false,
      composerWritten: false, clickPerformed: false, evidence: null });
    check(preWrite.r.pageWriteAttempted === false,
      'a pre-write refusal is not a page write (' + preWrite.r.pageWriteAttempted + ')');
    check(preWrite.r.code === 'send_control_missing',
      'and it keeps its own code (' + preWrite.r.code + ')');
    check(preWrite.state().journal[RUN + '|completed'] === undefined,
      'the write-ahead entry is rolled back, so autosend is not disarmed');
    check(preWrite.state().enabled === true,
      'autosend stays armed (' + preWrite.state().lastError + ')');

    const missingFlag = await controller({ status: 'refused',
      reason: 'send_control_missing', evidence: null });
    check(missingFlag.r.pageWriteAttempted === true,
      'a refusal without the touched flag is still treated as a write');
    check(missingFlag.state().enabled === false,
      'and it disarms, exactly as before');

    const writtenNoClick = await controller({ status: 'unconfirmed',
      reason: 'send_button_not_ready', composerTouched: true,
      composerWritten: true, clickPerformed: false, evidence: {} });
    check(writtenNoClick.r.pageWriteAttempted === true,
      'a written-but-not-clicked result is a page write');
    check(writtenNoClick.state().journal[RUN + '|completed'].state === 'ambiguous',
      'so it is recorded ambiguous, never retried');
    check(writtenNoClick.state().enabled === false,
      'and autosend disarms (' + writtenNoClick.state().lastError + ')');

    check(S.classifyRefusal('send_control_missing') === 'deferred',
      'the trigger defers a missing control');
    check(S.classifyRefusal('send_control_ambiguous') === 'blocked',
      'and blocks an ambiguous one');
    check(S.classifyRefusal('send_button_not_ready') === 'ambiguous',
      'while a written-no-click code stays ambiguous');

    const cand = { runId: RUN, status: 'completed' };
    const k = RUN + '|completed';
    let state = T.configure(T.createTriggerState(), { binding: BINDING },
      T.CONFIRM_PREFIX + CONV, true, 2000).state;
    let outcome = null;
    for (let i = 1; i <= 4; i += 1) {
      state = T.settle(T.markAttempt(state, cand, 2100 + i).state, k,
        { sent: false, pageWriteAttempted: false, code: 'send_control_missing' },
        2200 + i).state;
      if (i <= 3) {
        check(state.enabled === true && state.deferred[k].attempts === i,
          'deferral ' + i + ' keeps the trigger armed (' + state.enabled + ')');
      }
      outcome = state.lastError;
    }
    check(state.enabled === false, 'the fourth escalates to a stop (' +
      state.lastError + ')');
    check(String(outcome).startsWith('blocked:send_control_missing_after_'),
      'naming the reason and the count (' + outcome + ')');
    check(state.seen[k].state === 'blocked',
      'and the run is terminal, so it is never offered again');
    check(state.windowCount === 0, 'while no quota was ever consumed (' +
      state.windowCount + ')');

    // The panel must be able to name the class, and must not invent one.
    check(A.classifySendReason('stopped:send_button_not_ready')
      === 'written_not_clicked', 'a not-ready button is "written, not clicked"');
    check(A.classifySendReason('blocked:send_control_missing_after_3_deferrals')
      === 'never_written', 'an escalated missing control is "never written"');
    check(A.classifySendReason('stopped:delivery_not_confirmed')
      === 'clicked_unknown', 'an unconfirmed receipt is "clicked, unknown"');
    check(A.classifySendReason('stopped:something_new') === null,
      'an unrecognised reason is not classified at all');
    check(A.classifySendReason(null) === null, 'and neither is a missing one');
  }

  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('FATAL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});


