// T058: offline tests for the standing authorization and its controller.
//
// These are the properties Plan A rests on, each checked against the real
// modules with injected fakes:
//   * default off, and off again after any doubt;
//   * one-time authorization that still re-verifies the target every send;
//   * strict dedup by (runId, status), including the attempt left by a restart;
//   * the journal entry is written before the page is touched;
//   * never a second write for the same notice.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

let passed = 0;
const failures = [];
function check(ok, label) {
  if (ok) { passed += 1; return; }
  failures.push(label);
  console.log('  FAILED: ' + label);
}

const dir = mkdtempSync(join(tmpdir(), 't058-autosend-'));
for (const name of ['autosend', 'autosend_controller']) {
  const source = readFileSync(new URL(`./extension/lib/${name}.js`, import.meta.url), 'utf8')
    .replace(/from '\.\/([a-z_]+)\.js'/g, "from './$1.mjs'");
  writeFileSync(join(dir, name + '.mjs'), source);
}
const P = await import(pathToFileURL(join(dir, 'autosend.mjs')).href);
const { createAutoSendController } =
  await import(pathToFileURL(join(dir, 'autosend_controller.mjs')).href);

const CONV = '22222222-2222-4222-8222-222222222222';
const RUN = '11111111-1111-4111-8111-111111111111';
const RUN2 = '33333333-3333-4333-8333-333333333333';
const URL_OK = 'https://chatgpt.com/c/' + CONV;

function binding(over = {}) {
  return Object.assign({
    version: 1, revision: 3, boundAt: 1000, tabId: 7, windowId: 2,
    url: URL_OK, conversationId: CONV, documentInstanceId: 'doc-instance-0001',
    accountIdentity: 'unverified', accountVerified: false,
    manuallyConfirmed: true, invalidatedReason: null,
  }, over);
}
function probeAt(now, over = {}) {
  return Object.assign({
    observedAt: now, tabId: 7, windowId: 2, url: URL_OK, conversationId: CONV,
    documentInstanceId: 'doc-instance-0001', active: true, hasFocus: true,
    visibilityState: 'visible', composerPresent: true, pageLoaded: true,
  }, over);
}

console.log('== policy: off by default, and arming needs a real gesture ==');
{
  const fresh = P.createAutoSendState();
  check(fresh.enabled === false, 'a fresh state is not enabled');
  check(P.decide(fresh, { binding: binding(), probe: probeAt(1000),
    runId: RUN, status: 'completed' }, 1000).code === 'autosend_disabled',
    'and a send is refused while disabled');

  const noGesture = P.arm(fresh, { binding: binding() },
    P.CONFIRM_PREFIX + CONV, false, 1000);
  check(noGesture.result.ok === false &&
        noGesture.result.code === 'arm_user_gesture_required',
        'arming without a user gesture is refused (' + noGesture.result.code + ')');

  const wrong = P.arm(fresh, { binding: binding() }, 'AUTOSEND nope', true, 1000);
  check(wrong.result.ok === false &&
        wrong.result.code === 'arm_confirmation_mismatch',
        'arming with the wrong phrase is refused (' + wrong.result.code + ')');

  const unbound = P.arm(fresh, { binding: binding({ manuallyConfirmed: false }) },
    P.CONFIRM_PREFIX + CONV, true, 1000);
  check(unbound.result.ok === false &&
        unbound.result.code === 'target_not_manually_bound',
        'arming refuses a binding a human did not confirm (' + unbound.result.code + ')');

  const ok = P.arm(fresh, { binding: binding() }, P.CONFIRM_PREFIX + CONV, true, 1000);
  check(ok.result.ok === true && ok.state.enabled === true, 'a correct arm enables it');
  check(ok.state.expiresAt === 1000 + P.DEFAULT_TTL_MS, 'with a bounded lifetime');
  check(ok.state.maxSends === P.DEFAULT_MAX_SENDS, 'and a bounded count');
}

console.log('== policy: the bounds are re-checked on every send ==');
{
  const armed = P.arm(P.createAutoSendState(), { binding: binding() },
    P.CONFIRM_PREFIX + CONV, true, 1000).state;
  const expired = P.decide(armed, { binding: binding(), probe: probeAt(armed.expiresAt),
    runId: RUN, status: 'completed' }, armed.expiresAt);
  check(expired.code === 'authorization_expired',
        'an expired authorization refuses (' + expired.code + ')');

  const spent = Object.assign({}, armed, { sentCount: armed.maxSends });
  const exhausted = P.decide(spent, { binding: binding(), probe: probeAt(1000),
    runId: RUN, status: 'completed' }, 1000);
  check(exhausted.code === 'authorization_exhausted',
        'an exhausted authorization refuses (' + exhausted.code + ')');
}

