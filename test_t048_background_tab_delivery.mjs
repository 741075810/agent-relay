// T048: background-tab delivery -- the fail-first reproduction, then the matrix.
//
// Section 1 proves, against the *current* modules, exactly what the user reports:
// with the tab in the background the notice is deferred and nothing is sent. That
// is the bug, reproduced before any fix existed.
//
// Section 2 proves the second refusal -- the adapter's own `doc.hasFocus()` gate.
//
// Section 3 onward exercises the new `background` delivery mode: its own
// confirmation phrase, the preserved gates, and the preserved refusals for frozen /
// discarded / navigated / occupied / duplicated states.
//
// No browser, no ChatGPT, no network. What is NOT claimed: that ChatGPT's own front
// end accepts a programmatic submit while the tab is hidden. That needs one real
// canary, and the report says so.
import { readFileSync } from 'node:fs';
import {
  A, AS, WIRE, TT, PRE, NOTICE, CONV, CONV2, RUN, RUN2, URL_OK, DOC, FG_PHRASE,
  BG_PHRASE, createClock, createObserverRegistry, createPage, createChrome, build,
  drive, deps,
} from './test_t048_fakes.mjs';

let passed = 0;
const failures = [];
function check(ok, label) {
  if (ok) { passed += 1; console.log('  PASS  ' + label); return; }
  failures.push(label);
  console.log('  FAIL  ' + label);
}

const spec = (over) => Object.assign({
  runId: RUN, status: 'completed', expectedConversationId: CONV,
}, over || {});
const deliver = (page, over, budget = 4000) =>
  drive(page, A.deliverInto(page.doc, spec(over.deliveryMode ? over : over),
    1000, deps(page, over)), budget);

