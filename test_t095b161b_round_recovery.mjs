// T095B161 round 2: recovery decisions, from the states that actually appear after a restart.
//
// Interior corruption blocks first; otherwise a torn tail outranks other decisions (you cannot judge rounds
// you cannot read), revision drift outranks a plan mismatch (an edited goal invalidates the approval
// itself), an open round outranks "the goal is armed" (otherwise the next round overlaps half-done work),
// and a disarmed goal outranks "resume ok" (the driver will not run).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'tools', 'continuation');
const RC = await import(pathToFileURL(path.join(DIR, 'round_recovery.mjs')).href + '?r=t161b'
  + Math.random().toString(36).slice(2));
const RE = await import(pathToFileURL(path.join(DIR, 'round_evidence.mjs')).href + '?r=t161b'
  + Math.random().toString(36).slice(2));

const PLAN = { objective: 'x', approvedBy: 'op', maxRounds: 5,
  tasks: [{ id: 'R1', acceptance: 'a' }, { id: 'R2', acceptance: 'b' }] };
const OWN = RE.planDigestOf(PLAN);
const goal = (over = {}) => ({ id: 'goal-x', revision: 1, phase: 'active', activation: 'armed',
  roundsStarted: 1, ...over });
const row = (roundId, taskId, outcome, over = {}) => ({ roundId, taskId, at: 1, planDigest: OWN,
  revision: 1, gates: [{ name: 'js', result: 'pass' }], outcome, recordDigest: 'b'.repeat(64), ...over });

test('T161-2: a clean armed run resumes, and says not to start a round by hand', () => {
  const out = RC.assessRecovery({ goal: goal(), plan: PLAN, records: [row('r1', 'R1', 'done')] });
  assert.equal(out.code, RC.DECISION.RESUME_OK);
  assert.match(out.steps.join(' '), /do not start one by hand/);
  assert.equal(out.planDigest, OWN);
});

test('T161-2: a torn tail outranks every other judgement', () => {
  const tailText = [JSON.stringify(row('r1', 'R1', 'continue')), '{"roundId":"r2","tas'].join('\n');
  const out = RC.assessRecovery({ goal: goal({ activation: 'disarmed' }), plan: PLAN, tailText });
  assert.equal(out.code, RC.DECISION.DISCARD_TAIL);
  assert.equal(out.tornLineIndex, 1);
  assert.equal(out.keptRounds, 1);
  assert.match(out.steps.join(' '), /keep every complete round/);
});

test('T161-2: an open round stops the next one even though the goal is armed', () => {
  const out = RC.assessRecovery({ goal: goal(), plan: PLAN,
    records: [row('r1', 'R1', 'done'), row('r2', 'R2', 'continue')] });
  assert.equal(out.code, RC.DECISION.FINISH_OPEN_FIRST);
  assert.deepEqual(out.open, ['r2(outcome_continue)']);
  assert.match(out.steps[0], /before any new work/);
});

test('T161-2: revision drift is reported as drift, not as a plan problem', () => {
  const out = RC.assessRecovery({ goal: goal({ revision: 1 }), plan: PLAN,
    records: [row('r1', 'R1', 'done', { revision: 3 })] });
  assert.equal(out.code, RC.DECISION.REVISION_DRIFT);
  assert.equal(out.goalRevision, 1);
  assert.deepEqual(out.rounds, ['r1']);
});

test('T161-2: a plan edited after approval stops the run', () => {
  const out = RC.assessRecovery({ goal: goal(), plan: PLAN,
    records: [row('r1', 'R1', 'done', { planDigest: 'c'.repeat(64) })] });
  assert.equal(out.code, RC.DECISION.PLAN_CHANGED);
  assert.deepEqual(out.drifted.map((d) => d.roundId), ['r1']);

  const byDigest = RC.assessRecovery({ goal: goal(), planDigest: OWN,
    records: [row('r1', 'R1', 'done', { planDigest: 'd'.repeat(64) })] });
  assert.equal(byDigest.code, RC.DECISION.PLAN_CHANGED);
});

test('T161-2: a missing plan is blocked with a code, not resumed on hope', () => {
  const out = RC.assessRecovery({ goal: goal(), plan: null, records: [row('r1', 'R1', 'done')] });
  assert.equal(out.code, RC.DECISION.BLOCKED);
  assert.equal(out.why, 'plan_missing');
});

