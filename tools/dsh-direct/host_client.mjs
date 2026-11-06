// DSH Direct: the client the MCP server uses to reach the loopback Host bridge.
//
// It reads the bearer token from a file at call time (never from argv, so it does not land in a process list), and
// it refuses to talk to a non-loopback base URL. Every failure is a `DirectError` with a code: `host_unreachable`
// when nothing answered, `unauthenticated` on 401, and the bridge's own code when it refused on purpose.

import { readFileSync } from 'node:fs';

import { CODES, DirectError, fail } from './protocol.mjs';

const LOOPBACK_BASE = /^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}$/;

export class HostClient {
  constructor({ baseUrl, tokenFile, timeoutMs = 10000, kind = 'host_bridge' } = {}) {
    if (typeof baseUrl !== 'string' || !LOOPBACK_BASE.test(baseUrl)) {
      fail(CODES.invalid_arguments, 'the Host base URL must be loopback http', { baseUrl });
    }
    if (typeof tokenFile !== 'string' || !tokenFile) {
      fail(CODES.invalid_arguments, 'a token file is required', { field: 'tokenFile' });
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.tokenFile = tokenFile;
    this.timeoutMs = timeoutMs;
    this.kind = kind;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response = null;
    try {
      response = await fetch(this.baseUrl + pathname, {
        method,
        headers: Object.assign({ authorization: 'Bearer ' + this.#token() },
          payload === undefined ? {} : { 'content-type': 'application/json' }),
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      fail(CODES.host_unreachable, 'the Host bridge did not answer', { pathname,
        reason: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message) });
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      fail(CODES.host_unreachable, 'the Host bridge answered with something that is not JSON',
        { status: response.status });
    }
    if (response.status === 401) fail(CODES.unauthenticated, 'the Host bridge rejected the token');
    if (!response.ok || body.ok === false) {
      fail(typeof body.code === 'string' ? body.code : CODES.internal,
        typeof body.message === 'string' ? body.message : 'the Host bridge refused the call',
        { status: response.status, host: body.host === undefined ? null : body.host });
    }
    return body;
  }

  async listSessions() {
    const body = await this.#request('GET', '/sessions');
    if (!Array.isArray(body.sessions)) fail(CODES.internal, 'the Host bridge returned no session list');
    // The bridge's own label travels with the data: a caller must be able to tell an offline fake from a live Host.
    if (typeof body.host === 'string') this.kind = body.host;
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

  async getEvents({ sessionId, turnId, cursor }) {
    const query = '?sessionId=' + encodeURIComponent(sessionId) + '&turnId=' + encodeURIComponent(turnId)
      + (cursor === null || cursor === undefined ? '' : '&cursor=' + encodeURIComponent(String(cursor)));
    const body = await this.#request('GET', '/events' + query);
    return {
      events: Array.isArray(body.events) ? body.events : [],
      cursor: Number.isFinite(body.cursor) ? body.cursor : null,
      done: body.done === true,
    };
  }

  async health() {
    return this.#request('GET', '/health');
  }
}

export function isLoopbackUrl(value) {
  return typeof value === 'string' && LOOPBACK_BASE.test(value);
}

export { DirectError };
