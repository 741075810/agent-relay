// T052: the document-identity race between the read-only probe and the page write.
//
// The claim under test, in the shipped code's own terms:
//
//   decide()  compares `binding.documentInstanceId` with `probe.documentInstanceId`
//   write()   sends `{runId, status, expectedConversationId, deliveryMode}`
//   content   has a per-document `DOCUMENT_INSTANCE_ID` and never compares it
//   adapter   checks only the conversation route
//
// So the question is narrow: if the bound tab finishes a same-URL reload between
// the probe and the write, does the notice land in a document that was never
// authorized?
//
// This file answers it with the real content.js (both instances), the real
// send_adapter and the real controller/wiring. Nothing about the handler is
// re-implemented here: content.js is evaluated as a classic script against a fake
// `chrome`, `document` and `location`, exactly the globals Chrome gives it.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  createPage, createClock, createObserverRegistry, createChrome, deps, drive,
  makeNode, AS, WIRE, TT, RUN, CONV, URL_OK, NOTICE,
} from './test_t048_fakes.mjs';

let passed = 0;
const failures = [];
function check(ok, label) {
  if (ok) { passed += 1; return; }
  failures.push(label);
  console.log('  FAILED: ' + label);
}

// The adapter is loaded from a temp copy so its `./send_gate.js` import resolves
// as an ES module, which is what the content script's dynamic `import()` does in
// the browser.
const dir = mkdtempSync(join(tmpdir(), 't052-doc-'));
for (const name of ['send_adapter', 'send_gate']) {
  writeFileSync(join(dir, name + '.mjs'),
    readFileSync(new URL('./extension/lib/' + name + '.js', import.meta.url), 'utf8')
      .replace(/from '\.\/([a-z_]+)\.js'/g, "from './$1.mjs'"));
}
const ADAPTER_URL = pathToFileURL(join(dir, 'send_adapter.mjs')).href;
const SA = await import(ADAPTER_URL);
const CONTENT_SOURCE = readFileSync(new URL('./extension/content.js', import.meta.url),
  'utf8');

// ------------------------------------------------------- one page load
// Evaluating content.js a second time is exactly what a reload does: a new
// document, a new script instance, a new `DOCUMENT_INSTANCE_ID`, and a listener
// that only knows about its own document.
function loadContentScript(page) {
  const listeners = [];
  const chrome = {
    runtime: {
      id: 'test-extension',
      // The real one returns a chrome-extension:// URL; both are absolute, and the
      // module the browser would load is this same file.
      getURL: () => ADAPTER_URL,
      onMessage: { addListener: (fn) => { listeners.push(fn); } },
      sendMessage: () => { /* the periodic content-report; nothing reads it here */ },
    },
  };
  const doc = page.doc;
  doc.addEventListener = () => {};
  // eslint-disable-next-line no-new-func
  const run = new Function('chrome', 'document', 'location', 'URL', 'crypto', 'Date',
    CONTENT_SOURCE);
  run(chrome, doc, doc.location, URL, crypto, Date);

  function send(msg) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const reply = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      for (const listener of listeners) {
        let kept = false;
        try {
          kept = listener(msg, { id: 'test-extension' }, reply) === true;
        } catch (err) {
          reject(err);
          return;
        }
        // A synchronous `sendResponse` (the read-only probe) already settled it.
        if (!kept && settled) return;
        if (!kept && !settled) { resolve(undefined); return; }
        return;
      }
      resolve(undefined);
    });
  }
  return { send, page, listeners };
}

function freshPage() {
  const clock = createClock();
  const registry = createObserverRegistry();
  return createPage({ clock, registry, visibilityState: 'hidden', focused: false });
}

// The adapter reaches for the browser's `MutationObserver` when its caller does not
// inject one -- which is exactly what content.js does. Two documents live in this
// process where the browser has one per script context, so the shim forwards to the
// page currently under test; `pump` is what names it.
let activePage = null;
globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback; this.inner = null; }
  observe() {
    const registry = activePage && activePage.registry;
    if (!registry) return;
    this.inner = new registry.FakeObserver(this.callback);
    this.inner.observe();
  }
  disconnect() { if (this.inner) this.inner.disconnect(); }
};

