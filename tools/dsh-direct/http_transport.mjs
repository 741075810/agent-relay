// DSH Direct: the Streamable HTTP transport for the MCP server (spec revisions 2025-03-26 through 2025-11-25).
//
// This file is a transport, not a second implementation. Every JSON-RPC method is dispatched by `handle()` in
// `mcp_server.mjs` -- the same function the stdio server calls -- against the same `DirectServer`, the same task ledger
// and the same Host bridge. Nothing here knows what a session, a task or a prompt is. The dependency runs one way
// (`http_transport -> mcp_server -> protocol`); `mcp_server` loads this module dynamically only when HTTP is enabled.
//
// What the transport owns, and why each rule exists:
//
//   * one endpoint: POST for client messages, DELETE to end a session, GET answered 405. This server has nothing to
//     push -- a task is observed by calling `get_task`/`get_result` -- and the specification allows 405 instead of
//     holding an idle server-initiated stream open.
//   * `Origin` validation before anything else. A loopback listener is still reachable from a web page in the
//     operator's browser, and without this check any page could drive the Host. An absent `Origin` is allowed (a CLI
//     client sends none); a present one must match `http.allowedOrigins` exactly. Empty by default = deny every browser.
//   * bearer authentication compared in constant time, 401 with `WWW-Authenticate`, as the specification's auth
//     section requires. The token is read once at start, so a bad token file fails the process, not the first request.
//   * `Mcp-Session-Id` issued on `initialize`, required afterwards: 400 when missing, 404 when unknown, unusable after
//     DELETE. A session records only the negotiated revision and whether `notifications/initialized` arrived.
//   * `MCP-Protocol-Version` on requests after `initialize`: 400 for a revision this server does not speak, and 400
//     when it disagrees with the revision negotiated in `initialize`.
//   * bounded bodies (413 before the body is buffered) and a bounded wait for a tool call (504). A 504 is not a
//     refusal: the Host may already hold the prompt, so the transport never touches the ledger and the caller
//     reconciles.
//   * responses are `application/json` when the client accepts it and a single-event `text/event-stream` otherwise.
//     Same JSON-RPC bytes, different framing.
//
// Deliberately absent, and documented as absent in README.md: server-initiated SSE streaming, resumability via
// `Last-Event-ID`, and OAuth. None of them is simulated.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import {
  CODES, DirectError, LATEST_PROTOCOL_VERSION, MAX_CONCURRENT_DEFAULT, MIN_TOKEN_CHARS, SERVER_NAME, SERVER_VERSION,
  SUPPORTED_HTTP_PROTOCOL_VERSIONS, fail,
} from './protocol.mjs';
import { handle } from './mcp_server.mjs';

/** Read the HTTP bearer token. Length is checked here; the value never appears in an error or a log line. */
export function readHttpToken(file) {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    fail(CODES.unauthenticated, 'config.http.authTokenFile is unreadable', { reason: err.code || 'unreadable' });
  }
  const token = text.trim();
  if (token.length < MIN_TOKEN_CHARS) {
    fail(CODES.unauthenticated, 'the HTTP token is shorter than ' + MIN_TOKEN_CHARS + ' characters',
      { chars: token.length, minChars: MIN_TOKEN_CHARS });
  }
  return token;
}

const digest = (value) => createHash('sha256').update(value, 'utf8').digest();

/** Constant-time bearer comparison. Digests first so the compared buffers are always the same length. */
export function tokenMatches(expected, header) {
  if (typeof header !== 'string') return false;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header);
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), digest(expected));
}

const newSessionId = () => randomBytes(16).toString('hex');

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

const isInitialize = (message) => Boolean(message) && message.method === 'initialize';
const isNotification = (message) => Boolean(message) && message.id === undefined && typeof message.method === 'string';

/**
 * Which revision this server may be spoken to with, and what it answers when it does not know the requested one.
 * The set is the HTTP one: `2024-11-05` predates this transport, so a client asking for it gets the newest revision this
 * endpoint actually speaks rather than a false echo.
 */
export function negotiateProtocolVersion(requested) {
  if (typeof requested === 'string' && SUPPORTED_HTTP_PROTOCOL_VERSIONS.includes(requested)) {
    return { version: requested, supported: true };
  }
  return { version: LATEST_PROTOCOL_VERSION, supported: false };
}

