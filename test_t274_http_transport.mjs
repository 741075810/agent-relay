// T274: the MCP Streamable HTTP transport, driven end to end over a real socket.
//
// Every test here talks HTTP to a listening port; the Host behind it is a real `startHostBridge` process-internal
// listener over the offline fake controller, which reports `kind: 'offline_fake'`. That label is asserted, not assumed:
// nothing in this file is evidence that a real DSH Desktop is connected, and the suite says so where it matters.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFakeHost, createSessionControllerAdapter } from './tools/dsh-direct/adapters.mjs';
import { startHostBridge } from './tools/dsh-direct/host_bridge.mjs';
import { DirectServer, handle, loadConfig } from './tools/dsh-direct/mcp_server.mjs';
import { CODES, DirectError, LATEST_PROTOCOL_VERSION, TOOLS, loadHttpConfig } from './tools/dsh-direct/protocol.mjs';
import { negotiateProtocolVersion, startHttpTransport, tokenMatches } from './tools/dsh-direct/http_transport.mjs';
import { checkDocs } from './tools/dsh-direct/preflight.mjs';

const SESSION = 'session-11111111-2222-4333-8444-555566667777';
const OTHER = 'session-99999999-8888-4777-8666-555544443333';
const HOST_TOKEN = 'host-bridge-token-' + 'h'.repeat(40);
const HTTP_TOKEN = 'http-mcp-token-' + 'c'.repeat(40);
const V = 'MCP-Protocol-Version';
const ROOT = path.dirname(fileURLToPath(import.meta.url));

function temp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A port the kernel says is free. `http.port` cannot be 0: a listener nobody can name is the T273 defect again. */
async function pickPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One full deployment: fake Host controller -> real Host bridge -> real DirectServer -> real HTTP MCP transport.
 * The only simulated part is the DSH controller, and it names itself `offline_fake` on every answer.
 */