// The content script calls the adapter with no injected clock, so the receipt wait
// uses the real timers -- exactly as it does in the browser. The page's own render
// happens on the fake clock. Pumping both is what lets the two meet.
async function pump(page, promise, budgetMs = 9000) {
  let settled = false;
  let value;
  let failure = null;
  promise.then((v) => { settled = true; value = v; },
    (e) => { settled = true; failure = e; });
  const startedAt = Date.now();
  const previous = activePage;
  activePage = page;
  try {
    while (!settled && Date.now() - startedAt < budgetMs) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      page.clock.advance(200);
    }
  } finally {
    activePage = previous;
  }
  if (failure) throw failure;
  if (!settled) throw new Error('the content script never answered within ' + budgetMs + 'ms');
  return value;
}

async function probeId(content) {
  const reply = await content.send({ type: 'readonly-probe', requestId: 'probe-1' });
  return reply && reply.documentInstanceId;
}

// --------------------------------------------------------------- the rig
// A fake `chrome` whose tabs.sendMessage routes to whichever content script is
// live *at that moment*. That single mutable binding is the whole race.
function rig() {
  const pageA = freshPage();
  const pageB = freshPage();
  const contentA = loadContentScript(pageA);
  const contentB = loadContentScript(pageB);
  const env = createChrome({ visibilityState: 'hidden', focused: false });
  const state = { live: contentA, probed: null, writes: [] };
  env.chrome.tabs.sendMessage = async (id, msg) => {
    state.writes.push(msg);
    return state.live.send(msg);
  };
  return { pageA, pageB, contentA, contentB, env, state };
}

function wireFor(env, probe) {
  return WIRE.createChromeAutoSend(env.chrome, {
    probeSpecificTab: probe,
    getBindingState: env.getBindingState,
    now: () => 5000,
  });
}

function armedState(documentInstanceId) {
  return Object.assign(AS.createAutoSendState(), {
    enabled: true, deliveryMode: 'background', armedAt: 1000, expiresAt: 9000000,
    maxSends: 100, sentCount: 0, bindingRevision: 3, conversationId: CONV,
    documentInstanceId,
  });
}

// =====================================================================
// 1. What the worker actually puts on the wire
// =====================================================================
console.log('== T052: the write message carries the bound document identity ==');
{
  const seen = [];
  const env = createChrome({ visibilityState: 'hidden', focused: false });
  env.chrome.tabs.sendMessage = async (id, msg) => {
    seen.push(msg);
    return { ok: true, result: { status: 'refused', reason: 'composer_not_empty',
      composerTouched: false, clickPerformed: false } };
  };
  env.store.local.autosend = armedState('doc-identity-from-the-binding');
  const wiring = wireFor(env);
  await wiring.write({ runId: RUN, status: 'completed' },
    { tabId: 7, conversationId: CONV, documentInstanceId: 'doc-identity-from-the-binding' },
    'background');
  const msg = seen[0] || {};
  check(msg.type === 't058-write-notice',
    'the message is still the notice (' + msg.type + ')');
  check(msg.expectedConversationId === CONV,
    'and still carries the expected conversation');
  check(msg.deliveryMode === 'background', 'and still carries the mode');
  check(msg.expectedDocumentInstanceId === 'doc-identity-from-the-binding',
    'and now names the document instance the grant was bound to (' +
    JSON.stringify(msg.expectedDocumentInstanceId) + ')');
}

