// T051: what the *page-side* writer does in a background tab when the page is
// not as quiet as we assumed.
//
// The four questions this file answers, all through the real `deliverInto`:
//   1. a non-empty draft in an unfocused tab          -> must be refused, untouched
//   2. an open dialog over the composer               -> must not be typed into
//   3. the route changing mid-write                   -> must not be clicked
//   4. the send control changing identity mid-write   -> must not be clicked
//
// Plus the two claims that are easiest to get wrong:
//   * "the value stuck" is NOT "the page submitted"  -> only a receipt can say that
//   * a React-style composer has no send button until it has text -> the dynamic
//     wait has to work in background mode, where nothing is focused.
import {
  createPage, createClock, createObserverRegistry, createChrome, deps, drive,
  makeNode, A, AS, WIRE, TT, RUN, CONV, DOC, NOTICE,
} from './test_t048_fakes.mjs';

let passed = 0;
const failures = [];
function check(ok, label) {
  if (ok) { passed += 1; return; }
  failures.push(label);
  console.log('  FAILED: ' + label);
}

// Deliberately not read off the module under test: this file has to reproduce the
// defect *before* the fix exists, and importing the selector list would turn a
// missing export into a confusing failure instead of a clean reproduction.
const MODAL_SELECTORS = [
  '[aria-modal="true"]',
  'dialog:modal',
];

const SEND_ATTRS = { type: 'submit', 'aria-label': '\u53d1\u9001' };
const noticeText = NOTICE;

// A dialog is only modelled the way the real page presents one: an overlay node
// with `aria-modal="true"` in a portal. Crucially it does NOT swallow a
// programmatic `value` write or a programmatic `click` -- both are direct
// dispatches that never consult an overlay. That is exactly why the adapter needs
// its own gate: the DOM will happily do both underneath a dialog.
function withDialog(page, options = {}) {
  const doc = page.doc;
  let open = options.open !== false;
  const node = makeNode({
    tag: 'div',
    attrs: { role: 'dialog', 'aria-modal': 'true' },
    rect: { width: 640, height: 480 },
  });
  page.all.push(node);
  const wrapped = Object.create(doc);
  wrapped.querySelectorAll = (selector) => {
    if (MODAL_SELECTORS.includes(selector)) return open ? [node] : [];
    return doc.querySelectorAll(selector);
  };
  return { doc: wrapped, node, setOpen(v) { open = v; } };
}

function sendButton(page, extra) {
  const node = makeNode(Object.assign({
    tag: 'button', attrs: SEND_ATTRS, parents: [page.all[0]],
    rect: { width: 32, height: 32 },
  }, extra || {}));
  node.click = () => {
    node.clicks += 1;
    page.clicks.push(node);
    page.messages.push(page.composer.value || '');
    page.composer.value = '';
    page.registry.notify();
  };
  page.all.push(node);
  return node;
}

const bg = (extra) => Object.assign({
  runId: RUN, status: 'completed', expectedConversationId: CONV,
  deliveryMode: 'background',
}, extra || {});

function freshPage(options) {
  const clock = createClock();
  const registry = createObserverRegistry();
  return createPage(Object.assign({ clock, registry }, options || {}));
}

// =====================================================================
// 1. A draft in an unfocused tab is still somebody's draft
// =====================================================================
console.log('== T051: a draft is refused before anything is written ==');
{
  const page = freshPage({ visibilityState: 'hidden', focused: false,
    draft: '\u534a\u622a\u8349\u7a3f' });
  const r = await drive(page, A.deliverInto(page.doc, bg(), 5000, deps(page)), 1000);
  check(r.status === 'refused' && r.reason === 'composer_not_empty',
    'a non-empty composer is refused (' + r.status + '/' + r.reason + ')');
  check(r.composerTouched === false && r.clickPerformed === false,
    'and it is reported as untouched, not as an attempted write');
  check(page.text === '\u534a\u622a\u8349\u7a3f',
    'the draft is byte-identical afterwards');
  check(page.clicks.length === 0 && page.messages.length === 0,
    'nothing was clicked and nothing was posted');
  check(page.focusCalls() === 0, 'and the composer was never focused');
}