async function scene({ allowedOrigins = [], requestTimeoutMs = 5000, maxBodyBytes = 8192, slowListMs = 0 } = {}) {
  const dir = temp('t274-');
  const hostTokenFile = path.join(dir, 'host.token');
  const httpTokenFile = path.join(dir, 'http.token');
  const endpointFile = path.join(dir, 'endpoint.json');
  writeFileSync(hostTokenFile, HOST_TOKEN + '\n', 'utf8');
  writeFileSync(httpTokenFile, HTTP_TOKEN + '\n', 'utf8');

  const controller = createFakeHost({ sessions: [
    { sessionId: SESSION, cwd: '/work/alpha', title: 'alpha' },
    { sessionId: OTHER, cwd: '/work/beta', title: 'beta' },
  ] });
  const countPrompts = controller.control.admissions;
  if (slowListMs) {
    const realList = controller.list.bind(controller);
    controller.list = async () => { await sleep(slowListMs); return realList(); };
  }
  // `kind: 'offline_fake'` is carried all the way to `/health` and into every tool result, so this suite can prove it
  // never talked to a real Desktop: the adapter would otherwise report `cordis_session_controller` like a live Host.
  const bridge = await startHostBridge({ adapter: createSessionControllerAdapter(controller, { kind: 'offline_fake' }),
    token: HOST_TOKEN, endpointFile });

  let transport = null;
  let config = null;
  let direct = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3 && !transport; attempt += 1) {
    const port = await pickPort();
    const configPath = path.join(dir, 'config-' + attempt + '.json');
    writeFileSync(configPath, JSON.stringify({
      endpointFile,
      tokenFile: hostTokenFile,
      stateDir: path.join(dir, 'state'),
      boundSessionIds: [SESSION],
      boundCwds: [],
      expectKind: 'offline_fake',
      maxPolls: 2,
      http: { enabled: true, port, authTokenFile: httpTokenFile, allowedOrigins, maxBodyBytes, requestTimeoutMs },
    }, null, 2) + '\n', 'utf8');
    config = loadConfig(configPath);
    direct = new DirectServer(config);
    try {
      transport = await startHttpTransport({ direct, http: config.http });
    } catch (err) {
      lastError = err;
    }
  }
  if (!transport) {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
    throw lastError || new Error('could not start the transport');
  }

  const call = async (method, { body, sessionId, token = HTTP_TOKEN, origin, accept = 'application/json',
    headers = {}, raw = false } = {}) => {
    const sent = { ...headers, accept };
    if (token !== null) sent.authorization = 'Bearer ' + token;
    if (sessionId) sent['mcp-session-id'] = sessionId;
    if (origin) sent.origin = origin;
    let payload;
    if (body !== undefined) {
      sent['content-type'] = 'application/json';
      payload = raw ? body : JSON.stringify(body);
    }
    const response = await fetch(transport.base, { method, headers: sent, body: payload });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, text, json };
  };

  /** initialize + notifications/initialized, returning the session id. */
  const open = async ({ version = LATEST_PROTOCOL_VERSION, origin } = {}) => {
    const init = await call('POST', { body: { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 't274-client', version: '1.0.0' } } },
    origin });
    assert.equal(init.status, 200, 'initialize must succeed: ' + init.text);
    const sessionId = init.headers.get('mcp-session-id');
    assert.match(String(sessionId), /^[0-9a-f]{32}$/, 'the server must issue an Mcp-Session-Id');
    const ready = await call('POST', { sessionId, origin,
      body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.equal(ready.status, 202);
    return { sessionId, init };
  };

  const tools = async (sessionId, name, args = {}, id = 10, origin) => call('POST', { sessionId, origin,
    headers: { [V]: LATEST_PROTOCOL_VERSION },
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } } });

  return {
    dir, bridge, transport, config, controller, call, open, tools, direct, admissions: countPrompts,
    close: async () => {
      await transport.close();
      await bridge.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('T274: the HTTP transport is off unless config.http.enabled is the boolean true', () => {
  assert.equal(loadHttpConfig(undefined), null);
  assert.equal(loadHttpConfig({}), null);
  assert.equal(loadHttpConfig({ enabled: false, port: 42731 }), null);

  const refused = (block, pattern) => assert.throws(() => loadHttpConfig(block), (err) => {
    assert.ok(err instanceof DirectError);
    assert.equal(err.code, CODES.invalid_arguments);
    assert.match(err.message, pattern);
    return true;
  });
  refused({ enabled: 'true', port: 42731, authTokenFile: 'x' }, /must be the boolean true/);
  refused({ enabled: 1, port: 42731, authTokenFile: 'x' }, /must be the boolean true/);
  refused({ enabled: true, port: 42731 }, /authTokenFile is required/);
  refused({ enabled: true, port: 42731, authTokenFile: 'x', host: '0.0.0.0' }, /must be 127\.0\.0\.1/);
  refused({ enabled: true, port: 42731, authTokenFile: 'x', host: 'localhost' }, /must be 127\.0\.0\.1/);
  refused({ enabled: true, port: 80, authTokenFile: 'x' }, /1024\.\.65535/);
  refused({ enabled: true, port: 0, authTokenFile: 'x' }, /1024\.\.65535/);
  refused({ enabled: true, port: 42731, authTokenFile: 'x', path: 'mcp' }, /must start with/);
  refused({ enabled: true, port: 42731, authTokenFile: 'x', path: '/../mcp' }, /contain no/);
  refused({ enabled: true, port: 42731, authTokenFile: 'x', maxBodyBytes: 99 }, /maxBodyBytes/);
  refused({ enabled: true, port: 42731, authTokenFile: 'x', requestTimeoutMs: 10 }, /requestTimeoutMs/);
  refused({ enabled: true, port: 42731, authTokenFile: 'x', origin: 'http://a' }, /fields this server does not read/);

  const on = loadHttpConfig({ enabled: true, port: 42731, authTokenFile: '/tmp/http.token' });
  assert.equal(on.host, '127.0.0.1', 'the only host this transport will ever bind');
  assert.equal(on.path, '/mcp');
  assert.deepEqual(on.allowedOrigins, [], 'empty by default: every browser Origin is refused until one is named');
  assert.equal(on.maxBodyBytes, 1048576);
  assert.equal(on.requestTimeoutMs, 120000);
});

test('T274: the bearer comparison rejects a wrong token and a non-bearer scheme', () => {
  assert.equal(tokenMatches(HTTP_TOKEN, 'Bearer ' + HTTP_TOKEN), true);
  assert.equal(tokenMatches(HTTP_TOKEN, 'bearer ' + HTTP_TOKEN), true);
  assert.equal(tokenMatches(HTTP_TOKEN, 'Bearer ' + HTTP_TOKEN + 'x'), false);
  assert.equal(tokenMatches(HTTP_TOKEN, HTTP_TOKEN), false);
  assert.equal(tokenMatches(HTTP_TOKEN, undefined), false);
});

test('T274: initialize over a real socket negotiates the revision and issues a session', async () => {
  const sc = await scene();
  try {
    const { init, sessionId } = await sc.open();
    assert.equal(init.json.jsonrpc, '2.0');
    assert.equal(init.json.id, 1);
    assert.equal(init.json.result.protocolVersion, LATEST_PROTOCOL_VERSION);
    assert.equal(init.json.result.serverInfo.name, 'dsh-direct');
    assert.deepEqual(init.json.result.capabilities, { tools: { listChanged: false } });
    assert.match(init.json.result.instructions, /never creates/);
    assert.equal(init.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(sessionId.length, 32);

    // T275 correction: 2024-11-05 has no Streamable HTTP, so echoing it would be a claim that cannot be true. The
    // server answers with the newest revision it actually speaks; the stdio transport still speaks 2024-11-05.
    const old = await sc.open({ version: '2024-11-05' });
    assert.equal(old.init.json.result.protocolVersion, LATEST_PROTOCOL_VERSION,
      'a revision older than this transport is not echoed');
    const supported = await sc.open({ version: '2025-03-26' });
    assert.equal(supported.init.json.result.protocolVersion, '2025-03-26', 'a supported revision is echoed');

    const future = await sc.open({ version: '2026-99-99' });
    assert.equal(future.init.json.result.protocolVersion, LATEST_PROTOCOL_VERSION,
      'an unknown revision is answered with the newest this server speaks');

    assert.deepEqual(negotiateProtocolVersion(undefined), { version: LATEST_PROTOCOL_VERSION, supported: false });
  } finally {
    await sc.close();
  }
});

test('T274: notifications are answered 202 with no body, and tools/list needs a session first', async () => {
  const sc = await scene();
  try {
    const init = await sc.call('POST', { body: { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '1' } } } });
    const sessionId = init.headers.get('mcp-session-id');

    const beforeReady = await sc.call('POST', { sessionId, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    assert.equal(beforeReady.status, 400);
    assert.equal(beforeReady.json.error.data.code, CODES.session_required);

    const notified = await sc.call('POST', { sessionId, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.equal(notified.status, 202);
    assert.equal(notified.text, '', 'a notification gets no body');

    const listed = await sc.call('POST', { sessionId, body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.result.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));

    const noSession = await sc.call('POST', { body: { jsonrpc: '2.0', id: 4, method: 'tools/list' } });
    assert.equal(noSession.status, 400);
    assert.equal(noSession.json.error.data.code, CODES.session_required);

    const bogus = await sc.call('POST', { sessionId: 'f'.repeat(32), body: { jsonrpc: '2.0', id: 5,
      method: 'tools/list' } });
    assert.equal(bogus.status, 404);
    assert.equal(bogus.json.error.data.code, CODES.session_not_found);
  } finally {
    await sc.close();
  }
});

test('T274: an unauthenticated or wrong-origin request is refused before the Host is touched', async () => {
  const sc = await scene({ allowedOrigins: ['http://127.0.0.1:51999'] });
  try {
    const anonymous = await sc.call('POST', { token: null, body: { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION } } });
    assert.equal(anonymous.status, 401);
    assert.match(String(anonymous.headers.get('www-authenticate')), /^Bearer realm="dsh-direct"/);
    assert.equal(anonymous.json.error.data.code, CODES.unauthenticated);

    const wrong = await sc.call('POST', { token: 'nope-' + 'x'.repeat(40), body: { jsonrpc: '2.0', id: 2,
      method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } } });
    assert.equal(wrong.status, 401);

    const foreign = await sc.call('POST', { origin: 'http://evil.example', body: { jsonrpc: '2.0', id: 3,
      method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } } });
    assert.equal(foreign.status, 403, 'DNS rebinding: a page cannot drive the Host');
    assert.equal(foreign.json.error.data.code, CODES.origin_rejected);

    const allowed = await sc.call('POST', { origin: 'http://127.0.0.1:51999', body: { jsonrpc: '2.0', id: 4,
      method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } } });
    assert.equal(allowed.status, 200, 'an origin named in allowedOrigins is accepted');

    assert.deepEqual(sc.admissions(), [], 'no refused request may have reached the Host');
  } finally {
    await sc.close();
  }
});

test('T274: GET is 405, an unknown path is 404, DELETE ends the session', async () => {
  const sc = await scene();
  try {
    const { sessionId } = await sc.open();
    const get = await sc.call('GET', { sessionId });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST, DELETE');
    assert.match(get.json.error.message, /no server-initiated stream/);

    const elsewhere = await fetch(sc.transport.base.replace('/mcp', '/other'), { method: 'POST',
      headers: { authorization: 'Bearer ' + HTTP_TOKEN } });
    assert.equal(elsewhere.status, 404);

    const deleted = await sc.call('DELETE', { sessionId });
    assert.equal(deleted.status, 204);
    const reused = await sc.call('POST', { sessionId, body: { jsonrpc: '2.0', id: 9, method: 'tools/list' } });
    assert.equal(reused.status, 404, 'a terminated session id is not recyclable');

    const deleteAgain = await sc.call('DELETE', { sessionId });
    assert.equal(deleteAgain.status, 404);
  } finally {
    await sc.close();
  }
});

test('T274: malformed, batched and oversized bodies are refused with the transport code that matches', async () => {
  const sc = await scene({ maxBodyBytes: 2048 });
  try {
    const { sessionId } = await sc.open();

    const broken = await sc.call('POST', { sessionId, body: '{not json', raw: true });
    assert.equal(broken.status, 400);
    assert.equal(broken.json.error.code, -32700);

    const batch = await sc.call('POST', { sessionId, body: [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }] });
    assert.equal(batch.status, 400);
    assert.equal(batch.json.error.code, -32600);
    assert.match(batch.json.error.message, /batches/);

    const wrongShape = await sc.call('POST', { sessionId, body: { jsonrpc: '1.0', id: 2, method: 'tools/list' } });
    assert.equal(wrongShape.status, 200);
    assert.equal(wrongShape.json.error.code, -32600);
    assert.match(wrongShape.json.error.message, /jsonrpc must be/);

    const huge = 'x'.repeat(4096);
    const oversized = await sc.call('POST', { sessionId, body: { jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'list_sessions', arguments: { projectId: huge } } } });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.json.error.data.code, CODES.body_too_large);

    const badAccept = await sc.call('POST', { sessionId, accept: 'text/html',
      body: { jsonrpc: '2.0', id: 4, method: 'tools/list' } });
    assert.equal(badAccept.status, 406);
    assert.equal(badAccept.json.error.data.code, CODES.unsupported_accept);

    const badVersion = await sc.call('POST', { sessionId, headers: { [V]: '2026-01-01' },
      body: { jsonrpc: '2.0', id: 5, method: 'tools/list' } });
    assert.equal(badVersion.status, 400);
    assert.equal(badVersion.json.error.data.code, CODES.unsupported_protocol_version);

    // T275: 2024-11-05 has no Streamable HTTP, so this header is refused by the supported set before the
    // session-mismatch check is reached; the refusal names the revisions this transport does speak.
    const preTransport = await sc.call('POST', { sessionId, headers: { [V]: '2024-11-05' },
      body: { jsonrpc: '2.0', id: 6, method: 'tools/list' } });
    assert.equal(preTransport.status, 400);
    assert.equal(preTransport.json.error.data.code, CODES.unsupported_protocol_version);
    assert.deepEqual(preTransport.json.error.data.supported, ['2025-11-25', '2025-06-18', '2025-03-26']);

    const mismatch = await sc.call('POST', { sessionId, headers: { [V]: '2025-06-18' },
      body: { jsonrpc: '2.0', id: 7, method: 'tools/list' } });
    assert.equal(mismatch.status, 400, 'the header must agree with what initialize negotiated');
    assert.equal(mismatch.json.error.data.negotiated, LATEST_PROTOCOL_VERSION);
  } finally {
    await sc.close();
  }
});

