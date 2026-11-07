// T275: strict MCP Streamable HTTP interoperability, and the "unknown means unknown" rule for a timed-out submit.
//
// Every test drives the real chain over a real socket: a labelled fake Host controller -> the real `startHostBridge` ->
// the real `DirectServer` -> the real listening transport. Nothing here is a mock of our own transport: what is checked
// is what a client would see.
//
// The fake Host calls itself `offline_fake` (`/health`, every tool result). No assertion below is evidence that a real
// DSH Desktop is connected: this is acceptance level A.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFakeHost, createSessionControllerAdapter } from './tools/dsh-direct/adapters.mjs';
import { startHostBridge } from './tools/dsh-direct/host_bridge.mjs';
import { DirectServer, loadConfig } from './tools/dsh-direct/mcp_server.mjs';
import { isJsonContentType, negotiateProtocolVersion, startHttpTransport } from './tools/dsh-direct/http_transport.mjs';
import { SUPPORTED_HTTP_PROTOCOL_VERSIONS, SUPPORTED_PROTOCOL_VERSIONS } from './tools/dsh-direct/protocol.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SESSION = 'session-11111111-2222-4333-8444-555566667777';
const HTTP_TOKEN = 't275-http-' + 'a'.repeat(48);
const HOST_TOKEN = 't275-host-' + 'b'.repeat(48);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pickPort = async (avoid) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const server = createServer();
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    await new Promise((resolve) => server.close(resolve));
    if (port !== avoid) return port;
  }
  throw new Error('could not pick a port');
};

/** One deployment: fake Host, bridge, one DirectServer, one listening transport. */
async function scene(t, { http = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 't275-'));
  const hostTokenFile = path.join(dir, 'host.token');
  const httpTokenFile = path.join(dir, 'http.token');
  const endpointFile = path.join(dir, 'endpoint.json');
  writeFileSync(hostTokenFile, HOST_TOKEN + '\n');
  writeFileSync(httpTokenFile, HTTP_TOKEN + '\n');
  const controller = createFakeHost({ sessions: [{ sessionId: SESSION, cwd: '/work/alpha' }] });
  const bridge = await startHostBridge({
    adapter: createSessionControllerAdapter(controller, { kind: 'offline_fake' }),
    token: HOST_TOKEN, endpointFile,
  });
  const port = await pickPort();
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    endpointFile, tokenFile: hostTokenFile, stateDir: path.join(dir, 'state'),
    boundSessionIds: [SESSION], expectKind: 'offline_fake', maxPolls: 2,
    http: { enabled: true, port, authTokenFile: httpTokenFile, allowedOrigins: [], ...http },
  }, null, 2));
  const config = loadConfig(configPath);
  const direct = new DirectServer(config);
  const transport = await startHttpTransport({ direct, http: config.http });
  t.after(async () => {
    await transport.close();
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { controller, bridge, direct, transport, config, dir };
}

/** One HTTP request against the transport, with the bearer token already attached. */
async function raw(transport, body, headers = {}, method = 'POST') {
  const response = await fetch(transport.base, {
    method,
    headers: { authorization: 'Bearer ' + HTTP_TOKEN, accept: 'application/json',
      ...(body === null ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === null ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

async function open(transport, protocolVersion = '2025-11-25') {
  const response = await raw(transport, { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 't275', version: '1' } } });
  const sessionId = response.headers.get('mcp-session-id');
  if (sessionId) {
    await raw(transport, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sessionId });
  }
  return { status: response.status, body: response.json, sessionId,
    protocolVersion: response.json && response.json.result && response.json.result.protocolVersion };
}

const call = (transport, sessionId, name, args, extra = {}) => raw(transport, {
  jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
{ 'mcp-session-id': sessionId, ...extra });

const payload = (response) => JSON.parse(response.json.result.content[0].text);

test('T275: a body sent with a non-JSON media type is refused 415 and never reaches the Host', async (t) => {
  const sc = await scene(t);
  const { sessionId } = await open(sc.transport);
  const before = sc.controller.control.admissions().length;

  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonx',
    'multipart/form-data; boundary=x', undefined]) {
    const response = await fetch(sc.transport.base, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + HTTP_TOKEN, accept: 'application/json', 'mcp-session-id': sessionId,
        ...(contentType === undefined ? {} : { 'content-type': contentType }) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'submit_task', arguments: { requestId: 'ct-' + String(contentType), sessionId: SESSION,
          prompt: 'must never be sent' } } }),
    });
    const text = await response.text();
    assert.equal(response.status, 415, String(contentType) + ' must be refused');
    assert.match(text, /unsupported_content_type/);
  }
  assert.equal(sc.controller.control.admissions().length, before, 'no prompt for a refused media type');

  // The same body with a JSON media type, parameters included, is what standard clients send and is accepted.
  for (const contentType of ['application/json', 'application/json; charset=utf-8', 'Application/JSON;charset=UTF-8']) {
    const response = await fetch(sc.transport.base, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + HTTP_TOKEN, accept: 'application/json', 'content-type': contentType,
        'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    assert.equal(response.status, 200, contentType + ' must be accepted');
    await response.text();
  }
  assert.equal(isJsonContentType('application/json; charset=utf-8'), true);
  assert.equal(isJsonContentType(''), false);
  assert.equal(isJsonContentType(undefined), false);
});