// =====================================================================
// 2. A dialog over the page
// =====================================================================
console.log('== T051: an open dialog must not be typed through ==');
{
  const page = freshPage({ visibilityState: 'hidden', focused: false });
  const dialog = withDialog(page);
  const r = await drive(page,
    A.deliverInto(dialog.doc, bg(), 5000, deps(page)), 1500);
  check(r.status === 'refused' && r.reason === 'modal_open',
    'a background write under a dialog is refused before typing (' +
    r.status + '/' + r.reason + ')');
  check(r.composerTouched === false && r.composerWritten === false,
    'and the composer is reported untouched');
  check(r.clickPerformed === false, 'and no click is reported');
  check(page.text === '', 'the composer is still empty');
  check(page.clicks.length === 0 && page.messages.length === 0,
    'so nothing was sent into the conversation (' + page.messages.length + ' msgs)');
  check(r.evidence && r.evidence.precheckOnly === true,
    'the refusal carries precheckOnly, so it cannot be read as a write');
  check(r.evidence && r.evidence.dialog === MODAL_SELECTORS[0],
    'and names which modal signal was seen (' +
    JSON.stringify(r.evidence && r.evidence.dialog) + ')');

  // Closing the dialog must be enough: this is a deferral, not a permanent block.
  dialog.setOpen(false);
  const after = await drive(page,
    A.deliverInto(dialog.doc, bg(), 5000, deps(page)), 1500);
  check(after.status === 'submitted',
    'once the dialog closes the same page delivers (' + after.status +
    (after.status === 'submitted' ? '' : '/' + after.reason) + ')');
  check(page.clicks.length === 1, 'with exactly one click (' + page.clicks.length + ')');
}

console.log('== T051: a dialog that opens after the write still blocks the click ==');
{
  const page = freshPage({ visibilityState: 'hidden', focused: false, send: 'none' });
  const dialog = withDialog(page, { open: false });
  const first = sendButton(page, { disabled: true });
  const inner = page.composer.onDispatch;
  page.composer.onDispatch = () => {
    if (inner) inner();
    // Enable the control (so the ready-wait resolves) and open a dialog in the same
    // tick -- the shape of "the operator clicked something while we were writing".
    page.clock.setTimeout(() => {
      first.disabled = false;
      dialog.setOpen(true);
      page.registry.notify();
    }, 10);
  };
  const r = await drive(page,
    A.deliverInto(dialog.doc, bg(), 5000, deps(page)), 2000);
  check(r.status === 'unconfirmed' && r.reason === 'modal_open_before_click',
    'a dialog opened before the click stops the click (' +
    r.status + '/' + r.reason + ')');
  check(r.composerWritten === true && r.clickPerformed === false,
    'the write is admitted and the click is not (the honest split)');
  check(page.clicks.length === 0 && page.messages.length === 0,
    'so no message reached the conversation');
}

// =====================================================================
// 3. The route moves underneath the notice
// =====================================================================
console.log('== T051: a navigation during the write is never clicked through ==');
{
  const page = freshPage({
    visibilityState: 'hidden', focused: false, send: 'none', navigateOnInput: true,
  });
  const submit = sendButton(page, { disabled: true });
  page.clock.setTimeout(() => { submit.disabled = false; page.registry.notify(); }, 10);
  const r = await drive(page,
    A.deliverInto(page.doc, bg(), 5000, deps(page)), 2000);
  check(r.status === 'unconfirmed' &&
    (r.reason === 'conversation_changed_before_click' ||
     r.reason === 'conversation_route_changed'),
    'a route change is refused (' + r.status + '/' + r.reason + ')');
  check(r.clickPerformed === false, 'and nothing was clicked');
  check(page.clicks.length === 0, 'zero clicks (' + page.clicks.length + ')');
}

// =====================================================================
// 4. The send control changes identity
// =====================================================================
console.log('== T051: the pre-click control identity check still holds ==');
{
  const page = freshPage({ visibilityState: 'hidden', focused: false, send: 'none' });
  const first = sendButton(page, { disabled: true });
  const inner = page.composer.onDispatch;
  page.composer.onDispatch = () => {
    if (inner) inner();
    page.clock.setTimeout(() => {
      first.disabled = false;      // the original becomes usable ...
      sendButton(page);            // ... and a twin appears beside it
      page.registry.notify();
    }, 10);
  };
  const r = await drive(page,
    A.deliverInto(page.doc, bg(), 5000, deps(page)), 2000);
  check(r.status === 'unconfirmed' && r.reason === 'send_control_changed_before_click',
    'two candidate controls refuse the click (' + r.status + '/' + r.reason + ')');
  check(r.clickPerformed === false && page.clicks.length === 0,
    'and neither control was clicked');
}

