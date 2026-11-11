// T350: the durable pre-admission reservation, and the four places a process can die.
//
// Every case is a real state directory on disk and the real TaskStore/DirectServer code.
// Only the Host client is a fixture, because the question is what the *ledger* proves --
// not what the Host does. The fixture counts prompts, so "no second prompt" is asserted
// rather than assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, isProvablyUnsent, isRecoverableUnknown, promptSha, RESERVATION_PROTOCOL } from './tools/dsh-direct/store.mjs';
import { DirectServer } from './tools/dsh-direct/mcp_server.mjs';

const SID = 'session-11111111-2222-4333-8444-555566667777';
const RID = 't350-fixture-request';
const PROMPT = 'fixture prompt';

function harness(t, { idle = true, promptThrows = false } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 't350-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const calls = { prompt: 0, listSessions: 0, getEvents: 0 };
  const client = {
    kind: 'fixture', protocol: 'rc.2',
    async listSessions() {
      calls.listSessions += 1;
      return [{ sessionId: SID, cwd: '/fixture', running: idle ? false : true, agentAvailable: true }];
    },
    async prompt() {
      calls.prompt += 1;
      if (promptThrows) throw Object.assign(new Error('no answer'), { code: 'timeout' });
      return { accepted: true, turnId: 'turn-1' };
    },
    async getEvents() {
      calls.getEvents += 1;
      return { cursor: 'c1', events: [], done: false, assistantText: null, admission: { found: false } };
    },
  };
  const config = { stateDir, boundSessionIds: [SID], boundCwds: [], boundProjectIds: [],
    worktreeRoot: null, allowDirtyWorktree: false, maxPolls: 1 };
  const build = () => {
    const store = new TaskStore(stateDir);
    return { store, server: new DirectServer(config, { client, store,
      worktree: async () => ({ clean: true, head: 'head', entries: [] }) }) };
  };
  return { stateDir, calls, client, config, build, ...build() };
}

function submit(server, overrides = {}) {
  return server.submitTask({ requestId: RID, sessionId: SID, prompt: PROMPT, ...overrides });
}

test('T350 a failure before the reservation leaves no record and locks nothing', async t => {
  const { server, calls, build } = harness(t, { idle: false });
  await assert.rejects(submit(server), { code: 'session_busy' });
  assert.equal(calls.prompt, 0);
  const restarted = build();
  assert.equal(restarted.store.activeFor(SID), null);
  assert.equal(restarted.store.tasks.length, 0);
});

test('T350 a crash after the durable reservation is provably unsent, not unknown', async t => {
  const { store, stateDir, calls, build } = harness(t);
  // Exactly what `accept()` persists immediately before `#admit` would call the Host.
  const accepted = store.accept({ requestId: RID, sessionId: SID, projectId: '/fixture', prompt: PROMPT });
  const onDisk = JSON.parse(readFileSync(join(stateDir, 'tasks.json'), 'utf8'));
  assert.equal(onDisk.tasks[0].reservation.protocol, RESERVATION_PROTOCOL);
  assert.equal(onDisk.tasks[0].reservation.promptSha256, promptSha(PROMPT));
  assert.equal(calls.prompt, 0);

  const restarted = build();
  const task = restarted.store.find(accepted.task.taskId);
  assert.equal(task.state, 'reserved');
  assert.equal(task.stages.at(-1).stage, 'recovered_as_reserved');
  // The session must not stay locked by a request that never left this machine.
  assert.equal(restarted.store.activeFor(SID), null);
  assert.throws(() => restarted.store.finished(task.taskId), { code: 'task_not_finished' });
  assert.equal(isProvablyUnsent(task), true);
});

test('T350 a crash after Host acceptance and before the response keeps the session locked', async t => {
  const { store, calls, build } = harness(t);
  const accepted = store.accept({ requestId: RID, sessionId: SID, projectId: '/fixture', prompt: PROMPT });
  // `#admit` stages this durably before the only call that can submit a prompt.
  store.stage(accepted.task.taskId, 'host_prompt_sent', { sessionId: SID, requestId: RID });
  assert.equal(calls.prompt, 0);

  const restarted = build();
  const task = restarted.store.find(accepted.task.taskId);
  assert.equal(task.state, 'unknown');
  assert.equal(task.unknownReason, 'process_restart');
  assert.equal(isRecoverableUnknown(task), true);
  assert.equal(isProvablyUnsent(task), false);
  assert.notEqual(restarted.store.activeFor(SID), null);
  assert.throws(() => restarted.store.finished(task.taskId), { code: 'task_not_finished' });
});

test('T350 a row from before the reservation marker is never treated as unsent', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 't350-legacy-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  // The shape an older writer produced: `accepted`, no reservation, no prompt stage.
  writeFileSync(join(stateDir, 'tasks.json'), JSON.stringify({ version: 1, requestIds: { [RID]: 'dshd-1111111111111111' },
    tasks: [{ taskId: 'dshd-1111111111111111', requestId: RID, sessionId: SID, projectId: '/fixture',
      promptSha256: promptSha(PROMPT), promptChars: PROMPT.length, state: 'accepted',
      stages: [{ at: 1, stage: 'accepted', detail: null }], createdAt: 1, updatedAt: 1,
      turnId: null, result: null, error: null }] }));
  const store = new TaskStore(stateDir);
  const task = store.find('dshd-1111111111111111');
  assert.equal(task.state, 'unknown', 'silence must not become proof of non-admission');
  assert.equal(store.activeFor(SID).taskId, 'dshd-1111111111111111');
});

test('T350 a provably unsent reservation is admitted exactly once when retried', async t => {
  const { store, calls, build } = harness(t);
  store.accept({ requestId: RID, sessionId: SID, projectId: '/fixture', prompt: PROMPT });
  const restarted = build(); // the restart that recovers the reservation
  const first = await submit(restarted.server);
  assert.equal(calls.prompt, 1, 'the reservation had never reached the Host, so one prompt is correct');
  assert.equal(first.task.state, 'running');
  assert.ok(first.task.stages.some((row) => row.stage === 'reservation_reused'));
  const again = await submit(restarted.server);
  assert.equal(again.duplicate, true);
  assert.equal(calls.prompt, 1, 'a second prompt after acceptance would be a real duplicate');
});

test('T350 the same request with a different payload is refused, and nothing is sent', async t => {
  const { server, calls } = harness(t);
  await submit(server);
  await assert.rejects(submit(server, { prompt: 'a different instruction' }), { code: 'request_conflict' });
  assert.equal(calls.prompt, 1);
});

test('T350 concurrent submissions of one request reach the Host once', async t => {
  const { server, calls } = harness(t);
  const results = await Promise.allSettled([submit(server), submit(server)]);
  const rejected = results.filter((row) => row.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'direct_writer_held');
  assert.equal(calls.prompt, 1);
});

test('T350 a Host that never answers leaves an unsettled task, not a retry', async t => {
  const { server, calls, build } = harness(t, { promptThrows: true });
  const result = await submit(server);
  assert.equal(result.ok, false);
  assert.equal(result.requiresReconcile, true);
  assert.equal(result.task.state, 'unsettled');
  const restarted = build();
  const task = restarted.store.tasks[0];
  assert.equal(task.state, 'unsettled');
  assert.equal(task.stages.at(-1).stage, 'unsettled_across_restart');
  assert.notEqual(restarted.store.activeFor(SID), null);
  assert.equal(calls.prompt, 1);
});
