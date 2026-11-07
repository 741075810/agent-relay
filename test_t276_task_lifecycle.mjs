// T276: Host idle gating and read-only collection beyond the initial poll budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectServer } from './tools/dsh-direct/mcp_server.mjs';

const SESSION = 'session-11111111-2222-4333-8444-555566667777';
const REQUEST = 't276-life-0001';
function scene(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 't276life-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const row = { sessionId: SESSION, cwd: '/synthetic', running: false, agentAvailable: true };
  const state = { reads: 0, sends: 0, finishAfter: 4, admission: true, terminal: 'completed' };
  const client = {
    kind: 'offline_fake', protocol: 'test-only',
    listSessions: async () => [row],
    prompt: async () => { state.sends++; row.running = true; return { accepted: true }; },
    findAdmission: async () => ({ found: state.admission, seq: 2, eventType: 'user/message' }),
    getEvents: async () => {
      state.reads++;
      const terminal = state.reads >= state.finishAfter ? { kind: state.terminal, seq: 5 } : null;
      if (terminal) row.running = false;
      return { events: [], cursor: 5, done: Boolean(terminal && terminal.kind === 'completed'),
        assistantText: terminal ? 'DIRECT-OK' : null, terminal, turnId: '7',
        admission: { found: state.admission, seq: 2, eventType: 'user/message' } };
    },
  };
  const server = new DirectServer({ stateDir: dir, boundSessionIds: [SESSION], boundCwds: [], maxPolls: 1 }, { client });
  return { server, row, state };
}
const submit = (server, requestId = REQUEST) => server.submitTask({ requestId, sessionId: SESSION, prompt: 'DIRECT-OK' });

test('T276: busy or unknown-idle Host rows never reach prompt or create a ledger task', async (t) => {
  const { server, row, state } = scene(t);
  for (const running of [true, null, undefined]) {
    row.running = running;
    await assert.rejects(submit(server), { code: 'session_busy' });
  }
  row.running = false;
  row.agentAvailable = false;
  await assert.rejects(submit(server), { code: 'session_busy' });
  assert.equal(state.sends, 0);
  assert.equal(server.store.tasks.length, 0);
});

test('T276: result polling refreshes history after initial budget, never sends another prompt', async (t) => {
  const { server, state } = scene(t);
  const first = await submit(server);
  assert.equal(first.task.state, 'running');
  for (let i = 0; i < 2; i++) {
    await assert.rejects(server.getResult({ taskId: first.task.taskId }), { code: 'task_not_finished' });
  }
  const done = await server.getResult({ taskId: first.task.taskId });
  assert.equal(done.task.state, 'succeeded');
  assert.equal(done.task.turnId, '7');
  assert.equal(done.task.result.text, 'DIRECT-OK');
  assert.equal(done.task.result.admission.found, true);
  assert.equal(state.sends, 1);
  const reads = state.reads;
  await server.getResult({ taskId: first.task.taskId });
  assert.equal(state.reads, reads, 'completed results are durable, not repolled');
});

test('T276: missing request admission never becomes success even if a bridge says done', async (t) => {
  const { server, state } = scene(t);
  state.admission = false;
  state.finishAfter = 1;
  const first = await submit(server);
  assert.equal(first.task.state, 'running');
  await assert.rejects(server.getResult({ taskId: first.task.taskId }), { code: 'task_not_finished' });
  assert.equal(state.sends, 1);
});

test('T276: a matching aborted terminal is failed rather than a successful text result', async (t) => {
  const { server, state } = scene(t);
  state.terminal = 'aborted';
  state.finishAfter = 1;
  const result = await submit(server);
  assert.equal(result.task.state, 'failed');
  assert.equal(result.task.error.phase, 'host_turn');
  assert.equal(result.task.error.reason, 'aborted');
});

test('T276: duplicate lookup is permitted while busy but no new request is admitted', async (t) => {
  const { server, state } = scene(t);
  const first = await submit(server);
  const duplicate = await submit(server);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.task.taskId, first.task.taskId);
  await assert.rejects(submit(server, 't276-life-0002'), { code: 'session_busy' });
  assert.equal(state.sends, 1);
});

test('T276: reconciliation may read busy history but requires positive idle before reprompt', async (t) => {
  const { server, row, state } = scene(t);
  const first = await submit(server);
  server.store.transition(first.task.taskId, 'unsettled', { requiresReconcile: true });
  state.admission = false;
  await assert.rejects(server.reconcileTask({ taskId: first.task.taskId, prompt: 'DIRECT-OK' }), { code: 'session_busy' });
  assert.equal(state.sends, 1);
  assert.equal(server.store.find(first.task.taskId).state, 'unsettled');
  row.running = false;
  await server.reconcileTask({ taskId: first.task.taskId, prompt: 'DIRECT-OK' });
  assert.equal(state.sends, 2, 'one explicit same-id retry only after idle');
});

test('T276: get_result preserves an unsettled task without sending or collecting', async (t) => {
  const { server, state } = scene(t);
  const first = await submit(server);
  server.store.transition(first.task.taskId, 'unsettled');
  const reads = state.reads;
  await assert.rejects(server.getResult({ taskId: first.task.taskId }), { code: 'task_unsettled' });
  assert.equal(state.reads, reads);
  assert.equal(state.sends, 1);
});