console.log('== T051: two candidates are refused before the composer is touched ==');
{
  const page = freshPage({ visibilityState: 'hidden', focused: false, send: 'none' });
  sendButton(page);
  sendButton(page);
  const r = await drive(page,
    A.deliverInto(page.doc, bg(), 5000, deps(page)), 1500);
  check(r.status === 'refused' && r.reason === 'send_control_ambiguous',
    'an ambiguous send control is a pre-write refusal (' +
    r.status + '/' + r.reason + ')');
  check(r.composerTouched === false && page.text === '',
    'so nothing was typed into the box');
}

// =====================================================================
// 5. "The value stuck" is not "the page submitted"
// =====================================================================
console.log('== T051: a refused synthetic write never reaches a click ==');
{
  // The React-controlled case: assigning `.value` does not stick because the
  // component only accepts text it believes a human typed.
  const page = freshPage({
    visibilityState: 'hidden', focused: false, ignoreSyntheticInput: true,
  });
  const r = await drive(page,
    A.deliverInto(page.doc, bg(), 5000, deps(page)), 1500);
  check(r.status === 'refused' && r.reason === 'insert_mismatch',
    'a write the page does not adopt is refused (' + r.status + '/' + r.reason + ')');
  check(r.composerTouched === true && r.clickPerformed === false,
    'it is reported as touched-but-not-clicked, which is a different fact');
  check(page.clicks.length === 0 && page.messages.length === 0,
    'and no message was posted');
  check(A.classifySendReason(r.reason) === A.WRITTEN_NOT_CLICKED,
    'classified as written_not_clicked (' + A.classifySendReason(r.reason) + ')');
}

console.log('== T051: text in the composer is not proof of submission ==');
{
  // The text sticks, the button is there, the click happens -- and the page never
  // renders a bubble. Only `submitted` may be reported for a real receipt.
  const page = freshPage({
    visibilityState: 'hidden', focused: false, neverCommits: true,
  });
  const r = await drive(page,
    A.deliverInto(page.doc, bg(), 5000, deps(page)), 6000);
  check(r.composerWritten === true && r.clickPerformed === true,
    'the click was made once on a page that adopted the text');
  check(r.status === 'unconfirmed' && r.reason === 'delivery_not_confirmed',
    'and the outcome is unconfirmed, never submitted (' +
    r.status + '/' + r.reason + ')');
  check(r.evidence && r.evidence.exactTemplateMatched === false,
    'because no exact-template bubble appeared');
  check(r.evidence && r.evidence.deliveryMode === 'background',
    'with the delivery mode recorded in the evidence');
  check(page.clicks.length === 1, 'exactly one click (' + page.clicks.length + ')');
}

// =====================================================================
// 6. A React-style composer with no button yet, in a hidden tab
// =====================================================================
console.log('== T051: the dynamic send control works with nothing focused ==');
{
  const page = freshPage({
    visibilityState: 'hidden', focused: false, send: 'none',
  });
  // The page has no send control while the composer is empty and creates one on the
  // render that follows the input event. That is the layout T081 measured, and it
  // has to work in a tab where nothing is focused.
  const inner = page.composer.onDispatch;
  page.composer.onDispatch = () => {
    if (inner) inner();
    page.clock.setTimeout(() => {
      if (page.send.node) return;
      page.send.node = sendButton(page);
      page.registry.notify();
    }, 0);
  };
  const r = await drive(page,
    A.deliverInto(page.doc, bg(), 5000, deps(page)), 3000);
  check(r.status === 'submitted',
    'the button the page creates after the write is used (' + r.status + '/' +
    r.reason + ')');
  check(r.evidence && r.evidence.controlMode === 'dynamic',
    'and the dynamic mode is recorded (' +
    JSON.stringify(r.evidence && r.evidence.controlMode) + ')');
  check(page.clicks.length === 1 && page.messages.length === 1,
    'one click, one message (' + page.clicks.length + '/' + page.messages.length + ')');
  check(page.messages[0] === noticeText, 'and the message is the exact notice');
  check(page.focusCalls() === 0, 'with zero focus calls in a hidden tab');
}

