// T056: a human draft in the composer must not disarm the whole trigger.
//
// The defect (R2 of the T55 review), reproduced here through the real modules and
// only then fixed:
//
//   send_adapter.deliverInto   refuses `composer_not_empty`, nothing typed
//   autosend_controller        rolls the write-ahead journal back (T079),
//                              returns pageWriteAttempted:false
//   autosend.classifyRefusal   had no entry for that code  ->  'ambiguous'
//   terminal_trigger.settle    'ambiguous' means "a write may have happened"
//                              -> stopped + enabled:false
//
// So one half-written sentence in the operator's composer silently turned off the
// whole notification path, and it required a manual re-arm to come back. Nothing
// was ever sent, and the draft was never touched.
//
// What this file asserts, in order:
//   1. the refusal really is pre-write (composerTouched:false, draft byte-identical,
//      zero clicks, zero messages, no focus in background mode);
//   2. the real probe never reports `composerEmpty`, which is why `decide()` cannot
//      catch this one layer up;
//   3. the controller therefore hands the trigger a *pure* pre-write refusal;
//   4. that refusal must be classified `deferred`, in both delivery modes;
//   5. the candidate survives, the trigger stays armed, and once the draft is gone
//      the notice is sent exactly once;
//   6. nothing that touched the page may defer: `insert_mismatch` (typed, not
//      clicked) and `delivery_not_confirmed` (clicked) still stop it, and a
//      pre-write *code* carried with pageWriteAttempted:true still stops it.
//
// No browser, no Chrome storage, no network, no real message, no real draft.
import {
  A, AS, WIRE, TT, PRE, NOTICE, CONV, RUN, URL_OK, DOC,
  createPage, createChrome, drive, deps,
} from './test_t048_fakes.mjs';

let passed = 0;
const failures = [];
function check(ok, label) {
  if (ok) { passed += 1; return; }
  failures.push(label);
  console.log('  FAILED: ' + label);
}
function section(title) { console.log('== ' + title); }

const TGR_ARM = 'AUTOTRIGGER ' + CONV;
const DRAFT = '\u534a\u622a\u8349\u7a3f draft';

function grant(mode) {
  return Object.assign(AS.createAutoSendState(), {
    enabled: true, deliveryMode: mode, armedAt: 1000, expiresAt: 9000000,
    maxSends: 100, sentCount: 0, bindingRevision: 3, conversationId: CONV,
    documentInstanceId: DOC,
  });
}

// The real chain: real terminal_trigger -> real controller -> real wiring.write ->
// real send_adapter -> a fake page. The only thing faked is the browser.
function chain(mode, pageOptions) {
  const background = mode === 'background';
  const page = createPage(Object.assign({
    focused: !background, visibilityState: background ? 'hidden' : 'visible',
  }, pageOptions || {}));
  const env = createChrome({
    active: !background, focused: !background,
    visibilityState: background ? 'hidden' : 'visible',
  });
  const realProbe = env.probeSpecificTab;
  // Exactly what content.js's `t058-write-notice` branch does: the adapter is the
  // only writer, and it is handed the fields the worker passed down.
  env.chrome.tabs.sendMessage = async (_id, msg) => {
    const result = await A.deliverInto(page.doc, {
      runId: msg.runId, status: msg.status,
      expectedConversationId: msg.expectedConversationId,
      deliveryMode: msg.deliveryMode,
      expectedDocumentInstanceId: msg.expectedDocumentInstanceId,
    }, page.clock.now, deps(page));
    return { ok: true, result };
  };
  env.store.local.autosend = grant(mode);
  const wiring = WIRE.createChromeAutoSend(env.chrome, {
    // The served read-only probe never reports `composerEmpty` (asserted below),
    // so remove it here rather than pretending a page fact we do not have.
    probeSpecificTab: async (api, target) => {
      const r = await realProbe(api, target);
      delete r.composerEmpty;
      return r;
    },
    getBindingState: env.getBindingState,
    now: () => 5000,
  });
  const armed = TT.configure(TT.createTriggerState(), {
    binding: env.binding, minIntervalMs: 30000, maxPerHour: 100,
  }, TGR_ARM, true, 1000);
  if (armed.result.ok !== true) throw new Error('trigger arm failed: ' +
    armed.result.code);
  return { page, env, wiring, trigger: armed.state, outcome: null, settled: null };
}

// One unattended tick, in the same order background.js does it.
async function tick(ctx, now) {
  const candidate = { runId: RUN, status: 'completed', origin: 'bridge', startedAt: 2 };
  const admitted = TT.admit(ctx.trigger, candidate, now);
  if (!admitted.admit) return { admitted };
  const marked = TT.markAttempt(ctx.trigger, candidate, now);
  ctx.trigger = marked.state;
  const outcome = await drive(ctx.page, ctx.wiring.controller.sendOnce(candidate),
    6000);
  ctx.outcome = outcome;
  const settled = TT.settle(ctx.trigger, marked.key, outcome, now);
  ctx.trigger = settled.state;
  ctx.settled = settled.result;
  return { admitted, outcome, settled: settled.result };
}

