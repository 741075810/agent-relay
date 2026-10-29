// T059: offline tests for the terminal trigger.
//
// Properties: default off, clamped bounds, dedup, rate limit, write-ahead,
// stop-on-doubt, and no restart retry. The trigger never touches a page itself,
// so every case here is a pure state-machine decision.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

const dir = mkdtempSync(join(tmpdir(), 't059-trigger-'));
// T076: the trigger now imports `classifyRefusal` from autosend (the module that
// owns the refusal codes), so both files are copied and the specifier rewritten.
writeFileSync(join(dir, 'autosend.mjs'),
  readFileSync(new URL('./extension/lib/autosend.js', import.meta.url), 'utf8'));
writeFileSync(join(dir, 'terminal_trigger.mjs'),
  readFileSync(new URL('./extension/lib/terminal_trigger.js', import.meta.url), 'utf8')
    .replace(/from '\.\/([a-z_]+)\.js'/g, "from './$1.mjs'"));
const T = await import(pathToFileURL(join(dir, 'terminal_trigger.mjs')).href);

const CONV = '22222222-2222-4222-8222-222222222222';
const RUN = '11111111-1111-4111-8111-111111111111';
const RUN2 = '33333333-3333-4333-8333-333333333333';
const RUN3 = '44444444-4444-4444-8444-444444444444';
const binding = { manuallyConfirmed: true, conversationId: CONV, revision: 1 };
// T067: a candidate is auto-admissible only when the host proved the Bridge
// dispatched the run, so every candidate now carries a channel. This suite is
// about pacing, the hourly ceiling and the journal -- not about the channel gate --
// so its fixtures declare `bridge` and keep asserting exactly what they always
// did. The gate itself, including both opt-in paths, is covered by
// test_t067_ab_origin.mjs.
const BRIDGE = { origin: 'bridge' };

console.log('== trigger: off by default, and arming is explicit ==');
{
  const fresh = T.createTriggerState();
  check(fresh.enabled === false, 'a fresh trigger is not enabled');
  check(T.admit(fresh, { runId: RUN, status: 'completed', ...BRIDGE }).code === 'trigger_disabled',
        'and it admits nothing while disabled');

  check(T.configure(fresh, { binding }, T.CONFIRM_PREFIX + CONV, false).result.code
        === 'trigger_user_gesture_required',
        'arming without a gesture is refused');
  check(T.configure(fresh, { binding }, 'AUTOTRIGGER nope', true).result.code
        === 'trigger_confirmation_mismatch',
        'arming with the wrong phrase is refused');
  check(T.configure(fresh, { binding: { manuallyConfirmed: false, conversationId: CONV } },
        T.CONFIRM_PREFIX + CONV, true).result.code === 'target_not_manually_bound',
        'arming on an unconfirmed binding is refused');

  const armed = T.configure(fresh, { binding }, T.CONFIRM_PREFIX + CONV, true, 1000);
  check(armed.result.ok === true && armed.state.enabled === true, 'a correct arm enables it');
}

console.log('== trigger: bounds are clamped, not trusted ==');
{
  const greedy = T.configure(T.createTriggerState(),
    { binding, minIntervalMs: 1, maxPerHour: 9999 }, T.CONFIRM_PREFIX + CONV, true, 1000);
  check(greedy.state.minIntervalMs === T.MIN_INTERVAL_FLOOR_MS,
        'a 1ms interval is raised to the floor (' + greedy.state.minIntervalMs + ')');
  check(greedy.state.maxPerHour === T.MAX_PER_HOUR_CEILING,
        'a 9999/hour cap is lowered to the ceiling (' + greedy.state.maxPerHour + ')');
}

console.log('== trigger: only terminal, well-formed completions ==');
{
  const armed = T.configure(T.createTriggerState(), { binding },
    T.CONFIRM_PREFIX + CONV, true, 1000).state;
  check(T.admit(armed, { runId: 'not-a-uuid', status: 'completed', ...BRIDGE }, 100000).code
        === 'run_id_invalid', 'a malformed run id is refused');
  check(T.admit(armed, { runId: RUN, status: 'running', ...BRIDGE }, 100000).code
        === 'status_not_terminal', 'a non-terminal status is refused');
  check(T.admit(armed, { runId: RUN, status: 'completed', ...BRIDGE }, 100000).admit === true,
        'a well-formed terminal completion is admitted');
}