test('T274: a client that only accepts text/event-stream gets one SSE event', async () => {
  const sc = await scene();
  try {
    const init = await sc.call('POST', { accept: 'text/event-stream', body: { jsonrpc: '2.0', id: 1,
      method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sse',
        version: '1' } } } });
    assert.equal(init.status, 200);
    assert.match(String(init.headers.get('content-type')), /^text\/event-stream/);
    const dataLine = init.text.split('\n').find((line) => line.startsWith('data: '));
    assert.ok(dataLine, 'the stream must carry the JSON-RPC message in a data line: ' + init.text);
    const message = JSON.parse(dataLine.slice('data: '.length));
    assert.equal(message.jsonrpc, '2.0');
    assert.equal(message.result.protocolVersion, '2025-06-18');
    assert.match(init.text, /^event: message/m, 'the event name is what an MCP SSE client parses');
    assert.equal(init.headers.get('mcp-session-id') !== null, true, 'SSE and JSON frames carry the same headers');
  } finally {
    await sc.close();
  }
});

test('T274: a task submitted over HTTP runs through the real Host bridge and cannot be executed twice', async () => {
  const sc = await scene();
  try {
    const { sessionId } = await sc.open();

    const listed = await sc.tools(sessionId, 'list_sessions');
    assert.equal(listed.status, 200);
    const sessions = listed.json.result.structuredContent;
    assert.equal(sessions.host, 'offline_fake', 'the Host behind this test names itself; it is not a real Desktop');
    assert.equal(listed.json.result.isError, false);
    assert.deepEqual(sessions.sessions.map((row) => row.sessionId), [SESSION],
      'the unbound session must not be listed, let alone reachable');

    const submitted = await sc.tools(sessionId, 'submit_task', { requestId: 't274-http-0001', sessionId: SESSION,
      prompt: 'over http, one turn' });
    const task = submitted.json.result.structuredContent;
    assert.equal(submitted.status, 200);
    assert.equal(task.ok, true, JSON.stringify(task));
    assert.equal(task.task.state, 'succeeded', 'the fake Host answers in one turn');
    assert.equal(task.task.result.text, 'offline fake answer for over http, one turn');
    assert.equal(task.host, 'offline_fake');
    assert.equal(sc.admissions().length, 1, 'exactly one prompt reached the Host');

    const fetched = await sc.tools(sessionId, 'get_result', { taskId: task.task.taskId }, 11);
    assert.equal(fetched.json.result.structuredContent.task.result.text, 'offline fake answer for over http, one turn');

    // The same requestId again: the ledger answers, the Host is not called a second time.
    const duplicate = await sc.tools(sessionId, 'submit_task', { requestId: 't274-http-0001', sessionId: SESSION,
      prompt: 'over http, one turn' }, 12);
    const again = duplicate.json.result.structuredContent;
    assert.equal(again.duplicate, true);
    assert.equal(again.task.taskId, task.task.taskId);
    assert.equal(sc.admissions().length, 1, 'a duplicate requestId must never execute twice');

    // The transport called the real DirectServer: the same task is in the server's own ledger, not in a mock.
    const fromServer = sc.direct.getTask({ taskId: task.task.taskId });
    assert.equal(fromServer.task.taskId, task.task.taskId);

    // A second, independent MCP session sees the same ledger (tasks are per deployment, sessions are per transport).
    const second = await sc.open();
    const sameTask = await sc.tools(second.sessionId, 'get_task', { taskId: task.task.taskId }, 13);
    assert.equal(sameTask.json.result.structuredContent.task.state, 'succeeded');
  } finally {
    await sc.close();
  }
});