// =====================================================================
// 2. The race: a same-URL reload lands between the probe and the write
// =====================================================================
console.log('== T052: a same-URL reload between probe and write ==');
{
  const { pageA, pageB, contentA, contentB, env, state } = rig();
  const idA = await probeId(contentA);
  const idB = await probeId(contentB);
  check(typeof idA === 'string' && idA.length >= 16,
    'the first document reports a usable instance id');
  check(idA !== idB, 'and a reloaded document reports a different one (' +
    (idA === idB ? 'SAME -- the rig is wrong' : 'distinct') + ')');
  check(pageA.doc.location.href === pageB.doc.location.href,
    'both documents are at the same URL, so no route check can tell them apart (' +
    pageA.doc.location.pathname + ')');

  env.store.local.autosend = armedState(idA);
  // The probe sees document A and reports A. Then the tab reloads: the next
  // `tabs.sendMessage` reaches document B's content script. This is the precise
  // window the report is about -- nothing else is faked.
  const probe = async () => {
    const observed = {
      status: 'background_observable', tabId: 7, windowId: 2, url: URL_OK,
      conversationId: CONV, documentInstanceId: idA, observedAt: 5000,
      visibilityState: 'hidden', hasFocus: false, composerPresent: true,
      pageLoaded: true,
    };
    state.live = contentB;      // <-- the reload, after the page was measured
    return observed;
  };
  const wiring = wireFor(env, probe);
  const outcome = await pump(pageB, wiring.controller.sendOnce(
    { runId: RUN, status: 'completed' }), 9000);

  check(pageB.clicks.length === 0,
    'the reloaded document was never clicked (' + pageB.clicks.length + ')');
  check(pageB.messages.length === 0,
    'and no notice was posted into it (' + pageB.messages.length + ')');
  check(pageB.text === '', 'and its composer is still empty');
  check(outcome.sent === false && outcome.pageWriteAttempted === false,
    'the outcome is "not sent, page not written" (' + JSON.stringify({
      sent: outcome.sent, pageWriteAttempted: outcome.pageWriteAttempted }) + ')');
  check(outcome.code === 'document_instance_changed',
    'and the cause is the document identity, not a guess (' + outcome.code + ')');
  const journal = env.store.local.autosend.journal || {};
  check(!journal[AS.journalKey(RUN, 'completed')],
    'the write-ahead journal entry was rolled back');
  check(env.store.local.autosend.sentCount === 0,
    'nothing was counted as sent (' + env.store.local.autosend.sentCount + ')');

  // The original document must not be used either: its authorization is gone with
  // it, and the tab is showing something else now.
  check(pageA.clicks.length === 0 && pageA.messages.length === 0,
    'and the stale document was not written to either');
}

// =====================================================================
// 3. The gate is in the content script, before any import or page write
// =====================================================================
console.log('== T052: the content script checks its own identity first ==');
{
  const page = freshPage();
  const content = loadContentScript(page);
  const own = await probeId(content);
  const reply = await content.send({
    type: 't058-write-notice', runId: RUN, status: 'completed',
    expectedConversationId: CONV, deliveryMode: 'background',
    expectedDocumentInstanceId: 'a-document-that-is-not-this-one',
  });
  check(reply && reply.ok === true, 'the handler answers instead of throwing');
  const result = reply && reply.result;
  check(result && result.status === 'refused' && result.reason === 'document_instance_changed',
    'a foreign document id is refused (' + (result && result.reason) + ')');
  check(result && result.composerTouched === false,
    'with composerTouched:false, so the controller cannot call it an attempt');
  check(result && result.clickPerformed === false, 'and no click is claimed');
  check(page.text === '' && page.clicks.length === 0,
    'the page was never typed into or clicked');
  check(own !== 'a-document-that-is-not-this-one', 'the ids really did differ');

  // A message with no document id at all must also fail closed: writing on an
  // unprovable identity is the hazard this gate exists to remove.
  const bare = await content.send({
    type: 't058-write-notice', runId: RUN, status: 'completed',
    expectedConversationId: CONV, deliveryMode: 'background',
  });
  const bareResult = bare && bare.result;
  check(bareResult && bareResult.status === 'refused' &&
    bareResult.reason === 'document_identity_unavailable',
    'a message without the field is refused with its own code (' +
    (bareResult && bareResult.reason) + ')');
  check(bareResult && bareResult.composerTouched === false,
    'and is likewise proved to have written nothing');
  check(page.text === '' && page.clicks.length === 0,
    'so an old-style caller cannot reach the page either');

  // The matching id still delivers: the gate refuses strangers, not everybody.
  // Pumped, because a real receipt needs the page to render its bubble.
  const good = await pump(page, content.send({
    type: 't058-write-notice', runId: RUN, status: 'completed',
    expectedConversationId: CONV, deliveryMode: 'background',
    expectedDocumentInstanceId: own,
  }));
  const goodResult = good && good.result;
  check(goodResult && goodResult.status === 'submitted',
    'the matching document still delivers (' + (goodResult && goodResult.status) +
    '/' + (goodResult && goodResult.reason) + ')');
  check(page.clicks.length === 1, 'with exactly one click (' + page.clicks.length + ')');
  check(page.messages.length === 1 && page.messages[0] === NOTICE,
    'and exactly one message, the fixed notice');
}