async function main() {
  // =====================================================================
  // 1. FAIL-FIRST: a background tab is refused by the policy gate today
  // =====================================================================
  console.log('== T048 fail-first: the background tab is refused before any fix ==');
  {
    // Tab inactive, document hidden, page unfocused -- the user's exact situation.
    const { env, wiring } = build({ active: false, focused: false,
      visibilityState: 'hidden' });
    // A foreground grant, which is all that exists today.
    const armed = await wiring.controller.armWith({}, FG_PHRASE, true);
    check(armed.ok === true, 'a foreground grant arms as it always has');
    check(armed.deliveryMode === undefined || armed.deliveryMode === 'foreground',
      'and reports foreground semantics (' + armed.deliveryMode + ')');

    const result = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
    check(result.sent === false, 'a background tab is NOT sent to');
    check(result.code === 'target_not_visible_and_focused',
      'and the reason is the focus gate (' + result.code + ')');
    check(result.pageWriteAttempted === false,
      'with the writer proving the page was never touched');
    const writes = env.calls.filter((c) => c[0] === 'tabs.sendMessage');
    check(writes.length === 0,
      'nothing reached the content script (' + writes.length + ' messages)');
  }

  // =====================================================================
  // 2. FAIL-FIRST: the adapter's own focus gate, before write and before click
  // =====================================================================
  console.log('== T048 fail-first: the writer refuses an unfocused document ==');
  {
    const page = createPage({ focused: false, visibilityState: 'hidden' });
    const r = await drive(page, A.deliverInto(page.doc, spec(), 1000, deps(page)), 3000);
    check(r.status === 'refused' && r.reason === 'target_focus_lost',
      'the adapter refuses before writing (' + r.status + '/' + r.reason + ')');
    check(r.composerTouched === false && r.clickPerformed === false,
      'and says the composer was never touched');
    check(page.text === '', 'the composer really is empty ("' + page.text + '")');
    check(page.clicks.length === 0, 'and nothing was clicked');
  }
  {
    // Losing focus *after* the write is the worst case: the notice is already in
    // the box, so the outcome is unconfirmed and must never be retried.
    //
    // The flip is deterministic (a call counter) rather than a timer, because a
    // timer would race the adapter's own promise continuations and could fire
    // after the click -- proving nothing about the pre-click check.
    const page = createPage({ focused: true, focusFlipAfter: 1 });
    const r = await drive(page, A.deliverInto(page.doc, spec(), 1000,
      deps(page)), 3000);
    check(r.status === 'unconfirmed' && r.reason === 'target_lost_focus_before_click',
      'losing focus before the click is unconfirmed (' + r.status + '/' + r.reason + ')');
    check(r.composerWritten === true && r.clickPerformed === false,
      'the text is in the box and nothing was clicked');
    check(page.clicks.length === 0, 'no click happened');
  }

  // =====================================================================
  // 3. The new mode cannot be reached by the old phrase
  // =====================================================================
  console.log('== T048: background needs its own explicit authorization ==');
  {
    const { wiring } = build();
    const wrong = await wiring.controller.armWith({ deliveryMode: 'background' },
      FG_PHRASE, true);
    check(wrong.ok === false && wrong.code === 'arm_background_confirmation_mismatch',
      'the foreground phrase does not arm background (' + wrong.code + ')');
    const noGesture = await wiring.controller.armWith({ deliveryMode: 'background' },
      BG_PHRASE, false);
    check(noGesture.ok === false && noGesture.code === 'arm_user_gesture_required',
      'a button-less call cannot arm it (' + noGesture.code + ')');
    const okay = await wiring.controller.armWith({ deliveryMode: 'background' },
      BG_PHRASE, true);
    check(okay.ok === true, 'the background phrase does arm it');
    check(okay.deliveryMode === 'background', 'and the grant records the mode (' +
      okay.deliveryMode + ')');
    // The old phrase must still work for the old mode.
    const fg = await wiring.controller.armWith({}, FG_PHRASE, true);
    check(fg.ok === true && fg.deliveryMode === 'foreground',
      'and the foreground phrase still arms foreground (' + fg.deliveryMode + ')');
  }

  // =====================================================================
  // 4. Existing grants do not silently become background-capable
  // =====================================================================
  console.log('== T048: a stored grant with no mode stays foreground ==');
  {
    const state = AS.createAutoSendState();
    check(state.deliveryMode === 'foreground',
      'a fresh state is foreground (' + state.deliveryMode + ')');
    const legacy = Object.assign(AS.createAutoSendState(), {
      enabled: true, armedAt: 1000, expiresAt: 9000000, maxSends: 100,
      sentCount: 0, bindingRevision: 3, conversationId: CONV,
      documentInstanceId: DOC,
    });
    delete legacy.deliveryMode;                    // exactly what T058 wrote
    const binding = { revision: 3, conversationId: CONV, documentInstanceId: DOC,
      tabId: 7, windowId: 2, url: URL_OK, manuallyConfirmed: true };
    const probe = { tabId: 7, windowId: 2, url: URL_OK, conversationId: CONV,
      documentInstanceId: DOC, observedAt: 5000, active: false, hasFocus: false,
      visibilityState: 'hidden', composerPresent: true, composerEmpty: true };
    const verdict = AS.decide(legacy, { binding, probe, runId: RUN,
      status: 'completed' }, 5000);
    check(verdict.send === false && verdict.code === 'target_not_visible_and_focused',
      'a legacy grant still refuses a background tab (' + verdict.code + ')');

    const bgState = Object.assign({}, legacy, { deliveryMode: 'background' });
    const bgVerdict = AS.decide(bgState, { binding, probe, runId: RUN,
      status: 'completed' }, 5000);
    check(bgVerdict.send === true,
      'the same facts in background mode are allowed (' + bgVerdict.code + ')');
  }

  // =====================================================================
  // 5. Background delivery through the real wiring + the real adapter
  // =====================================================================
  console.log('== T048: a background tab is delivered exactly once ==');
  {
    const page = createPage({ focused: false, visibilityState: 'hidden' });
    const r = await drive(page, A.deliverInto(page.doc,
      spec({ deliveryMode: 'background' }), 1000, deps(page)), 4000);
    check(r.status === 'submitted', 'the notice submits from a hidden tab (' +
      r.status + '/' + r.reason + ')');
    check(page.clicks.length === 1, 'with exactly one click (' + page.clicks.length + ')');
    check(page.messages.length === 1 && page.messages[0] === NOTICE,
      'carrying the fixed template once ("' + page.messages[0] + '")');
    check(r.evidence && r.evidence.deliveryMode === 'background',
      'and the evidence records the mode (' + (r.evidence && r.evidence.deliveryMode) + ')');
  }
  {
    // The composer must not be focused: `composer.focus()` can raise the window,
    // which is the one thing this mode must never do.
    const page = createPage({ focused: false, visibilityState: 'hidden' });
    await drive(page, A.deliverInto(page.doc, spec({ deliveryMode: 'background' }),
      1000, deps(page)), 4000);
    check(page.focusCalls() === 0,
      'the background writer never calls composer.focus() (' + page.focusCalls() + ')');
  }
  {
    // Foreground mode must still focus, unchanged.
    const page = createPage({ focused: true });
    await drive(page, A.deliverInto(page.doc, spec(), 1000, deps(page)), 4000);
    check(page.focusCalls() === 1,
      'foreground mode still focuses the composer once (' + page.focusCalls() + ')');
  }

  // =====================================================================
  // 6. A tab whose document was hidden must still be observed as the target
  // =====================================================================
  console.log('== T048: hidden is not a risk signal, prerender/unloaded still are ==');
  {
    const base = {
      status: 'background_observable', tabId: 7, windowId: 2, url: URL_OK,
      conversationId: CONV, documentInstanceId: DOC, observedAt: 5000,
      composerPresent: true, pageLoaded: true, routeStable: true,
    };
    const tab = { id: 7, windowId: 2, url: URL_OK, active: false, discarded: false,
      frozen: false };
    const after = Object.assign({}, tab);
    for (const [visibility, expected] of [['visible', true], ['hidden', true],
      ['prerender', false], ['unloaded', false]]) {
      const assessed = PRE.assessProbe(tab, Object.assign({}, base, {
        requestId: 'r1', visibilityState: visibility, hasFocus: false,
      }), after, 5000, 'r1');
      check(assessed.status === 'background_observable',
        visibility + ' is still a background observation (' + assessed.status + ')');
      check(assessed.backgroundDeliverable === expected,
        visibility + ' deliverable=' + expected + ' (got ' +
        assessed.backgroundDeliverable + ')');
      check(assessed.sendEligible === false,
        visibility + ' never makes a probe send-eligible by itself');
      check(assessed.focusEvidence && assessed.focusEvidence.active === false,
        visibility + ' keeps the focus facts as facts');
      check(assessed.focusRisk === undefined,
        visibility + ' is not labelled a known risk');
    }
  }
  {
    // Frozen and discarded tabs must be excluded in both modes. Two separate
    // facts are asserted: the tab-level classifier refuses them outright, and a
    // tab that drops *during* the probe is refused rather than observed.
    const tab = { id: 7, windowId: 2, url: URL_OK, active: false, discarded: false,
      frozen: false };
    for (const [flag, status] of [['discarded', 'discarded'], ['frozen', 'frozen']]) {
      const dirty = Object.assign({}, tab, { [flag]: true });
      check(PRE.classifyTab(dirty).status === status,
        'a ' + flag + ' tab is classified ' + status + ' (' +
        PRE.classifyTab(dirty).status + ')');
      const assessed = PRE.assessProbe(tab, { requestId: 'r1' }, dirty, 5000, 'r1');
      check(String(assessed.status).startsWith(status),
        'and dropping during the probe is refused as ' + status + '_during_probe (' +
        assessed.status + ')');
      check(assessed.backgroundObservable === false,
        'and it is not observable');
    }
  }

  // =====================================================================
  // 7. Every old gate survives in background mode
  // =====================================================================
  console.log('== T048: background mode keeps every other refusal ==');
  {
    const state = Object.assign(AS.createAutoSendState(), {
      enabled: true, deliveryMode: 'background', armedAt: 1000, expiresAt: 9000000,
      maxSends: 100, sentCount: 0, bindingRevision: 3, conversationId: CONV,
      documentInstanceId: DOC,
    });
    const binding = { revision: 3, conversationId: CONV, documentInstanceId: DOC,
      tabId: 7, windowId: 2, url: URL_OK, manuallyConfirmed: true };
    const good = { tabId: 7, windowId: 2, url: URL_OK, conversationId: CONV,
      documentInstanceId: DOC, observedAt: 5000, active: false, hasFocus: false,
      visibilityState: 'hidden', composerPresent: true, composerEmpty: true };
    const at = (probe, extra) => AS.decide(state, Object.assign({
      binding, probe, runId: RUN, status: 'completed' }, extra || {}), 5000);

    check(at(good).send === true, 'the control case still sends');
    check(at(Object.assign({}, good, { composerEmpty: false })).code ===
      'session_occupied', 'a draft still blocks');
    check(at(Object.assign({}, good, { modalOpen: true })).code ===
      'session_occupied_by_dialog', 'a dialog still blocks');
    check(at(Object.assign({}, good, { conversationId: CONV2 })).code ===
      'conversation_identity_mismatch', 'a changed conversation still blocks');
    check(at(Object.assign({}, good, { url: URL_OK + '?x=1' })).code ===
      'redirect_or_url_mismatch', 'a changed URL still blocks');
    check(at(Object.assign({}, good, { tabId: 8 })).code === 'wrong_tab',
      'a different tab still blocks');
    check(at(Object.assign({}, good, { documentInstanceId: 'other' })).code ===
      'document_instance_changed', 'a reloaded document still blocks');
    check(at(Object.assign({}, good, { observedAt: -100 })).code === 'probe_stale',
      'a stale probe still waits');
    check(at(Object.assign({}, good, { discarded: true })).code ===
      'target_background_unobservable', 'a discarded tab is refused, not sent');
    check(at(Object.assign({}, good, { frozen: true })).code ===
      'target_background_unobservable', 'a frozen tab is refused, not sent');
    check(at(Object.assign({}, good, { visibilityState: 'prerender' })).code ===
      'target_background_unobservable', 'a prerendering tab is refused, not sent');
    check(at(good, { binding: Object.assign({}, binding, { conversationId: CONV2 }) })
      .code === 'conversation_changed', 'a re-armed conversation still blocks');
    check(at(good, { runId: RUN2, status: 'failed' }).send === true,
      'a different run is admitted');
    const expired = Object.assign({}, state, { expiresAt: 4000 });
    const ex = AS.decide(expired, { binding, probe: good, runId: RUN,
      status: 'completed' }, 5000);
    check(ex.code === 'authorization_expired', 'an expired grant still blocks (' +
      ex.code + ')');
    const drained = Object.assign({}, state, { sentCount: 100 });
    check(AS.decide(drained, { binding, probe: good, runId: RUN,
      status: 'completed' }, 5000).code === 'authorization_exhausted',
      'an exhausted grant still blocks');
  }

  // =====================================================================
  // 8. Content-side re-check: the page refuses a prerendering document itself
  // =====================================================================
  console.log('== T048: the writer re-checks the page rather than trusting the caller ==');
  {
    for (const visibility of ['prerender', 'unloaded']) {
      const page = createPage({ focused: false, visibilityState: visibility });
      const r = await drive(page, A.deliverInto(page.doc,
        spec({ deliveryMode: 'background' }), 1000, deps(page)), 2000);
      check(r.status === 'refused' && r.reason === 'target_background_unobservable',
        'a ' + visibility + ' document is refused by the writer (' +
        r.status + '/' + r.reason + ')');
      check(page.text === '' && page.clicks.length === 0,
        'and nothing was written or clicked for ' + visibility);
    }
    // A front end that ignores synthetic input must be reported, not retried.
    const deaf = createPage({ focused: false, visibilityState: 'hidden',
      ignoreSyntheticInput: true });
    const r = await drive(deaf, A.deliverInto(deaf.doc,
      spec({ deliveryMode: 'background' }), 1000, deps(deaf)), 2000);
    check(r.status === 'refused' && r.reason === 'insert_mismatch',
      'a page that refuses the write is reported honestly (' + r.status + '/' +
      r.reason + ')');
    check(deaf.clicks.length === 0, 'and no click is attempted after a failed write');
  }

  // =====================================================================
  // 9. Navigation between write and click, in background mode
  // =====================================================================
  console.log('== T048: a route change between write and click is unconfirmed ==');
  {
    // The route moves *during* the write, which is the window a background
    // delivery really has to survive: the notice is in the box and the page
    // underneath it is no longer the conversation we bound.
    const page = createPage({ focused: false, visibilityState: 'hidden',
      navigateOnInput: true });
    const r = await drive(page, A.deliverInto(page.doc,
      spec({ deliveryMode: 'background' }), 1000, deps(page, { readyTimeoutMs: 400 })),
      3000);
    check(r.status === 'unconfirmed', 'a navigation mid-flight is unconfirmed (' +
      r.status + '/' + r.reason + ')');
    check(r.clickPerformed === false, 'and no click was made after the page moved');
    check(page.clicks.length === 0, 'no control was clicked');
  }

  // =====================================================================
  // 10. Repeated ticks and repeated tab switches never duplicate
  // =====================================================================
  console.log('== T048: switching tabs repeatedly does not send twice ==');
  {
    const { env, wiring } = build({ active: false, focused: false,
      visibilityState: 'hidden' });
    await wiring.controller.armWith({ deliveryMode: 'background' }, BG_PHRASE, true);
    const first = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
    check(first.sent === true, 'the first attempt sends (' + first.code + ')');
    for (let i = 0; i < 5; i += 1) {
      const again = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
      check(again.sent === false && again.code === 'duplicate_event',
        'attempt ' + (i + 2) + ' is a duplicate, not a resend (' + again.code + ')');
    }
    const writes = env.calls.filter((c) => c[0] === 'tabs.sendMessage');
    check(writes.length === 1, 'the page was written once in total (' + writes.length + ')');
    check(writes[0][3] === 'background',
      'and the message carried the background mode (' + writes[0][3] + ')');
    const status = await wiring.controller.state();
    check(status.sentCount === 1, 'the quota moved by exactly one (' + status.sentCount + ')');
    const other = await wiring.controller.sendOnce({ runId: RUN, status: 'failed' });
    check(other.sent === false && other.code === 'duplicate_run',
      'a second status for the same run is also refused (' + other.code + ')');
  }

  // =====================================================================
  // 11. No activation surface, statically and at runtime
  // =====================================================================
  console.log('== T048: nothing activates, focuses or opens a window ==');
  {
    const { env, wiring } = build({ active: false, focused: false,
      visibilityState: 'hidden' });
    await wiring.controller.armWith({ deliveryMode: 'background' }, BG_PHRASE, true);
    await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
    const forbidden = env.calls.filter((c) => ['tabs.update', 'tabs.highlight',
      'tabs.create', 'windows.update', 'windows.create'].includes(c[0]));
    check(forbidden.length === 0,
      'no activation call was made (' + JSON.stringify(forbidden) + ')');
    for (const name of ['autosend', 'autosend_controller',
      'autosend_chrome_wiring', 'send_adapter']) {
      const source = readFileSyncSafe(name).replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const hit = /tabs\.(update|highlight|create|move|reload)|windows\.(update|create)/;
      check(!hit.test(source), name + ' has no activation surface outside comments');
    }
  }

  // =====================================================================
  // 12. The terminal trigger keeps a repeated deferral observable, then blocks
  // =====================================================================
  console.log('== T048: a permanently unobservable tab stops after bounded tries ==');
  {
    let state = TT.createTriggerState();
    const triggerBinding = { conversationId: CONV, manuallyConfirmed: true,
      revision: 3, tabId: 7, windowId: 2, url: URL_OK };
    const configured = TT.configure(state, { binding: triggerBinding },
      'AUTOTRIGGER ' + CONV, true, 1000);
    check(configured.result.ok === true, 'the trigger arms');
    const candidate = { runId: RUN, status: 'completed', startedAt: 2000,
      finishedAt: 3000, postArm: true };
    const first = TT.settle(TT.markAttempt(configured.state, candidate, 4000).state,
      TT.key(RUN, 'completed'),
      { sent: false, pageWriteAttempted: false, code: 'target_background_unobservable' },
      4000);
    check(first.result.status === 'deferred',
      'a pre-write refusal defers (' + first.result.status + ')');
    check(first.state.enabled === true, 'and the trigger stays armed');
    check(first.state.deferred[TT.key(RUN, 'completed')].detail !== undefined,
      'the deferred entry carries a detail field for the cause');
    let cursor = first.state;
    let last = first;
    let tried = 0;
    // Stop as soon as it blocks. Continuing past that point would
    // re-defer against a disabled trigger and report the wrong thing.
    while (last.result.status === 'deferred' && tried < 6) {
      tried += 1;
      const marked = TT.markAttempt(cursor, candidate, 5000 + tried * 600000);
      last = TT.settle(marked.state, marked.key,
        { sent: false, pageWriteAttempted: false,
          code: 'target_background_unobservable', cause: 'discarded' },
        5000 + tried * 600000);
      cursor = last.state;
    }
    check(tried < 6, 'it stops on its own after a bounded number of tries (' +
      tried + ')');
    // `settle` reports a block through `code`, not `status` -- the two outcomes
    // have different shapes, and the deferral branch is the only one with status.
    check(last.result.code === 'blocked',
      'after the bounded deferrals it blocks instead of waiting for ever (' +
      last.result.code + '/' + last.result.status + ')');
    check(last.result.reason === 'target_background_unobservable',
      'and the block names the cause (' + last.result.reason + ')');
    check(cursor.enabled === false, 'and the trigger is disabled for a human to look');
    check(/blocked:target_background_unobservable/.test(cursor.lastError || ''),
      'with a reason that names the cause (' + cursor.lastError + ')');
  }

  // =====================================================================
  // 13. The page shapes that only appear in a real background tab
  // =====================================================================
  console.log('== T048: background tab page shapes ==');
  {
    // The send button materialises only after the input event, which is exactly
    // what happens on the served front end (T081). Waiting for it must still be
    // bounded, and the notice must still be confirmed by its own bubble.
    const page = createPage({ focused: false, visibilityState: 'hidden',
      send: 'dynamic' });
    const r = await drive(page, A.deliverInto(page.doc,
      spec({ deliveryMode: 'background' }), 1000, deps(page)), 4000);
    check(r.status === 'submitted', 'a late send button is still clicked once (' +
      r.status + '/' + r.reason + ')');
    check(page.clicks.length === 1 && page.messages[0] === NOTICE,
      'and the delivery is confirmed by the exact bubble');
  }
  {
    // A slow render: the receipt arrives well after the click. The adapter must
    // wait for it rather than call it a timeout.
    const page = createPage({ focused: false, visibilityState: 'hidden',
      commitDelayMs: 900 });
    const r = await drive(page, A.deliverInto(page.doc,
      spec({ deliveryMode: 'background' }), 1000, deps(page)), 4000);
    check(r.status === 'submitted', 'a slow background receipt still confirms (' +
      r.status + '/' + r.reason + ')');
    check(r.evidence && r.evidence.waitedMs >= 900,
      'and the wait is reported, not hidden (' +
      (r.evidence && r.evidence.waitedMs) + ' ms)');
  }
  {
    // The page never renders the bubble. Nothing may be claimed, and the click
    // already happened -- so this must be unconfirmed rather than deferred.
    const page = createPage({ focused: false, visibilityState: 'hidden',
      neverCommits: true });
    const r = await drive(page, A.deliverInto(page.doc,
      spec({ deliveryMode: 'background' }), 1000, deps(page, { timeoutMs: 800 })), 4000);
    check(r.status === 'unconfirmed' && r.reason === 'delivery_not_confirmed',
      'a receipt that never arrives is unconfirmed (' + r.status + '/' + r.reason + ')');
    check(r.clickPerformed === true,
      'and the click is still reported as having happened');
  }
  {
    // The operator comes back to the tab while the notice is in flight. This must
    // not produce a second write: the click already governs the outcome.
    const page = createPage({ focused: false, visibilityState: 'hidden',
      commitDelayMs: 400 });
    const promise = A.deliverInto(page.doc, spec({ deliveryMode: 'background' }),
      1000, deps(page));
    page.clock.setTimeout(() => { page.setVisibility('visible'); page.setFocus(true); }, 60);
    const r = await drive(page, promise, 4000);
    check(r.status === 'submitted', 'returning to the tab mid-flight still submits (' +
      r.status + '/' + r.reason + ')');
    check(page.clicks.length === 1 && page.messages.length === 1,
      'with one click and one message (' + page.clicks.length + '/' +
      page.messages.length + ')');
  }

  // =====================================================================
  // 14. Browser closed, tab discarded, tab frozen -- measured, not assumed
  // =====================================================================
  console.log('== T048: unobservable tabs defer with a cause, never send ==');
  {
    for (const [option, code, wantDetail] of [
      ['discarded', 'target_background_unobservable', 'discarded'],
      ['frozen', 'target_background_unobservable', 'frozen'],
    ]) {
      const { env, wiring } = build({ active: false, focused: false,
        visibilityState: 'hidden', [option]: true });
      await wiring.controller.armWith({ deliveryMode: 'background' }, BG_PHRASE, true);
      const r = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
      check(r.sent === false && r.code === code,
        'a ' + option + ' tab refuses with ' + code + ' (' + r.code + ')');
      check(r.pageWriteAttempted === false, 'and nothing was written');
      check(r.detail === wantDetail,
        'and the cause is carried through (' + r.detail + ')');
      const writes = env.calls.filter((c) => c[0] === 'tabs.sendMessage');
      check(writes.length === 0, 'no content message was sent for a ' + option + ' tab');
    }
  }
  {
    // The browser is gone: `tabs.get` fails, so there is no probe at all. That is
    // a deferral with no page write, and the mode must not paper over it.
    const { wiring } = build({ active: false, focused: false, visibilityState: 'hidden',
      probeFails: 'content_unavailable' });
    await wiring.controller.armWith({ deliveryMode: 'background' }, BG_PHRASE, true);
    const r = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
    check(r.sent === false && r.pageWriteAttempted === false,
      'a page that cannot be observed is refused (' + r.code + ')');
    check(['probe_unavailable', 'target_background_unobservable'].includes(r.code),
      'and the code names that fact (' + r.code + ')');
  }
  {
    // No binding at all -- the mode cannot invent a target. Nothing can be armed
    // without a binding either, so the honest expectation is "refused before any
    // page write", with the specific code depending on which check comes first.
    const { wiring } = build({ noBinding: true });
    const r = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
    check(r.sent === false && r.pageWriteAttempted === false,
      'no binding still refuses before any write (' + r.code + ')');
    check(['target_not_bound', 'autosend_disabled'].includes(r.code),
      'and the code is a configured-level refusal (' + r.code + ')');
  }

  // =====================================================================
  // 15. A restart during a background attempt stays unconfirmed
  // =====================================================================
  console.log('== T048: restart during a background attempt never resends ==');
  {
    const state = Object.assign(AS.createAutoSendState(), {
      enabled: true, deliveryMode: 'background', armedAt: 1000, expiresAt: 9000000,
      maxSends: 100, sentCount: 0, bindingRevision: 3, conversationId: CONV,
      documentInstanceId: DOC,
    });
    const attempted = AS.recordAttempt(state, { runId: RUN, status: 'completed' }, 2000);
    const reconciled = AS.reconcileAfterRestart(attempted.state, 3000).state;
    check(reconciled.journal[AS.journalKey(RUN, 'completed')].state === 'ambiguous',
      'the in-flight attempt becomes ambiguous, not sent');
    check(reconciled.deliveryMode === 'background',
      'and the mode survives the restart (' + reconciled.deliveryMode + ')');
    const binding = { revision: 3, conversationId: CONV, documentInstanceId: DOC,
      tabId: 7, windowId: 2, url: URL_OK, manuallyConfirmed: true };
    const probe = { tabId: 7, windowId: 2, url: URL_OK, conversationId: CONV,
      documentInstanceId: DOC, observedAt: 5000, active: false, hasFocus: false,
      visibilityState: 'hidden', composerPresent: true, composerEmpty: true };
    const verdict = AS.decide(reconciled, { binding, probe, runId: RUN,
      status: 'completed' }, 5000);
    check(verdict.send === false && verdict.code === 'previous_attempt_ambiguous',
      'and the same run is refused afterwards (' + verdict.code + ')');
  }

  console.log('\nRESULT: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
}

// Read a shipped source file for the static assertions, with a stable path.
function readFileSyncSafe(name) {
  return readFileSync(new URL('./extension/lib/' + name + '.js', import.meta.url), 'utf8');
}

main().catch((err) => {
  console.log('UNCAUGHT: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
