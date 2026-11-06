// DSH Direct: the loopback Host bridge.
//
// This is the process a Cordis Desktop plugin would run in (or be replaced by, once the plugin path is proven). It
// holds the only object that can talk to the Host, and it publishes exactly three routes on 127.0.0.1:
//
//   GET  /health          -- no auth: what kind of Host this is, and whether it can do the job
//   GET  /sessions        -- listSessions()
//   POST /prompt          -- prompt(), one turn into an existing session
//   GET  /events          -- getEvents() for one turn
//
// Refusals are explicit: a non-loopback peer is rejected before routing, a missing or wrong bearer token is 401, and
// an adapter that lacks the required methods answers 503 `host_capability_missing` instead of half-working.
//
// Nothing here binds a public interface, opens a WebSocket, or reads a Chrome token.

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

import { CODES, DirectError } from './protocol.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function readToken(tokenFile) {
  const raw = readFileSync(tokenFile, 'utf8').trim();
  if (raw.length < 32) {
    throw new DirectError(CODES.unauthenticated, 'the bearer token file holds fewer than 32 characters',
      { tokenFile });
  }
  return raw;
}

/** Constant-time compare that does not leak the expected length through an early return. */
export function tokenMatches(expected, presented) {
  if (typeof presented !== 'string' || !presented.length) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) {
    // Still do the comparison so the timing does not simply report "wrong length".
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function json(res, status, body) {
  const payload = JSON.stringify(body) + '\n';
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  res.end(payload);
}

function refusal(res, err) {
  const status = err instanceof DirectError
    ? ({ unauthenticated: 401, host_capability_missing: 503, invalid_arguments: 400,
      session_not_found: 404, not_bound: 403, project_mismatch: 409 }[err.code] || 500)
    : 500;
  json(res, status, err instanceof DirectError ? err.toJSON()
    : { ok: false, code: CODES.internal, message: String(err && err.message) });
}

async function body(req, limitBytes = 1 << 20) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      throw new DirectError(CODES.invalid_arguments, 'request body too large', { limitBytes });
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DirectError(CODES.invalid_arguments, 'request body is not valid JSON');
  }
}

/**
 * Start the bridge. `adapter` is either an adapter built by `createSessionControllerAdapter()` or the offline fake;
 * the bridge records which, and reports it on `/health` and in every successful response's `host` field.
 */
export function startHostBridge({ adapter, token, port = 0, host = '127.0.0.1' }) {
  if (!LOOPBACK.has(host)) {
    throw new DirectError(CODES.internal, 'the Host bridge may only bind loopback', { host });
  }
  const name = typeof adapter.kind === 'string' ? adapter.kind : 'unknown';
  const server = createServer(async (req, res) => {
    const peer = req.socket.remoteAddress;
    if (!LOOPBACK.has(peer)) {
      return json(res, 403, { ok: false, code: 'loopback_only', message: 'only loopback peers are served',
        peer });
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') {
      const caps = typeof adapter.capabilities === 'function' ? adapter.capabilities() : null;
      return json(res, 200, { ok: true, kind: name, capabilities: caps, loopbackOnly: true });
    }
    const presented = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tokenMatches(token, presented)) {
      return json(res, 401, { ok: false, code: CODES.unauthenticated, message: 'a bearer token is required' });
    }
    try {
      if (req.method === 'GET' && url.pathname === '/sessions') {
        const sessions = await adapter.listSessions();
        return json(res, 200, { ok: true, host: name, sessions });
      }
      if (req.method === 'POST' && url.pathname === '/prompt') {
        const input = await body(req);
        if (typeof input.sessionId !== 'string' || typeof input.text !== 'string') {
          throw new DirectError(CODES.invalid_arguments, 'prompt needs `sessionId` and `text`');
        }
        const receipt = await adapter.prompt({ sessionId: input.sessionId, text: input.text,
          requestId: typeof input.requestId === 'string' ? input.requestId : null });
        if (receipt.accepted !== true) {
          // A Host refusing one turn is an outcome, not a broken transport: answer 200 and let the ledger record it.
          return json(res, 200, { ok: true, host: name, accepted: false, turnId: null,
            reason: receipt.reason === undefined ? null : receipt.reason });
        }
        return json(res, 200, { ok: true, host: name, accepted: true, turnId: receipt.turnId });
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        const sessionId = url.searchParams.get('sessionId');
        const turnId = url.searchParams.get('turnId');
        const cursor = url.searchParams.get('cursor');
        if (!sessionId || !turnId) {
          throw new DirectError(CODES.invalid_arguments, 'events needs `sessionId` and `turnId`');
        }
        const page = await adapter.getEvents({ sessionId, turnId,
          cursor: cursor === null || cursor === '' ? null : Number(cursor) });
        return json(res, 200, { ok: true, host: name, ...page });
      }
      return json(res, 404, { ok: false, code: 'no_route', message: 'no such route', path: url.pathname });
    } catch (err) {
      return refusal(res, err);
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        base: 'http://' + host + ':' + address.port,
        host,
        port: address.port,
        kind: name,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** The same bridge, but reachable only through an already-accepted loopback socket; used by `/health` checks. */
export function describeBridge(bridge) {
  return { base: bridge.base, host: bridge.host, port: bridge.port, kind: bridge.kind };
}
