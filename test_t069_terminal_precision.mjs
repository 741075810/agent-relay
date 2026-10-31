// T069: terminal-time precision, end to end through the extension's own layers.
//
// The defect this file exists for: DSH records `turn/end` with millisecond precision,
// `terminal_source` floored it to seconds, and the consent rule compared a
// millisecond-stamped click against `(endedAt + 1) * 1000`. Every click made in the
// same second as the end was therefore treated as "before the end", so an operator who
// watched a task finish and *then* clicked 结束后通知这一条 got a notice for the task they
// had already seen complete. Measured against the T068 staged code: the two
// after-the-end cases below both admitted.
//
// The fix has three parts and each has its own tests here:
//   1. `terminal_source` emits `endedAtMs` at the precision DSH recorded (host side,
//      covered by test_t069_terminal_precision.py);
//   2. the rule compares strictly in milliseconds, and refuses when the instant is
//      unknown instead of guessing;
//   3. nothing between the host answer and the stored candidate drops the field --
//      intake, re-offer refresh, and the candidates the popup lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// T095B77: this used to be an absolute path into one machine's working copy, which did
// two kinds of damage. It published the operator's directory layout in a public
// repository, and it made the suite read the *live* tree instead of the tree under
// test -- so on any other machine the suite threw ENOENT, and in the working copy it
// silently verified files that the clone did not contain. Resolving from this file's
// own URL fixes both: every checkout tests itself.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const LIB = join(HERE, 'extension/lib');

// The lib is Chrome-flavoured ESM; node needs `.mjs` copies with the specifiers fixed.
const dir = join(tmpdir(), 't069-lib-' + process.pid);
mkdirSync(dir, { recursive: true });
for (const name of ['autosend', 'terminal_trigger']) {
  writeFileSync(join(dir, name + '.mjs'),
    readFileSync(join(LIB, name + '.js'), 'utf8')
      .replace(/from '\.\/([a-z_]+)\.js'/g, "from './$1.mjs'"));
}
const T = await import(pathToFileURL(join(dir, 'terminal_trigger.mjs')).href);

const S1 = 'session-11111111-2222-4333-8444-555555555555';
// `admit` refuses anything that is not a UUID, so the fixture has to be one.
const RUN = '00000000-0000-4000-8000-000000000069';
const SECOND = 1_700_000_000;                 // arbitrary whole second, in seconds
const MS = SECOND * 1000;                     // and in milliseconds

function state(armedAt) {
  return T.armRunning(T.createOptInState(), S1, 7, armedAt).state;
}

// The trigger state a real machine would have: enabled, armed at a known instant, with
// a snapshot. Built through the module's own constructor so the test cannot invent a
// shape the product never produces.
function armedTrigger(armedAt) {
  const built = T.configure(T.createTriggerState(), {
    binding: { manuallyConfirmed: true, conversationId: 'conv' },
  }, T.CONFIRM_PREFIX + 'conv', true, armedAt);
  return built.state;
}

function candidate(extra = {}) {
  return Object.assign({
    runId: RUN, status: 'completed', origin: T.ORIGIN_DIRECT,
    nativeSession: S1, nativeTurn: 7, endedAtMs: MS + 900,
    endedAt: SECOND,
  }, extra);
}

function verdict(armedAt, cand, now = armedAt + 60_000) {
  return T.optInUsable(T.optInFor(state(armedAt), cand), cand, now);
}

// ---------------------------------------------------------------- the four cases
// the request names, in the order it names them

test('same second, chosen BEFORE the end: admitted', () => {
  // Click at .600, end at .900 of the same second. The old rule compared against the
  // end of the second and so admitted this -- for the wrong reason. The new rule
  // admits it for the right one, which is what lets the mirror case be refused.
  const got = verdict(MS + 600, candidate({ endedAtMs: MS + 900 }));
  assert.equal(got.ok, true);
  assert.equal(got.armedAt, MS + 600);
  assert.equal(got.endedAtMs, MS + 900);
});

