// T285: recovery is history-only; missing Host descriptors must not kill stdio discovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { DirectServer } from './tools/dsh-direct/mcp_server.mjs';
import { TaskStore } from './tools/dsh-direct/store.mjs';
import { createFakeHost } from './tools/dsh-direct/adapters.mjs';
import { startHostBridge } from './tools/dsh-direct/host_bridge.mjs';
import { HostClient } from './tools/dsh-direct/host_client.mjs';
import { writeEndpointFile, buildEndpoint } from './tools/dsh-direct/endpoint.mjs';

const SID = 'session-11111111-2222-4333-8444-555566667777';
const RID = 't285-offline-restart-001';
const ENTRY = fileURLToPath(new URL('./tools/dsh-direct/mcp_server.mjs', import.meta.url));
function recovery(t, prior = 'running') {
  const dir = mkdtempSync(path.join(tmpdir(), 't285-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = new TaskStore(dir);
  const task = original.accept({ requestId: RID, sessionId: SID, prompt: 'offline only' }).task;
  original.transition(task.taskId, prior);
  const seen = { reads: 0, prompts: 0, admission: true, terminal: 'completed', turnId: '7', down: false };
  const client = {
    kind: 'offline_fake',
    listSessions: async () => [{ sessionId: SID, cwd: '/synthetic', running: false, agentAvailable: true }],
    prompt: async () => { seen.prompts++; throw new Error('recovery must never prompt'); },
    getEvents: async ({ sessionId, requestId }) => {
      assert.equal(sessionId, SID); assert.equal(requestId, RID);
      seen.reads++;
      if (seen.down) throw new Error('offline transport unavailable');
      return { events: [], cursor: 9, admission: { found: seen.admission, seq: 2 }, turnId: seen.turnId,
        terminal: seen.terminal ? { kind: seen.terminal, seq: 9 } : null,
        done: seen.terminal === 'completed', assistantText: 'OFFLINE-OK' };
    },
  };
  const config = { stateDir: dir, boundSessionIds: [SID], boundCwds: [], maxPolls: 1 };
  const server = new DirectServer(config, { client });
  return { taskId: task.taskId, server, seen, config, client };
}

test('T285: restarted admitted task reads durable terminal without resending', async (t) => {
  const f = recovery(t);
  assert.equal(f.server.getTask({ taskId: f.taskId }).task.state, 'unknown');
  assert.equal(f.seen.reads, 0, 'get_task stays a ledger-only read');
  const result = await f.server.getResult({ taskId: f.taskId });
  assert.equal(result.task.state, 'succeeded');
  assert.equal(result.task.result.text, 'OFFLINE-OK');
  assert.equal(result.task.unknownReason, null);
  assert.equal(f.seen.reads, 1);
  assert.equal(f.seen.prompts, 0);
  const again = new DirectServer(f.config, { client: f.client });
  assert.equal((await again.getResult({ taskId: f.taskId })).task.state, 'succeeded');
  assert.equal(f.seen.reads, 1, 'collected terminal survives another restart');
});

test('T285: unknown retains its session lock and needs exact admission plus terminal', async (t) => {
  // T350 changed what a pre-prompt row recovers to, so this case must start from a state
  // where a prompt call really was attempted: `running` in the ledger, which a restart
  // turns into `unknown`/`process_restart`. The rejected-prompt variant is covered below.
  const f = recovery(t, 'running');
  assert.equal(f.server.store.activeFor(SID)?.taskId, f.taskId);
  await assert.rejects(f.server.submitTask({ requestId: 't285-other-offline', sessionId: SID, prompt: 'other' }),
    { code: 'session_busy' });
  f.seen.admission = false;
  await assert.rejects(f.server.getResult({ taskId: f.taskId }), { code: 'task_not_finished' });
  f.seen.admission = true; f.seen.terminal = null;
  await assert.rejects(f.server.getResult({ taskId: f.taskId }), { code: 'task_not_finished' });
  assert.equal(f.server.store.find(f.taskId).state, 'unknown');
  assert.equal(f.server.store.activeFor(SID)?.taskId, f.taskId);
  await assert.rejects(f.server.reconcileTask({ taskId: f.taskId, prompt: 'offline only' }),
    { code: 'not_reconcilable' });
  f.seen.terminal = 'completed';
  assert.equal((await f.server.getResult({ taskId: f.taskId })).task.state, 'succeeded');
  assert.equal(f.server.store.activeFor(SID), null);
  assert.equal(f.seen.prompts, 0);
});

test('T285: a reservation that never reached the Host recovers as reserved, not unknown', async (t) => {
  // T350 made the pre-prompt window provable: `accept()` writes its reservation durably
  // before `#admit` can call the Host, and `#admit` stages `host_prompt_sent` durably before
  // that call. A marker without a prompt stage means nothing was submitted, so the session
  // must be released rather than locked forever behind an unreconcilable `unknown`.
  const f = recovery(t, 'accepted');
  assert.equal(f.server.store.find(f.taskId).state, 'reserved');
  assert.equal(f.server.store.activeFor(SID), null);
  assert.equal(f.server.getTask({ taskId: f.taskId }).task.state, 'reserved');
  assert.equal(f.seen.prompts, 0);
  assert.equal(f.seen.reads, 0);
});

test('T285: failed read preserves unknown and the next exact aborted terminal settles failure', async (t) => {
  const f = recovery(t);
  f.seen.down = true;
  await assert.rejects(f.server.getResult({ taskId: f.taskId }), /offline transport unavailable/);
  assert.equal(f.server.store.find(f.taskId).state, 'unknown');
  assert.equal(f.server.store.activeFor(SID)?.taskId, f.taskId);
  f.seen.down = false; f.seen.terminal = 'aborted';
  const result = await f.server.getResult({ taskId: f.taskId });
  assert.equal(result.task.state, 'failed');
  assert.equal(result.task.error.reason, 'aborted');
  assert.equal(result.task.unknownReason, null);
  assert.equal(f.seen.prompts, 0);
});

test('T285: uncorrelated turn ids never settle recovered success or failure', async (t) => {
  const f = recovery(t);
  f.seen.turnId = null;
  for (const terminal of ['completed', 'aborted']) {
    f.seen.terminal = terminal;
    await assert.rejects(f.server.getResult({ taskId: f.taskId }), { code: 'task_not_finished' });
    assert.equal(f.server.store.activeFor(SID)?.taskId, f.taskId);
  }
  assert.equal(f.seen.prompts, 0);
  const reopened = new TaskStore(f.config.stateDir);
  assert.equal(reopened.find(f.taskId).stages.filter((s) => s.stage === 'recovered_as_unknown').length, 1);
});

test('T285: missing descriptor exception never hides invalid locator, JSON or identity', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 't285-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const endpointFile = path.join(dir, 'endpoint.json');
  const tokenFile = path.join(dir, 'fixture.token');
  const token = 'x'.repeat(48);
  writeFileSync(tokenFile, token);
  assert.throws(() => new HostClient({ baseUrl: 'http://127.0.0.1:42731', endpointFile, tokenFile }),
    { code: 'invalid_arguments' });
  const client = new HostClient({ endpointFile, tokenFile, expectKind: 'offline_fake' });
  await assert.rejects(client.listSessions(), { code: 'host_unreachable' });
  writeFileSync(endpointFile, '{ invalid');
  assert.throws(() => new HostClient({ endpointFile, tokenFile }), { code: 'invalid_arguments' });
  const fake = createFakeHost({ sessions: [{ sessionId: SID, cwd: dir }] });
  const bridge = await startHostBridge({ adapter: fake, token });
  t.after(() => bridge.close());
  writeEndpointFile(endpointFile, buildEndpoint({ port: bridge.port, kind: 'offline_fake',
    protocol: 'dsh-api-session-controller@0.2.0-rc.2' }));
  await assert.rejects(client.listSessions(), { code: 'host_identity_mismatch' });
  assert.equal(client.verified, false);
  assert.equal(fake.control.admissions().length, 0);
});

test('T285: stdio survives missing endpoint, repeated initialize and later fake Host bind', { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 't285-stdio-'));
  const endpointFile = path.join(dir, 'endpoint.json');
  const tokenFile = path.join(dir, 'fixture.token');
  const config = path.join(dir, 'config.json');
  const token = 'x'.repeat(48);
  writeFileSync(tokenFile, token);
  writeFileSync(config, JSON.stringify({ endpointFile, tokenFile, stateDir: path.join(dir, 'ledger'),
    boundSessionIds: [SID], maxPolls: 1, expectKind: 'offline_fake' }));
  const child = spawn(process.execPath, [ENTRY, '--config', config], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let stderr = ''; let serial = 0; let bridge;
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.resolve(message);
  });
  child.on('exit', (code) => {
    for (const value of pending.values()) value.reject(new Error('stdio exited ' + code + ': ' + stderr));
  });
  child.on('error', (error) => {
    for (const value of pending.values()) value.reject(error);
  });
  t.after(async () => {
    let timer;
    try {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await Promise.race([exited, new Promise((resolve, reject) => {
          timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture child stop timed out')); }, 3000);
        })]);
      }
    } finally {
      clearTimeout(timer);
      lines.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (bridge) await bridge.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  async function rpc(method, params) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('stdio timeout: ' + stderr)); }, 3000);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); pending.delete(id); resolve(v); },
        reject: (e) => { clearTimeout(timer); pending.delete(id); reject(e); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  const first = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  assert.equal(first.result.serverInfo.name, 'dsh-direct');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.equal((await rpc('tools/list')).result.tools.length, 5);
  const missing = await rpc('tools/call', { name: 'list_sessions', arguments: {} });
  assert.equal(missing.result.isError, true);
  assert.equal(missing.result.structuredContent.code, 'host_unreachable');
  assert.deepEqual((await rpc('ping')).result, {});
  const second = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.equal(second.result.protocolVersion, '2024-11-05');
  const fake = createFakeHost({ sessions: [{ sessionId: SID, cwd: dir }] });
  bridge = await startHostBridge({ adapter: fake, token, endpointFile });
  const listed = await rpc('tools/call', { name: 'list_sessions', arguments: {} });
  assert.equal(listed.result.isError, false);
  assert.equal(listed.result.structuredContent.sessions[0].sessionId, SID);
  assert.equal(fake.control.admissions().length, 0);
  await bridge.close(); bridge = null;
  const down = await rpc('tools/call', { name: 'list_sessions', arguments: {} });
  assert.equal(down.result.structuredContent.code, 'host_unreachable');
  assert.deepEqual((await rpc('ping')).result, {});
});
