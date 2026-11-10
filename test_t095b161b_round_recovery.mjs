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

test('T311: isolated default-off filesystem checkpoints refuse ambiguous replacement', async () => {
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { createOfflineCheckpointStore, MAX_CHECKPOINT_BYTES } =
    await import('./tools/continuation/offline_checkpoint_store.mjs');
  const identity = { sessionId: 'offline-t311', goalId: 'synthetic-goal', goalRevision: 1 };
  const envelope = { version: 1, ...identity, checkpoint: JSON.stringify({ version: 1,
    sessionId: identity.sessionId, state: {}, store: {} }) };
  const root = await fs.mkdtemp(path.join(tmpdir(), 't311-'));
  let serial = 0;
  const fresh = async () => {
    const directory = path.join(root, String(++serial));
    await fs.mkdir(directory);
    return directory;
  };
  const make = (directory, extra = {}) => createOfflineCheckpointStore({ directory, identity,
    enabled: true, ...extra });
  try {
    const directory = await fresh();
    const off = make(directory, { enabled: false });
    assert.equal((await off.write(envelope)).code, 'disabled');
    assert.equal((await off.read()).code, 'disabled');
    assert.deepEqual(await fs.readdir(directory), []);
    const store = make(directory);
    assert.equal((await store.read()).code, 'missing');
    assert.equal((await store.write(envelope)).code, null);
    assert.deepEqual((await make(directory).read()).envelope, envelope);
    const replacement = { ...envelope, note: 'new' };
    assert.equal((await store.write(replacement)).code, null);
    assert.deepEqual((await make(directory).read()).envelope, replacement);
    assert.deepEqual(await fs.readdir(directory), ['checkpoint.json']);
    assert.equal((await make(directory, { identity: { ...identity, goalId: 'other' } }).read()).code,
      'identity_mismatch');
    await fs.writeFile(path.join(directory, 'checkpoint.json'), '{"version":');
    assert.equal((await make(directory).read()).code, 'stored_json_invalid');
    assert.equal(await fs.readFile(path.join(directory, 'checkpoint.json'), 'utf8'), '{"version":');

    for (const stage of ['after_intent', 'after_write', 'before_rename', 'after_rename']) {
      const dir = await fresh();
      await make(dir).write(envelope);
      const old = await fs.readFile(path.join(dir, 'checkpoint.json'), 'utf8');
      const broken = make(dir, { fault: at => { if (at === stage) throw new Error('injected'); } });
      assert.equal((await broken.write(replacement)).code, 'storage_error');
      assert.equal((await broken.read()).code, 'unsettled_write');
      assert.equal((await make(dir).read()).code, 'unsettled_write', stage + ': no old fallback');
      assert.ok((await fs.readdir(dir)).includes('checkpoint.intent'));
      if (stage !== 'after_rename') assert.equal(await fs.readFile(path.join(dir, 'checkpoint.json'), 'utf8'), old);
    }
    for (const invalid of [{ ...envelope, version: 2 }, { ...envelope, goalId: 'wrong' },
      { ...envelope, checkpoint: '{bad' }, { ...envelope, checkpoint: JSON.stringify({ version: 2 }) },
      { ...envelope, checkpoint: 'x'.repeat(MAX_CHECKPOINT_BYTES + 1) }]) {
      const dir = await fresh();
      await make(dir).write(envelope);
      assert.notEqual((await make(dir).write(invalid)).code, null);
      assert.equal((await make(dir).read()).code, 'unsettled_write');
    }
    const dir = await fresh();
    await make(dir).write(envelope);
    const file = path.join(dir, 'checkpoint.json');
    const damaged = JSON.parse(await fs.readFile(file, 'utf8'));
    damaged.payload += ' ';
    await fs.writeFile(file, JSON.stringify(damaged));
    assert.equal((await make(dir).read()).code, 'integrity_mismatch');
    await fs.writeFile(file, Buffer.alloc(256 * 1024 + 1));
    assert.equal((await make(dir).read()).code, 'file_size');
    const mismatchDir = await fresh();
    const mismatch = make(mismatchDir, { fault: async stage => {
      if (stage === 'after_rename') await fs.writeFile(path.join(mismatchDir, 'checkpoint.json'), 'torn');
    } });
    assert.equal((await mismatch.write(envelope)).code, 'readback_mismatch');
    assert.equal((await make(mismatchDir).read()).code, 'unsettled_write');
    const corruptDir = await fresh();
    await fs.writeFile(path.join(corruptDir, 'checkpoint.json'), 'original-corrupt');
    assert.equal((await make(corruptDir).write(envelope)).code, 'stored_json_invalid');
    assert.equal(await fs.readFile(path.join(corruptDir, 'checkpoint.json'), 'utf8'), 'original-corrupt');
    const partialDir = await fresh();
    await fs.writeFile(path.join(partialDir, 'checkpoint.pending'), 'partial');
    assert.equal((await make(partialDir).read()).code, 'unsettled_write');
  } finally {
    await fs.rm(root, { recursive: true, force: true }); // only these synthetic fixtures
  }
});

