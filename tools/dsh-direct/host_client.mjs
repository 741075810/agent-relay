// DSH Direct: the client the MCP server uses to reach the loopback Host bridge.
//
// The token is read from a file at call time (never from argv, so it does not land in a process list), and a
// non-loopback base URL is refused. The important part of this file is the status mapping:
//
//   401 -> unauthenticated            504 -> host_unanswered  (the Host never answered: outcome unknown)
//   409 -> the Host said no           5xx -> host_error       (also unknown: we cannot read the reason)
//
// `host_unanswered` is deliberately *not* folded into a failure: the MCP server turns it into `unsettled`.

import { readFileSync } from 'node:fs';

import { CODES, DirectError, fail } from './protocol.mjs';

const LOOPBACK_BASE = /^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}$/;

const STATUS_CODES = Object.freeze({
  499: CODES.cancelled,
  502: CODES.host_error,
  503: CODES.host_capability_missing,
  504: CODES.host_unreachable,
});

export class HostClient {
  constructor({ baseUrl, tokenFile, timeoutMs = 0, kind = 'host_bridge' } = {}) {
    if (typeof baseUrl !== 'string' || !LOOPBACK_BASE.test(baseUrl)) {
      fail(CODES.invalid_arguments, 'the Host base URL must be loopback http', { baseUrl });
    }
    if (typeof tokenFile !== 'string' || !tokenFile) {
      fail(CODES.invalid_arguments, 'a token file is required', { field: 'tokenFile' });
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.tokenFile = tokenFile;
    // 0 means "no client-side deadline". A deadline here would manufacture the very ambiguity this module exists to
    // avoid: we cannot tell an accepted-then-slow prompt from a rejected one.
    this.timeoutMs = timeoutMs;
    this.kind = kind;
    this.protocol = null;
  }

  #token() {
    let raw = null;
    try {
      raw = readFileSync(this.tokenFile, 'utf8').trim();
    } catch (err) {
      fail(CODES.host_unreachable, 'the bearer token file cannot be read', { reason: String(err && err.code) });
    }
    if (raw.length < 32) fail(CODES.unauthenticated, 'the bearer token file is too short to be a token');
    return raw;
  }

  async #request(method, pathname, payload) {
    const controller = this.timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let response = null;
    try {
      response = await fetch(this.baseUrl + pathname, {
        method,
        headers: Object.assign({ authorization: 'Bearer ' + this.#token() },
          payload === undefined ? {} : { 'content-type': 'application/json' }),
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      fail(CODES.host_unreachable, 'the Host bridge did not answer', { pathname,
        reason: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message) });
    } finally {
      if (timer) clearTimeout(timer);
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      fail(STATUS_CODES[response.status] || CODES.host_error,
        'the Host bridge answered with something that is not JSON', { status: response.status });
    }
    if (response.status === 401) fail(CODES.unauthenticated, 'the Host bridge rejected the token');
    if (!response.ok || body.ok === false) {
      const code = typeof body.code === 'string' ? body.code : (STATUS_CODES[response.status] || CODES.host_error);
      fail(code, typeof body.message === 'string' ? body.message : 'the Host bridge refused the call',
        { status: response.status, host: body.host === undefined ? null : body.host,
          remoteCode: body.details && body.details.remoteCode ? body.details.remoteCode : null });
    }
    if (typeof body.host === 'string') this.kind = body.host;
    if (typeof body.protocol === 'string') this.protocol = body.protocol;
    return body;
  }

  async listSessions() {
    const body = await this.#request('GET', '/sessions');
    if (!Array.isArray(body.sessions)) fail(CODES.internal, 'the Host bridge returned no session list');
    return body.sessions;
  }

  async prompt({ sessionId, text, requestId }) {
    const body = await this.#request('POST', '/prompt', { sessionId, text, requestId });
    return {
      accepted: body.accepted === true,
      turnId: typeof body.turnId === 'string' ? body.turnId : null,
      reason: typeof body.reason === 'string' ? body.reason : null,
    };
  }

  async getEvents({ sessionId, requestId }) {
    const query = '?sessionId=' + encodeURIComponent(sessionId)
      + (requestId ? '&requestId=' + encodeURIComponent(requestId) : '');
    const body = await this.#request('GET', '/events' + query);
    return {
      events: Array.isArray(body.events) ? body.events : [],
      cursor: Number.isFinite(body.cursor) ? body.cursor : null,
      done: body.done === true,
      assistantText: typeof body.assistantText === 'string' ? body.assistantText : null,
      admission: body.admission || null,
    };
  }

  async findAdmission({ sessionId, requestId }) {
    const body = await this.#request('GET', '/admission?sessionId=' + encodeURIComponent(sessionId)
      + '&requestId=' + encodeURIComponent(requestId));
    return body.admission || { found: false, seq: null, eventType: null };
  }

  async health() {
    return this.#request('GET', '/health');
  }
}

export function isLoopbackUrl(value) {
  return typeof value === 'string' && LOOPBACK_BASE.test(value);
}

export { DirectError };
