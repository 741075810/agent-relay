// T058: the orchestration Plan A needed -- decide, journal, write, settle.
//
// Order is the whole design. Every step that can refuse happens before the
// write; the write happens exactly once; the settle step can only downgrade.
//
//   1. reconcile  any `attempting` left by a restart becomes `ambiguous`
//   2. probe      ask the page what it is, right now
//   3. decide     authorization + target + journal must all agree
//   4. journal    persist `attempting` -- before the page is touched
//   5. write      one adapter call, no retry, no fallback
//   6. settle     `sent` only on positive evidence; anything else disarms
//
// Dependencies are injected so this runs against fakes in tests without a
// browser, and so the module itself owns no chrome.* surface.
import {
  arm, consumeSingleShot, createAutoSendState, decide, disarm, journalKey,
  reconcileAfterRestart, recordAttempt, settle,
} from './autosend.js';

export function createAutoSendController(deps) {
  const now = deps.now || (() => Date.now());
  const load = deps.load;
  const save = deps.save;
  const readBinding = deps.readBinding;
  const probe = deps.probe;
  const write = deps.write;

  async function state() {
    return (await load()) || createAutoSendState();
  }

  async function reconcile() {
    const current = await state();
    const done = reconcileAfterRestart(current, now());
    if (done.changed) await save(done.state);
    return done.state;
  }

  async function armWith(input, confirmation, userGesture) {
    const binding = await readBinding();
    const current = await reconcile();
    const done = arm(current, Object.assign({}, input, { binding }),
      confirmation, userGesture, now());
    if (done.result.ok) await save(done.state);
    return done.result;
  }

  // T122: the restricted grant. The bounds are set here and not by the caller, so a popup
  // that grew an extra field -- or a hand-written message -- still cannot ask for two.
  async function armOnce(confirmation, userGesture) {
    const binding = await readBinding();
    const current = await reconcile();
    const done = arm(current, { binding, singleShot: true },
      confirmation, userGesture, now());
    if (done.result.ok) await save(done.state);
    return done.result;
  }

  async function stop(reason) {
    const current = await state();
    const done = disarm(current, reason, now());
    await save(done.state);
    return done.result;
  }

  /**
   * Send one notice, if and only if everything agrees.
   *
   * `candidate` is `{runId, status}` supplied by an authorised caller. It is
   * never read out of the received-notification store: those records are
   * `deliverable:false` by construction, and promoting one to a send would be
   * an unrecorded change of meaning.
   */
  async function sendOnce(candidate) {
    const current = await reconcile();
    const binding = await readBinding();
    const observed = await probe(binding);
    const verdict = decide(current, {
      binding, probe: observed, runId: candidate.runId, status: candidate.status,
    }, now());
    if (!verdict.send) {
      // `pageWriteAttempted: false` is the load-bearing field: `decide` runs
      // strictly before `recordAttempt`/`write`, so a refusal here proves the page
      // was never touched. The caller may therefore treat it as a deferral instead
      // of an uncertain write -- and only when this flag says so.
      return { sent: false, pageWriteAttempted: false, code: verdict.code,
        detail: verdict.detail || null, state: current };
    }

    const key = journalKey(candidate.runId, candidate.status);
    const written = recordAttempt(current, candidate, now());
    await save(written.state);          // step 4, before any page write

    let outcome;
    try {
      // The binding is handed to the writer so it cannot re-read a different
      // one between the decision and the write. T048: the *mode* travels the same
      // way and from the same source -- the verdict, which read it off the grant.
      // A caller-supplied mode would let a foreground grant reach the background
      // writer, which is exactly the widening this design exists to prevent.
      outcome = await write(candidate, binding,
        verdict.deliveryMode === 'background' ? 'background' : 'foreground');
    } catch (err) {
      outcome = { status: 'unconfirmed',
        reason: 'adapter_error:' + String(err && err.message ? err.message : err) };
    }

    // T079: a refusal that provably never touched the composer is not an attempt.
    //
    // Step 4 journals `attempting` *before* the write so that a crash mid-write
    // cannot be mistaken for "never started". But when the writer itself reports
    // `composerTouched: false`, that guarantee has nothing left to protect: keeping
    // the entry would hand `settle` a non-`submitted` outcome, record `ambiguous`
    // and disarm autosend -- for a page that was never written to. Same defect
    // T076 fixed one layer up, fixed here for the same reason.
    //
    // The test is exact: `status === 'refused'` *and* `composerTouched === false`.
    // A missing flag, a thrown adapter, a timeout, or any other status all keep the
    // entry and stay fail-closed.
    if (outcome && outcome.status === 'refused' && outcome.composerTouched === false) {
      const rolled = JSON.parse(JSON.stringify(written.state));
      delete rolled.journal[key];
      await save(rolled);
      return {
        sent: false,
        pageWriteAttempted: false,
        code: outcome.reason || 'refused',
        reason: outcome.reason || null,
        // T048: the observable cause travels with the deferral so the popup can say
        // *why* a background tab could not be reached (discarded, frozen, a page
        // the browser is not running) instead of the generic code alone.
        detail: (outcome.evidence && outcome.evidence.visibilityState)
          || (outcome.evidence && outcome.evidence.detail) || null,
        evidence: outcome.evidence || null,
        state: rolled,
      };
    }

    const done = settle(written.state, key, outcome, now());
    // T122: a single shot is spent by the attempt, and an ambiguous write is the *strongest*
    // reason to stop, not the weakest -- the message may be on the page already. The deferral
    // path above returned early, so nothing that never touched the composer reaches here.
    const consumed = consumeSingleShot(done.state,
      done.result.ok ? 'sent' : 'ambiguous', now());
    const nextState = consumed.state;
    await save(nextState);
    return {
      sent: done.result.ok === true,
      // Past this point the page was definitely touched, whatever came back.
      pageWriteAttempted: true,
      code: done.result.ok ? null : done.result.code,
      reason: done.result.reason || (outcome && outcome.reason) || null,
      evidence: outcome && outcome.evidence ? outcome.evidence : null,
      singleShotConsumed: consumed.consumed === true,
      state: nextState,
    };
  }

  return { state, reconcile, armWith, armOnce, stop, sendOnce };
}
