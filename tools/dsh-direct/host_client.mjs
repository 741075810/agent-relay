// DSH Direct: the client the MCP server uses to reach the loopback Host bridge.
//
// Two things matter here and neither is the HTTP plumbing.
//
// 1. **Where the bridge is.** A plugin that lets the OS pick a port cannot be reached through a frozen URL: after every
//    Desktop restart the old port is dead and the first submit answers 504, which the MCP server must treat as "unknown",
//    leaving the task `unsettled` and the session locked. So the client can be given `endpointFile` and re-reads it on
//    each resolve, which lets a long-lived MCP server follow a restarted Desktop.
//
// 2. **Whether the port is ours.** `/health` is unauthenticated and any local program can answer 200 on a port the file
//    still names. Identity (kind, protocol, and the per-bind endpointId) is therefore verified before the first request,
//    and a mismatch is a *refusal*: nothing was sent, so no session may stay locked.
//
// Status mapping: 401 -> unauthenticated, 409/4xx -> the Host said no, 504 -> host_unreachable (the Host never answered,
// outcome unknown), 5xx -> host_error (also unknown: we cannot read the reason). Only 504/5xx become `unsettled`.

import { readFileSync } from 'node:fs';

import { CODES, DirectError, fail } from './protocol.mjs';
import { assertHealthIdentity, resolveEndpoint, sameEndpointIdentity } from './endpoint.mjs';

const LOOPBACK_BASE = /^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}$/;

const STATUS_CODES = Object.freeze({
  499: CODES.cancelled,
  502: CODES.host_error,
  503: CODES.host_capability_missing,
  504: CODES.host_unreachable,
});

export class HostClient {
  /**
   * Exactly one locator: `baseUrl` (a fixed port pinned by the operator) or `endpointFile` (a plugin that may rebind).
   * `expectKind`/`expectProtocol` default to the real 0.2.0-rc.2 values; a test that uses the offline fake must say so
   * explicitly, so a fake can never pass for a live Host by accident.
   */
  constructor({ baseUrl = null, endpointFile = null, tokenFile, timeoutMs = 0, kind = 'host_bridge',
    expectKind = null, expectProtocol = null } = {}) {
    if (typeof tokenFile !== 'string' || !tokenFile) {
      fail(CODES.invalid_arguments, 'a token file is required', { field: 'tokenFile' });
    }
    if (!baseUrl && !endpointFile) {
      fail(CODES.invalid_arguments, 'the client needs config.hostUrl or config.endpointFile', {});
    }
    const initial = resolveEndpoint({ hostUrl: baseUrl, endpointFile });
    this.locator = endpointFile ? { endpointFile } : { hostUrl: baseUrl };
    this.expected = { kind: expectKind || null, protocol: expectProtocol || null };
    this.tokenFile = tokenFile;
    // 0 means "no client-side deadline". A deadline here would manufacture the very ambiguity this module exists to
    // avoid: we cannot tell an accepted-then-slow prompt from a rejected one.
    this.timeoutMs = timeoutMs;
    this.kind = kind;
    this.protocol = null;
    this.endpoint = initial;
    this.baseUrl = initial.base.replace(/\/+$/, '');
    this.verified = false;
  }

  /** Re-read the locator. A restarted Desktop writes a new descriptor; the old base is not reused. */
  refresh() {
    const next = resolveEndpoint(this.locator);
    if (!sameEndpointIdentity(this.endpoint, next)) {
      this.endpoint = next;
      this.baseUrl = next.base.replace(/\/+$/, '');
      this.verified = false;
    }
    return next;
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

  #abort() {
    const controller = this.timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    return { signal: controller ? controller.signal : undefined, clear: () => { if (timer) clearTimeout(timer); } };
  }

  /** Unauthenticated, and the only request allowed before identity is established for the current endpoint. */
  async #probeHealth() {
    const { signal, clear } = this.#abort();
    let response = null;
    try {
      response = await fetch(this.baseUrl + '/health', { method: 'GET', signal });
    } catch (err) {
      fail(CODES.host_unreachable, 'the Host bridge did not answer', { pathname: '/health',
        reason: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message) });
    } finally {
      clear();
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      fail(CODES.host_identity_mismatch, 'the endpoint answered /health with something that is not JSON',
        { status: response.status });
    }
    return body;
  }

  async #verify() {
    if (this.verified) return;
    const health = await this.#probeHealth();
    assertHealthIdentity(health, { kind: this.expected.kind, protocol: this.expected.protocol,
      endpointId: this.endpoint.endpointId });
    if (typeof health.kind === 'string') this.kind = health.kind;
    if (typeof health.protocol === 'string') this.protocol = health.protocol;
    this.verified = true;
  }

  async #request(method, pathname, payload) {
    // Re-resolve first: the Desktop may have restarted since the last call, and the descriptor is the only thing that
    // knows the new port. An unchanged descriptor keeps the verification we already paid for.
    this.refresh();
    await this.#verify();
    const { signal, clear } = this.#abort();
    let response = null;
    try {
      response = await fetch(this.baseUrl + pathname, {
        method,
        headers: Object.assign({ authorization: 'Bearer ' + this.#token() },
          payload === undefined ? {} : { 'content-type': 'application/json' }),
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      fail(CODES.host_unreachable, 'the Host bridge did not answer', { pathname,
        reason: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message) });
    } finally {
      clear();
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
      turnId: typeof body.turnId === 'string' ? body.turnId : null,
      terminal: body.terminal && typeof body.terminal.kind === 'string' ? body.terminal : null,
    };
  }

  async findAdmission({ sessionId, requestId }) {
    const body = await this.#request('GET', '/admission?sessionId=' + encodeURIComponent(sessionId)
      + '&requestId=' + encodeURIComponent(requestId));
    return body.admission || { found: false, seq: null, eventType: null };
  }

  /** Verified identity report, for the tool surface and for the preflight. */
  async health() {
    this.refresh();
    const body = await this.#probeHealth();
    return body;
  }
}

export function isLoopbackUrl(value) {
  return typeof value === 'string' && LOOPBACK_BASE.test(value);
}

export { DirectError };
