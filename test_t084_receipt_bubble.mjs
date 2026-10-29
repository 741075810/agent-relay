// T084: the live page's user message is a `[data-user-message-bubble]` div, not a
// `[data-message-author-role="user"]` turn.
//
// Measured on a message that really did appear, by inspecting its ancestors:
//
//   lvl 8  div [data-chatgpt-search-unit-key][data-chatgpt-search-message-ids]
//   lvl 5  div  class="bg-user-message bubble-vBnidZ"  [data-user-message-bubble]
//   lvl 0  div  class="text-size-chat whitespace-pre-wrap" → "DSH task … completed."
//
// and on the same page these were all 0:
//   [data-message-author-role="user"] , [data-testid^="conversation-turn-"]
//   [data-testid="user-message"] , [data-role="user"] , main article
//
// T071 read only the first of those, so every real send timed out as
// `delivery_not_confirmed`. What is *not* allowed as a fix is loosening the text
// comparison: the bubble also carries 复制/编辑 buttons, so the bubble's own
// textContent is the notice plus button labels. The rule below therefore keeps
// exact matching and adds one verifiable path: a descendant whose entire text is
// exactly the template.
import { readFileSync } from 'node:fs';

const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);
const CONV = 'c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f';
const OTHER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const RUN = '80c60e95-d439-4f27-bf07-0fa72850c7fd';

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}

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
    observe(target) { this.target = target; live.add(this); }
    disconnect() { live.delete(this); }
    trigger() { if (typeof this.callback === 'function') this.callback([]); }
  }
  return { FakeObserver, notify() { for (const o of [...live]) o.trigger(); }, live };
}

// ------------------------------------------------------------- fake DOM nodes
function makeNode(spec) {
  const attrs = spec.attrs || {};
  const kids = spec.children || [];
  const self = {
    tag: spec.tag || 'div',
    classList: spec.classes || [],
    parents: spec.parents || [],
    ownText: spec.text === undefined ? '' : String(spec.text),
    children: kids,
    rect: spec.rect || { width: 200, height: 24 },
    clicks: 0,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    getBoundingClientRect() {
      return self.rect;
    },
    get textContent() {
      return self.ownText + kids.map((k) => k.textContent).join('');
    },
    set textContent(v) { self.ownText = String(v); self.children = []; },
    querySelectorAll(selector) {
      const all = [];
      const walk = (node) => {
        for (const kid of node.children) { all.push(kid); walk(kid); }
      };
      walk(self);
      if (selector === '*') return all;
      if (selector === 'button') return all.filter((n) => n.tag === 'button');
      return [];
    },
    get isConnected() { return true; },
  };
  Object.defineProperty(self, 'value', {
    get() { return self.ownText + kids.map((k) => k.textContent).join(''); },
    set(v) { self.ownText = String(v); self.children = []; },
  });
  self.parentElement = spec.parentElement || null;
  for (const kid of kids) kid.parentElement = self;
  return self;
}

// ------------------------------------------------------- the measured message
// `kind` selects which part of the live DOM a message imitates:
//   'bubble'      the measured layout: [data-user-message-bubble] + copy/edit buttons
//   'legacy'      the older [data-message-author-role="user"] wrapper
//   'both'        a bubble inside a user turn, i.e. one message matched twice
//   'superset'    the template with extra text in the SAME text node
//   'hidden'      an exact copy of the template with zero geometry
function makeMessage(kind, text) {
  const turn = { tag: 'div', children: [] };
  if (kind === 'legacy') {
    const wrapper = makeNode({ tag: 'div', attrs: { 'data-message-author-role': 'user' },
      classes: ['whitespace-pre-wrap'], text });
    return { node: wrapper, turn };
  }
  const body = makeNode({
    tag: 'div',
    classes: ['text-size-chat', 'whitespace-pre-wrap'],
    text: kind === 'superset' ? text + '复制' : text,
    rect: kind === 'hidden' ? { width: 0, height: 0 } : { width: 180, height: 20 },
  });
  const copy = makeNode({ tag: 'button', attrs: { 'aria-label': '复制' }, text: '复制' });
  const edit = makeNode({ tag: 'button', attrs: { 'aria-label': '编辑' }, text: '编辑' });
  const bubble = makeNode({
    tag: 'div',
    classes: ['bg-user-message', 'bubble-vBnidZ'],
    attrs: { 'data-user-message-bubble': '' },
    children: [body, copy, edit],
    rect: kind === 'hidden' ? { width: 0, height: 0 } : { width: 600, height: 60 },
  });
  if (kind === 'both') {
    const wrapper = makeNode({ tag: 'div',
      attrs: { 'data-message-author-role': 'user' }, children: [bubble] });
    return { node: wrapper, bubble, turn };
  }
  return { node: bubble, bubble, turn };
}

