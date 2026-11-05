// T259: ONLY temporary Git repos, fictional credentials, and an in-process mock MCP server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync,
  realpathSync, unlinkSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpbAdapter, gitPreflightEnvironment } from './tools/continuation/mcpb_adapter.mjs';

const TOKEN = 'fixture-token-AAAAAAAAAAAAAAAA';
const PROJECT = 'project-11111111-1111-4111-8111-111111111111';
const SESSION = 'session-22222222-2222-4222-8222-222222222222';
const INSTALL = 'installation-fixture';
const TASK = (n = 1) => `tsk-11111111-1111-4111-8111-11111111111${n}`;
const INPUT = { clientRequestId: 'fixture-request-1', prompt: '修改代码\n保留既有改动', acceptanceCriteria: ['offline only'] };
const props = ['prompt', 'project_id', 'provider_id', 'installation_id', 'thread_id', 'client_request_id', 'acceptance_criteria'];
const tool = (name, mode = '') => {
  const fields = name === 'submit_task' ? props : (mode === 'get-criteria' ? ['task_id', 'acceptance_criteria'] : ['task_id']);
  const required = name === 'submit_task' ? (mode === 'require-criteria' ? ['prompt', 'acceptance_criteria'] : ['prompt'])
    : (mode === 'get-criteria' ? ['task_id', 'acceptance_criteria'] : ['task_id']);
  return { name, inputSchema: { type: 'object', required,
    properties: Object.fromEntries(fields.map((key) => [key, key === 'acceptance_criteria'
      ? { type: 'array', items: { type: 'string' } } : { type: 'string' }])) } };
};