test('T275: Streamable HTTP never claims 2024-11-05, and stdio keeps it', async (t) => {
  assert.deepEqual([...SUPPORTED_HTTP_PROTOCOL_VERSIONS], ['2025-11-25', '2025-06-18', '2025-03-26']);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes('2024-11-05'), 'the stdio set still speaks the oldest revision');
  assert.deepEqual(negotiateProtocolVersion('2025-03-26'), { version: '2025-03-26', supported: true });
  assert.deepEqual(negotiateProtocolVersion('2024-11-05'), { version: '2025-11-25', supported: false });

  const sc = await scene(t);
  const oldest = await open(sc.transport, '2025-03-26');
  assert.equal(oldest.status, 200);
  assert.equal(oldest.protocolVersion, '2025-03-26', 'a revision this transport has is echoed');

  const preTransport = await open(sc.transport, '2024-11-05');
  assert.equal(preTransport.status, 200);
  assert.equal(preTransport.protocolVersion, '2025-11-25',
    '2024-11-05 predates this transport: the server offers the newest revision it speaks instead of echoing that one');

  const header = await raw(sc.transport, { jsonrpc: '2.0', id: 10, method: 'tools/list' },
    { 'mcp-session-id': oldest.sessionId, 'mcp-protocol-version': '2024-11-05' });
  assert.equal(header.status, 400);
  assert.match(header.text, /2025-03-26/);
});

test('T275: initialize without a string protocolVersion is -32602 and issues no session', async (t) => {
  const sc = await scene(t);
  for (const params of [undefined, null, {}, { protocolVersion: 42 }, { protocolVersion: ['2025-11-25'] }]) {
    const response = await raw(sc.transport, { jsonrpc: '2.0', id: 1, method: 'initialize',
      ...(params === undefined ? {} : { params }) });
    // JSON-RPC protocol errors travel in a 200 body; what matters is the code and that no session was issued.
    assert.equal(response.json.error.code, -32602, JSON.stringify(params) + ' must not negotiate');
    assert.equal(response.headers.get('mcp-session-id'), null, 'no session may be issued');
  }
  assert.equal((await open(sc.transport)).status, 200, 'a well-formed initialize still works');
});