test('T274: an unbound or unknown session is refused in-band, with nothing sent to the Host', async () => {
  const sc = await scene();
  try {
    const { sessionId } = await sc.open();

    const unbound = await sc.tools(sessionId, 'submit_task', { requestId: 't274-http-0002', sessionId: OTHER,
      prompt: 'should not arrive' });
    assert.equal(unbound.status, 200, 'a tool-level refusal is a JSON-RPC result, not an HTTP error');
    assert.equal(unbound.json.result.isError, true);
    assert.equal(unbound.json.result.structuredContent.code, CODES.not_bound);
    assert.equal(unbound.json.result.structuredContent.ok, false);

    const missing = await sc.tools(sessionId, 'submit_task', { requestId: 't274-http-0003',
      sessionId: 'session-00000000-0000-4000-8000-000000000000', prompt: 'nowhere' });
    assert.equal(missing.json.result.structuredContent.code, CODES.session_not_found);

    const unknownTool = await sc.tools(sessionId, 'delete_everything', {});
    assert.equal(unknownTool.json.result.isError, true);
    assert.equal(unknownTool.json.result.structuredContent.code, CODES.unknown_tool);

    assert.deepEqual(sc.admissions(), [], 'no refusal may have produced a prompt');
  } finally {
    await sc.close();
  }
});