// =====================================================================
// 7. Policy: a dialog defers and never disarms; doubt still stops
// =====================================================================
console.log('== T051: what the refusal codes mean one layer up ==');
{
  check(AS.classifyRefusal('modal_open') === 'deferred',
    'modal_open is a deferral, so the candidate stays queued');
  check(AS.ESCALATING_DEFERRALS.includes('modal_open') === false,
    'and it never escalates to a block (a dialog is transient)');
  check(A.classifySendReason('modal_open') === A.NEVER_WRITTEN,
    'the adapter classifies modal_open as never_written');
  check(A.classifySendReason('modal_open_before_click') === A.WRITTEN_NOT_CLICKED,
    'and modal_open_before_click as written_not_clicked');

  const binding = { manuallyConfirmed: true, conversationId: CONV, revision: 1 };
  const armed = TT.configure(TT.createTriggerState(), { binding },
    TT.CONFIRM_PREFIX + CONV, true, 0).state;
  const k = TT.key(RUN, 'completed');
  const marked = TT.markAttempt(armed, { runId: RUN, status: 'completed' }, 0);

  const deferred = TT.settle(marked.state, k,
    { sent: false, pageWriteAttempted: false, code: 'modal_open',
      detail: MODAL_SELECTORS[0] }, 0);
  check(deferred.result.status === 'deferred' && deferred.state.enabled === true,
    'a dialog leaves the trigger armed');
  check(deferred.state.windowCount === 0,
    'and consumes no quota (the window counter is untouched)');
  check(deferred.state.deferred[k].detail === MODAL_SELECTORS[0],
    'and records which dialog signal was seen');

  const clicked = TT.settle(
    TT.markAttempt(armed, { runId: RUN, status: 'completed' }, 0).state, k,
    { sent: false, pageWriteAttempted: true, code: 'unconfirmed',
      reason: 'modal_open_before_click' }, 0);
  check(clicked.result.code === 'stopped' && clicked.state.enabled === false,
    'a dialog seen after the write stops the trigger instead of retrying');
  check(clicked.state.seen[k].state === 'stopped',
    'and the run is recorded as stopped, so it is never offered again');
  check(!clicked.state.deferred[k], 'with no waiting row left behind');
}

// =====================================================================
// 8. The gate through the real controller and the real wiring
// =====================================================================
console.log('== T051: a refused dialog write is never journalled as a send ==');
{
  const page = freshPage({ visibilityState: 'hidden', focused: false });
  const dialog = withDialog(page);
  const env = createChrome({ visibilityState: 'hidden', focused: false });
  // Route the worker's message into the *real* adapter against the fake page, so
  // this measures the shipped path rather than a stub.
  env.chrome.tabs.sendMessage = async (id, msg) => ({
    ok: true, result: await A.deliverInto(dialog.doc, msg, 5000, deps(page)),
  });
  env.store.local.autosend = Object.assign(AS.createAutoSendState(), {
    enabled: true, deliveryMode: 'background', armedAt: 1000, expiresAt: 9000000,
    maxSends: 100, sentCount: 0, bindingRevision: 3, conversationId: CONV,
    documentInstanceId: DOC,
  });
  const wiring = WIRE.createChromeAutoSend(env.chrome, {
    probeSpecificTab: env.probeSpecificTab,
    getBindingState: env.getBindingState,
    now: () => 5000,
  });
  const outcome = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });

  check(outcome.sent === false && outcome.pageWriteAttempted === false,
    'the outcome is "not sent, page not written" (' +
    JSON.stringify({ sent: outcome.sent, pageWriteAttempted: outcome.pageWriteAttempted }) + ')');
  check(outcome.code === 'modal_open',
    'with the dialog named as the cause (' + outcome.code + ')');
  check(outcome.evidence && outcome.evidence.dialog === MODAL_SELECTORS[0],
    'and the evidence names the modal signal');
  const journal = env.store.local.autosend.journal || {};
  check(!journal[AS.journalKey(RUN, 'completed')],
    'the write-ahead journal entry was rolled back, so this was never an attempt');
  check(env.store.local.autosend.enabled === true,
    'and the grant is still enabled -- a dialog must not disarm it');
  check(env.store.local.autosend.sentCount === 0,
    'and no send was counted against the quota');
  check(page.messages.length === 0 && page.clicks.length === 0,
    'nothing reached the conversation (' + page.messages.length + ' msgs)');
  const activating = env.calls.filter((call) => ['tabs.update', 'tabs.highlight',
    'tabs.create', 'windows.update', 'windows.create'].includes(call[0]));
  check(activating.length === 0,
    'and nothing tried to activate, switch or open a tab (' + activating.length + ')');
}

console.log('\nRESULT: ' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