test('T275: tool calls beyond maxConcurrentRequests are 429, and initialize still answers', async (t) => {
  const sc = await scene(t, { http: { maxConcurrentRequests: 2 } });
  const { sessionId } = await open(sc.transport);
  const realList = sc.controller.list.bind(sc.controller);
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  sc.controller.list = async () => { await gate; return realList(); };

  const held = [call(sc.transport, sessionId, 'list_sessions', {}), call(sc.transport, sessionId, 'list_sessions', {})];
  await sleep(150);
  const refused = await call(sc.transport, sessionId, 'list_sessions', {});
  assert.equal(refused.status, 429);
  assert.match(refused.text, /too_many_requests/);
  assert.equal(refused.headers.get('retry-after'), '1');

  // initialize is never rate-limited: a client must be able to recover a session handle.
  assert.equal((await open(sc.transport)).status, 200);

  release();
  const finished = await Promise.all(held);
  assert.deepEqual(finished.map((item) => item.status), [200, 200]);
  sc.controller.list = realList;

  // The counter is released, so the next call is accepted again.
  assert.equal((await call(sc.transport, sessionId, 'list_sessions', {})).status, 200);
});

test('T275: a 504 does not double-dispatch, does not release the lock, and the retried requestId settles it', async (t) => {
  const sc = await scene(t, { http: { requestTimeoutMs: 150 } });
  const { sessionId } = await open(sc.transport);
  const realPrompt = sc.controller.prompt.bind(sc.controller);
  sc.controller.prompt = async (request, signal) => { await sleep(600); return realPrompt(request, signal); };

  const slow = await call(sc.transport, sessionId, 'submit_task',
    { requestId: 't275.504.0001', sessionId: SESSION, prompt: 'slow turn' });
  assert.equal(slow.status, 504, 'the transport answers 504 instead of waiting forever');

  // The first turn is still inside the Host. A second submit with a *different* requestId must not reach it: the
  // session is locked by a task whose outcome the client never saw.
  const parallel = await call(sc.transport, sessionId, 'submit_task',
    { requestId: 't275.504.0002', sessionId: SESSION, prompt: 'second turn' });
  assert.equal(parallel.status, 200);
  const parallelPayload = payload(parallel);
  assert.equal(parallelPayload.ok, false);
  assert.equal(parallelPayload.code, 'session_busy');

  await sleep(900);
  assert.equal(sc.controller.control.admissions().length, 1, 'exactly one prompt reached the Host');

  // Retrying the original requestId reports the real outcome and sends nothing.
  const retry = await call(sc.transport, sessionId, 'submit_task',
    { requestId: 't275.504.0001', sessionId: SESSION, prompt: 'slow turn' });
  assert.equal(retry.status, 200);
  const retryPayload = payload(retry);
  assert.equal(retryPayload.ok, true);
  assert.equal(retryPayload.duplicate, true);
  assert.equal(sc.controller.control.admissions().length, 1, 'the duplicate retry sent nothing');

  // The ledger agrees with the Host.
  const fetched = payload(await call(sc.transport, sessionId, 'get_task', { taskId: retryPayload.task.taskId }));
  assert.equal(fetched.task.taskId, retryPayload.task.taskId);

  // The lock is gone once the turn settled: a fresh requestId is admitted exactly once. The slow wrapper is removed
  // first, because otherwise this third call would hit the transport timeout again and prove nothing about the lock.
  sc.controller.prompt = realPrompt;
  const next = payload(await call(sc.transport, sessionId, 'submit_task',
    { requestId: 't275.504.0003', sessionId: SESSION, prompt: 'third turn' }));
  assert.equal(next.ok, true, JSON.stringify(next.error || {}));
  assert.equal(sc.controller.control.admissions().length, 2);
  sc.controller.prompt = realPrompt;
});

test('T275: a turn the Host fails after the transport timed out does not kill the server or leak the lock', async (t) => {
  const sc = await scene(t, { http: { requestTimeoutMs: 100 } });
  const { sessionId } = await open(sc.transport);
  const realPrompt = sc.controller.prompt.bind(sc.controller);
  sc.controller.prompt = async () => { await sleep(400); throw new Error('host blew up after the timeout'); };
  const crashes = [];
  const onUnhandled = (err) => crashes.push(err);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const timed = await call(sc.transport, sessionId, 'submit_task',
    { requestId: 't275.late.fail.1', sessionId: SESSION, prompt: 'dies late' });
  assert.equal(timed.status, 504);
  await sleep(700);
  assert.deepEqual(crashes, [], 'the abandoned dispatch must not surface as an unhandled rejection');

  // Still serving, and the failure was recorded rather than leaving the session locked forever.
  assert.equal((await call(sc.transport, sessionId, 'list_sessions', {})).status, 200);
  const settled = payload(await call(sc.transport, sessionId, 'submit_task',
    { requestId: 't275.late.fail.1', sessionId: SESSION, prompt: 'dies late' }));
  assert.equal(settled.ok, true);
  assert.equal(settled.duplicate, true);
  assert.match(settled.task.state, /failed|unsettled|succeeded/);
  sc.controller.prompt = realPrompt;
});