test('T274: a tool call that outlives requestTimeoutMs answers 504 and leaves the server usable', async () => {
  const sc = await scene({ requestTimeoutMs: 120, slowListMs: 600 });
  try {
    const { sessionId } = await sc.open();
    const slow = await sc.tools(sessionId, 'list_sessions');
    assert.equal(slow.status, 504);
    assert.equal(slow.json.error.data.code, CODES.request_timeout);
    assert.match(slow.json.error.message, /reconcile before retrying/);
    assert.equal(slow.json.id, null, 'a transport-level failure has no JSON-RPC request id to echo');

    // The listener is not wedged: the next request is answered normally.
    const quick = await sc.call('POST', { sessionId, body: { jsonrpc: '2.0', id: 20, method: 'tools/list' } });
    assert.equal(quick.status, 200);
  } finally {
    await sc.close();
  }
});

test('T274: an unknown JSON-RPC method is -32601, and an unsupported method never reaches the tools', async () => {
  const sc = await scene();
  try {
    const { sessionId } = await sc.open();
    const resources = await sc.call('POST', { sessionId, body: { jsonrpc: '2.0', id: 30, method: 'resources/list' } });
    assert.equal(resources.status, 200);
    assert.equal(resources.json.error.code, -32601);
    assert.equal(resources.json.error.data.method, 'resources/list');

    const ping = await sc.call('POST', { sessionId, body: { jsonrpc: '2.0', id: 31, method: 'ping' } });
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.json.result, {});
  } finally {
    await sc.close();
  }
});