/**
 * The client MUST send `application/json` on a Streamable HTTP POST. A body of the right shape under the wrong media
 * type is a request the server cannot claim to understand, so it is refused with 415 before a byte of it is parsed.
 * Parameters (`; charset=utf-8`) are accepted; anything else, including a missing header, is not.
 */
export function isJsonContentType(header) {
  if (typeof header !== 'string') return false;
  const base = header.split(';')[0].trim().toLowerCase();
  return base === 'application/json';
}

/**
 * Build the request handler. Kept separate from `createServer` so the pieces can be reasoned about, though every test
 * drives it over a real socket: a handler exercised through a mock socket proves the handler, not the transport.
 */
export function createMcpHttpHandler({ direct, http: rawHttp, token, serverInfo }) {
  if (!rawHttp || rawHttp.enabled !== true) fail(CODES.http_disabled, 'the HTTP transport is not enabled in config.http');
  // A caller may hand in a hand-built object (tests, embedded use); `loadHttpConfig` is the only path that fills every
  // field, so missing values are defaulted here rather than dereferenced as undefined.
  const http = { ...rawHttp, maxConcurrentRequests: Number.isInteger(rawHttp.maxConcurrentRequests)
    ? rawHttp.maxConcurrentRequests : MAX_CONCURRENT_DEFAULT };
  const sessions = new Map();
  // Tool calls currently in flight, bounded by `config.http.maxConcurrentRequests`. Declared before any handler runs.
  const inFlight = { count: 0 };

  const send = (res, status, body, headers = {}) => {
    const payload = body === null ? '' : JSON.stringify(body);
    const base = { 'cache-control': 'no-store', ...headers };
    if (body !== null) base['content-type'] = 'application/json; charset=utf-8';
    base['content-length'] = Buffer.byteLength(payload);
    res.writeHead(status, base);
    res.end(payload);
  };

  const sendError = (res, status, code, message, details, headers = {}) => {
    const data = details === undefined ? { code } : { code, ...details };
    send(res, status, rpcError(null, typeof code === 'number' ? code : -32000,
      typeof code === 'number' ? message : code + ': ' + message,
      typeof code === 'number' ? details : data), headers);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > http.maxBodyBytes) {
      req.resume();
      reject(new DirectError(CODES.body_too_large, 'request body is larger than config.http.maxBodyBytes',
        { declared, maxBodyBytes: http.maxBodyBytes }));
      return;
    }
    const chunks = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > http.maxBodyBytes) {
        done = true;
        req.destroy();
        reject(new DirectError(CODES.body_too_large, 'request body is larger than config.http.maxBodyBytes',
          { maxBodyBytes: http.maxBodyBytes }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });

  const prune = () => {
    while (sessions.size > http.maxSessions) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      sessions.delete(oldest[0]);
    }
  };

  /** One JSON-RPC message. Returns the response object, or `null` for a notification. */
  const dispatchOne = async (message, session, res) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return rpcError(null, -32600, 'invalid request: expected one JSON-RPC message object');
    }
    if (message.jsonrpc !== '2.0') {
      return rpcError(message.id, -32600, 'invalid request: jsonrpc must be "2.0"');
    }
    if (isNotification(message)) {
      // `notifications/initialized` is the only notification with meaning here; `notifications/cancelled` has nothing
      // to cancel because every request completes inside its own HTTP response. Both are accepted, answered 202.
      if (message.method === 'notifications/initialized' && session) session.initialized = true;
      return null;
    }
    if (typeof message.method !== 'string') {
      return rpcError(message.id, -32600, 'invalid request: a response is not accepted on this endpoint');
    }
    if (isInitialize(message)) {
      const params = message.params;
      // The specification requires `params.protocolVersion` on initialize. Answering without one would let a client
      // believe it negotiated something it never asked for, so an absent or non-string version is invalid params.
      if (!params || typeof params !== 'object' || Array.isArray(params) || typeof params.protocolVersion !== 'string') {
        const received = params === undefined || params === null ? null : typeof params.protocolVersion;
        return rpcError(message.id, -32602, 'invalid params: initialize requires a string protocolVersion',
          { received });
      }
      const negotiated = negotiateProtocolVersion(params.protocolVersion);
      const created = { id: newSessionId(), protocolVersion: negotiated.version, initialized: false,
        requestedVersion: params.protocolVersion,
        touchedAt: Date.now(), createdAt: Date.now() };
      sessions.set(created.id, created);
      prune();
      res.setHeader('mcp-session-id', created.id);
      return rpcResult(message.id, {
        protocolVersion: negotiated.version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: serverInfo || { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'dsh-direct submits one prompt into an existing, explicitly bound DSH session and never creates '
          + 'one. Use reconcile_task when submit_task reports an unsettled outcome.',
      });
    }
    if (!session) {
      return rpcError(message.id, -32600, 'initialize is required before any other request');
    }
    session.touchedAt = Date.now();
    try {
      const result = await handle(direct, message, { protocolVersion: session.protocolVersion });
      return rpcResult(message.id, result);
    } catch (err) {
      if (err instanceof DirectError) {
        if (err.details && typeof err.details.method === 'string') {
          return rpcError(message.id, -32601, 'method not found', { method: err.details.method });
        }
        return rpcError(message.id, -32000, err.code + ': ' + err.message, err.toJSON());
      }
      return rpcError(message.id, -32603, 'internal error', { message: String(err && err.message) });
    }
  };

  /**
   * Race the dispatch against `requestTimeoutMs`. When the timeout wins the dispatch keeps running — the Host may
   * already hold the prompt — so its eventual outcome is recorded only in the ledger. The abandoned branch must never
   * surface as an unhandled rejection: a process that dies right after a timeout is the failure mode this transport
   * must not have.
   */
  const withTimeout = async (promise) => {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ __timeout: true }), http.requestTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      // Attached unconditionally: a no-op when the dispatch won the race, and the only thing standing between a late
      // failure and an unhandled rejection when it did not.
      promise.catch(() => {});
    }
  };

  const authorized = (req, res) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !http.allowedOrigins.includes(origin)) {
      // DNS-rebinding defence: a page on any origin can reach 127.0.0.1, and it cannot forge Origin.
      sendError(res, 403, CODES.origin_rejected, 'this Origin is not in config.http.allowedOrigins', { origin });
      return false;
    }
    if (!tokenMatches(token, req.headers.authorization)) {
      sendError(res, 401, CODES.unauthenticated, 'a bearer token is required', undefined,
        { 'www-authenticate': 'Bearer realm="dsh-direct", error="invalid_token"' });
      return false;
    }
    return true;
  };

  const post = async (req, res) => {
    if (!authorized(req, res)) return;
    // The media type comes before anything that reads the body: a valid JSON-RPC payload sent as text/plain is a
    // request this server cannot claim to have understood, and T274 parsed it anyway.
    if (!isJsonContentType(req.headers['content-type'])) {
      sendError(res, 415, CODES.unsupported_content_type,
        'Content-Type must be application/json on a Streamable HTTP request',
        { contentType: req.headers['content-type'] === undefined ? null : String(req.headers['content-type']) });
      return;
    }
    const accept = String(req.headers.accept || '');
    const wantsJson = accept === '' || accept.includes('application/json') || accept.includes('*/*');
    const wantsSse = accept.includes('text/event-stream');
    if (!wantsJson && !wantsSse) {
      sendError(res, 406, CODES.unsupported_accept, 'Accept must allow application/json or text/event-stream',
        { accept });
      return;
    }
    const versionHeader = req.headers['mcp-protocol-version'];
    if (versionHeader !== undefined && !SUPPORTED_HTTP_PROTOCOL_VERSIONS.includes(String(versionHeader))) {
      sendError(res, 400, CODES.unsupported_protocol_version,
        'MCP-Protocol-Version names a revision this transport does not speak (Streamable HTTP starts at 2025-03-26)',
        { requested: String(versionHeader), supported: SUPPORTED_HTTP_PROTOCOL_VERSIONS });
      return;
    }
    let body = '';
    try {
      body = await readBody(req);
    } catch (err) {
      if (err instanceof DirectError && err.code === CODES.body_too_large) {
        sendError(res, 413, CODES.body_too_large, err.message, err.details);
        return;
      }
      sendError(res, 400, CODES.invalid_arguments, 'the request body could not be read',
        { reason: String(err && err.message) });
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      send(res, 400, rpcError(null, -32700, 'parse error: the body is not valid JSON'));
      return;
    }
    if (Array.isArray(parsed)) {
      // Batching was removed from the specification in 2025-06-18; accepting it silently would mean two different
      // ordering semantics depending on the negotiated revision.
      send(res, 400, rpcError(null, -32600, 'this server does not support JSON-RPC batches'));
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    const session = sessionId === undefined ? null : sessions.get(String(sessionId)) || null;
    if (!isInitialize(parsed)) {
      if (sessionId === undefined) {
        sendError(res, 400, CODES.session_required, 'initialize first: Mcp-Session-Id is required on every request');
        return;
      }
      if (!session) {
        sendError(res, 404, CODES.session_not_found, 'no such MCP session; initialize again', { sessionId });
        return;
      }
      if (!session.initialized && !isNotification(parsed)) {
        sendError(res, 400, CODES.session_required, 'send notifications/initialized before calling tools',
          { sessionId });
        return;
      }
      if (versionHeader !== undefined && String(versionHeader) !== session.protocolVersion) {
        sendError(res, 400, CODES.unsupported_protocol_version,
          'MCP-Protocol-Version does not match the revision negotiated in initialize',
          { requested: String(versionHeader), negotiated: session.protocolVersion });
        return;
      }
    }
    // One bounded queue for the expensive path. `initialize` and notifications stay cheap and always answerable, so a
    // client that filled the queue can still recover a session; `tools/call` is what holds Host sockets and session
    // locks, and that is what gets the 429.
    const isToolCall = parsed !== null && typeof parsed === 'object' && parsed.method === 'tools/call';
    if (isToolCall && inFlight.count >= http.maxConcurrentRequests) {
      sendError(res, 429, CODES.too_many_requests,
        'too many tool calls in flight; retry after the current ones finish',
        { maxConcurrentRequests: http.maxConcurrentRequests, inFlight: inFlight.count },
        { 'retry-after': '1' });
      return;
    }
    if (isToolCall) inFlight.count += 1;
    let outcome = null;
    try {
      outcome = await withTimeout(dispatchOne(parsed, session, res));
    } finally {
      if (isToolCall) inFlight.count -= 1;
    }
    if (outcome && outcome.__timeout === true) {
      // No answer in time. The transport reports that and nothing else: a `submit_task` in flight may already have been
      // admitted by the Host, so a caller that reads 504 as a refusal would lose track of a real prompt.
      sendError(res, 504, CODES.request_timeout,
        'the request did not finish inside config.http.requestTimeoutMs; reconcile before retrying',
        { requestTimeoutMs: http.requestTimeoutMs });
      return;
    }
    if (outcome === null) {
      // Notification or response only: 202 with no body, which is what the specification asks for.
      res.writeHead(202, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const negotiated = session ? session.protocolVersion : LATEST_PROTOCOL_VERSION;
    if (wantsJson || !wantsSse) {
      send(res, 200, outcome, { 'mcp-protocol-version': negotiated });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
      'mcp-protocol-version': negotiated });
    res.write('event: message\ndata: ' + JSON.stringify(outcome) + '\n\n');
    res.end();
  };

  return async function handler(req, res) {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      sendError(res, 400, 'invalid_request', 'the request target could not be parsed');
      return;
    }
    if (pathname !== http.path) {
      sendError(res, 404, 'not_found', 'no MCP endpoint at this path', { path: pathname, expected: http.path });
      return;
    }
    if (req.method === 'POST') {
      await post(req, res);
      return;
    }
    if (req.method === 'DELETE') {
      if (!authorized(req, res)) return;
      const sessionId = req.headers['mcp-session-id'];
      if (sessionId === undefined || !sessions.has(String(sessionId))) {
        sendError(res, 404, CODES.session_not_found, 'no such MCP session', { sessionId });
        return;
      }
      sessions.delete(String(sessionId));
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    sendError(res, 405, CODES.method_not_allowed,
      'this MCP endpoint answers POST and DELETE only; it has no server-initiated stream', undefined,
      { allow: 'POST, DELETE' });
  };
}

/**
 * Start the transport on 127.0.0.1. Returns the listening port and a closer that resolves once the socket is released.
 */
export async function startHttpTransport({ direct, http, serverInfo }) {
  const token = readHttpToken(http.authTokenFile);
  const handler = createMcpHttpHandler({ direct, http, token, serverInfo });
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(rpcError(null, -32603, 'internal error',
          { message: String(err && err.message) })));
      } else {
        res.end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(new DirectError(CODES.bind_failed,
      'the MCP HTTP transport could not bind ' + http.host + ':' + http.port,
      { host: http.host, port: http.port, reason: err.code || 'error' }));
    server.once('error', onError);
    server.listen(http.port, http.host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const port = server.address().port;
  return {
    port,
    base: 'http://' + http.host + ':' + port + http.path,
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