console.log('== policy: the target is re-verified every single time ==');
{
  const armed = P.arm(P.createAutoSendState(), { binding: binding() },
    P.CONFIRM_PREFIX + CONV, true, 1000).state;
  const cases = [
    ['binding_changed', { binding: binding({ revision: 4 }) }],
    ['conversation_changed', { binding: binding({ conversationId: RUN2 }) }],
    ['probe_stale', { probe: probeAt(1000 - P.PROBE_MAX_AGE_MS - 1) }],
    ['wrong_tab', { probe: probeAt(1000, { tabId: 99 }) }],
    ['redirect_or_url_mismatch', { probe: probeAt(1000, { url: URL_OK + '?x=1' }) }],
    ['conversation_identity_mismatch', { probe: probeAt(1000, { conversationId: RUN2 }) }],
    ['document_instance_changed', { probe: probeAt(1000, { documentInstanceId: 'other' }) }],
    ['target_not_visible_and_focused', { probe: probeAt(1000, { hasFocus: false }) }],
    ['composer_unavailable', { probe: probeAt(1000, { composerPresent: false }) }],
    ['probe_unavailable', { probe: null }],
  ];
  for (const [expected, over] of cases) {
    const verdict = P.decide(armed, Object.assign({
      binding: binding(), probe: probeAt(1000), runId: RUN, status: 'completed',
    }, over), 1000);
    check(verdict.code === expected,
          'refuses on ' + expected + ' (got ' + verdict.code + ')');
  }
  const good = P.decide(armed, { binding: binding(), probe: probeAt(1000),
    runId: RUN, status: 'completed' }, 1000);
  check(good.send === true, 'and allows the one case where everything agrees');
}

console.log('== policy: strict dedup, including the attempt a restart left behind ==');
{
  const armed = P.arm(P.createAutoSendState(), { binding: binding() },
    P.CONFIRM_PREFIX + CONV, true, 1000).state;
  const key = P.journalKey(RUN, 'completed');

  const attempted = P.recordAttempt(armed, { runId: RUN, status: 'completed' }, 1000);
  check(attempted.state.journal[key].state === 'attempting',
        'an attempt is journalled as attempting');
  check(attempted.state.journal[key].provenance === 'unverified_candidate',
        'and is labelled unverified, never as proof of origin');
  check(P.decide(attempted.state, { binding: binding(), probe: probeAt(1000),
    runId: RUN, status: 'completed' }, 1000).code === 'attempt_in_progress',
    'a second send while attempting is refused');

  const settled = P.settle(attempted.state, key, { status: 'submitted' }, 1000);
  check(settled.result.ok === true && settled.state.sentCount === 1,
        'a confirmed send increments the count once');
  check(P.decide(settled.state, { binding: binding(), probe: probeAt(1000),
    runId: RUN, status: 'completed' }, 1000).code === 'duplicate_event',
    'the same notice can never be sent twice');
  const other = P.decide(settled.state, { binding: binding(), probe: probeAt(1000),
    runId: RUN2, status: 'completed' }, 1000);
  check(other.send === true, 'but a different run id is still allowed');
}

console.log('== policy: doubt disarms, and a restart never retries ==');
{
  const armed = P.arm(P.createAutoSendState(), { binding: binding() },
    P.CONFIRM_PREFIX + CONV, true, 1000).state;
  const key = P.journalKey(RUN, 'completed');
  const attempted = P.recordAttempt(armed, { runId: RUN, status: 'completed' }, 1000);
  const ambiguous = P.settle(attempted.state, key,
    { status: 'unconfirmed', reason: 'delivery_not_confirmed' }, 1000);
  check(ambiguous.result.ok === false && ambiguous.result.code === 'ambiguous',
        'an unconfirmed send settles as ambiguous');
  check(ambiguous.state.enabled === false,
        'and disarms the authorization instead of leaving it armed');
  check(ambiguous.state.journal[key].state === 'ambiguous',
        'the journal keeps the ambiguous outcome');

  const restart = P.reconcileAfterRestart(attempted.state, 2000);
  check(restart.changed === true, 'a restart notices the dangling attempt');
  check(restart.state.journal[key].state === 'ambiguous',
        'and turns it into ambiguous rather than retrying it');

  const afterRestart = P.decide(restart.state, { binding: binding(), probe: probeAt(2000),
    runId: RUN, status: 'completed' }, 2000);
  check(afterRestart.code === 'previous_attempt_ambiguous',
        'the notice is refused afterwards (' + afterRestart.code + ')');
}