test('T275: two concurrent submits with different requestIds admit exactly one prompt', async (t) => {
  const sc = await scene(t);
  const { sessionId } = await open(sc.transport);
  const realPrompt = sc.controller.prompt.bind(sc.controller);
  sc.controller.prompt = async (request, signal) => { await sleep(250); return realPrompt(request, signal); };

  const [first, second] = await Promise.all([
    call(sc.transport, sessionId, 'submit_task', { requestId: 't275.race.aaaa.1', sessionId: SESSION, prompt: 'race a' }),
    call(sc.transport, sessionId, 'submit_task', { requestId: 't275.race.bbbb.2', sessionId: SESSION, prompt: 'race b' }),
  ]);
  const results = [payload(first), payload(second)];
  assert.equal(results.filter((item) => item.ok === true && item.duplicate !== true).length, 1,
    'one of the two wins the session');
  const lost = results.find((item) => item.ok === false);
  assert.equal(lost.code, 'session_busy');
  await sleep(400);
  assert.equal(sc.controller.control.admissions().length, 1);
  sc.controller.prompt = realPrompt;
});

test('T275: session and id edge cases keep their transport status', async (t) => {
  const sc = await scene(t);
  const { sessionId } = await open(sc.transport);

  assert.equal((await raw(sc.transport, { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { 'mcp-session-id': '' })).status, 404, 'an empty session header is not a session');

  const asResponse = await raw(sc.transport, { jsonrpc: '2.0', id: 5, result: { ok: true } },
    { 'mcp-session-id': sessionId });
  assert.equal(asResponse.status, 200);
  assert.equal(asResponse.json.error.code, -32600);

  const nullId = await raw(sc.transport, { jsonrpc: '2.0', id: null, method: 'tools/list' },
    { 'mcp-session-id': sessionId });
  assert.equal(nullId.status, 200);
  assert.equal(nullId.json.id, null, 'id null is a request and is answered');
  assert.ok(Array.isArray(nullId.json.result.tools));

  const notification = await raw(sc.transport, { jsonrpc: '2.0', method: 'notifications/whatever' },
    { 'mcp-session-id': sessionId });
  assert.equal(notification.status, 202);
  assert.equal(notification.text, '', 'notifications are never answered with an error');

  // A second initialize opens a *new* session; the first keeps working and is not rebound.
  const second = await open(sc.transport);
  assert.notEqual(second.sessionId, sessionId);
  assert.equal((await raw(sc.transport, { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { 'mcp-session-id': sessionId })).status, 200);
  assert.equal((await raw(sc.transport, { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { 'mcp-session-id': second.sessionId })).status, 200);

  // Deleting one session leaves the other alone.
  assert.equal((await raw(sc.transport, null, { 'mcp-session-id': second.sessionId }, 'DELETE')).status, 204);
  assert.equal((await raw(sc.transport, { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { 'mcp-session-id': second.sessionId })).status, 404);
  assert.equal((await raw(sc.transport, { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { 'mcp-session-id': sessionId })).status, 200);
});

test('T275: the shipped example documents the concurrency bound and stays disabled', () => {
  const example = JSON.parse(readFileSync(path.join(ROOT, 'tools/dsh-direct/config.example.json'), 'utf8'));
  assert.equal(example.http.enabled, false);
  assert.equal(example.http.maxConcurrentRequests, 8);
  assert.match(example.http.$comment, /maxConcurrentRequests/);
});