test('T274: closing the transport releases the socket', async () => {
  const sc = await scene();
  const base = sc.transport.base;
  try {
    const { sessionId } = await sc.open();
    assert.equal(typeof sessionId, 'string');
  } finally {
    await sc.close();
  }
  const after = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }).then(() => 'up').catch(() => 'down');
  assert.equal(after, 'down', 'a closed transport must not still accept connections');
});

test('T274: the stdio dispatcher answers the same initialize, with the version it is given', async () => {
  // The shared dispatcher is the acceptance point: the transport must not carry a second copy of the protocol.
  const direct = { marker: true };
  const plain = await handle(direct, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(plain.protocolVersion, '2024-11-05', 'stdio keeps its T271 default');
  const negotiated = await handle(direct, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { protocolVersion: LATEST_PROTOCOL_VERSION });
  assert.equal(negotiated.protocolVersion, LATEST_PROTOCOL_VERSION);
  const toolsIndex = await handle(direct, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(toolsIndex.tools.length, TOOLS.length);
});

test('T274: the install document and the shipped example describe the transport, disabled', () => {
  const clean = checkDocs(ROOT);
  const docs = clean.filter((check) => check.id === 'docs.consistency');
  assert.equal(docs.length, 1);
  assert.equal(docs[0].status, 'ok', docs[0].detail);

  const dir = temp('t274-docs-');
  try {
    mkdirSync(path.join(dir, 'tools', 'dsh-direct'), { recursive: true });
    const docPath = path.join(dir, 'tools', 'dsh-direct', 'INSTALL-WINDOWS.md');
    const examplePath = path.join(dir, 'tools', 'dsh-direct', 'config.example.json');
    const doc = readFileSync(path.join(ROOT, 'tools', 'dsh-direct', 'INSTALL-WINDOWS.md'), 'utf8');
    const example = JSON.parse(readFileSync(path.join(ROOT, 'tools', 'dsh-direct', 'config.example.json'), 'utf8'));
    writeFileSync(docPath, doc, 'utf8');

    // The example must ship the transport off: a copy-paste install must not open a listener.
    const enabled = JSON.parse(JSON.stringify(example));
    enabled.http.enabled = true;
    writeFileSync(examplePath, JSON.stringify(enabled, null, 2) + '\n', 'utf8');
    const on = checkDocs(dir).find((check) => check.id === 'docs.consistency');
    assert.equal(on.status, 'fail');
    assert.match(on.detail, /enabled other than false/);

    // A field the validator does not read would be documented and then ignored.
    const stray = JSON.parse(JSON.stringify(example));
    stray.http.tls = true;
    writeFileSync(examplePath, JSON.stringify(stray, null, 2) + '\n', 'utf8');
    const unknown = checkDocs(dir).find((check) => check.id === 'docs.consistency');
    assert.equal(unknown.status, 'fail');
    assert.match(unknown.detail, /tls/);

    // And the document must mention the transport at all.
    writeFileSync(examplePath, JSON.stringify(example, null, 2) + '\n', 'utf8');
    const stripped = doc.replace(/http/gi, 'h-t-t-p');
    writeFileSync(docPath, stripped, 'utf8');
    const undocumented = checkDocs(dir).find((check) => check.id === 'docs.consistency');
    assert.equal(undocumented.status, 'fail');
    assert.match(undocumented.detail, /never mentions http/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T274: the CLI starts the HTTP transport from config and answers before it is stopped', async () => {
  const sc = await scene();
  // Its own port: the in-process transport from `scene()` already holds the configured one, and two listeners on one
  // port is exactly the `bind_failed` case, not what this test is about.
  const cliPort = await pickPort();
  const cliConfig = path.join(sc.dir, 'config-cli.json');
  writeFileSync(cliConfig, JSON.stringify({
    endpointFile: path.join(sc.dir, 'endpoint.json'),
    tokenFile: path.join(sc.dir, 'host.token'),
    stateDir: path.join(sc.dir, 'state-cli'),
    boundSessionIds: [SESSION],
    expectKind: 'offline_fake',
    http: { enabled: true, port: cliPort, authTokenFile: path.join(sc.dir, 'http.token') },
  }, null, 2) + '\n', 'utf8');
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'dsh-direct', 'mcp_server.mjs'),
    '--config', cliConfig], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    const banner = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('no banner; stderr was: ' + buffer)), 15000);
      child.stderr.on('data', (chunk) => {
        buffer += String(chunk);
        const match = /Streamable HTTP on (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(buffer);
        if (match) {
          clearTimeout(timer);
          resolve({ base: match[1], buffer });
        }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error('exited early with ' + code + ': '
        + buffer)); });
    });
    assert.match(banner.buffer, /loopback only/, 'the banner states the binding it actually uses');
    assert.equal(banner.buffer.includes(HTTP_TOKEN), false, 'the banner must never print the token');

    const response = await fetch(banner.base, { method: 'POST', headers: { 'content-type': 'application/json',
      accept: 'application/json', authorization: 'Bearer ' + HTTP_TOKEN },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25',
      capabilities: {}, clientInfo: { name: 'cli-client', version: '1.0.0' } } }) });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.result.protocolVersion, '2025-11-25');
    assert.equal(body.result.serverInfo.name, 'dsh-direct');
  } finally {
    child.kill();
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
    await sc.close();
  }
});