// =====================================================================
// 4. The page layer re-asks, at its own pre-write and pre-click gates
// =====================================================================
console.log('== T052: the adapter does not take the caller\'s word for it ==');
{
  const spec = {
    runId: RUN, status: 'completed', expectedConversationId: CONV,
    deliveryMode: 'background',
  };
  const live = { documentInstanceId: 'the-document-that-is-running' };

  const pageA = freshPage();
  const stale = await drive(pageA, SA.deliverInto(pageA.doc,
    Object.assign({}, spec, { expectedDocumentInstanceId: 'the-bound-one' }), 5000,
    deps(pageA, live)), 1500);
  check(stale.status === 'refused' && stale.reason === 'document_instance_changed',
    'a pre-write mismatch is refused (' + stale.status + '/' + stale.reason + ')');
  check(stale.composerTouched === false && stale.clickPerformed === false,
    'with composerTouched:false, before anything was typed');
  check(pageA.text === '' && pageA.clicks.length === 0,
    'so the page is untouched (' + pageA.clicks.length + ' clicks)');
  check(SA.classifySendReason(stale.reason) === SA.NEVER_WRITTEN,
    'and it classifies as never_written');

  const pageB = freshPage();
  const bare = await drive(pageB, SA.deliverInto(pageB.doc, spec, 5000,
    deps(pageB, live)), 1500);
  check(bare.status === 'refused' && bare.reason === 'document_identity_unavailable',
    'an unprovable identity is refused too (' + bare.status + '/' + bare.reason + ')');
  check(bare.composerTouched === false && pageB.text === '',
    'also with nothing typed');

  // Now the same-document case, where the write happens and the pre-click gate is
  // the one that fires: the identity changes between the write and the click.
  const pageC = freshPage();
  // The same object the adapter holds, so flipping a field is seen at the pre-click
  // gate rather than in a copy taken before the call.
  const moving = deps(pageC, { documentInstanceId: 'the-document-that-is-running' });
  const inner = pageC.composer.onDispatch;
  pageC.composer.onDispatch = () => {
    if (inner) inner();
    // The write itself is the last moment before the click, so flipping here makes
    // the ordering explicit instead of racing a timer.
    moving.documentInstanceId = 'a-document-that-replaced-it';
  };
  const late = await drive(pageC, SA.deliverInto(pageC.doc,
    Object.assign({}, spec, { expectedDocumentInstanceId: 'the-document-that-is-running' }),
    5000, moving), 2000);
  check(late.status === 'unconfirmed' &&
    late.reason === 'document_instance_changed_before_click',
    'a mismatch found after the write stops the click (' +
    late.status + '/' + late.reason + ')');
  check(late.composerWritten === true && late.clickPerformed === false,
    'the split is honest: written, not clicked');
  check(pageC.clicks.length === 0, 'zero clicks (' + pageC.clicks.length + ')');
  check(SA.classifySendReason(late.reason) === SA.WRITTEN_NOT_CLICKED,
    'and it classifies as written_not_clicked, so a retry is forbidden');
}

console.log('== T052: the refusal codes land on the right verdicts ==');
{
  check(AS.classifyRefusal('document_instance_changed') === 'blocked',
    'a changed document blocks: the grant named a document that is gone');
  check(AS.classifyRefusal('document_identity_unavailable') === 'deferred',
    'an unprovable identity waits for a current content script');
  check(AS.ESCALATING_DEFERRALS.includes('document_identity_unavailable') === false,
    'but never escalates on its own; MAX_DEFERRAL_ATTEMPTS does that');
  check(AS.PRE_WRITE_BLOCKED.includes('document_instance_changed'),
    'and the block is the pre-existing T053 rule, unchanged by this round');
}

console.log('\nRESULT: ' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