test('same second, chosen AFTER the end: refused', () => {
  // This is the defect. Click at .900, task already ended at .100.
  const got = verdict(MS + 900, candidate({ endedAtMs: MS + 100 }));
  assert.equal(got.ok, false);
  assert.equal(got.code, 'opt_in_after_terminal');
  // The two instants travel with the refusal so the popup can say why.
  assert.equal(got.armedAt, MS + 900);
  assert.equal(got.endedAtMs, MS + 100);
});

test('the very same millisecond: refused', () => {
  // No ordering can be proved at one instant, and "probably before" is exactly how
  // the floored-second rule went wrong. The comparison is strict.
  const got = verdict(MS + 500, candidate({ endedAtMs: MS + 500 }));
  assert.equal(got.ok, false);
  assert.equal(got.code, 'opt_in_after_terminal');
});

test('one millisecond either side of the end', () => {
  const before = verdict(MS + 499, candidate({ endedAtMs: MS + 500 }));
  assert.equal(before.ok, true, '1 ms before is before');
  const after = verdict(MS + 501, candidate({ endedAtMs: MS + 500 }));
  assert.equal(after.ok, false, '1 ms after is after');
});

test('no end time at all: refused, not guessed', () => {
  for (const missing of [undefined, null, 0, -1, '1700000000900', 1.5, NaN]) {
    const got = verdict(MS + 100, candidate({ endedAtMs: missing }));
    assert.equal(got.ok, false, 'endedAtMs=' + String(missing) + ' must not admit');
    assert.equal(got.code, 'terminal_time_unknown',
      'endedAtMs=' + String(missing) + ' must report the unknown, not a verdict');
  }
});

test('a floored endedAt is never used to decide', () => {
  // A pre-T069 stored candidate has only `endedAt`, and `endedAt` says the click was
  // hours earlier. If the rule fell back to it, this would be admitted.
  const got = verdict(MS + 3_600_000, candidate({ endedAtMs: undefined }));
  assert.equal(got.ok, false);
  assert.equal(got.code, 'terminal_time_unknown');
});

// ------------------------------------------------- the refusal reaches the caller
// as itself, not as "nobody ever asked"

test('admit() reports the real reason a stored opt-in was refused', () => {
  const got = T.admit(armedTrigger(1000),
    candidate({ optInRefusal: 'terminal_time_unknown' }), 10 * MS);
  assert.equal(got.admit, false);
  assert.equal(got.code, 'terminal_time_unknown',
    'a refused opt-in must not read as direct_not_opted_in');
});

test('admit() still says nobody asked when nobody asked', () => {
  const none = T.admit(armedTrigger(1000), candidate(), 10 * MS);
  assert.equal(none.admit, false);
  assert.equal(none.code, 'direct_not_opted_in');
});

// ------------------------------------------------ the field survives the transport
// and the store: intake, re-offer refresh, and the popup's own view

const bgPath = join(HERE, 'extension/background.js');
const bgSource = readFileSync(bgPath, 'utf8');