test('T161-2: a disarmed goal needs a human resume, and must not spawn a second goal', () => {
  const out = RC.assessRecovery({ goal: goal({ activation: 'disarmed' }), plan: PLAN,
    records: [row('r1', 'R1', 'done')] });
  assert.equal(out.code, RC.DECISION.NEEDS_HUMAN_RESUME);
  assert.equal(out.why, 'activation=disarmed');
  assert.match(out.steps.join(' '), /do not create a second goal/);
});

test('T161-2: a complete goal has nothing to do, whatever the ledger says', () => {
  const out = RC.assessRecovery({ goal: goal({ phase: 'complete', activation: 'disarmed' }),
    plan: PLAN, records: [row('r1', 'R1', 'continue')] });
  assert.equal(out.code, RC.DECISION.NOTHING_TO_DO);
});

test('T161-2: a torn tail is reported even when the goal already says complete', () => {
  const tailText = [JSON.stringify(row('r1', 'R1', 'done')), '{"roundId":"r2"'].join('\n');
  const out = RC.assessRecovery({ goal: goal({ phase: 'complete', activation: 'disarmed' }),
    plan: PLAN, tailText });
  assert.equal(out.code, RC.DECISION.DISCARD_TAIL,
    'completion may have been decided from a view missing its last round');
  assert.equal(out.recheckCompletion, true);
  assert.equal(out.keptRounds, 1);
});

test('T161-2: a ledger row that cannot name its revision blocks instead of passing the drift check', () => {
  const legacy = { roundId: 'r1', taskId: 'R1', at: 1, planDigest: OWN, outcome: 'done',
    gates: [{ name: 'js', result: 'pass' }], recordDigest: 'b'.repeat(64) };
  const out = RC.assessRecovery({ goal: goal(), plan: PLAN, records: [legacy] });
  assert.equal(out.code, RC.DECISION.BLOCKED);
  assert.match(out.why, /row_revision_missing:r1/);
});

test('T301: Host exit with no round outcome stays open despite stale duplicate completion', () => {
  // Synthetic ledger only: a transport failure is not proof the upstream rejected work.
  // The older completion shares a task but does not settle this distinct open round.
  const unfinished = row('new-round', 'R1', null, {
    failure_code: 'desktop_host_exited', acceptance: 'unknown',
  });
  const stale = row('old-round', 'R1', 'done');
  for (const activation of ['armed', 'disarmed']) {
    for (const records of [
      [unfinished, stale], [stale, unfinished],
      [stale, unfinished, stale], [unfinished, stale, unfinished],
    ]) {
      const input = { goal: goal({ activation }), plan: PLAN, records };
      const before = structuredClone(input);
      const result = RC.assessRecovery(input);
      assert.equal(result.code, RC.DECISION.FINISH_OPEN_FIRST);
      assert.ok(result.open.includes('new-round(no_outcome)'));
      assert.notEqual(result.code, RC.DECISION.RESUME_OK);
      assert.deepEqual(input, before, 'assessment must not close/rewrite the ledger or rearm goal');
    }
  }
  // A missing terminal callback must not be synthesized from the Host failure code.
  const out = RC.assessRecovery({ goal: goal(), plan: PLAN, records: [unfinished] });
  assert.deepEqual(out.open, ['new-round(no_outcome)']);
});

test('T302: another round terminal record cannot settle later nonterminal work', () => {
  for (const outcome of ['continue', 'unknown', 'desktop_host_exited']) {
    for (const closedOutcome of ['done', 'blocked', 'stop_and_report']) {
      const older = row('older', 'R1', closedOutcome, { at: 1 });
      const later = row('later', 'R1', outcome, { at: 2 });
      for (const records of [[older, later], [later, older], [older, later, older]]) {
        for (const activation of ['armed', 'disarmed']) {
          const input = { goal: goal({ activation }), plan: PLAN, records };
          const before = structuredClone(input);
          assert.deepEqual(RE.openRounds(records), [
            { roundId: 'later', taskId: 'R1', why: 'outcome_' + outcome },
          ]);
          assert.equal(RC.assessRecovery(input).code, RC.DECISION.FINISH_OPEN_FIRST);
          assert.equal(RE.buildEvidence({ plan: PLAN, records }).complete, false);
          assert.deepEqual(input, before);
        }
      }
    }
  }
});

