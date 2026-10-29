// T081: the live page has no send button until the composer is non-empty.
//
// The user's own read-only DevTools check, on a new ChatGPT conversation:
//
//   composer EMPTY : button[data-testid="send-button"]                 -> 0
//                    form button[type="submit"]                       -> 0
//                    button[aria-label*="Send"],…*="发送"]              -> 0
//                    nearby controls: 添加文件等内容 / 选择 ChatGPT 模型 /
//                                     听写 / 开始语音
//   after typing   : data-testid still 0; form button[type="submit"]   -> 1
//                    button[aria-label*="发送"]                        -> 1
//                    the SAME single primary button, aria-label="发送",
//                    type="submit", data-testid=null, disabled=false
//
// So the send control is *created* on input. T079 made `inspectSendControl()` a
// hard pre-write gate, which means the adapter now refuses `send_control_missing`
// on a page that can send perfectly well -- and never even types, so the button it
// is waiting for can never appear.
//
// The fix has to keep that gate honest, not delete it: a page with no send control
// and no recognisable composer cluster must still be refused. Only when the
// composer's own form carries identifiable input-area controls (attach / model /
// dictate / voice) may the adapter type and then wait for a unique, semantically
// "send", enabled, same-form control to appear -- and click it at most once.
//
// Everything below is a fake page driven by an injected clock and a fake
// MutationObserver. No browser, no ChatGPT, no real DOM.
import { readFileSync } from 'node:fs';

const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);
const CONV = 'b81e2f34-5a6b-4c7d-9e0f-1a2b3c4d5e6f';
const RUN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    getBoundingClientRect() {
      return self.connected ? self.rect : { width: 0, height: 0 };
    },
    closest(sel) {
      if (matches(self, sel)) return self;
      for (const p of self.parents || []) {
        if (matches(p, sel)) return p;
      }
      return null;
    },
    focus() {},
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
  'button',
  'form button',
]);

