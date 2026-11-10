import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectServer } from './tools/dsh-direct/mcp_server.mjs';
import { createFakeHost, createSessionControllerAdapter } from './tools/dsh-direct/adapters.mjs';
import { createContinueOnce, continuationRequestId } from './tools/dsh-direct/continue_once.mjs';

const sessionId = 'session-11111111-2222-4333-8444-555566667777';
const projectId = '/synthetic/workspace';
async function scene(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 't322-'));
  try {
    const fake = createFakeHost({ sessions: [{ sessionId, cwd: projectId }], pagesPerTurn: 1 });
    const client = createSessionControllerAdapter(fake, { kind: 'offline_fake' });
    const config = { stateDir: dir, boundSessionIds: [sessionId], boundCwds: [], maxPolls: 1 };
    const direct = new DirectServer(config, { client });
    const predecessor = await direct.submitTask({ sessionId, projectId, requestId: 'predecessor-0001', prompt: 'first' });
    assert.equal(predecessor.task.state, 'succeeded');
    const trigger = Object.fromEntries(['taskId', 'requestId', 'sessionId', 'projectId', 'turnId']
      .map(k => [k, predecessor.task[k]]));
    const input = { trigger, next: { sessionId, projectId, requestId: continuationRequestId(trigger), prompt: 'next' } };
    await fn({ direct, fake, input, config, client });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const verifyResult = task => task.result.text === 'offline fake answer for first';

test('T322 default-off does not call an injected client or verifier', async () => {
  const runner = createContinueOnce({ client: new Proxy({}, { get() { throw new Error('access'); } }) });
  assert.deepEqual(await runner.run(), { code: 'disabled', submitted: false });
});

test('T322 real DirectServer ledger: verified result -> idle -> one same-session handoff, stable restart key', async () => {
  await scene(async ({ direct, fake, input, config, client }) => {
    const runner = createContinueOnce({ enabled: true, client: direct, verifyResult });
    const [out, concurrent] = await Promise.all([runner.run(input), runner.run(input)]);
    assert.equal(out.code, 'handoff_recorded'); assert.equal(out.completionVerified, false);
    assert.equal(concurrent.code, 'runner_used');
    assert.deepEqual(fake.control.admissions(), ['predecessor-0001', input.next.requestId]);
    const restartedClient = new DirectServer(config, { client });
    const duplicate = await createContinueOnce({ enabled: true, client: restartedClient, verifyResult }).run(input);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.taskId, out.taskId);
    assert.equal(fake.control.admissions().length, 2);
  });
});

test('T322 invalid completion, acceptance, idle and next binding produce zero next submissions', async () => {
  await scene(async ({ direct, fake, input }) => {
    for (const mode of ['incomplete', 'wrong-turn', 'no-admission', 'acceptance', 'busy', 'unknown-idle', 'request-id']) {
      const client = {
        getResult: async args => {
          const reply = structuredClone(await direct.getResult(args));
          if (mode === 'incomplete') reply.task.state = 'running';
          if (mode === 'wrong-turn') reply.task.turnId = 'other';
          if (mode === 'no-admission') reply.task.result.admission.found = false;
          return reply;
        },
        listSessions: async args => {
          const reply = await direct.listSessions(args);
          if (mode === 'busy') reply.sessions[0].running = true;
          if (mode === 'unknown-idle') delete reply.sessions[0].running;
          return reply;
        },
        submitTask: () => assert.fail('preflight must block submit'),
      };
      const changed = structuredClone(input);
      if (mode === 'request-id') changed.next.requestId = 'different-request';
      const out = await createContinueOnce({ enabled: true, client,
        verifyResult: mode === 'acceptance' ? () => false : verifyResult }).run(changed);
      assert.equal(out.submitted, false, mode);
    }
    assert.equal(fake.control.admissions().length, 1);
  });
});

test('T322 idle race is rechecked by DirectServer and changed prompt cannot reuse predecessor slot', async () => {
  await scene(async ({ direct, fake, input }) => {
    const raced = createContinueOnce({ enabled: true, verifyResult, client: {
      getResult: a => direct.getResult(a), listSessions: a => direct.listSessions(a),
      submitTask: a => { fake.control.setRunning(sessionId, true); return direct.submitTask(a); },
    } });
    assert.equal((await raced.run(input)).code, 'submission_unknown');
    assert.equal(fake.control.admissions().length, 1);
    fake.control.setRunning(sessionId, false);
    assert.equal((await createContinueOnce({ enabled: true, client: direct, verifyResult }).run(input)).code,
      'handoff_recorded');
    const changed = structuredClone(input); changed.next.prompt = 'different next intent';
    assert.equal((await createContinueOnce({ enabled: true, client: direct, verifyResult }).run(changed)).code,
      'submission_unknown');
    assert.equal(fake.control.admissions().length, 2);
  });
});

test('T322 lost submit response stays unsettled; no reconcile or prompt retry', async () => {
  await scene(async ({ direct, fake, input, config, client }) => {
    fake.control.loseNextResponse();
    const runner = createContinueOnce({ enabled: true, client: direct, verifyResult });
    assert.equal((await runner.run(input)).code, 'submission_unknown');
    assert.equal((await runner.run(input)).code, 'runner_used');
    // Even a new runner using the same ledger/key cannot create another Host admission.
    const out = await createContinueOnce({ enabled: true,
      client: new DirectServer(config, { client }), verifyResult }).run(input);
    assert.equal(out.submitted, false); // Host is still busy, no submit call
    assert.equal(fake.control.admissions().length, 2);
  });
});

test('T322 budgets stop preflight and classify submitted timeout as unknown, without cancellation claim', async () => {
  await scene(async ({ direct, input }) => {
    const never = () => new Promise(() => {});
    const preflight = createContinueOnce({ enabled: true, budgetMs: 15, verifyResult,
      client: { getResult: never, listSessions: () => assert.fail(), submitTask: () => assert.fail() } });
    assert.equal((await preflight.run(input)).code, 'preflight_unverified');
    let calls = 0;
    const runner = createContinueOnce({ enabled: true, budgetMs: 30, verifyResult,
      client: { getResult: a => direct.getResult(a), listSessions: a => direct.listSessions(a),
        submitTask: () => { calls++; return never(); } } });
    assert.equal((await runner.run(input)).code, 'submission_unknown');
    assert.equal((await runner.run(input)).code, 'runner_used'); assert.equal(calls, 1);
  });
});