test('T302: terminal-only rounds remain settled; conflicting duplicate stays conservative', () => {
  const done = row('settled', 'R1', 'done');
  assert.deepEqual(RE.openRounds([done, done]), []);
  assert.equal(RC.assessRecovery({ goal: goal(), plan: PLAN, records: [done, done] }).code,
    RC.DECISION.RESUME_OK);
  const conflict = row('settled', 'R1', 'unknown');
  for (const records of [[done, conflict], [conflict, done]]) {
    assert.equal(RC.assessRecovery({ goal: goal(), plan: PLAN, records }).code,
      RC.DECISION.FINISH_OPEN_FIRST);
  }
});

test('T303: interior syntax errors block recovery instead of disappearing from valid rows', () => {
  const tailText = [JSON.stringify(row('r1', 'R1', 'done')), '{broken-secret',
    JSON.stringify(row('r2', 'R2', 'done'))].join('\n');
  const parsed = RE.recoverTail(tailText);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.unparsable[0].lineIndex, 1);
  const input = { goal: goal(), plan: PLAN, tailText };
  const before = structuredClone(input);
  const result = RC.assessRecovery(input);
  assert.equal(result.code, RC.DECISION.BLOCKED);
  assert.equal(result.why, 'ledger_corrupt');
  assert.deepEqual(result.unparsableLineIndexes, [1]);
  assert.deepEqual(result.invalidLineIndexes, []);
  assert.equal(result.keptRounds, 2);
  assert.ok(!JSON.stringify(result).includes('broken-secret'));
  assert.deepEqual(input, before);
});

test('T303: valid JSON non-round lines block active and complete goals', () => {
  for (const invalid of ['null', '42', 'true', '"secret-value"', '[]']) {
    for (const phase of ['active', 'complete']) {
      const tailText = [JSON.stringify(row('r1', 'R1', 'done')), invalid,
        JSON.stringify(row('r2', 'R2', 'done'))].join('\r\n');
      const result = RC.assessRecovery({ goal: goal({ phase }), plan: PLAN, tailText });
      assert.equal(result.code, RC.DECISION.BLOCKED);
      assert.equal(result.why, 'ledger_corrupt');
      assert.deepEqual(result.invalidLineIndexes, [1]);
      assert.deepEqual(result.unparsableLineIndexes, []);
    }
  }
});

test('T303: corruption plus torn tail preserves evidence rather than suggesting a drop', () => {
  const tailText = [JSON.stringify(row('r1', 'R1', 'done')), 'null', '{bad',
    JSON.stringify(row('r2', 'R2', 'done')), '{torn'].join('\n');
  const result = RC.assessRecovery({ goal: goal(), plan: PLAN, tailText });
  assert.equal(result.code, RC.DECISION.BLOCKED);
  assert.deepEqual(result.invalidLineIndexes, [1]);
  assert.deepEqual(result.unparsableLineIndexes, [2]);
  assert.equal(result.tornLineIndex, 4);
  assert.match(result.steps.join(' '), /preserve/i);
});

test('T303: clean raw ledgers still resume with blank lines, BOM and CRLF', () => {
  const tailText = '\uFEFF' + JSON.stringify(row('r1', 'R1', 'done')) + '\r\n\r\n';
  const result = RC.assessRecovery({ goal: goal(), plan: PLAN, tailText });
  assert.equal(result.code, RC.DECISION.RESUME_OK);
  assert.equal(result.ledgerRounds, 1);
});

test('T306: torn-tail advice preserves original evidence without deletion or dispatch', () => {
  const input = { goal: goal(), plan: PLAN,
    tailText: JSON.stringify(row('r1', 'R1', 'done')) + '\n{"unfinished"' };
  const before = structuredClone(input);
  const out = RC.assessRecovery(input);
  assert.equal(out.code, RC.DECISION.DISCARD_TAIL);
  const text = out.steps.join(' ');
  assert.doesNotMatch(text, /drop the torn last line|after the drop/i);
  assert.match(text, /preserve the original ledger/i);
  assert.match(text, /do not delete or rewrite/i);
  assert.match(text, /not permission to retry or dispatch/i);
  assert.deepEqual(input, before);
});