// ---------------------------------------------- fake page, matching the evidence
//
// The default layout is the one the user measured: an empty composer with four
// input-area controls and NO send control at all; typing creates a single
// `<button type="submit" aria-label="发送">` inside the same form.
function createPage(options = {}) {
  const clock = options.clock || createClock();
  const registry = options.registry || createObserverRegistry();
  const path = options.path || '/c/' + CONV;
  const unknown = new Set();
  const all = [];
  const clicks = [];
  const messages = [];
  let focused = options.focused !== false;

  const form = makeNode({ tag: 'form', parents: [] });
  all.push(form);

  const composer = makeNode({
    tag: 'div',
    classes: ['ProseMirror'],
    attrs: { contenteditable: 'true', 'data-testid': 'prompt-textarea' },
    parents: [form],
    rect: { width: 600, height: 80 },
  });
  let text = options.draft || '';
  Object.defineProperty(composer, 'value',
    { get() { return text; }, set(v) { text = String(v); } });
  Object.defineProperty(composer, 'textContent',
    { get() { return text; }, set(v) { text = String(v); } });
  all.push(composer);

  // The four controls the user actually saw while the composer was empty.
  const anchors = [
    { 'aria-label': '添加文件等内容' },
    { 'aria-label': '选择 ChatGPT 模型' },
    { 'aria-label': '听写' },
    { 'aria-label': '开始语音' },
  ];
  for (const attrs of anchors) {
    all.push(makeNode({ tag: 'button', attrs, parents: [form],
      rect: { width: 28, height: 28 } }));
  }

  function makeClickable(node, spec) {
    node.click = () => {
      node.clicks += 1;
      clicks.push(node);
      if (spec && typeof spec.onClick === 'function') spec.onClick(node);
    };
    return node;
  }

  // One extra button in a *different* form: its submit must never be touched.
  let foreign = null;
  if (options.foreignSubmit) {
    const otherForm = makeNode({ tag: 'form', parents: [] });
    all.push(otherForm);
    foreign = makeClickable(makeNode({
      tag: 'button', attrs: { type: 'submit', 'aria-label': 'OK' },
      parents: [otherForm],
    }), options.foreignClick);
    all.push(foreign);
  }

  function addSend(spec) {
    const node = makeClickable(makeNode({
      tag: 'button',
      attrs: spec.attrs,
      parents: [form],
      disabled: spec.disabled === true,
      rect: spec.rect || { width: 32, height: 32 },
    }), spec);
    all.push(node);
    return node;
  }

  const mode = options.send || 'dynamic';
  const send = { node: null };
  const voice = { node: null };
  const SEND_ATTRS = { type: 'submit', 'aria-label': '发送' };

  function commit() {
    if (options.neverCommits) return;
    const typed = composer.value || '';
    const delay = options.commitDelayMs === undefined ? 60 : options.commitDelayMs;
    clock.setTimeout(() => {
      const copies = Number.isSafeInteger(options.messageCount)
        ? options.messageCount : 1;
      for (let i = 0; i < copies; i += 1) messages.push(typed);
      registry.notify();
    }, delay);
    clock.setTimeout(() => {
      composer.value = '';
      registry.notify();
    }, delay);
  }

  function showSend(extra) {
    if (send.node) return send.node;
    send.node = addSend(Object.assign({ attrs: SEND_ATTRS, onClick: commit }, extra));
    registry.notify();
    return send.node;
  }

  function onInput() {
    const after = options.appearAfterMs === undefined ? 0 : options.appearAfterMs;
    if (mode === 'dynamic') {
      clock.setTimeout(() => showSend({}), after);
    } else if (mode === 'dynamic-disabled') {
      clock.setTimeout(() => showSend({ disabled: true }), after);
    } else if (mode === 'dynamic-hidden') {
      clock.setTimeout(() => showSend({ rect: { width: 0, height: 0 } }), after);
    } else if (mode === 'dynamic-two') {
      // Both appear in one render: the page never offers a single answer.
      clock.setTimeout(() => {
        send.node = addSend({ attrs: SEND_ATTRS, onClick: commit });
        all.push(makeClickable(makeNode({ tag: 'button',
          attrs: { type: 'submit', 'aria-label': '发送到某处' }, parents: [form] })));
        registry.notify();
      }, after);
    } else if (mode === 'dynamic-two-race') {
      // One appears, then a second one right after: the waiter may already have
      // decided, so the pre-click re-check is what has to catch it.
      clock.setTimeout(() => {
        showSend({});
        all.push(makeClickable(makeNode({ tag: 'button',
          attrs: { type: 'submit', 'aria-label': '发送到某处' }, parents: [form] })));
        registry.notify();
      }, after);
    } else if (mode === 'dynamic-voice-submit') {
      // The trap: a voice control that also matches `form button[type="submit"]`.
      // It must be excluded by semantics, leaving the real send button clickable.
      clock.setTimeout(() => {
        voice.node = makeClickable(makeNode({ tag: 'button',
          attrs: { type: 'submit', 'aria-label': '开始语音' }, parents: [form] }));
        all.push(voice.node);
        showSend({});
      }, after);
    } else if (mode === 'dynamic-stop') {
      clock.setTimeout(() => {
        all.push(makeClickable(makeNode({ tag: 'button',
          attrs: { type: 'submit', 'aria-label': '停止生成' }, parents: [form] })));
        registry.notify();
      }, after);
    }
    if (options.navigateAfterMs !== undefined) {
      clock.setTimeout(() => {
        doc.location.pathname = options.navigateTo
          || '/c/ffffffff-ffff-4fff-8fff-ffffffffffff';
        doc.location.href = 'https://chatgpt.com' + doc.location.pathname;
        registry.notify();
      }, options.navigateAfterMs);
    }
    if (options.blurAfterMs !== undefined) {
      clock.setTimeout(() => { focused = false; registry.notify(); },
        options.blurAfterMs);
    }
  }
  composer.onDispatch = onInput;

  // A stop control present from the start, as it is during a generation.
  if (options.stopNow) {
    all.push(makeClickable(makeNode({ tag: 'button',
      attrs: { type: 'submit', 'data-testid': 'stop-button' }, parents: [form] })));
  }

  const doc = {
    location: { pathname: path, href: 'https://chatgpt.com' + path },
    body: makeNode({ tag: 'body' }),
    documentElement: makeNode({ tag: 'html' }),
    hasFocus() { return focused; },
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

  return { doc, clock, registry, all, clicks, messages, composer, send, voice,
    foreign, unknown, form, blur() { focused = false; },
    get text() { return composer.value; } };
}

// Advance the fake clock in slices, letting promise continuations run between
// slices, so a chain of waits (control appears, then receipt) can both complete.
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
    readyTimeoutMs: 800,
  }, over || {});
  const spec = { runId: RUN, status: 'completed', expectedConversationId: CONV };
  const run = (page, over, budget = 4000) => drive(page,
    A.deliverInto(page.doc, spec, 1000, deps(page, over)), budget);
  const clean = (page) => page.registry.live.size === 0 && page.clock.pending === 0;
  // Anything that is not the real send button but got clicked. Must always be [].
  const wrong = (page) => page.clicks.filter((n) => n !== page.send.node);

  // ---------------------------- 1. the measured page: empty -> typing creates it
  console.log('== T081: the send control only exists once the composer has text ==');
  {
    const page = createPage({ send: 'dynamic' });
    const { doc } = page;
    const before = {
      testid: doc.querySelectorAll('button[data-testid="send-button"]').length,
      submit: doc.querySelectorAll('form button[type="submit"]').length,
      label: doc.querySelectorAll('button[aria-label*="Send"],button[aria-label*="发送"]')
        .length,
    };
    check(before.testid === 0 && before.submit === 0 && before.label === 0,
      'the fake page reproduces the measured empty state (' +
      JSON.stringify(before) + ')');

    const r = await run(page);
    // Before the fix this was 'refused / send_control_missing': the preflight gate
    // saw no button, so it never typed, so the button could never appear.
    check(r.status === 'submitted',
      'a dynamic send control still submits (' + r.status + '/' + r.reason + ')');
    check(page.clicks.length === 1, 'with exactly one click (' + page.clicks.length + ')');
    check(page.clicks[0] === page.send.node, 'and it is the control that appeared');
    check(page.messages.length === 1 && page.messages[0] === NOTICE,
      'carrying the fixed template once');
    check(wrong(page).length === 0,
      'no attach / model / dictate / voice control was clicked (' +
      page.clicks.length + ' total)');
    check(r.evidence && r.evidence.controlMode === 'dynamic',
      'and the result says it took the dynamic path (' +
      (r.evidence && r.evidence.controlMode) + ')');
    check(clean(page), 'no observer or timer left behind');
  }

  console.log('== T081: a button that appears late is still found in time ==');
  {
    const page = createPage({ send: 'dynamic', appearAfterMs: 250 });
    const r = await run(page);
    check(r.status === 'submitted', 'a late-appearing control submits (' +
      r.status + '/' + r.reason + ')');
    check(page.clicks.length === 1, 'one click (' + page.clicks.length + ')');
    check(r.evidence && r.evidence.readyWaitedMs > 0,
      'the wait is recorded (' + (r.evidence && r.evidence.readyWaitedMs) + 'ms)');
    check(wrong(page).length === 0, 'and no input-area control was clicked');
  }

  // ----------------------------- 2. the gate is kept, not deleted
  console.log('== T081: a page with no send control and no anchors is refused ==');
  {
    const page = createPage({ send: 'none' });
    // Remove the composer from its form: without the input-area cluster there is
    // no evidence that the button will ever appear.
    for (const node of page.all) {
      if (node !== page.composer && node.tag === 'button') node.connected = false;
    }
    const r = await run(page);
    check(r.status === 'refused' && r.reason === 'send_control_missing',
      'no control and no anchor is refused (' + r.status + '/' + r.reason + ')');
    check(page.text === '', 'the composer was never written ("' + page.text + '")');
    check(r.composerWritten === false && r.clickPerformed === false,
      'and both flags say nothing happened');
    check(page.clicks.length === 0, 'zero clicks');
  }

  console.log('== T081: anchors alone do not license a click ==');
  {
    const page = createPage({ send: 'none' });
    const r = await run(page);
    check(r.status === 'unconfirmed'
      && r.reason === 'send_button_missing_after_write',
      'a control that never appears is unconfirmed (' + r.status + '/'
      + r.reason + ')');
    check(r.composerWritten === true && r.clickPerformed === false,
      'the composer was written and nothing was clicked');
    check(page.clicks.length === 0, 'zero clicks (' + page.clicks.length + ')');
    check(r.evidence && r.evidence.readyWaitedMs >= 800,
      'the wait was bounded, not endless (' +
      (r.evidence && r.evidence.readyWaitedMs) + 'ms)');
    check(clean(page), 'and every observer and timer was released');
  }

  // ------------------------------- 3. never click something that is not send
  console.log('== T081: a stop / voice / foreign control is never clicked ==');
  {
    const page = createPage({ send: 'dynamic-stop' });
    const r = await run(page);
    check(r.status === 'unconfirmed', 'only a stop control appeared (' +
      r.status + '/' + r.reason + ')');
    check(page.clicks.length === 0, 'so nothing was clicked (' + page.clicks.length + ')');
    check(wrong(page).length === 0, 'and certainly not the stop control');
  }
  {
    const page = createPage({ send: 'dynamic-voice-submit' });
    const r = await run(page);
    // The voice control is `type="submit"` too, so a selector-only rule would see
    // two candidates and could pick the wrong one. It is excluded by semantics
    // instead, which leaves the real send button as the single answer.
    check(page.voice.node && page.voice.node.clicks === 0,
      'the voice control was never clicked (' +
      (page.voice.node && page.voice.node.clicks) + ')');
    check(page.clicks.length === 1, 'exactly one click happened (' +
      page.clicks.length + ')');
    check(page.clicks[0] === page.send.node,
      'and it landed on the real send control');
    check(r.status === 'submitted', 'so the send still succeeds (' + r.status + '/'
      + r.reason + ')');
  }
  {
    const page = createPage({ send: 'dynamic', foreignSubmit: true });
    const r = await run(page);
    check(r.status === 'submitted', 'a foreign form does not block sending (' +
      r.status + '/' + r.reason + ')');
    check(page.foreign && page.foreign.clicks === 0,
      'and its submit was never clicked (' + (page.foreign && page.foreign.clicks) + ')');
    check(page.clicks.length === 1 && page.clicks[0] === page.send.node,
      'only the owned control was clicked');
  }

  // ------------------------------------- 4. an unusable control stays unusable
  console.log('== T081: a disabled or hidden send control is not clicked ==');
  {
    const page = createPage({ send: 'dynamic-disabled' });
    const r = await run(page);
    check(r.status === 'unconfirmed' && r.reason === 'send_button_not_ready',
      'a permanently disabled control is unconfirmed (' + r.status + '/'
      + r.reason + ')');
    check(page.clicks.length === 0, 'with zero clicks (' + page.clicks.length + ')');
    check(r.composerWritten === true && r.clickPerformed === false,
      'and it admits the composer was written');
  }
  {
    const page = createPage({ send: 'dynamic-hidden' });
    const r = await run(page);
    // An invisible control is not a candidate at all, so the honest report is
    // "no visible send control appeared" -- the same rule T079 applies pre-write.
    check(r.status === 'unconfirmed'
      && r.reason === 'send_button_missing_after_write',
      'a zero-size control counts as no control (' + r.status + '/' + r.reason + ')');
    check(page.clicks.length === 0, 'with zero clicks (' + page.clicks.length + ')');
  }
  {
    const page = createPage({ send: 'dynamic-two' });
    const r = await run(page);
    check(r.status === 'unconfirmed' && r.reason === 'send_control_ambiguous',
      'two submit controls in one form are ambiguous (' + r.status + '/'
      + r.reason + ')');
    check(page.clicks.length === 0, 'and neither is clicked (' + page.clicks.length + ')');
    check(r.evidence && r.evidence.candidates === 2,
      'the candidate count is recorded (' +
      JSON.stringify(r.evidence && r.evidence.candidates) + ')');
  }
  {
    // The race: one control satisfies the wait, a second appears before the click.
    const page = createPage({ send: 'dynamic-two-race' });
    const r = await run(page);
    check(r.status === 'unconfirmed'
      && r.reason === 'send_control_changed_before_click',
      'a control that appears between ready and click stops the click (' +
      r.status + '/' + r.reason + ')');
    check(page.clicks.length === 0, 'so nothing was clicked (' + page.clicks.length + ')');
    check(r.evidence && r.evidence.candidates === 2,
      'and the new candidate count is recorded (' +
      JSON.stringify(r.evidence && r.evidence.candidates) + ')');
  }

  // ------------------------- 5. the guards around the write are all still live
  console.log('== T081: an existing draft is refused before anything is typed ==');
  {
    const page = createPage({ send: 'dynamic', draft: 'half a thought' });
    const r = await run(page);
    check(r.status === 'refused' && r.reason === 'composer_not_empty',
      'a non-empty composer is refused (' + r.reason + ')');
    check(page.text === 'half a thought', 'and the draft is untouched');
    check(page.clicks.length === 0, 'with zero clicks');
  }

  console.log('== T081: navigating while waiting for the control stops the click ==');
  {
    const page = createPage({ send: 'dynamic', appearAfterMs: 400,
      navigateAfterMs: 100 });
    const r = await run(page);
    check(r.status === 'unconfirmed'
      && r.reason === 'conversation_changed_before_click',
      'a route change before the click is reported (' + r.status + '/'
      + r.reason + ')');
    check(page.clicks.length === 0, 'and the stale page is never clicked');
    check(r.clickPerformed === false, 'clickPerformed stays false');
  }

  console.log('== T081: losing focus while waiting stops the click ==');
  {
    const page = createPage({ send: 'dynamic', appearAfterMs: 400,
      blurAfterMs: 100 });
    const r = await run(page);
    check(r.status === 'unconfirmed'
      && r.reason === 'target_lost_focus_before_click',
      'a blurred tab before the click is reported (' + r.status + '/'
      + r.reason + ')');
    check(page.clicks.length === 0, 'and nothing is clicked (' + page.clicks.length + ')');
    check(r.composerWritten === true, 'while still admitting the composer was written');
  }

  // --------------------------------------- 6. the receipt half is untouched
  console.log('== T081: receipt outcomes keep their meaning on the dynamic path ==');
  {
    const page = createPage({ send: 'dynamic', messageCount: 2 });
    const r = await run(page);
    check(r.status === 'unconfirmed' && r.reason === 'duplicate_message_appeared',
      'two rendered copies are unconfirmed (' + r.reason + ')');
    check(r.clickPerformed === true && page.clicks.length === 1,
      'after exactly one click (' + page.clicks.length + ')');
  }
  {
    const page = createPage({ send: 'dynamic', neverCommits: true });
    const r = await run(page);
    check(r.status === 'unconfirmed' && r.reason === 'delivery_not_confirmed',
      'a click that never renders is unconfirmed (' + r.reason + ')');
    check(r.clickPerformed === true, 'and is reported as clicked');
    check(page.clicks.length === 1, 'one click only (' + page.clicks.length + ')');
    check(clean(page), 'with every timer released');
  }
  {
    // The double-click guard: an unconfirmed send leaves the notice in the
    // composer, so a second call cannot even reach the button.
    const page = createPage({ send: 'dynamic', neverCommits: true });
    const first = await run(page);
    check(first.status === 'unconfirmed', 'the first call is unconfirmed');
    const second = await run(page);
    check(second.status === 'refused' && second.reason === 'composer_not_empty',
      'the second call refuses on the leftover notice (' + second.reason + ')');
    check(page.clicks.length === 1, 'so the page saw exactly one click (' +
      page.clicks.length + ')');
  }

  // --------------------------------- 7. nothing widened, no alternative path
  console.log('== T081: a blurred tab is refused before anything is typed ==');
  {
    const page = createPage({ send: 'dynamic', focused: false });
    const r = await run(page);
    check(r.status === 'refused' && r.reason === 'target_focus_lost',
      'a tab that is already blurred is refused (' + r.status + '/' + r.reason + ')');
    check(page.text === '', 'the composer was never written ("' + page.text + '")');
    check(r.composerWritten === false && r.clickPerformed === false,
      'and the flags agree nothing happened');
    check(page.clicks.length === 0, 'zero clicks');
  }

  console.log('== T081: the three outcome classes still separate cleanly ==');
  {
    check(A.classifySendReason('stopped:target_focus_lost') === 'never_written',
      'a pre-write focus refusal is "never written"');
    check(A.classifySendReason('stopped:target_lost_focus_before_click')
      === 'written_not_clicked', 'a post-write focus refusal is "written, not clicked"');
    check(A.classifySendReason('stopped:send_button_missing_after_write')
      === 'written_not_clicked',
      'a control that never appeared is "written, not clicked"');
    const S = await mod('./extension/lib/autosend.js');
    check(S.classifyRefusal('target_focus_lost') === 'deferred',
      'and the trigger may defer the pre-write one');
    check(S.classifyRefusal('target_lost_focus_before_click') === 'ambiguous',
      'while the post-write one stays fail-closed');
    check(S.classifyRefusal('send_button_missing_after_write') === 'ambiguous',
      'as does a control that never appeared');
    const bare = createPage({ send: 'none' });
    for (const node of bare.all) {
      if (node !== bare.composer && node.tag === 'button') node.connected = false;
    }
    check(A.inspectSendControl(bare.doc, bare.composer).mode === 'none',
      'and a page with neither control nor anchor reports mode none');
    const anchored = createPage({ send: 'dynamic' });
    check(A.inspectSendControl(anchored.doc, anchored.composer).mode === 'dynamic',
      'while an anchored empty composer reports mode dynamic');
    check(A.inputAreaAnchors(anchored.doc, anchored.composer).length === 4,
      'with all four input-area controls found (' +
      A.inputAreaAnchors(anchored.doc, anchored.composer).length + ')');
  }

  console.log('== T081: the click path is still exactly one call ==');
  {
    const raw = readFileSync(new URL('./extension/lib/send_adapter.js', ROOT), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(!/Enter/.test(code), 'no Enter-key path');
    check(!/KeyboardEvent|keyCode|keypress|keydown/.test(code),
      'no synthetic key dispatch');
    check(!/\.submit\s*\(/.test(code), 'no form.submit()');
    check(!/requestSubmit/.test(code), 'no requestSubmit()');
    const clicks = code.match(/\.click\s*\(/g) || [];
    check(clicks.length === 1, 'exactly one click call (' + clicks.length + ')');
    const quoted = code.match(/'((?:form )?button\[[^']*)'/g) || [];
    const sendSelectors = [...new Set(quoted.map((q) => q.slice(1, -1)))].sort();
    check(JSON.stringify(sendSelectors) === JSON.stringify([
      'button[aria-label*="Send"]', 'button[aria-label*="发送"]',
      'button[data-testid="send-button"]', 'form button[type="submit"]',
    ]), 'the send selector list is byte-identical to T079 (' +
      JSON.stringify(sendSelectors) + ')');
    // Anchor discovery may read `button` / `form button`, but those are only ever
    // used for the preflight anchor count, never as a click target.
    check(!/querySelectorAll\('form button'\)[\s\S]{0,80}\.click/.test(code),
      'the broad anchor query is not used as a click target');
  }

  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('FATAL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