// =====================================================================
section('T056/1 the refusal is pre-write, and the draft is never touched');
// =====================================================================
for (const mode of ['background', 'foreground']) {
  const ctx = chain(mode, { draft: DRAFT });
  const r = await drive(ctx.page, A.deliverInto(ctx.page.doc, {
    runId: RUN, status: 'completed', origin: 'bridge', expectedConversationId: CONV,
    deliveryMode: mode, expectedDocumentInstanceId: DOC,
  }, 5000, deps(ctx.page, { documentInstanceId: DOC })), 4000);
  check(r.status === 'refused' && r.reason === 'composer_not_empty',
    mode + ': the draft is refused (' + r.status + '/' + r.reason + ')');
  check(r.composerTouched === false && r.composerWritten === false
    && r.clickPerformed === false,
    mode + ': and reported as untouched, not as an attempted write');
  check(ctx.page.text === DRAFT, mode + ': the draft is byte-identical afterwards');
  check(ctx.page.clicks.length === 0 && ctx.page.messages.length === 0,
    mode + ': nothing was clicked and nothing was posted');
  if (mode === 'background') {
    check(ctx.page.focusCalls() === 0,
      'background: the composer was never focused (' + ctx.page.focusCalls() + ')');
  }
}

// =====================================================================
section('T056/2 the served probe has no composerEmpty, so decide() cannot see it');
// =====================================================================
{
  const base = {
    status: 'background_observable', tabId: 7, windowId: 2, url: URL_OK,
    conversationId: CONV, documentInstanceId: DOC, observedAt: 5000,
    composerPresent: true, pageLoaded: true, routeStable: true,
    visibilityState: 'hidden', hasFocus: false,
  };
  const tab = { id: 7, windowId: 2, url: URL_OK, active: false, discarded: false,
    frozen: false };
  const assessed = PRE.assessProbe(tab, Object.assign({ requestId: 'r1' }, base),
    Object.assign({}, tab), 5000, 'r1');
  check(assessed.status === 'background_observable',
    'the probe still observes a hidden tab (' + assessed.status + ')');
  check(!Object.prototype.hasOwnProperty.call(assessed, 'composerEmpty'),
    'and it reports no composerEmpty at all');
  // Exactly what autosend_chrome_wiring.js:74-75 hands to `decide`.
  const probe = { composerEmpty: typeof assessed.composerEmpty === 'boolean'
    ? assessed.composerEmpty : undefined };
  check(probe.composerEmpty === undefined,
    'so decide() sees undefined, and its session_occupied rule stays unreachable');
}

// =====================================================================
section('T056/3 the controller hands the trigger a pure pre-write refusal');
// =====================================================================
for (const mode of ['background', 'foreground']) {
  const ctx = chain(mode, { draft: DRAFT });
  const run = await tick(ctx, 1000);
  check(run.admitted.admit === true, mode + ': the trigger admitted the candidate');
  check(run.outcome.sent === false, mode + ': nothing was reported sent');
  check(run.outcome.pageWriteAttempted === false,
    mode + ': and the page is proven untouched (pageWriteAttempted:false)');
  check(run.outcome.code === 'composer_not_empty',
    mode + ': with the draft code carried up (' + run.outcome.code + ')');
  check(ctx.page.text === DRAFT && ctx.page.messages.length === 0,
    mode + ': the draft survived the whole tick and nothing was posted');
  const stored = ctx.env.store.local.autosend;
  check(stored.enabled === true && Object.keys(stored.journal).length === 0,
    mode + ': the autosend journal was rolled back, the grant stays enabled');
}

// =====================================================================
section('T056/4 composer_not_empty is a write-before deferral');
// =====================================================================
check(AS.classifyRefusal('composer_not_empty') === 'deferred',
  'classifyRefusal(composer_not_empty) === deferred (got '
  + AS.classifyRefusal('composer_not_empty') + ')');
check(AS.PRE_WRITE_DEFERRED.includes('composer_not_empty'),
  'and it is listed in PRE_WRITE_DEFERRED');