async function fixture(t, mode = '', hook = null) {
  const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mcpb-fixture-')));
  const root = path.join(temp, 'repo'), state = path.join(temp, 'private-journal');
  mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(root, 'source.txt'), 'baseline\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  const f = { root, state, git, requests: [], now: 12345678, journal: () => JSON.parse(readFileSync(path.join(state, 'mcpb-intents.json'), 'utf8')) };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const packet = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    f.requests.push({ packet, headers: req.headers, url: req.url });
    if (packet.method === 'tools/call') {
      const schema = tool(packet.params.name, mode).inputSchema, args = packet.params.arguments;
      const invalid = schema.required.some((key) => !Object.hasOwn(args, key))
        || Object.entries(args).some(([key, value]) => !schema.properties[key]
          || (schema.properties[key].type === 'array' ? !Array.isArray(value) : typeof value !== 'string'));
      if (invalid) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: packet.id, error: { code: -32602, message: 'fixture schema mismatch' } })); return;
      }
    }
    if (hook && await hook(f, packet, req, res)) return;
    let result;
    if (mode === 'redirect') { res.writeHead(302, { location: f.options.env.CODEX_BRIDGE_MCP_URL }); res.end(); return; }
    if (packet.method === 'initialize') {
      res.setHeader('Mcp-Session-Id', 'mcp-fixture-connection');
      result = { protocolVersion: mode === 'version' ? 'unsupported' : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '0' } };
    } else if (packet.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    else if (packet.method === 'tools/list') result = { tools: mode === 'no-tool' ? [] : [tool('submit_task', mode), tool('get_task', mode)] };
    else if (packet.params.name === 'submit_task') {
      const count = f.requests.filter((r) => r.packet.params?.name === 'submit_task').length;
      f.writeAheadPhase = f.journal().jobs.at(-1).phase;
      if (mode === 'disconnect') { res.destroy(); return; }
      if (mode === 'timeout') return; // intentionally no response; client deadline closes the temporary socket
      result = { structuredContent: { receipt_type: 'provider_task', task_id: TASK(count),
        status: (mode === 'active' || mode === 'get-criteria') ? 'running' : 'completed', reused_existing_task: false,
        local_approval_required: false, wait_policy: {} }, content: [] };
      if (mode === 'bad-receipt') result.structuredContent.task_id = TOKEN;
      if (mode === 'reused') result.structuredContent.reused_existing_task = true;
      if (mode === 'missing-flags') delete result.structuredContent.local_approval_required;
      if (mode === 'tool-error') result = { isError: true, content: [{ type: 'text', text: TOKEN }] };
      if (mode === 'text') result = { content: [{ type: 'text', text: JSON.stringify(result.structuredContent) }] };
    } else {
      result = { structuredContent: { task: { task_id: packet.params.arguments.task_id,
        project_id: PROJECT, provider_id: 'deepseek-harness-desktop', provider_session_id: SESSION,
        installation_id: INSTALL, status: 'completed' } }, content: [] };
    }
    const envelope = { jsonrpc: '2.0', id: packet.id, result };
    if (mode === 'wrong-id') envelope.id = 'wrong';
    if (mode === 'rpc-error') { delete envelope.result; envelope.error = { code: -32000, message: TOKEN }; }
    if (mode === 'oversize') result.padding = 'x'.repeat(300000);
    if (mode.startsWith('sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const eol = mode === 'sse' ? '\r\n' : '\r';
      const bytes = Buffer.from('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"note":"模拟文本"}}' + eol + eol
        + `data: ${JSON.stringify(envelope)}${eol}${eol}`);
      const cut = bytes.indexOf(Buffer.from('模')) + 1;
      res.write(bytes.subarray(0, cut)); setImmediate(() => {
        if (mode === 'sse-cr-open') res.write(bytes.subarray(cut)); else res.end(bytes.subarray(cut));
      });
    } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(envelope)); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  f.options = { enabled: true, projectId: PROJECT, installationId: INSTALL, sessionId: SESSION,
    workspaceRoot: root, stateDir: state, env: { CODEX_BRIDGE_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp`, CODEX_BRIDGE_MCP_TOKEN: TOKEN },
    grant: { kind: 'continuation', projectId: PROJECT, installationId: INSTALL, sessionId: SESSION,
      workspaceRoot: root, approvedAt: 10000000, expiresAt: 20000000, maxTasks: 3 }, now: () => f.now,
    readTimeoutMs: 2000, submitTimeoutMs: mode === 'timeout' ? 100 : 2000 };
  f.client = (changes = {}) => createMcpbAdapter({ ...f.options, ...changes });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); });
  return f;
}

await test('Git child environment removes only explicit MCP credential inputs, including case variants', () => {
  const fake = { PATH: 'fixture-path', CODEX_BRIDGE_MCP_TOKEN: TOKEN, codex_bridge_mcp_token: TOKEN,
    CODEX_BRIDGE_MCP_URL: 'http://fixture.invalid/mcp', codex_bridge_mcp_url: 'fixture', GIT_OPTIONAL_LOCKS: '1' };
  assert.deepEqual(gitPreflightEnvironment(fake), { PATH: 'fixture-path', GIT_OPTIONAL_LOCKS: '0' });
  assert.equal(fake.CODEX_BRIDGE_MCP_TOKEN, TOKEN);
});

await test('default disabled and missing grant do not read credentials or touch files', async () => {
  const env = new Proxy({}, { get() { throw new Error('credential read forbidden'); } });
  assert.equal((await createMcpbAdapter({ env }).submitTask(INPUT)).code, 'disabled');
  assert.equal((await createMcpbAdapter({ enabled: true, env }).submitTask(INPUT)).code, 'not_authorised');
  assert.equal(createMcpbAdapter().status().enabled, false);
});

for (const [name, change, code] of [
  ['wrong project', (f) => ({ projectId: 'different' }), 'not_authorised'],
  ['wrong session', () => ({ sessionId: 'different' }), 'not_authorised'],
  ['wrong installation', () => ({ installationId: 'different' }), 'not_authorised'],
  ['notice grant', (f) => ({ grant: { ...f.options.grant, kind: 'page_notice' } }), 'not_authorised'],
  ['late approval', (f) => ({ grant: { ...f.options.grant, approvedAt: f.now } }), 'not_authorised'],
  ['expired grant', (f) => ({ grant: { ...f.options.grant, expiresAt: f.now } }), 'not_authorised'],
  ['unknown clock', () => ({ now: () => NaN }), 'not_authorised'],
  ['limit four', (f) => ({ grant: { ...f.options.grant, maxTasks: 4 } }), 'not_authorised'],
  ['unbounded timeout', () => ({ submitTimeoutMs: 15001 }), 'configuration_invalid'],
  ['missing token', (f) => ({ env: { CODEX_BRIDGE_MCP_URL: f.options.env.CODEX_BRIDGE_MCP_URL } }), 'credentials_missing'],
  ['inside workspace journal', (f) => ({ stateDir: path.join(f.root, 'journal') }), 'journal_inside_workspace'],
]) await test(name + ' refuses before networking', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.client(change(f)).submitTask(INPUT)).code, code);
  assert.equal(f.requests.length, 0);
});

for (const url of ['http://example.invalid/mcp', 'http://localhost/mcp', 'http://127.0.0.1/tasks',
  'http://user:pass@127.0.0.1/mcp', 'http://127.0.0.1/mcp?key=fixture', 'http://127.0.0.1/mcp#fixture', 'ftp://127.0.0.1/mcp'])
  await test('reject endpoint ' + url, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.client({ env: { ...f.options.env, CODEX_BRIDGE_MCP_URL: url } }).submitTask(INPUT)).code, 'configuration_invalid');
    assert.equal(f.requests.length, 0);
  });

await test('real JSON POST framing, fixed binding, write-ahead, durable idempotence and total three', async (t) => {
  const f = await fixture(t);
  const result = await f.client().submitTask(INPUT);
  assert.deepEqual(result, { ok: true, code: null, taskId: TASK(), status: 'completed' });
  assert.equal(f.writeAheadPhase, 'unknown');
  assert.deepEqual(f.requests.map((r) => r.packet.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  const sent = f.requests.at(-1);
  assert.equal(sent.headers['x-codex-bridge-token'], TOKEN);
  assert.equal(sent.headers['mcp-session-id'], 'mcp-fixture-connection');
  assert.notEqual(sent.headers['mcp-session-id'], SESSION);
  assert.equal(sent.headers['mcp-protocol-version'], '2025-03-26');
  assert.equal(sent.headers.accept, 'application/json, text/event-stream');
  assert.deepEqual(sent.packet.params, { name: 'submit_task', arguments: { project_id: PROJECT,
    provider_id: 'deepseek-harness-desktop', installation_id: INSTALL, thread_id: SESSION,
    client_request_id: INPUT.clientRequestId, prompt: INPUT.prompt, acceptance_criteria: INPUT.acceptanceCriteria } });
  assert.equal(JSON.stringify(sent.packet).includes(TOKEN), false);
  assert.deepEqual(await f.client().submitTask(INPUT), result); // new instance, same persisted intent
  assert.equal(f.requests.length, 4);
  assert.equal((await f.client().submitTask({ ...INPUT, prompt: 'different' })).code, 'idempotency_conflict');
  for (let n = 2; n <= 3; n++) assert.equal((await f.client().submitTask({ ...INPUT, clientRequestId: `fixture-request-${n}` })).ok, true);
  assert.equal((await f.client().submitTask({ ...INPUT, clientRequestId: 'fixture-request-4' })).code, 'task_limit');
  assert.equal(f.requests.length, 12);
  const disk = readFileSync(path.join(f.state, 'mcpb-intents.json'), 'utf8');
  assert.equal(disk.includes(TOKEN), false); assert.equal(disk.includes(INPUT.prompt), false);
  assert.equal(f.journal().jobs.length, 3);
});

await test('caller mutation during handshake cannot change the hashed intent packet', async (t) => {
  const criteria = ['original'];
  const f = await fixture(t, '', (f, packet) => { if (packet.method === 'tools/list') criteria.push('changed'); return false; });
  assert.equal((await f.client().submitTask({ ...INPUT, acceptanceCriteria: criteria })).ok, true);
  assert.deepEqual(f.requests.at(-1).packet.params.arguments.acceptance_criteria, ['original']);
});

await test('required empty criteria is sent as an array and accepted by validating mock', async (t) => {
  const f = await fixture(t, 'require-criteria');
  assert.equal((await f.client().submitTask({ clientRequestId: 'fixture-empty', prompt: 'fixture' })).ok, true);
  assert.deepEqual(f.requests.at(-1).packet.params.arguments.acceptance_criteria, []);
});
await test('unsupported get_task required criteria refuses before any get_task packet', async (t) => {
  const f = await fixture(t, 'get-criteria'); await f.client().submitTask(INPUT);
  assert.equal((await f.client().getTask(TASK())).code, 'unknown_outcome');
  assert.equal(f.requests.some((r) => r.packet.params?.name === 'get_task'), false);
});

for (const mode of ['sse', 'sse-cr', 'sse-cr-open', 'text']) await test(mode + ' standard response supported', async (t) => {
  const f = await fixture(t, mode); assert.equal((await f.client().submitTask(INPUT)).ok, true);
});
for (const [mode, code] of [['redirect', 'transport_error'], ['wrong-id', 'protocol_invalid'],
  ['version', 'protocol_unsupported'], ['rpc-error', 'rpc_error'], ['no-tool', 'capability_unverified'], ['oversize', 'response_limit']])
  await test(mode + ' handshake has no submit and no secret echo', async (t) => {
    const f = await fixture(t, mode); const result = await f.client().submitTask(INPUT);
    assert.equal(result.code, code); assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.equal(f.requests.some((r) => r.packet.params?.name === 'submit_task'), false);
    assert.equal(f.journal().jobs.length, 0);
    if (mode === 'redirect') assert.equal(f.requests.length, 1);
  });

for (const mode of ['disconnect', 'timeout', 'bad-receipt', 'tool-error', 'reused', 'missing-flags'])
  await test(mode + ' submit becomes sticky unknown across restart, with zero resend', async (t) => {
    const f = await fixture(t, mode); const result = await f.client().submitTask(INPUT);
    assert.equal(result.code, 'unknown_outcome'); assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.equal(f.journal().jobs[0].phase, 'unknown');
    const count = f.requests.length;
    assert.equal((await f.client().submitTask(INPUT)).code, 'unknown_outcome');
    assert.equal((await f.client().submitTask({ ...INPUT, clientRequestId: 'fixture-other' })).code, 'unknown_outcome');
    assert.equal(f.requests.length, count);
    assert.equal(f.requests.filter((r) => r.packet.params?.name === 'submit_task').length, 1);
  });

await test('dirty initial repository blocks networking without discarding changes', async (t) => {
  const f = await fixture(t); writeFileSync(path.join(f.root, 'source.txt'), 'operator changes');
  assert.equal((await f.client().submitTask(INPUT)).code, 'dirty_workspace');
  assert.equal(f.requests.length, 0); assert.equal(readFileSync(path.join(f.root, 'source.txt'), 'utf8'), 'operator changes');
});
await test('dirty during handshake blocks submit and preserves untracked edits', async (t) => {
  const f = await fixture(t, '', (f, packet) => { if (packet.method === 'tools/list') writeFileSync(path.join(f.root, 'new.txt'), 'preserve'); return false; });
  assert.equal((await f.client().submitTask(INPUT)).code, 'dirty_workspace');
  assert.equal(f.requests.length, 3); assert.equal(f.journal().jobs.length, 0);
  assert.equal(readFileSync(path.join(f.root, 'new.txt'), 'utf8'), 'preserve');
});
await test('grant expiry during handshake blocks submit', async (t) => {
  const f = await fixture(t, '', (f, packet) => { if (packet.method === 'tools/list') f.now = 20000001; return false; });
  assert.equal((await f.client().submitTask(INPUT)).code, 'not_authorised'); assert.equal(f.requests.length, 3);
});
for (const checkpoint of [3, 4]) await test('expiry at final authorization checkpoint ' + checkpoint + ' sends no submit', async (t) => {
  const f = await fixture(t); let reads = 0;
  const client = f.client({ now: () => ++reads >= checkpoint ? 20000001 : f.now });
  assert.equal((await client.submitTask(INPUT)).code, 'not_authorised');
  assert.equal(f.requests.length, 3);
  assert.equal(f.journal().jobs.length, checkpoint === 4 ? 1 : 0);
  if (checkpoint === 4) assert.equal(f.journal().jobs[0].phase, 'unknown');
});

await test('one active task, owned exact get_task, and terminal release', async (t) => {
  const f = await fixture(t, 'active'); assert.equal((await f.client().submitTask(INPUT)).status, 'running');
  assert.equal((await f.client().submitTask({ ...INPUT, clientRequestId: 'fixture-other' })).code, 'active_task');
  assert.equal((await f.client().getTask(TASK(3))).code, 'task_not_owned');
  assert.equal((await f.client().getTask(TASK())).status, 'completed');
  assert.equal(f.requests.at(-1).packet.params.name, 'get_task');
  assert.deepEqual(f.requests.at(-1).packet.params.arguments, { task_id: TASK() });
  assert.equal((await f.client().submitTask({ ...INPUT, clientRequestId: 'fixture-other' })).ok, true);
});
await test('missing/mismatched terminal binding does not release the active slot', async (t) => {
  const f = await fixture(t, 'active', (f, packet, req, res) => {
    if (packet.params?.name !== 'get_task') return false;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: packet.id, result: { structuredContent: { task: { task_id: TASK(), status: 'completed' } } } })); return true;
  });
  await f.client().submitTask(INPUT);
  assert.equal((await f.client().getTask(TASK())).code, 'unknown_outcome');
  assert.equal((await f.client().submitTask({ ...INPUT, clientRequestId: 'fixture-other' })).code, 'unknown_outcome');
});
await test('deleted/corrupt journal is never reinitialized', async (t) => {
  const f = await fixture(t); await f.client().submitTask(INPUT);
  const file = path.join(f.state, 'mcpb-intents.json'); unlinkSync(file);
  assert.equal((await f.client().submitTask(INPUT)).code, 'journal_invalid'); assert.equal(existsSync(file), false);
  writeFileSync(file, '{broken');
  assert.equal((await f.client().submitTask(INPUT)).code, 'journal_invalid');
  assert.equal(readFileSync(file, 'utf8'), '{broken'); assert.equal(f.requests.length, 4);
});
await test('journal binding change refuses instead of resetting quota', async (t) => {
  const f = await fixture(t); await f.client().submitTask(INPUT);
  const changes = { sessionId: 'session-33333333-3333-4333-8333-333333333333', grant: { ...f.options.grant, sessionId: 'session-33333333-3333-4333-8333-333333333333' } };
  assert.equal((await f.client(changes).submitTask(INPUT)).code, 'journal_invalid'); assert.equal(f.requests.length, 4);
});
await test('directory lock stops second instance and never removes stale contents', async (t) => {
  let arrived, release; const received = new Promise((r) => { arrived = r; }); const gate = new Promise((r) => { release = r; });
  const f = await fixture(t, '', async (f, packet) => { if (packet.params?.name === 'submit_task') { arrived(); await gate; } return false; });
  const first = f.client(), pending = first.submitTask(INPUT); await received;
  assert.equal((await first.submitTask(INPUT)).code, 'busy');
  assert.equal((await f.client().submitTask(INPUT)).code, 'journal_busy');
  release(); assert.equal((await pending).ok, true);
  mkdirSync(path.join(f.state, '.mcpb-lock')); writeFileSync(path.join(f.state, '.mcpb-lock', 'preserve.txt'), 'owner');
  assert.equal((await f.client().submitTask(INPUT)).code, 'journal_busy');
  assert.equal(readFileSync(path.join(f.state, '.mcpb-lock', 'preserve.txt'), 'utf8'), 'owner');
});
await test('journal symlink into repo is refused', async (t) => {
  const f = await fixture(t); symlinkSync(f.root, f.state, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.client().submitTask(INPUT)).code, 'journal_inside_workspace'); assert.equal(f.requests.length, 0);
});