console.log('== controller: write-ahead ordering and one write per notice ==');
{
  let stored = null;
  const saves = [];
  const writes = [];
  const deps = {
    now: () => 5000,
    load: async () => stored,
    save: async (next) => { stored = next; saves.push(JSON.parse(JSON.stringify(next))); },
    readBinding: async () => binding(),
    probe: async () => probeAt(5000),
    write: async (candidate) => {
      writes.push({ candidate, journalledBeforeWrite:
        !!(stored && stored.journal[P.journalKey(candidate.runId, candidate.status)] &&
           stored.journal[P.journalKey(candidate.runId, candidate.status)].state === 'attempting') });
      return { status: 'submitted', evidence: { composerEmpty: true } };
    },
  };
  const controller = createAutoSendController(deps);

  const armResult = await controller.armWith({}, P.CONFIRM_PREFIX + CONV, true);
  check(armResult.ok === true, 'the controller arms through the same policy');

  const first = await controller.sendOnce({ runId: RUN, status: 'completed' });
  check(first.sent === true, 'the first send succeeds (' + first.code + ')');
  check(writes.length === 1 && writes[0].journalledBeforeWrite === true,
        'the journal was persisted before the page write');

  const second = await controller.sendOnce({ runId: RUN, status: 'completed' });
  check(second.sent === false && second.code === 'duplicate_event',
        'the same notice is never written twice (' + second.code + ')');
  check(writes.length === 1, 'and the adapter was called exactly once (' + writes.length + ')');

  const other = await controller.sendOnce({ runId: RUN2, status: 'failed' });
  check(other.sent === true, 'a different notice still sends under the same authorization');
  check(writes.length === 2, 'and that is the second and last write');
}

console.log('== controller: an unconfirmed write stops everything ==');
{
  let stored = null;
  const writes = [];
  const deps = {
    now: () => 5000,
    load: async () => stored,
    save: async (next) => { stored = next; },
    readBinding: async () => binding(),
    probe: async () => probeAt(5000),
    write: async (candidate) => {
      writes.push(candidate);
      return { status: 'unconfirmed', reason: 'delivery_not_confirmed' };
    },
  };
  const controller = createAutoSendController(deps);
  await controller.armWith({}, P.CONFIRM_PREFIX + CONV, true);

  const result = await controller.sendOnce({ runId: RUN, status: 'completed' });
  check(result.sent === false && result.code === 'ambiguous',
        'an unconfirmed write reports ambiguous (' + result.code + ')');
  check(stored.enabled === false, 'and the authorization is disarmed');

  const again = await controller.sendOnce({ runId: RUN2, status: 'completed' });
  check(again.sent === false && again.code === 'autosend_disabled',
        'no further notice is attempted afterwards (' + again.code + ')');
  check(writes.length === 1, 'the adapter ran exactly once across both calls');
}

console.log('== controller: a target that moved is refused before any write ==');
{
  let stored = null;
  const writes = [];
  const deps = {
    now: () => 5000,
    load: async () => stored,
    save: async (next) => { stored = next; },
    readBinding: async () => binding(),
    probe: async () => probeAt(5000, { conversationId: RUN2 }),
    write: async (candidate) => { writes.push(candidate); return { status: 'submitted' }; },
  };
  const controller = createAutoSendController(deps);
  await controller.armWith({}, P.CONFIRM_PREFIX + CONV, true);
  const result = await controller.sendOnce({ runId: RUN, status: 'completed' });
  check(result.sent === false && result.code === 'conversation_identity_mismatch',
        'a different conversation is refused (' + result.code + ')');
  check(writes.length === 0, 'and no adapter call was made');
  check(stored.enabled === true,
        'the authorization survives a pre-write refusal (nothing is at stake)');
}

console.log('== controller: a throwing adapter cannot leave the notice re-sendable ==');
{
  let stored = null;
  const deps = {
    now: () => 5000,
    load: async () => stored,
    save: async (next) => { stored = next; },
    readBinding: async () => binding(),
    probe: async () => probeAt(5000),
    write: async () => { throw new Error('tab closed mid-write'); },
  };
  const controller = createAutoSendController(deps);
  await controller.armWith({}, P.CONFIRM_PREFIX + CONV, true);
  const result = await controller.sendOnce({ runId: RUN, status: 'completed' });
  check(result.sent === false && result.code === 'ambiguous',
        'an adapter exception settles as ambiguous (' + result.code + ')');
  const key = P.journalKey(RUN, 'completed');
  check(stored.journal[key].state === 'ambiguous',
        'the notice is marked ambiguous, so it cannot be retried blindly');
  check(stored.enabled === false, 'and the authorization is disarmed');
}

rmSync(dir, { recursive: true, force: true });
console.log('\nRESULT: ' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
