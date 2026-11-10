import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectServer } from './tools/dsh-direct/mcp_server.mjs';
import { createFakeHost, createSessionControllerAdapter } from './tools/dsh-direct/adapters.mjs';
import { createAcceptanceBootstrap, SEED_TEXT, NEXT_TEXT } from './tools/dsh-direct/acceptance_bootstrap.mjs';
const sessionId = 'session-11111111-2222-4333-8444-555566667777';
const projectId = '/synthetic/canary';
async function scene(fn) {
  const directory = mkdtempSync(path.join(tmpdir(), 't324-'));
  try {
    const fake = createFakeHost({ sessions: [{ sessionId, cwd: projectId }], pagesPerTurn: 3 });
    const adapter = createSessionControllerAdapter(fake, { kind: 'offline_fake' });
    const baseEvents = adapter.getEvents.bind(adapter);
    // Only fixture model output is customized; real request/turn/admission/result machinery is retained.
    adapter.getEvents = async args => {
      const page = await baseEvents(args);
      if (page.done) page.assistantText = args.requestId.startsWith('seed-t324-') ? SEED_TEXT : NEXT_TEXT;
      return page;
    };
    const direct = new DirectServer({ stateDir: directory, boundSessionIds: [sessionId], boundCwds: [], maxPolls: 1 },
      { client: adapter });
    await fn({ direct, fake });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
test('T324 seed receipt -> T323 owner -> exact successor result, no Bridge source ID', async () => {
  await scene(async ({ direct, fake }) => {
    const records = [];
    const bootstrap = createAcceptanceBootstrap({ enabled: true, client: direct,
      record: row => records.push(row), budgetMs: 1000, intervalMs: 1 });
    const out = await bootstrap.run({ sessionId, projectId });
    assert.equal(out.code, 'canary_verified');
    assert.equal(fake.control.admissions().length, 2);
    assert.equal(records[0].stage, 'seed_reserved');
    const seed = records.find(r => r.stage === 'seed_receipt');
    assert.equal(seed.taskId, out.seedTaskId);
    for (const text of [SEED_TEXT, NEXT_TEXT]) {
      const row = records.find(r => r.stage === 'task_result' && r.result === text);
      assert.ok(row.turnId); assert.equal(row.admission.found, true); assert.equal(row.sessionId, sessionId);
    }
    assert.equal((await bootstrap.run({ sessionId, projectId })).code, 'bootstrap_used');
    assert.equal(fake.control.admissions().length, 2);
  });
});
test('T324 default-off, busy, record failure and lost response never retry or fabricate successor', async () => {
  assert.equal((await createAcceptanceBootstrap().run()).code, 'disabled');
  for (const mode of ['busy', 'journal-error', 'unknown']) {
    await scene(async ({ direct, fake }) => {
      if (mode === 'busy') fake.control.setRunning(sessionId, true);
      if (mode === 'unknown') fake.control.loseNextResponse();
      const bootstrap = createAcceptanceBootstrap({ enabled: true, client: direct, budgetMs: 1000,
        intervalMs: 1, record: () => { if (mode === 'journal-error') throw new Error('fixture'); } });
      const out = await bootstrap.run({ sessionId, projectId });
      assert.equal(out.code, { busy: 'idle_unverified', 'journal-error': 'preflight_stopped', unknown: 'canary_unknown' }[mode]);
      assert.equal(fake.control.admissions().length, mode === 'unknown' ? 1 : 0);
      assert.equal((await bootstrap.run({ sessionId, projectId })).code, 'bootstrap_used');
    });
  }
});