// =====================================================================
section('T056/5 the trigger defers, stays armed, then sends exactly once');
// =====================================================================
for (const mode of ['background', 'foreground']) {
  const ctx = chain(mode, { draft: DRAFT });
  const first = await tick(ctx, 1000);
  const firstSettled = first.settled || {};
  check(firstSettled.status === 'deferred',
    mode + ': the draft defers instead of stopping (' + firstSettled.status + ')');
  check(firstSettled.reason === 'composer_not_empty',
    mode + ': named after the cause (' + firstSettled.reason + ')');
  check(ctx.trigger.enabled === true, mode + ': the trigger stays armed');
  check(ctx.trigger.lastError === null,
    mode + ': and no error is recorded (' + ctx.trigger.lastError + ')');
  const k = TT.key(RUN, 'completed');
  check(!ctx.trigger.seen[k], mode + ': the candidate is not recorded as seen');
  check(TT.deferralOf(ctx.trigger, { runId: RUN, status: 'completed' , origin: 'bridge'}) !== null,
    mode + ': a deferral row is waiting');
  check(ctx.page.text === DRAFT, mode + ': the draft is still byte-identical');

  // The alarm fires before the backoff expires: it must not probe or send.
  const retryAt = firstSettled.retryAt;
  const early = TT.admit(ctx.trigger,
    { runId: RUN, status: 'completed', origin: 'bridge', startedAt: 2 }, retryAt - 1);
  check(early.admit === false && early.code === 'deferred_backoff',
    mode + ': the backoff holds the page probe (' + early.code + ')');

  // The operator clears the draft, the backoff expires, the notice goes out once.
  ctx.page.composer.value = '';
  const second = await tick(ctx, retryAt + 1);
  const secondSettled = second.settled || {};
  check(second.admitted.admit === true,
    mode + ': the re-check is admitted (' + second.admitted.code + ')');
  check(secondSettled.status === 'sent',
    mode + ': and the notice is sent (' + secondSettled.status + ')');
  check(ctx.page.clicks.length === 1,
    mode + ': with exactly one click (' + ctx.page.clicks.length + ')');
  check(ctx.page.messages.length === 1 && ctx.page.messages[0] === NOTICE,
    mode + ': carrying the fixed template once ("' + ctx.page.messages[0] + '")');
  check(ctx.trigger.enabled === true, mode + ': the trigger is still armed afterwards');

  // Any later tick must refuse the same completion.
  const third = TT.admit(ctx.trigger,
    { runId: RUN, status: 'completed', origin: 'bridge', startedAt: 2 }, retryAt + 1000);
  check(third.admit === false && third.code === 'duplicate_event',
    mode + ': a repeat tick is a duplicate, not a second write (' + third.code + ')');
  check(ctx.page.messages.length === 1,
    mode + ': still exactly one message on the page');
}

// =====================================================================
section('T056/6 anything that touched the page still stops, never defers');
// =====================================================================
{
  // Typed but not clicked: the composer refused the synthetic insert, so the
  // adapter reports composerTouched:true. That is a partial write, not a refusal.
  const ctx = chain('background', { ignoreSyntheticInput: true });
  const run = await tick(ctx, 1000);
  check(run.outcome.pageWriteAttempted === true,
    'a composer that rejected the insert is reported as a page write');
  check(run.outcome.reason === 'insert_mismatch',
    'with the page-layer cause carried up (' + run.outcome.reason + ')');
  check(run.settled.code === 'stopped',
    'and it stops the trigger (' + run.settled.code + ')');
  check(ctx.trigger.enabled === false, 'with the trigger disarmed');
  check(AS.classifyRefusal('insert_mismatch') === 'ambiguous',
    'because insert_mismatch is ambiguous, not deferred');
}
{
  // Clicked, outcome unknown: never a retry.
  const ctx = chain('background', { neverCommits: true });
  const run = await tick(ctx, 1000);
  check(ctx.page.clicks.length === 1, 'the notice was clicked once');
  check(run.settled.code === 'stopped',
    'an unconfirmed receipt stops the trigger (' + run.settled.code + ')');
  check(String(run.settled.reason).includes('delivery_not_confirmed'),
    'named as delivery_not_confirmed (' + run.settled.reason + ')');
  check(ctx.trigger.enabled === false, 'and the trigger is disarmed');
  check(ctx.page.clicks.length === 1, 'nothing was retried after the unknown click');
}
{
  // The gate is the writer's own proof, not the code. A pre-write *code* arriving
  // with pageWriteAttempted:true must still stop.
  const armed = TT.configure(TT.createTriggerState(), {
    binding: { manuallyConfirmed: true, conversationId: CONV },
    minIntervalMs: 30000, maxPerHour: 100,
  }, TGR_ARM, true, 1000).state;
  const cand = { runId: RUN, status: 'completed', origin: 'bridge', startedAt: 2 };
  const marked = TT.markAttempt(armed, cand, 1000);
  const settled = TT.settle(marked.state, marked.key,
    { sent: false, pageWriteAttempted: true, code: 'modal_open' }, 1000);
  check(settled.result.code === 'stopped',
    'a deferral code with pageWriteAttempted:true still stops (' +
    settled.result.code + ')');
  check(settled.state.enabled === false, 'and disarms the trigger');
}
{
  // And the converse: a code that is NOT a known pre-write cause must not defer
  // merely because the writer claims it never touched the page.
  const armed = TT.configure(TT.createTriggerState(), {
    binding: { manuallyConfirmed: true, conversationId: CONV },
    minIntervalMs: 30000, maxPerHour: 100,
  }, TGR_ARM, true, 1000).state;
  const cand = { runId: RUN, status: 'completed', origin: 'bridge', startedAt: 2 };
  const marked = TT.markAttempt(armed, cand, 1000);
  const settled = TT.settle(marked.state, marked.key,
    { sent: false, pageWriteAttempted: false, code: 'something_unheard_of' }, 1000);
  check(settled.result.code === 'stopped',
    'an unknown code still stops even with pageWriteAttempted:false (' +
    settled.result.code + ')');
  check(settled.state.enabled === false, 'and disarms the trigger');
}

console.log('');
console.log('T056: ' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length > 0) {
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
