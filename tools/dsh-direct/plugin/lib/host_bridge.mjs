// DSH Direct: the loopback Host bridge.
//
// This is the process the Cordis plugin runs inside the existing Desktop Host. It holds the only object that can talk
// to `ctx.sessionController`, and it publishes exactly these routes on 127.0.0.1:
//
//   GET  /health     -- no auth: what kind of Host this is, its protocol, whether it can do the job
//   GET  /sessions   -- list()   -> { items } | array, normalised to rows
//   POST /prompt     -- prompt() -> acknowledged / refused / never answered
//   GET  /events     -- page()   -> assistant text, newest seq, and admission evidence for one requestId
//   GET  /admission  -- page() evidence only, used by reconcile before re-prompting
//
// Refusals are explicit: a non-loopback peer is rejected before routing, a missing or wrong bearer token is 401, and
// an adapter without the rc.2 methods answers 503 `host_capability_missing` instead of half-working. An unanswered
// Host call answers 504 `host_unanswered` -- the client must not read that as "the prompt was rejected".

import { timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

import { CODES, DirectError } from './protocol.mjs';
import { buildEndpoint, removeEndpointFile, writeEndpointFile } from './endpoint.mjs';
import { createSessionControllerAdapter } from './adapters.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Every listener this process currently has open. A plugin that unloads must leave this empty; so must a test run.
const OPEN = new Set();
export function openBridgeCount() {
  return OPEN.size;
}

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
  // 504 is reserved for "the Host never answered": the caller must treat that as unknown, not as a rejection.
  const status = err instanceof DirectError
    ? ({ unauthenticated: 401, host_capability_missing: 503, invalid_arguments: 400,
      session_not_found: 404, not_bound: 403, project_mismatch: 409, host_refused: 409,
      session_busy: 409, session_writer_held: 409, cancelled: 499, host_unreachable: 504, host_error: 502,
      internal: 502 }[err.code] || 500)
    : 502;
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
 * Start the bridge. `adapter` is either the rc.2 adapter or the offline fake; the bridge records which, and reports it
 * on `/health` and in every successful response's `host` field, so a receipt can never confuse the two.
 *
 * `endpointFile` (optional) makes the chosen port discoverable: a plugin that lets the OS pick a port cannot be
 * addressed by a frozen `hostUrl`, so it writes a descriptor the MCP side reads at call time. `endpointId` is echoed by
 * `/health` so a stale descriptor pointing at somebody else's port is caught before a prompt is sent.
 */
export function startHostBridge({ adapter, token, port = 0, host = '127.0.0.1', endpointFile = null,
  endpointId = null } = {}) {
  if (!LOOPBACK.has(host)) {
    throw new DirectError(CODES.internal, 'the Host bridge may only bind loopback', { host });
  }
  // Accept either the neutral adapter (what the plugin builds) or a bare rc.2 session controller (what a test or a
  // Host object may hand over). Getting this wrong used to surface as "adapter.listSessions is not a function" on
  // every route, which reads like a Host fault rather than a wiring fault, so the normalisation is done here.
  const target = adapter && typeof adapter.listSessions === 'function'
    ? adapter
    : createSessionControllerAdapter(adapter, { kind: (adapter && adapter.kind) || 'wrapped_controller' });
  const name = typeof target.kind === 'string' ? target.kind : 'unknown';
  const protocol = typeof target.protocol === 'string' ? target.protocol : null;
  // Decided before the request handler is built: `/health` must echo the id the descriptor file carries, otherwise the
  // staleness check the MCP side relies on would compare against null and pass for any bridge.
  const id = typeof endpointId === 'string' && endpointId ? endpointId : randomUUID();
  const server = createServer(async (req, res) => {
    const peer = req.socket.remoteAddress;
    if (!LOOPBACK.has(peer)) {
      return json(res, 403, { ok: false, code: 'loopback_only', message: 'only loopback peers are served', peer });
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') {
      const caps = typeof target.capabilities === 'function' ? target.capabilities() : null;
      return json(res, 200, { ok: true, kind: name, protocol, capabilities: caps, loopbackOnly: true,
        endpointId: id });
    }
    const presented = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tokenMatches(token, presented)) {
      return json(res, 401, { ok: false, code: CODES.unauthenticated, message: 'a bearer token is required' });
    }
    try {
      if (req.method === 'GET' && url.pathname === '/sessions') {
        const sessions = await target.listSessions();
        return json(res, 200, { ok: true, host: name, protocol, sessions });
      }
      if (req.method === 'POST' && url.pathname === '/prompt') {
        const input = await body(req);
        if (typeof input.sessionId !== 'string' || typeof input.text !== 'string'
            || typeof input.requestId !== 'string') {
          throw new DirectError(CODES.invalid_arguments, 'prompt needs `sessionId`, `text` and `requestId`');
        }
        // Deliberately NOT wrapped in a timeout: a prompt that times out here would be indistinguishable from one the
        // Host accepted, and the whole reconcile story depends on never making that mistake silently.
        const receipt = await target.prompt({ sessionId: input.sessionId, text: input.text,
          requestId: input.requestId });
        if (receipt.accepted !== true) {
          return json(res, 200, { ok: true, host: name, accepted: false, turnId: null,
            reason: receipt.reason === undefined ? null : receipt.reason });
        }
        return json(res, 200, { ok: true, host: name, accepted: true, turnId: receipt.turnId === undefined
          ? null : receipt.turnId, requestId: input.requestId });
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        const sessionId = url.searchParams.get('sessionId');
        const requestId = url.searchParams.get('requestId');
        if (!sessionId) throw new DirectError(CODES.invalid_arguments, 'events needs `sessionId`');
        const page = await target.getEvents({ sessionId, requestId });
        // MCP collection needs only event identities/counts, not tool payloads already held by the Host.
        // Opt-in preserves legacy clients. Project BEFORE JSON.stringify/UTF-8 conversion, not after transport.
        const events = url.searchParams.get('eventFormat') === 'summary'
          ? page.events.map(({ seq, kind }) => ({ seq, kind })) : page.events;
        // Admission, end reason, and answer must all come from the SAME exact history cut.
        return json(res, 200, { ok: true, host: name, protocol, events,
          cursor: page.cursor ?? null, done: page.done === true && page.admission?.found === true,
          assistantText: page.assistantText || null, admission: page.admission || null,
          turnId: page.turnId ?? null, terminal: page.terminal ?? null });
      }
      if (req.method === 'GET' && url.pathname === '/admission') {
        const sessionId = url.searchParams.get('sessionId');
        const requestId = url.searchParams.get('requestId');
        if (!sessionId || !requestId) {
          throw new DirectError(CODES.invalid_arguments, 'admission needs `sessionId` and `requestId`');
        }
        if (typeof target.findAdmission !== 'function') {
          throw new DirectError(CODES.host_capability_missing, 'this adapter cannot report admission evidence',
            { missing: ['findAdmission'] });
        }
        const admission = await target.findAdmission({ sessionId, requestId });
        return json(res, 200, { ok: true, host: name, protocol, admission });
      }
      return json(res, 404, { ok: false, code: 'no_route', message: 'no such route', path: url.pathname });
    } catch (err) {
      return refusal(res, err);
    }
  });
  return new Promise((resolve, reject) => {
    // Track every accepted socket. `server.close()` alone waits for keep-alive sockets to drain, and a client that
    // died mid-request can leave one behind -- which keeps the listener alive and, in a test process, keeps it from
    // exiting. Destroying tracked sockets makes `close()` mean "closed", not "asked to close".
    const sockets = new Set();
    let closing = null;
    const destroyAll = () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.closeAllConnections?.();
    };
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('close', () => {
      OPEN.delete(server);
    });
    // A fixed port is the only way the MCP side can be handed a URL that survives a restart, and a fixed port collides.
    // Before T273 `EADDRINUSE` was an unhandled 'error' event: the throw escaped `listen`, and inside the Desktop that is
    // a dead Host process. It must be a rejection the plugin can log and fail closed on.
    server.on('error', (err) => {
      OPEN.delete(server);
      destroyAll();
      reject(new DirectError(CODES.bind_failed, 'the Host bridge could not bind ' + host + ':' + port,
        { host, port, reason: err && err.code ? err.code : 'listen_failed' }));
    });
    OPEN.add(server);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = address.port;
      if (endpointFile) {
        try {
          writeEndpointFile(endpointFile, buildEndpoint({ host, port: boundPort, kind: name, protocol, endpointId: id,
            tokenFile: null }));
        } catch (err) {
          // A descriptor the MCP side cannot read is a bridge nobody can find: close and report instead of serving.
          try { server.close(); } catch { /* already closing */ }
          OPEN.delete(server);
          destroyAll();
          reject(new DirectError(CODES.bind_failed, 'the Host bridge bound but could not publish its endpoint file',
            { host, port: boundPort, endpointFile, reason: err && err.code ? err.code : 'write_failed' }));
          return;
        }
      }
      resolve({
        base: 'http://' + host + ':' + boundPort,
        host,
        port: boundPort,
        kind: name,
        protocol,
        endpointId: id,
        endpointFile,
        listening: () => server.listening,
        // Resolves when the listener is gone. `server.listening` flips to false the instant close() is called, while
        // the handle survives until every connection ends -- and a client that died mid-request can leave one behind.
        // So: ask, destroy everything we know about, and fall back after 250 ms rather than wait on a FIN that may
        // never arrive. `openBridgeCount()` lets a caller (and a test) prove the listener was actually released.
        close: () => {
          if (closing) return closing;
          if (endpointFile) removeEndpointFile(endpointFile, id);
          closing = new Promise((done) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              done();
            };
            server.once('close', finish);
            try {
              server.close(() => { /* 'close' listener is the resolver */ });
            } catch {
              finish();
            }
            destroyAll();
            const guard = setTimeout(() => {
              destroyAll();
              server.closeAllConnections?.();
              finish();
            }, 250);
            guard.unref?.();
          });
          return closing;
        },
      });
    });
  });
}

export function describeBridge(bridge) {
  return { base: bridge.base, host: bridge.host, port: bridge.port, kind: bridge.kind,
    protocol: bridge.protocol === undefined ? null : bridge.protocol };
}