test('T306: unknown work advice requires evidence rather than a synthetic terminal record', () => {
  for (const activation of ['armed', 'disarmed']) {
    const input = { goal: goal({ activation }), plan: PLAN,
      records: [row('unknown-round', 'R1', null, { failure_code: 'desktop_host_exited' })] };
    const before = structuredClone(input);
    const out = RC.assessRecovery(input);
    assert.equal(out.code, RC.DECISION.FINISH_OPEN_FIRST);
    const text = RC.renderRecoveryMarkdown(out);
    assert.doesNotMatch(text, /mark it stop_and_report|only then allow the next round/i);
    assert.match(text, /authoritative settlement evidence/i);
    assert.match(text, /do not invent a terminal outcome/i);
    assert.match(text, /do not retry, release leases or rearm/i);
    assert.deepEqual(input, before);
  }
});

test('T306: resume_ok advice is an assessment, not dispatch authority', () => {
  const out = RC.assessRecovery({ goal: goal(), plan: PLAN, records: [] });
  assert.equal(out.code, RC.DECISION.RESUME_OK);
  assert.doesNotMatch(out.steps.join(' '), /let the driver start/i);
  assert.match(out.steps.join(' '), /not dispatch authorization/i);
});

test('T307: default-off raw-ledger guard precedes restored offline coordinator step', async () => {
  const { createCoordinator, restore } = await import('./tools/continuation/coordinator.mjs');
  const now = 100000;
  const sessionId = 'offline-t307-session';
  const grant = { kind: 'continuation', epoch: 'offline-t307', sessionId,
    armedAt: 1000, expiresAt: 200000, maxTasks: 2, scopes: ['offline-fixture'] };
  const tasks = [{ id: 'fixture-next', scope: 'offline-fixture', title: 'synthetic next step' }];
  const seed = createCoordinator({ sessionId, tasks, now: () => now });
  assert.equal(seed.status().enabled, false);
  assert.equal(await seed.enable(grant), null);
  seed.poll({ ok: true, armEpoch: grant.epoch, count: 1, truncated: false,
    candidates: [{ runId: 'aa11bb22-cc33-4d44-8e55-ff6677889901', status: 'completed',
      origin: 'bridge', startedAt: 2, endedAtMs: 3000, postArm: true }] }, now);
  const checkpoint = seed.checkpoint();

  // Test-only integration seam. No exports, files, real transport, timer or driver.
  // Missing raw input must not fall back to a caller's filtered records.
  async function guardedStep(co, { enabled = false, tailText, goal: snapshot, plan }) {
    if (enabled !== true) return { code: 'offline_guard_disabled' };
    if (typeof tailText !== 'string' || !snapshot || typeof snapshot !== 'object') {
      return { code: 'recovery_input_missing' };
    }
    let recovery;
    try { recovery = RC.assessRecovery({ goal: snapshot, plan, tailText }); }
    catch { return { code: 'recovery_assessment_error' }; }
    if (recovery.code !== RC.DECISION.RESUME_OK) return { code: 'recovery_refused', recovery };
    return { code: 'offline_step', recovery, next: await co.step(now) };
  }

  const clean = JSON.stringify(row('settled', 'R1', 'done'));
  const unfinished = JSON.stringify(row('uncertain', 'R2', null,
    { failure_code: 'desktop_host_exited', acceptance: 'unknown' }));
  const cases = [
    { label: 'default off', tailText: clean, enabled: undefined, code: 'offline_guard_disabled' },
    { label: 'filtered-only', tailText: undefined, code: 'recovery_input_missing' },
    { label: 'interior syntax', tailText: clean + '\n{bad\n' + clean, recovery: RC.DECISION.BLOCKED },
    { label: 'interior non-object', tailText: clean + '\nnull\n' + clean, recovery: RC.DECISION.BLOCKED },
    { label: 'torn tail', tailText: clean + '\n{"partial"', recovery: RC.DECISION.DISCARD_TAIL },
    { label: 'unknown work', tailText: clean + '\n' + unfinished, recovery: RC.DECISION.FINISH_OPEN_FIRST },
    { label: 'disarmed', tailText: clean, activation: 'disarmed', recovery: RC.DECISION.NEEDS_HUMAN_RESUME },
    { label: 'malformed object', tailText: '{"revision":1}', recovery: RC.DECISION.PLAN_CHANGED },
    { label: 'missing goal', tailText: clean, snapshot: {}, recovery: 'goal_missing' },
    { label: 'clean', tailText: clean, allow: true },
  ];
  for (const fixture of cases) {
    let submits = 0;
    let steps = 0;
    const co = restore(checkpoint, { sessionId, tasks, now: () => now,
      bridge: { request: async () => { submits += 1; return { outcome: 'ack' }; } } });
    const originalStep = co.step;
    co.step = (...args) => { steps += 1; return originalStep(...args); };
    const input = { enabled: true, goal: fixture.snapshot ?? goal({ activation: fixture.activation ?? 'armed' }),
      plan: PLAN, records: [row('filtered', 'R1', 'done')], ...fixture };
    const originalInput = structuredClone(input);
    const before = co.checkpoint();
    const stateBefore = structuredClone(co.state);
    const out = await guardedStep(co, input);
    assert.deepEqual(input, originalInput, fixture.label + ': raw input unchanged');
    if (fixture.allow) {
      assert.equal(out.recovery.code, RC.DECISION.RESUME_OK);
      assert.equal(out.next.code, null);
      assert.equal(steps, 1);
      assert.equal(submits, 1, 'positive control must reach fake transport');
      assert.notEqual(co.checkpoint(), before);
    } else {
      assert.equal(out.code, fixture.code ?? 'recovery_refused', fixture.label);
      if (fixture.recovery) assert.equal(out.recovery.code, fixture.recovery, fixture.label);
      if (fixture.label.startsWith('interior')) {
        assert.equal(out.recovery.why, 'ledger_corrupt');
        assert.deepEqual(fixture.label === 'interior syntax' ? out.recovery.unparsableLineIndexes
          : out.recovery.invalidLineIndexes, [1]);
      }
      assert.equal(steps, 0, fixture.label + ': guard must precede step mutation');
      assert.equal(submits, 0, fixture.label + ': no submit');
      assert.equal(co.checkpoint(), before, fixture.label + ': checkpoint bytes preserved');
      assert.deepEqual(co.state, stateBefore, fixture.label + ': no hidden state mutation');
    }
  }
});