test('intake stores endedAtMs on a new candidate', () => {
  // Read the source rather than the runtime: `refreshTerminalCandidates` talks to a
  // Chrome API this process does not have. The assertion is narrow on purpose -- it
  // checks the field is written from the host answer, not that the code looks nice.
  assert.match(bgSource,
    /if \(Number\.isSafeInteger\(candidate\.endedAtMs\) && candidate\.endedAtMs > 0\) \{\s*\n\s*entry\.endedAtMs = candidate\.endedAtMs;/,
    'intake must persist endedAtMs');
  assert.match(bgSource, /entry\.endedAt = candidate\.endedAt;/,
    'and must keep the compatibility field');
});

test('a re-offered candidate refreshes provenance instead of being skipped', () => {
  assert.match(bgSource, /function refreshProvenance\(entry, candidate\)/,
    'the helper must exist');
  assert.match(bgSource, /const already = byKey\.get\(k\);/,
    'intake must look the entry up instead of skipping the key');
  assert.match(bgSource, /const patched = refreshProvenance\(already, candidate\);/);
  // And the repair has to be saved, or it is lost with the very write that meant to
  // persist it.
  assert.match(bgSource, /if \(added > 0 \|\| refreshed > 0\) \{\s*\n\s*await chrome\.storage\.local\.set\(\{ terminalCandidates: merged \}\);/,
    'a provenance-only change must still be persisted');
});

test('a refresh cannot rewrite a decision or an arm boundary', () => {
  // The refresh is limited to host-owned facts. `origin`, `directArmedAt`, `postArm`
  // and the journal decide what a run is allowed to do; a later sample must never be
  // able to make one of them more permissive.
  const start = bgSource.indexOf('function refreshProvenance(');
  assert.ok(start > 0, 'helper must exist');
  const body = bgSource.slice(start, bgSource.indexOf('\n}', start));
  for (const forbidden of ['origin', 'directArmedAt', 'postArm', 'consumedAt',
    'armedAt', 'journal']) {
    assert.ok(!new RegExp('next\\.' + forbidden + '\\s*=').test(body),
      'refreshProvenance must not write ' + forbidden);
  }
  for (const allowed of ['endedAtMs', 'endedAt', 'nativeTurn', 'nativeSession']) {
    assert.ok(body.includes('next.' + allowed + ' ='),
      'refreshProvenance must be able to fill ' + allowed);
  }
});

test('the running panel asks about the terminal instant in milliseconds', () => {
  // The running row has not ended, so the answer there is always
  // `terminal_time_unknown` -- and it must come from the millisecond field, not from
  // an `endedAt: null` that a future refactor could mistake for "no constraint".
  assert.match(bgSource,
    /optInUsable\(entry, \{ nativeSession: item\.sessionId,\s*\n\s*nativeTurn: item\.turn, endedAtMs: null \}/,
    'the running path must name endedAtMs');
});

test('the admission check reads the stored candidate, field and all', () => {
  // `runTerminalTrigger` passes the stored entry itself to `optInUsable`. If intake
  // dropped `endedAtMs`, every running opt-in would come back as
  // `terminal_time_unknown` and the feature would look broken rather than careful.
  assert.match(bgSource, /terminalTrigger\.optInUsable\(entry, item, nowFn\(\)\)/);
});

// ------------------------------------------------------------- B stays opt-in only

test('a direct candidate with no click at all is still not admitted', () => {
  const got = T.admit(armedTrigger(1000), candidate(), MS + 60_000);
  assert.equal(got.admit, false);
  assert.equal(got.code, 'direct_not_opted_in');
});

test('a bridge candidate is admitted with no click and no end time', () => {
  // Channel A is unaffected by this release: it never consults the opt-in store and
  // never needs a terminal instant.
  const got = T.admit(armedTrigger(1000), { runId: RUN, status: 'completed',
    origin: T.ORIGIN_BRIDGE }, MS + 60_000);
  assert.equal(got.admit, true);
});

test('precision does not disturb single-delivery', () => {
  // Two consents for one run -- one running, one candidate -- still yield one write.
  const armed = armedTrigger(1000);
  const cand = candidate({ runningArmedAt: MS + 100, directArmedAt: MS + 100 });
  const first = T.admit(armed, cand, MS + 60_000);
  assert.equal(first.admit, true);
  // Re-admitting against the state the first attempt left behind must not pass again.
  const afterFirst = T.markAttempt(armed, cand, MS + 60_000).state;
  // T142: an unsettled attempt is an explicit barrier now -- the sharper statement of the
  // same property: one run, one write.
  const inFlight = T.admit(afterFirst, cand, MS + 60_000);
  assert.equal(inFlight.admit, false);
  assert.equal(inFlight.code, 'attempt_in_flight', JSON.stringify(inFlight));
  // And once it is settled, the journal is what refuses the second offer.
  const settled = T.settle(afterFirst, T.key(cand.runId, cand.status),
    { sent: true, pageWriteAttempted: true }, MS + 61_000).state;
  const second = T.admit(settled, cand, MS + 61_500);
  assert.equal(second.admit, false);
  assert.ok(['duplicate_run', 'duplicate_event'].includes(second.code),
    'a second write for one run must be refused, got ' + second.code);
});