// ---------------------------------------------------------------- fake page
function createPage(options = {}) {
  const clock = options.clock || createClock();
  const registry = options.registry || createObserverRegistry();
  let path = options.path || '/c/' + CONV;
  let messages = (options.existing || []).map((m) => makeMessage(m.kind, m.text));
  const clicks = [];

  const composer = makeNode({
    tag: 'div',
    classes: ['ProseMirror'],
    attrs: { contenteditable: 'true', 'data-testid': 'prompt-textarea' },
    text: options.draft || '',
    rect: { width: 600, height: 80 },
  });

  const button = makeNode({ tag: 'button', attrs: { 'data-testid': 'send-button' } });
  button.click = () => {
    clicks.push(button);
    const delay = options.commitDelayMs === undefined ? 60 : options.commitDelayMs;
    clock.setTimeout(() => {
      for (const spec of options.newMessages || [{ kind: 'bubble', notice: true }]) {
        messages = messages.concat([makeMessage(spec.kind,
          spec.notice ? currentNotice() : (spec.text || ''))]);
        if (spec.notice) { messages[messages.length - 1].isNotice = true; }
      }
      registry.notify();
    }, delay);
    if (options.clearComposer !== false) {
      clock.setTimeout(() => { composer.ownText = ''; registry.notify(); }, delay);
    }
    if (options.navigateAfterMs !== undefined) {
      clock.setTimeout(() => { path = options.navigateTo || '/c/' + OTHER; },
        options.navigateAfterMs);
    }
  };

  let noticeText = '';
  const currentNotice = () => noticeText;

  // A real document.querySelectorAll also returns matching descendants, which is
  // exactly how one message ends up matched by both selectors.
  const allNodes = () => {
    const out = [];
    for (const m of messages) {
      out.push(m.node);
      for (const kid of m.node.querySelectorAll('*')) out.push(kid);
    }
    return out;
  };
  const byAttr = (name) => allNodes().filter((n) => n.getAttribute(name) !== null);

  const doc = {
    get location() { return { pathname: path, href: 'https://chatgpt.com' + path }; },
    body: makeNode({ tag: 'body' }),
    documentElement: makeNode({ tag: 'html' }),
    hasFocus() { return options.focused !== false; },
    querySelectorAll(selector) {
      if (selector === '[data-user-message-bubble]') {
        return byAttr('data-user-message-bubble');
      }
      if (selector === '[data-message-author-role="user"]') {
        return byAttr('data-message-author-role');
      }
      if (selector.includes('contenteditable')) return [composer];
      if (selector === 'button[data-testid="send-button"]') return [button];
      if (selector === '[data-message-author-role="user"]' && options.throwRole) {
        throw new Error('boom');
      }
      return [];
    },
    execCommand() { return false; },
    createEvent() { return { initEvent() {} }; },
  };

  return {
    doc, clock, registry, composer, button, clicks,
    setNotice(text) { noticeText = text; },
    messageCount: () => messages.length,
    noticeNodes: () => messages.filter((m) => m.isNotice).length,
  };
}

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
  const spec = { runId: RUN, status: 'completed', expectedConversationId: CONV };

  const run = async (page, budget = 4000) => {
    page.setNotice(NOTICE);
    return drive(page, A.deliverInto(page.doc, spec, 1000, {
      clock: () => page.clock.now,
      timers: page.clock,
      Observer: page.registry.FakeObserver,
      timeoutMs: 1000,
      readyTimeoutMs: 800,
    }), budget);
  };
  const clean = (page) => page.registry.live.size === 0 && page.clock.pending === 0;

  // ------------------------------- 1. the exact shape the user measured
  console.log('== T084: the measured bubble is a receipt ==');
  {
    const page = createPage({ newMessages: [{ kind: 'bubble', notice: true }] });
    check(page.doc.querySelectorAll('[data-message-author-role="user"]').length === 0,
      'the fake page has no legacy user turn at all (the live count was 0)');
    const r = await run(page);
    // Before the fix this was 'unconfirmed / delivery_not_confirmed': the only
    // selector the adapter knew matched nothing.
    check(r.status === 'submitted',
      'a bubble-only page still confirms the send (' + r.status + '/' + r.reason + ')');
    check(r.evidence && r.evidence.receiptCandidates === 1,
      'exactly one message carried the notice (' +
      (r.evidence && r.evidence.receiptCandidates) + ')');
    check(r.evidence && String(r.evidence.receiptPath).includes('data-user-message-bubble'),
      'and the evidence names the bubble selector (' +
      (r.evidence && r.evidence.receiptPath) + ')');
    check(String(r.evidence && r.evidence.receiptPath).includes(':text'),
      'matched through the message-text descendant, not the whole bubble (' +
      (r.evidence && r.evidence.receiptPath) + ')');
    check(r.evidence && r.evidence.receiptBaseline === 0,
      'with a zero baseline taken before the click (' +
      (r.evidence && r.evidence.receiptBaseline) + ')');
    check(r.evidence && r.evidence.composerEmpty === true,
      'and the composer emptied');
    check(page.clicks.length === 1, 'one click (' + page.clicks.length + ')');
    check(clean(page), 'no observer or timer left behind');
  }

  console.log('== T084: the legacy turn wrapper is still accepted ==');
  {
    const page = createPage({ newMessages: [{ kind: 'legacy', notice: true }] });
    const r = await run(page);
    check(r.status === 'submitted', 'a legacy-only page confirms (' + r.status + '/'
      + r.reason + ')');
    check(String(r.evidence && r.evidence.receiptPath)
      .includes('data-message-author-role'),
      'and names the legacy selector (' + (r.evidence && r.evidence.receiptPath) + ')');
    check(page.registry.live.size === 0, 'observer released');
  }

  // ------------------------- 2. one message matched by both selectors counts once
  console.log('== T084: a bubble inside a user turn is one message, not two ==');
  {
    const page = createPage({ newMessages: [{ kind: 'both', notice: true }] });
    const before = page.doc.querySelectorAll('[data-user-message-bubble]').length
      + page.doc.querySelectorAll('[data-message-author-role="user"]').length;
    check(before === 0, 'nothing matched before the click (' + before + ')');
    const r = await run(page);
    const dual = page.doc.querySelectorAll('[data-user-message-bubble]').length
      + page.doc.querySelectorAll('[data-message-author-role="user"]').length;
    check(dual === 2, 'but after the click both selectors match it (' + dual + ')');
    check(r.status === 'submitted',
      'and it is still a single receipt (' + r.status + '/' + r.reason + ')');
    check(r.evidence && r.evidence.receiptCandidates === 1,
      'because the double match is collapsed to one (' +
      (r.evidence && r.evidence.receiptCandidates) + ')');
    check(r.evidence && r.evidence.receiptRaw === 2,
      'while the raw match count is kept for diagnosis (' +
      (r.evidence && r.evidence.receiptRaw) + ')');
  }

  // ------------------------------------- 3. nothing old or wrong may pass
  console.log('== T084: an identical old message is not a new delivery ==');
  {
    const page = createPage({
      existing: [{ kind: 'bubble', text: NOTICE }],
      newMessages: [{ kind: 'bubble', text: 'another user message' }],
    });
    const r = await run(page);
    check(r.status === 'unconfirmed' && r.reason === 'delivery_not_confirmed',
      'with no new notice it stays unconfirmed (' + r.status + '/' + r.reason + ')');
    check(r.evidence && r.evidence.receiptBaseline === 1,
      'because the baseline already counted the old copy (' +
      (r.evidence && r.evidence.receiptBaseline) + ')');
    check(r.evidence && r.evidence.appeared === 0,
      'and nothing appeared (' + (r.evidence && r.evidence.appeared) + ')');
    check(r.clickPerformed === true, 'even though the click happened');
  }

  console.log('== T084: an old copy next to a genuinely new one still confirms ==');
  {
    const page = createPage({
      existing: [{ kind: 'bubble', text: NOTICE }],
      newMessages: [{ kind: 'bubble', notice: true }],
    });
    const r = await run(page);
    check(r.status === 'submitted', 'the new message is detected (' + r.status + '/'
      + r.reason + ')');
    check(r.evidence && r.evidence.receiptBaseline === 1
      && r.evidence.receiptCandidates === 2,
      'as one more than the baseline (' + (r.evidence && r.evidence.receiptBaseline)
      + ' -> ' + (r.evidence && r.evidence.receiptCandidates) + ')');
  }

  console.log('== T084: somebody else typing is not our delivery ==');
  {
    const page = createPage({ newMessages: [{ kind: 'bubble', text: 'unrelated' }] });
    const r = await run(page);
    check(r.status === 'unconfirmed' && r.reason === 'delivery_not_confirmed',
      'an unrelated user message does not confirm (' + r.reason + ')');
    check(r.evidence && r.evidence.appeared === 0, 'appeared stays 0');
  }

  // ------------------------------- 4. exactness is not traded away for the fix
  console.log('== T084: a superset of the notice is not the notice ==');
  {
    const page = createPage({ newMessages: [{ kind: 'superset', notice: true }] });
    const r = await run(page);
    check(r.status === 'unconfirmed' && r.reason === 'delivery_not_confirmed',
      'notice + extra text in one node is not accepted (' + r.reason + ')');
    check(r.evidence && r.evidence.appeared === 0, 'appeared stays 0');
  }
  {
    // A prefix and a suffix are both rejected by the same exact comparison.
    const probe = A.receiptProbe;
    const mk = (text) => makeMessage('bubble', text);
    const docWith = (node) => ({ querySelectorAll: (s) => (s === '[data-user-message-bubble]'
      ? [node] : []) });
    check(A.receiptProbe(docWith(mk(NOTICE).node), NOTICE).count === 1,
      'the exact template counts once');
    check(probe(docWith(mk(NOTICE + ' more').node), NOTICE).count === 0,
      'a suffix breaks the match');
    check(probe(docWith(mk(NOTICE.slice(0, -1)).node), NOTICE).count === 0,
      'a missing final character breaks the match');
    check(probe(docWith(mk(' ' + NOTICE + ' ').node), NOTICE).count === 1,
      'surrounding whitespace is normalised, not trimmed from the middle');
  }

  console.log('== T084: a hidden copy of the template is not evidence ==');
  {
    const page = createPage({ newMessages: [{ kind: 'hidden', notice: true }] });
    const r = await run(page);
    check(r.status === 'unconfirmed' && r.reason === 'delivery_not_confirmed',
      'a zero-geometry bubble is ignored (' + r.reason + ')');
    check(r.evidence && r.evidence.receiptCandidates === 0,
      'it is not even counted (' + (r.evidence && r.evidence.receiptCandidates) + ')');
  }

  // -------------------------------- 5. the guards around the receipt still hold
  console.log('== T084: two new copies are a duplicate, not a success ==');
  {
    const page = createPage({ newMessages: [{ kind: 'bubble', notice: true },
      { kind: 'bubble', notice: true }] });
    const r = await run(page);
    check(r.status === 'unconfirmed' && r.reason === 'duplicate_message_appeared',
      'two copies are reported as a duplicate (' + r.reason + ')');
    check(r.clickPerformed === true && page.clicks.length === 1,
      'after exactly one click (' + page.clicks.length + ')');
  }

  console.log('== T084: navigating away during the receipt is terminal ==');
  {
    const page = createPage({ newMessages: [{ kind: 'bubble', notice: true }],
      navigateAfterMs: 20 });
    const r = await run(page);
    check(r.status === 'unconfirmed'
      && r.reason === 'conversation_changed_during_receipt',
      'a route change is reported (' + r.status + '/' + r.reason + ')');
    check(r.evidence && r.evidence.conversationId === OTHER,
      'and the new conversation id is recorded (' +
      (r.evidence && r.evidence.conversationId) + ')');
  }

  console.log('== T084: a late render inside the budget still confirms ==');
  {
    const page = createPage({ newMessages: [{ kind: 'bubble', notice: true }],
      commitDelayMs: 320 });
    const r = await run(page, 6000);
    check(r.status === 'submitted', 'an async render confirms (' + r.status + '/'
      + r.reason + ')');
    check(r.evidence && r.evidence.waitedMs > 0,
      'with the wait recorded (' + (r.evidence && r.evidence.waitedMs) + 'ms)');
  }

  console.log('== T084: a composer that never clears is not a success ==');
  {
    const page = createPage({ newMessages: [{ kind: 'bubble', notice: true }],
      clearComposer: false });
    const r = await run(page);
    check(r.status === 'unconfirmed' && r.reason === 'delivery_not_confirmed',
      'a message without an emptied composer is unconfirmed (' + r.reason + ')');
    check(r.evidence && r.evidence.composerEmpty === false,
      'and the evidence says the composer still had text');
    check(r.evidence && r.evidence.appeared === 1,
      'while the message itself was seen (' +
      (r.evidence && r.evidence.appeared) + ')');
  }

  console.log('== T084: no message at all times out, having clicked once ==');
  {
    const page = createPage({ newMessages: [] });
    const r = await run(page);
    check(r.status === 'unconfirmed' && r.reason === 'delivery_not_confirmed',
      'a silent page is unconfirmed (' + r.reason + ')');
    check(r.evidence && r.evidence.waitedMs >= 1000,
      'after the full bounded wait (' + (r.evidence && r.evidence.waitedMs) + 'ms)');
    check(page.clicks.length === 1, 'with exactly one click (' + page.clicks.length + ')');
    check(clean(page), 'and every timer released');
  }

  // ------------------------------- 6. evidence never carries message content
  console.log('== T084: the evidence carries counts, not content ==');
  {
    const page = createPage({ newMessages: [{ kind: 'bubble', notice: true }] });
    const r = await run(page);
    const dump = JSON.stringify(r.evidence);
    check(!dump.includes('DSH task'), 'the notice text is not copied into evidence');
    check(!dump.includes(RUN), 'nor the run id');
    check(!dump.includes('复制') && !dump.includes('编辑'),
      'nor any button label from the bubble');
    check(JSON.stringify(r).includes('submitted'), 'while the outcome itself is there');
  }

  console.log('== T084: an unreadable page never becomes a success ==');
  {
    const dead = { location: { pathname: '/c/' + CONV },
      querySelectorAll() { throw new Error('dead'); },
      body: { nodeType: 1 }, documentElement: { nodeType: 1 } };
    const probe = A.receiptProbe(dead, NOTICE);
    check(probe.count === -1, 'a probe that cannot read anything reports -1 (' +
      probe.count + ')');
    // -1 - 0 is not 1, so `appeared === 1` can never fire on a dead probe.
    check(probe.count - 0 !== 1, 'and -1 can never look like one new message');
  }

  console.log('== T084: the selectors are presence-based, never hashed classes ==');
  {
    const raw = readFileSync(new URL('./extension/lib/send_adapter.js', ROOT), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(A.RECEIPT_SELECTORS.includes('[data-user-message-bubble]'),
      'the bubble attribute is in the receipt selector list');
    check(A.RECEIPT_SELECTORS.includes('[data-message-author-role="user"]'),
      'the legacy turn selector is kept for compatibility');
    check(A.RECEIPT_SELECTORS.length === 2,
      'and the list has exactly two entries (' + A.RECEIPT_SELECTORS.length + ')');
    check(!/bubble-[A-Za-z0-9_-]{4,}/.test(code),
      'no hashed bubble class appears in the code');
    check(!/bg-user-message/.test(code), 'and the class name is not relied on either');
    check(!/conversation-turn-|user-message"|data-role="user"|main article/
      .test(code), 'nor are the selectors the live page proved empty');
  }

  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

// Reusable by the fail-first probe below, which imports this module with
// T084_LIB=1 so the suite itself does not run.
export { createPage, makeMessage, createClock, createObserverRegistry };

if (!process.env.T084_LIB) {
  main().catch((err) => {
    console.error('FATAL', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}