console.log('== trigger: dedup and rate limiting ==');
{
  let state = T.configure(T.createTriggerState(), { binding },
    T.CONFIRM_PREFIX + CONV, true, 0).state;

  const marked = T.markAttempt(state, { runId: RUN, status: 'completed', ...BRIDGE }, 0);
  check(marked.state.seen[T.key(RUN, 'completed')].state === 'attempting',
        'the attempt is journalled before anything else happens');
  check(marked.state.seen[T.key(RUN, 'completed')].provenance === 'unverified_candidate',
        'and is labelled an unverified candidate');

  const settled = T.settle(marked.state, marked.key, { sent: true }, 0);
  state = settled.state;
  check(settled.result.ok === true && state.windowCount === 1,
        'a confirmed send advances the window counter');
  check(T.admit(state, { runId: RUN, status: 'completed', ...BRIDGE }, 100000).code
        === 'duplicate_event', 'the same completion is never sent twice');

  const tooSoon = T.admit(state, { runId: RUN2, status: 'completed', ...BRIDGE }, 1000);
  check(tooSoon.code === 'rate_limited', 'a second send too soon is rate limited');
  check(tooSoon.waitMs === state.minIntervalMs - 1000,
        'and it says how long to wait (' + tooSoon.waitMs + ')');

  const later = T.admit(state, { runId: RUN2, status: 'completed', ...BRIDGE },
    1000 + state.minIntervalMs);
  check(later.admit === true, 'and admits once the interval has passed');

  const full = Object.assign({}, state, { windowCount: state.maxPerHour });
  check(T.admit(full, { runId: RUN2, status: 'completed', ...BRIDGE }, 1000 + state.minIntervalMs).code
        === 'rate_window_exceeded', 'the hourly ceiling holds');

  // Rollover needs a clock past the window, not just past the interval.
  const rolled = Object.assign({}, full, { windowStartedAt: 0 });
  check(T.admit(rolled, { runId: RUN2, status: 'completed', ...BRIDGE },
    T.WINDOW_MS + 1000).admit === true,
        'and the window rolls over instead of blocking forever');
  check(T.admit(rolled, { runId: RUN2, status: 'completed', ...BRIDGE },
    T.WINDOW_MS - 1000).code === 'rate_window_exceeded',
        'but inside the window the ceiling still holds');
}

console.log('== trigger: doubt stops it, and a restart never retries ==');
{
  const armed = T.configure(T.createTriggerState(), { binding },
    T.CONFIRM_PREFIX + CONV, true, 0).state;
  const marked = T.markAttempt(armed, { runId: RUN, status: 'failed', ...BRIDGE }, 0);
  const stopped = T.settle(marked.state, marked.key,
    { sent: false, code: 'ambiguous', reason: 'delivery_not_confirmed' }, 0);
  check(stopped.result.ok === false && stopped.result.code === 'stopped',
        'an unconfirmed attempt settles as stopped');
  check(stopped.state.enabled === false, 'and the whole trigger is disabled');
  check(stopped.state.seen[T.key(RUN, 'failed')].state === 'stopped',
        'the completion is recorded as stopped, not as sent');
  check(T.admit(stopped.state, { runId: RUN3, status: 'completed', ...BRIDGE }, 100000).code
        === 'trigger_disabled', 'and nothing else is admitted afterwards');

  const restart = T.reconcileAfterRestart(marked.state, 5000);
  check(restart.changed === true, 'a restart notices the dangling attempt');
  check(restart.state.seen[T.key(RUN, 'failed')].state === 'stopped',
        'and turns it into stopped rather than retrying it');
  check(restart.state.enabled === false, 'and disables the trigger');
}

console.log('== trigger: a finished run leaves no waiting row behind ==');
{
  // A run can be deferred and then, on the re-check, be refused for good. Only the
  // successful path used to clear the deferral, so a live install accumulated
  // "waiting for a re-check" rows for runs that had already stopped or blocked --
  // four of them were still on disk when this was found.
  const armed = T.configure(T.createTriggerState(), { binding },
    T.CONFIRM_PREFIX + CONV, true, 0).state;

  const first = T.markAttempt(armed, { runId: RUN, status: 'completed', ...BRIDGE }, 0);
  const deferred = T.settle(first.state, first.key,
    { sent: false, pageWriteAttempted: false, code: 'target_not_visible_and_focused' }, 0);
  check(deferred.result.status === 'deferred' && Boolean(deferred.state.deferred[first.key]),
        'a pre-write refusal is held for a re-check');
  const retryAt = deferred.state.deferred[first.key].retryAt;

  const again = T.markAttempt(deferred.state, { runId: RUN, status: 'completed', ...BRIDGE }, retryAt);
  const blocked = T.settle(again.state, again.key,
    { sent: false, pageWriteAttempted: false, code: 'send_control_ambiguous' }, retryAt);
  check(blocked.result.code === 'blocked',
        'a refusal that waiting cannot fix settles as blocked');
  check(!blocked.state.deferred[again.key],
        'and the blocked run stops claiming a re-check');

  const third = T.markAttempt(armed, { runId: RUN3, status: 'completed', ...BRIDGE }, 0);
  const deferred3 = T.settle(third.state, third.key,
    { sent: false, pageWriteAttempted: false, code: 'target_not_visible_and_focused' }, 0);
  const restart = T.reconcileAfterRestart(
    T.markAttempt(deferred3.state, { runId: RUN3, status: 'completed', ...BRIDGE },
      deferred3.state.deferred[third.key].retryAt).state, 5000);
  check(restart.state.seen[T.key(RUN3, 'completed')].state === 'stopped',
        'an attempt interrupted by a restart is stopped, not retried');
  check(!restart.state.deferred[T.key(RUN3, 'completed')],
        'and the stopped run stops claiming a re-check');

  // The bounded map is the reason this matters beyond cosmetics: a finished run
  // that never releases its slot can evict a run that is genuinely waiting.
  check(blocked.state.enabled === false,
        'both outcomes still disable the trigger, as before');
}

console.log('\nRESULT: ' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
