// T337 subprocess fixture only: temporary state and a counting fake Host, no network/config/token.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DirectServer } from './mcp_server.mjs';
import { TaskStore } from './store.mjs';
const [mode, dir] = process.argv.slice(2);
const sessionId = 'session-11111111-2222-4333-8444-555566667777';
const requestId = 't337-known-request';
const taskId = 'dshd-1111111122222222';
const input = { sessionId, requestId, projectId: '/fixture', prompt: 'fixture only' };
const send = message => process.send(message);
if (mode === 'owner') {
  let finish;
  const client = {
    listSessions: async () => [{ sessionId, cwd: '/fixture', running: false, agentAvailable: true }],
    prompt: async () => { send({ phase: 'host_entered' }); await new Promise(resolve => { finish = resolve; }); return { accepted: true }; },
    getEvents: async () => ({ events: [], done: true, turnId: '7', cursor: 3,
      admission: { found: true, seq: 1, eventType: 'user/message' }, terminal: { kind: 'completed', seq: 3 }, assistantText: 'fixture' }),
  };
  process.on('message', message => { if (message === 'finish') finish?.(); });
  const server = new DirectServer({ stateDir: dir, boundSessionIds: [sessionId], boundCwds: [], maxPolls: 1 }, { client });
  try {
    const result = await server.submitTask(input);
    send({ phase: 'completed', state: result.task.state, taskId: result.task.taskId });
  } catch (e) { send({ phase: 'error', code: e.code || e.name }); process.exitCode = 2; }
  process.disconnect();
} else if (mode === 'contender') {
  let calls = 0;
  const client = new Proxy({}, { get(_target, key) { if (key === 'kind') return 'fixture'; return async () => { calls++; throw Error('unexpected Host access'); }; } });
  const server = new DirectServer({ stateDir: dir, boundSessionIds: [sessionId], boundCwds: [], maxPolls: 1 }, { client });
  const taskId = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')).tasks[0].taskId;
  const codes = {};
  for (const [name, op] of Object.entries({ submit: () => server.submitTask(input),
    reconcile: () => server.reconcileTask({ taskId, prompt: input.prompt }), getResult: () => server.getResult({ taskId }) })) {
    try { await op(); codes[name] = 'unexpected_success'; } catch (e) { codes[name] = e.code || e.name; }
  }
  const store = new TaskStore(dir);
  for (const [name, op] of Object.entries({ accept: () => store.accept(input), stage: () => store.stage(taskId, 'contender'),
    transition: () => store.transition(taskId, 'failed') })) {
    try { op(); codes[name] = 'unexpected_success'; } catch (e) { codes[name] = e.code || e.name; }
  }
  send({ phase: 'contender', codes, hostCalls: calls }); process.disconnect();
} else if (mode === 'crash') {
  const store = new TaskStore(dir);
  await store.withWriter(async () => {
    store.stage(taskId, 'crash_checkpoint');
    send({ phase: 'crash_ready', taskId });
    // Parent terminates this process after the persisted checkpoint; no cleanup handler.
    await new Promise(() => { setInterval(() => {}, 1000); });
  });
} else {
  send({ phase: 'invalid_mode' }); process.exitCode = 2; process.disconnect();
}