test('T312: real filesystem barrier composes raw recovery with offline coordinator', async () => {
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { createCoordinator, restore } = await import('./tools/continuation/coordinator.mjs');
  const { createOfflineCheckpointStore } = await import('./tools/continuation/offline_checkpoint_store.mjs');
  const now = 100000;
  const identity = { sessionId: 'offline-t312', goalId: 'goal-x', goalRevision: 1 };
  const tasks = [{ id: 'next', scope: 'fixture', title: 'synthetic next task' }];
  const deps = { sessionId: identity.sessionId, tasks, now: () => now };
  const seed = createCoordinator(deps);
  await seed.enable({ kind: 'continuation', epoch: 't312', sessionId: identity.sessionId,
    armedAt: 1000, expiresAt: 200000, maxTasks: 2, scopes: ['fixture'] });
  seed.poll({ ok: true, armEpoch: 't312', count: 1, truncated: false, candidates: [{
    runId: 'aa11bb22-cc33-4d44-8e55-ff6677889903', status: 'completed', origin: 'bridge',
    startedAt: 2, endedAtMs: 3000, postArm: true }] }, now);
  const initial = seed.checkpoint();
  const clean = JSON.stringify(row('settled', 'R1', 'done'));
  const root = await fs.mkdtemp(path.join(tmpdir(), 't312-'));
  const storeAt = (directory, extra = {}) => createOfflineCheckpointStore({
    directory, identity, enabled: true, ...extra });
  const envelopeOf = checkpoint => ({ version: 1, ...identity, checkpoint });

  // Test-local default-off seam, not a runtime driver. Trusted single-owner directory.
  function harness(directory, checkpoint = initial, mode = 'clean') {
    let submits = 0;
    let steps = 0;
    let storageCode = null;
    let context;
    let selected = checkpoint;
    const store = storeAt(directory, {
      identity: mode === 'identity' ? { ...identity, goalId: 'wrong' } : identity,
      fault: async stage => {
        if (mode === 'write' && stage === 'after_write') throw new Error('injected write failure');
        if (mode === 'rename' && stage === 'before_rename') {
          // Actual rename then fails because its source has gone; preserve bytes under another name.
          await fs.rename(path.join(directory, 'checkpoint.pending'), path.join(directory, 'held.pending'));
        }
        if (mode === 'readback' && stage === 'after_rename') {
          await fs.writeFile(path.join(directory, 'checkpoint.json'), '{torn');
        }
      },
    });
    const co = restore(checkpoint, { ...deps, bridge: { request: async request => {
      const prospective = co.checkpoint();
      const parsed = JSON.parse(prospective);
      const lease = parsed.store.jobs[request.key];
      assert.equal(parsed.sessionId, identity.sessionId);
      assert.equal(lease.state, 'leased');
      assert.equal(lease.taskId, request.taskId);
      assert.equal(lease.attempts, request.attempt);
      const envelope = { ...envelopeOf(prospective), ...context };
      const written = await store.write(envelope);
      storageCode = written.code;
      if (written.code !== null) throw new Error('persistence refused');
      const readback = await store.read();
      if (readback.code !== null || JSON.stringify(readback.envelope) !== JSON.stringify(envelope)) {
        throw new Error('readback refused');
      }
      selected = prospective;
      submits += 1; // only outbound fake submit, AFTER actual filesystem write/readback
      return mode === 'unknown' ? undefined : { outcome: 'ack' };
    } } });
    return { co, get submits() { return submits; }, get steps() { return steps; },
      get storageCode() { return storageCode; },
      async next({ enabled = false, tailText = clean, snapshot = goal() } = {}) {
        if (enabled !== true) return { code: 'disabled' };
        if (typeof tailText !== 'string') return { code: 'raw_missing' };
        if (snapshot.id !== identity.goalId || snapshot.revision !== identity.goalRevision) {
          return { code: 'goal_identity_mismatch' };
        }
        const recovery = RC.assessRecovery({ goal: snapshot, plan: PLAN, tailText });
        if (recovery.code !== RC.DECISION.RESUME_OK) return { code: 'recovery_refused', recovery };
        const prior = await store.read();
        if (prior.code !== null) return { code: prior.code };
        if (prior.envelope.checkpoint !== selected) return { code: 'stale_snapshot' };
        context = structuredClone({ tailText, goal: snapshot, plan: PLAN, recovery });
        steps += 1;
        return co.step(now);
      } };
  }
  try {
    const cases = [
      { mode: 'off', enabled: false, code: 'disabled' },
      { mode: 'interior', tailText: clean + '\n{bad\n' + clean, code: 'recovery_refused' },
      { mode: 'tail', tailText: clean + '\n{torn', code: 'recovery_refused' },
      { mode: 'disarmed', snapshot: goal({ activation: 'disarmed' }), code: 'recovery_refused' },
      { mode: 'unfinished', tailText: JSON.stringify(row('unknown', 'R1', null)), code: 'recovery_refused' },
      { mode: 'identity', code: 'identity_mismatch' },
      { mode: 'stale', code: 'stale_snapshot' },
      { mode: 'write', code: 'in_flight' }, { mode: 'rename', code: 'in_flight' },
      { mode: 'readback', code: 'in_flight' },
      { mode: 'clean', code: null }, { mode: 'unknown', code: 'in_flight' },
    ];
    for (const fixture of cases) {
      const directory = path.join(root, fixture.mode);
      await fs.mkdir(directory);
      const stored = fixture.mode === 'stale' ? JSON.stringify({ ...JSON.parse(initial), stale: true }) : initial;
      assert.equal((await storeAt(directory).write(envelopeOf(stored))).code, null);
      const beforeFile = await fs.readFile(path.join(directory, 'checkpoint.json'), 'utf8');
      const h = harness(directory, initial, fixture.mode);
      const beforeState = structuredClone(h.co.state);
      const beforeCheckpoint = h.co.checkpoint();
      const out = await h.next({ enabled: true, ...fixture });
      assert.equal(out.code, fixture.code, fixture.mode);
      const sent = ['clean', 'unknown'].includes(fixture.mode);
      assert.equal(h.submits, sent ? 1 : 0, fixture.mode);
      if (h.steps === 0) {
        assert.equal(h.co.checkpoint(), beforeCheckpoint);
        assert.deepEqual(h.co.state, beforeState);
        assert.equal(await fs.readFile(path.join(directory, 'checkpoint.json'), 'utf8'), beforeFile);
      }
      if (['write', 'rename', 'readback'].includes(fixture.mode)) {
        assert.equal(h.storageCode, fixture.mode === 'readback' ? 'readback_mismatch' : 'storage_error');
        assert.equal((await storeAt(directory).read()).code, 'unsettled_write');
        await h.next({ enabled: true });
        assert.equal(h.submits, 0);
      }
      if (sent) {
        const durable = await storeAt(directory).read();
        assert.equal(durable.code, null);
        assert.equal(durable.envelope.tailText, clean);
        assert.equal(durable.envelope.recovery.code, RC.DECISION.RESUME_OK);
        // Even a clean ACK not durably recorded must restore as uncertain, never as replay permission.
        const restarted = harness(directory, durable.envelope.checkpoint);
        assert.equal((await restarted.next({ enabled: true })).code, 'in_flight');
        await restarted.co.recover(now + 60001);
        assert.equal((await restarted.next({ enabled: true })).code, 'unknown_outcome');
        assert.equal(restarted.submits, 0);
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('T313: post-ACK crash window never replays a durably leased handoff', async () => {
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { createCoordinator, restore } = await import('./tools/continuation/coordinator.mjs');
  const { createOfflineCheckpointStore } = await import('./tools/continuation/offline_checkpoint_store.mjs');
  const root = await fs.mkdtemp(path.join(tmpdir(), 't313-'));
  const now = 100000;
  const identity = { sessionId: 'offline-t313', goalId: 'goal-x', goalRevision: 1 };
  const deps = { sessionId: identity.sessionId, now: () => now,
    tasks: [{ id: 'next', scope: 'fixture', title: 'synthetic handoff' }] };
  const tailText = JSON.stringify(row('settled', 'R1', 'done'));
  const recovery = RC.assessRecovery({ goal: goal(), plan: PLAN, tailText });
  assert.equal(recovery.code, RC.DECISION.RESUME_OK);
  const at = (directory, fault) => createOfflineCheckpointStore({ directory, identity, enabled: true, fault });
  const pack = checkpoint => ({ version: 1, ...identity, checkpoint, tailText, goal: goal(), plan: PLAN, recovery });
  try {
    for (const mode of ['lost-before-write', 'throw-terminal-write', 'corrupt-terminal', 'wrong-session', 'wrong-attempt', 'clean']) {
      const directory = path.join(root, mode);
      await fs.mkdir(directory);
      let submits = 0;
      let requestSeen;
      let ack;
      const co = createCoordinator({ ...deps, bridge: { request: async request => {
        requestSeen = { ...request };
        const prospective = pack(co.checkpoint());
        assert.equal(JSON.parse(prospective.checkpoint).store.jobs[request.key].state, 'leased');
        assert.equal((await at(directory).write(prospective)).code, null);
        assert.deepEqual((await at(directory).read()).envelope, prospective);
        submits += 1;
        ack = { outcome: 'ack', sessionId: request.sessionId, key: request.key, attempt: request.attempt };
        if (mode === 'wrong-session') ack.sessionId = 'other';
        if (mode === 'wrong-attempt') ack.attempt += 1;
        // Test-local identity check: coordinator itself does not authenticate reply fields.
        if (ack.sessionId !== request.sessionId || ack.key !== request.key || ack.attempt !== request.attempt) {
          return undefined;
        }
        return ack;
      } } });
      await co.enable({ kind: 'continuation', epoch: 't313', sessionId: identity.sessionId,
        armedAt: 1000, expiresAt: 200000, maxTasks: 2, scopes: ['fixture'] });
      co.poll({ ok: true, armEpoch: 't313', count: 1, truncated: false, candidates: [{
        runId: 'aa11bb22-cc33-4d44-8e55-ff6677889904', status: 'completed', origin: 'bridge',
        startedAt: 2, endedAtMs: 3000, postArm: true }] }, now);
      async function guardedStart(enabled = false) {
        if (enabled !== true) return { code: 'disabled' };
        if (recovery.code !== RC.DECISION.RESUME_OK) return { code: 'recovery_refused' };
        return co.step(now);
      }
      assert.equal((await guardedStart()).code, 'disabled');
      assert.equal(submits, 0);
      const out = await guardedStart(true);
      assert.equal(submits, 1);
      const mismatch = mode.startsWith('wrong-');
      assert.equal(out.code, mismatch ? 'in_flight' : null);
      const key = requestSeen.key;
      if (!mismatch) assert.equal(co.state.store.jobs[key].state, 'acked');
      let closed = false;
      if (['throw-terminal-write', 'corrupt-terminal', 'clean'].includes(mode)) {
        // Persist only the real coordinator's generated acked checkpoint; never invent done/history.
        const terminal = pack(co.checkpoint());
        const job = JSON.parse(terminal.checkpoint).store.jobs[key];
        assert.equal(job.state, 'acked');
        assert.equal(job.attempts, ack.attempt);
        assert.equal(job.taskId, requestSeen.taskId);
        assert.equal(co.state.tasksDone, 1); // handoffs, NOT authoritative upstream task completion
        const storage = at(directory, async stage => {
          if (mode === 'throw-terminal-write' && stage === 'after_write') throw new Error('terminal write failed');
          if (mode === 'corrupt-terminal' && stage === 'after_rename') {
            await fs.writeFile(path.join(directory, 'checkpoint.json'), '{corrupt');
          }
        });
        const saved = await storage.write(terminal);
        if (saved.code === null) {
          const readback = await storage.read();
          assert.deepEqual(readback.envelope, terminal);
          closed = readback.code === null;
        } else assert.equal(saved.code, mode === 'corrupt-terminal' ? 'readback_mismatch' : 'storage_error');
      }
      assert.equal(closed, mode === 'clean', 'closure only after verified ACK checkpoint readback');
      const durable = await at(directory).read();
      let restartSubmits = 0;
      if (['throw-terminal-write', 'corrupt-terminal'].includes(mode)) {
        assert.equal(durable.code, 'unsettled_write'); // refuse restore; no old fallback
      } else {
        assert.equal(durable.code, null);
        const restored = restore(durable.envelope.checkpoint, { ...deps,
          bridge: { request: async () => { restartSubmits += 1; return { outcome: 'ack' }; } } });
        assert.equal((await restored.step(now)).code, closed ? 'no_events' : 'in_flight');
        if (!closed) {
          await restored.recover(now + 60001);
          assert.equal((await restored.step(now + 60001)).code, 'unknown_outcome');
        } else {
          const before = restored.checkpoint();
          assert.equal((await restored.step(now)).code, 'no_events'); // duplicate delivery opportunity
          assert.equal(restored.checkpoint(), before);
          assert.equal(restored.state.tasksDone, 1);
        }
      }
      assert.equal(restartSubmits, 0, mode + ': never duplicate the accepted handoff');
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('T316/T317: reusable offline boundary preserves uncertainty across fresh adapter restart', async () => {
  const { createOfflineHandoff } = await import('./tools/continuation/offline_handoff.mjs');
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { createCoordinator, restore } = await import('./tools/continuation/coordinator.mjs');
  const { createOfflineCheckpointStore } = await import('./tools/continuation/offline_checkpoint_store.mjs');
  const { createOfflineBoundReceiptAdapter } = await import('./tools/continuation/offline_bound_receipt.mjs');
  const root = await fs.mkdtemp(path.join(tmpdir(), 't316-'));
  const now = 100000;
  const identity = { sessionId: 'offline-t316', goalId: 'goal-x', goalRevision: 1 };
  const deps = { sessionId: identity.sessionId, now: () => now,
    tasks: [{ id: 'next', scope: 'fixture', title: 'synthetic handoff' }] };
  try {
    for (const mode of ['malformed', 'corrupt-ledger', 'storage-error', 'write-loss', 'missing', 'mismatch', 'throw', 'unknown', 'lost-settlement', 'clean']) {
      const directory = path.join(root, mode); await fs.mkdir(directory);
      const store = createOfflineCheckpointStore({ directory, identity, enabled: true,
        fault: stage => { if (mode === 'storage-error' && stage === 'after_write') throw new Error('fixture'); } });
      let calls = 0, barrierChecks = 0, envelope, observedBinding;
      const transport = { request: async request => {
        calls += 1; // entry counter, even if an assertion/throw later becomes unknown
        const disk = await store.read();
        assert.equal(disk.code, null);
        envelope = disk.envelope;
        assert.equal(envelope.tailText, tailText);
        assert.deepEqual(envelope.goal, goal());
        const lease = JSON.parse(disk.envelope.checkpoint).store.jobs[request.key];
        assert.equal(lease.state, 'leased');
        assert.equal(lease.attempts, request.attempt);
        assert.equal(lease.taskId, request.taskId);
        assert.equal(disk.envelope.sessionId, request.sessionId);
        barrierChecks += 1; // checked outside adapter too, so swallowed assertion is not a false PASS
        observedBinding = { sessionId: request.sessionId, taskId: request.taskId,
          key: request.key, epoch: request.epoch, attempt: request.attempt };
        if (mode === 'throw') throw new Error('synthetic upstream uncertainty');
        if (mode === 'missing') return { outcome: 'ack' };
        if (mode === 'unknown') return { outcome: 'unknown' };
        return { outcome: 'ack', receipt: { version: 1, receiptId: 'synthetic-receipt',
          ...observedBinding, attempt: mode === 'mismatch' ? request.attempt + 1 : request.attempt } };
      } };
      const persistence = mode === 'write-loss' ? { read: () => store.read(),
        write: async () => ({ code: null }) } : store;
      const config = { identity, planDigest: OWN, store: persistence, transport };
      const boundary = createOfflineHandoff({ ...config, enabled: true });
      const co = createCoordinator({ ...deps, bridge: boundary.bridge });
      await co.enable({ kind: 'continuation', epoch: 't316', sessionId: identity.sessionId,
        armedAt: 1000, expiresAt: 200000, maxTasks: 2, scopes: ['fixture'] });
      co.poll({ ok: true, armEpoch: 't316', count: 1, truncated: false, candidates: [{
        runId: 'aa11bb22-cc33-4d44-8e55-ff6677889905', status: 'completed', origin: 'bridge',
        startedAt: 2, endedAtMs: 3000, postArm: true }] }, now);
      const raw = JSON.stringify(row('settled', 'R1', 'done'));
      const tailText = mode === 'corrupt-ledger' ? raw + '\n{bad\n' + raw : raw;
      const input = { tailText: mode === 'malformed' ? undefined : tailText, goal: goal(), plan: PLAN, at: now };
      const disabled = createOfflineHandoff(config);
      assert.equal((await disabled.step(co, input)).code, 'disabled'); assert.equal(calls, 0);
      const before = co.checkpoint();
      if (!['malformed', 'corrupt-ledger'].includes(mode)) {
        const initializer = createOfflineCheckpointStore({ directory, identity, enabled: true });
        const initialEnvelope = { version: 1, ...identity, checkpoint: before };
        assert.equal((await initializer.write(initialEnvelope)).code, null);
        assert.deepEqual((await initializer.read()).envelope, initialEnvelope);
      }
      const out = await boundary.step(co, input);
      assert.equal((await boundary.step(co, input)).code, 'offline_boundary_used');
      const preError = ['malformed', 'corrupt-ledger', 'storage-error', 'write-loss'].includes(mode);
      assert.equal(calls, preError ? 0 : 1, mode);
      assert.equal(barrierChecks, calls, 'every actual transport entry saw a verified persisted lease');
      assert.equal(out.code, mode === 'malformed' ? 'offline_input_invalid' : mode === 'corrupt-ledger' ? 'recovery_refused'
        : ['clean', 'lost-settlement'].includes(mode) ? null : 'in_flight');
      if (['malformed', 'corrupt-ledger'].includes(mode)) {
        assert.equal(co.checkpoint(), before); assert.deepEqual(await fs.readdir(directory), []); continue;
      }
      if (mode === 'storage-error') {
        assert.equal((await store.read()).code, 'unsettled_write'); continue;
      }
      if (mode === 'write-loss') {
        assert.equal((await store.read()).envelope.checkpoint, before);
        assert.equal((await co.step(now)).code, 'in_flight'); continue;
      }
      assert.equal(co.state.tasksDone, ['clean', 'lost-settlement'].includes(mode) ? 1 : 0);
      if (mode === 'clean') {
        const acked = { ...envelope, checkpoint: co.checkpoint() };
        assert.equal(JSON.parse(acked.checkpoint).store.jobs[observedBinding.key].state, 'acked');
        assert.equal((await store.write(acked)).code, null);
        assert.deepEqual((await store.read()).envelope, acked); // handoff bookkeeping, NOT task completion
      }
      const freshStore = createOfflineCheckpointStore({ directory, identity, enabled: true });
      const durable = await freshStore.read(); assert.equal(durable.code, null);
      assert.equal(durable.envelope.tailText, tailText);
      let restartCalls = 0;
      const freshBoundary = createOfflineHandoff({ enabled: true, identity, planDigest: OWN, store: freshStore,
        transport: { request: async () => { restartCalls += 1; return { outcome: 'unknown' }; } } });
      const restarted = restore(durable.envelope.checkpoint, { ...deps, bridge: freshBoundary.bridge });
      assert.equal((await freshBoundary.step(restarted, input)).code, mode === 'clean' ? 'no_events' : 'in_flight');
      if (mode !== 'clean') {
        await restarted.recover(now + 60001);
        assert.equal((await restarted.step(now + 60001)).code, 'unknown_outcome');
      }
      assert.equal(restartCalls, 0, mode + ': persisted state blocks send with empty adapter latch');
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('T319: missing historical checkpoint never licenses replay of a stale pre-send snapshot', async () => {
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { createCoordinator, restore } = await import('./tools/continuation/coordinator.mjs');
  const { createOfflineCheckpointStore } = await import('./tools/continuation/offline_checkpoint_store.mjs');
  const { createOfflineHandoff } = await import('./tools/continuation/offline_handoff.mjs');
  const directory = await fs.mkdtemp(path.join(tmpdir(), 't319-'));
  const identity = { sessionId: 'offline-t319', goalId: 'goal-x', goalRevision: 1 };
  const deps = { sessionId: identity.sessionId, now: () => 100000,
    tasks: [{ id: 'next', scope: 'fixture', title: 'synthetic task' }] };
  const input = { goal: goal(), plan: PLAN, tailText: '', at: 100000 };
  let calls = 0;
  const transport = { request: async request => {
    calls += 1; return { outcome: 'ack', receipt: { version: 1, receiptId: 'synthetic-' + calls, ...request } };
  } };
  const store = () => createOfflineCheckpointStore({ directory, identity, enabled: true });
  const boundary = () => createOfflineHandoff({ enabled: true, identity, planDigest: OWN, store: store(), transport });
  try {
    const first = boundary();
    const co = createCoordinator({ ...deps, bridge: first.bridge });
    await co.enable({ kind: 'continuation', epoch: 't319', sessionId: identity.sessionId,
      armedAt: 1000, expiresAt: 200000, maxTasks: 2, scopes: ['fixture'] });
    co.poll({ ok: true, armEpoch: 't319', count: 1, truncated: false, candidates: [{
      runId: 'aa11bb22-cc33-4d44-8e55-ff6677889906', status: 'completed', origin: 'bridge',
      startedAt: 2, endedAtMs: 3000, postArm: true }] }, 100000);
    const initial = co.checkpoint();
    // Explicit fixture initialization: known-new directory, exact pre-handoff snapshot.
    const initialized = { version: 1, ...identity, checkpoint: initial };
    assert.equal((await store().write(initialized)).code, null);
    assert.deepEqual((await store().read()).envelope, initialized);
    const mismatched = boundary();
    const mismatchedCo = restore(initial, { ...deps, bridge: mismatched.bridge });
    assert.equal((await mismatched.step(mismatchedCo, { ...input, goal: goal({ id: 'other-goal' }) })).code,
      'offline_binding_mismatch');
    const staleBoundary = boundary();
    const altered = JSON.parse(initial); altered.state.tasksDone = 1;
    const alteredCo = restore(altered, { ...deps, bridge: staleBoundary.bridge });
    assert.equal((await staleBoundary.step(alteredCo, input)).code, 'checkpoint_stale_or_mismatched');
    assert.equal(calls, 0);
    assert.equal((await first.step(co, input)).code, null);
    assert.equal(calls, 1);
    await fs.unlink(path.join(directory, 'checkpoint.json')); // simulate history loss ONLY in fixture
    const retry = boundary();
    const stale = restore(initial, { ...deps, bridge: retry.bridge });
    const before = stale.checkpoint();
    assert.equal((await retry.step(stale, input)).code, 'checkpoint_missing');
    assert.equal(calls, 1, 'missing history must not duplicate the accepted handoff');
    assert.equal(stale.checkpoint(), before);
    assert.deepEqual(await fs.readdir(directory), []);
    // An unresolved intent is not fresh initialization either.
    await fs.writeFile(path.join(directory, 'checkpoint.intent'), 'uncertain');
    const held = boundary(); const heldCo = restore(initial, { ...deps, bridge: held.bridge });
    assert.equal((await held.step(heldCo, input)).code, 'checkpoint_unreadable');
    assert.equal(calls, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
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