test('T310: test-only storage barrier proves recovery and lease bytes before fake handoff', async () => {
  const { createCoordinator, restore } = await import('./tools/continuation/coordinator.mjs');
  const now = 100000;
  const sessionId = 'offline-t310-session';
  const tasks = [{ id: 'next', scope: 'offline-fixture', title: 'synthetic next' }];
  const grant = { kind: 'continuation', epoch: 'offline-t310', sessionId,
    armedAt: 1000, expiresAt: 200000, maxTasks: 2, scopes: ['offline-fixture'] };
  const seed = createCoordinator({ sessionId, tasks, now: () => now });
  assert.equal(seed.status().enabled, false);
  await seed.enable(grant);
  seed.poll({ ok: true, armEpoch: grant.epoch, count: 1, truncated: false,
    candidates: [{ runId: 'aa11bb22-cc33-4d44-8e55-ff6677889902', status: 'completed',
      origin: 'bridge', startedAt: 2, endedAtMs: 3000, postArm: true }] }, now);
  const initial = seed.checkpoint();
  const raw = JSON.stringify(row('settled', 'R1', 'done'));

  // In-memory durable-store MODEL only. Exact readback is a model contract, not fsync proof.
  function harness(mode, checkpoint = initial) {
    let durable = null;
    let submitted = 0;
    let writes = 0;
    let context;
    const write = async bytes => {
      writes += 1;
      if (mode === 'throw') throw new Error('synthetic storage error');
      if (mode === 'lost') return; // even an apparently successful write may lose bytes
      durable = mode === 'torn' ? bytes.slice(0, -1) : bytes;
    };
    const co = restore(checkpoint, { sessionId, tasks, now: () => now,
      bridge: { request: async request => {
        const bytes = JSON.stringify({ ...context, checkpoint: co.checkpoint() });
        const saved = JSON.parse(JSON.parse(bytes).checkpoint);
        const job = saved.store.jobs[request.key];
        assert.equal(job.state, 'leased');
        assert.equal(job.taskId, request.taskId);
        assert.equal(job.attempts, request.attempt);
        await write(bytes);
        if (durable !== bytes) throw new Error('checkpoint persistence unverified');
        // The only outbound fake submit in this fixture occurs AFTER exact readback.
        submitted += 1;
        return mode === 'unknown' ? undefined : { outcome: 'ack' };
      } } });
    return { co, get durable() { return durable; }, get submitted() { return submitted; },
      get writes() { return writes; },
      async next({ enabled = false, tailText = raw, snapshot = goal() } = {}) {
        if (enabled !== true) return { code: 'offline_barrier_disabled' };
        if (typeof tailText !== 'string') return { code: 'raw_input_missing' };
        const recovery = RC.assessRecovery({ goal: snapshot, plan: PLAN, tailText });
        if (recovery.code !== RC.DECISION.RESUME_OK) return { code: 'recovery_refused', recovery };
        // Clone at assessment time; no borrowed mutable authorization/ledger objects.
        context = structuredClone({ tailText, goal: snapshot, plan: PLAN, recovery });
        return co.step(now);
      } };
  }

  const off = harness('ok');
  const offBefore = off.co.checkpoint();
  assert.equal((await off.next()).code, 'offline_barrier_disabled');
  assert.equal(off.writes, 0);
  assert.equal(off.submitted, 0);
  assert.equal(off.co.checkpoint(), offBefore);
  const unknownRaw = JSON.stringify(row('unfinished', 'R1', null));
  assert.equal((await off.next({ enabled: true, tailText: unknownRaw })).code, 'recovery_refused');
  assert.equal(off.writes, 0);
  assert.equal(off.submitted, 0);
  assert.equal(off.co.checkpoint(), offBefore);

  for (const mode of ['throw', 'lost', 'torn']) {
    const h = harness(mode);
    assert.equal((await h.next({ enabled: true })).code, 'in_flight', mode);
    assert.equal(h.submitted, 0, mode + ': persistence failure prevents fake submit');
    assert.equal((await h.next({ enabled: true })).code, 'in_flight');
    assert.equal(h.writes, 1, 'retained lease prevents silent retry after storage failure');
    if (mode === 'torn') assert.throws(() => JSON.parse(h.durable), SyntaxError);
  }
  assert.throws(() => restore(initial.slice(0, -1), {
    bridge: { request: () => assert.fail('torn checkpoint must never submit') },
  }), SyntaxError);

  const ok = harness('ok');
  assert.equal((await ok.next({ enabled: true })).code, null);
  assert.equal(ok.submitted, 1);
  const persisted = JSON.parse(ok.durable);
  assert.equal(persisted.tailText, raw);
  assert.deepEqual(persisted.goal, goal());
  assert.equal(persisted.recovery.code, RC.DECISION.RESUME_OK);

  const unknown = harness('unknown');
  assert.equal((await unknown.next({ enabled: true })).code, 'in_flight');
  assert.equal(unknown.submitted, 1, 'first acceptance becomes unknown only after handoff');
  const restart = harness('ok', JSON.parse(unknown.durable).checkpoint);
  assert.equal((await restart.next({ enabled: true })).code, 'in_flight');
  await restart.co.recover(now + 60001);
  assert.equal((await restart.next({ enabled: true })).code, 'unknown_outcome');
  assert.equal(restart.submitted, 0, 'unknown acceptance is never silently retried after restore');
  assert.equal(restart.writes, 0);
});

test('T161-2: no goal is its own answer', () => {
  for (const bad of [null, {}, { id: '' }]) {
    assert.equal(RC.assessRecovery({ goal: bad }).code, 'goal_missing');
  }
});

test('T161-2: every decision has steps, and the renderer names the decision', () => {
  const decisions = [
    RC.assessRecovery({ goal: goal(), plan: PLAN, records: [] }),
    RC.assessRecovery({ goal: goal(), plan: PLAN, tailText: '{"x' }),
    RC.assessRecovery({ goal: goal(), plan: PLAN, records: [row('r1', 'R1', 'continue')] }),
    RC.assessRecovery({ goal: goal({ activation: 'disarmed' }), plan: PLAN, records: [] }),
    RC.assessRecovery({ goal: goal({ phase: 'complete' }), plan: PLAN, records: [] }),
  ];
  for (const out of decisions) {
    assert.ok(Array.isArray(out.steps) && out.steps.length > 0, out.code + ' has steps');
    assert.match(RC.renderRecoveryMarkdown(out), new RegExp('Decision: `' + out.code + '`'));
  }
});
