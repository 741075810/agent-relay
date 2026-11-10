import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DirectServer } from './tools/dsh-direct/mcp_server.mjs';
import { createFakeHost, createSessionControllerAdapter } from './tools/dsh-direct/adapters.mjs';
import { createCompletionOwner } from './tools/dsh-direct/completion_owner.mjs';
const sessionId = 'session-11111111-2222-4333-8444-555566667777';
const projectId = '/synthetic/owner';
const sha = t => createHash('sha256').update(t).digest('hex');
async function scene(fn) {
  const directory = mkdtempSync(path.join(tmpdir(), 't323-'));
  try {
    const fake = createFakeHost({ sessions: [{ sessionId, cwd: projectId }], pagesPerTurn: 3 });
    const adapter = createSessionControllerAdapter(fake, { kind: 'offline_fake' });
    const direct = new DirectServer({ stateDir: directory, boundSessionIds: [sessionId], boundCwds: [], maxPolls: 1 },
      { client: adapter });
    const source = await direct.submitTask({ sessionId, projectId, requestId: 'source-t323-0001', prompt: 'first' });
    assert.equal(source.task.state, 'running');
    const plan = { sourceTaskId: source.task.taskId, sessionId, projectId, nextPrompt: 'next',
      sourceResultSha256: sha('offline fake answer for first'), successorResultSha256: sha('offline fake answer for next') };
    await fn({ direct, fake, plan });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
test('T323 finite owner observes running source, waits for idle, submits once and verifies successor', async () => {
  await scene(async ({ direct, fake, plan }) => {
    let idleReads = 0;
    const client = { getTask: a => direct.getTask(a), getResult: a => direct.getResult(a),
      submitTask: a => direct.submitTask(a), listSessions: async a => {
        const listed = await direct.listSessions(a);
        if (++idleReads === 1) listed.sessions[0].running = true;
        return listed;
      } };
    const owner = createCompletionOwner({ enabled: true, client, intervalMs: 1, deadlineMs: 1000 });
    const out = await owner.run(plan);
    assert.equal(out.code, 'successor_verified'); assert.equal(out.completionVerified, true);
    assert.equal(fake.control.admissions().length, 2); assert.ok(idleReads >= 3);
    assert.equal((await owner.run(plan)).code, 'owner_used');
  });
});
test('T323 default-off, wrong source, failed acceptance, busy deadline and lost reply never replay', async () => {
  assert.equal((await createCompletionOwner().run()).code, 'disabled');
  for (const mode of ['wrong-session', 'acceptance', 'busy', 'lost']) {
    await scene(async ({ direct, fake, plan }) => {
      if (mode === 'wrong-session') plan.sessionId = 'session-99999999-2222-4333-8444-555566667777';
      if (mode === 'acceptance') plan.sourceResultSha256 = '0'.repeat(64);
      let calls = 0;
      const client = { getTask: a => direct.getTask(a), getResult: a => direct.getResult(a),
        listSessions: async a => {
          const listed = await direct.listSessions(a);
          if (mode === 'busy') listed.sessions[0].running = true;
          return listed;
        }, submitTask: a => { calls++; if (mode === 'lost') fake.control.loseNextResponse(); return direct.submitTask(a); } };
      const owner = createCompletionOwner({ enabled: true, client, intervalMs: 1,
        deadlineMs: mode === 'busy' ? 30 : 1000 });
      const out = await owner.run(plan);
      assert.equal(out.code, { 'wrong-session': 'source_unverified', acceptance: 'acceptance_failed',
        busy: 'observation_stopped', lost: 'submission_unknown' }[mode]);
      assert.equal(calls, mode === 'lost' ? 1 : 0);
      assert.equal(fake.control.admissions().length, mode === 'lost' ? 2 : 1);
      assert.equal((await owner.run(plan)).code, 'owner_used');
    });
  }
});
