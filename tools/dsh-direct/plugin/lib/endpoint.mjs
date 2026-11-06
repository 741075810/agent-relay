// DSH Direct: the endpoint descriptor that lets the MCP side find the Host bridge after a Desktop restart.
//
// T272's install steps told the operator to put a literal `hostUrl: http://127.0.0.1:<port>` into config.json while the
// plugin bound `port: 0`. That combination cannot survive a restart: the plugin gets a new ephemeral port every time,
// the frozen URL then points at nothing, `/prompt` answers 504 (no answer -- correct, because a prompt may already be
// running), and the task goes `unsettled` with the session locked. The first submit after every Desktop start is
// therefore lost. Reproduced: 42609 -> 42610, `host_unreachable`.
//
// The fix is a descriptor file written by the plugin at bind time and read by the MCP server at call time:
//
//   { version, base, host, port, kind, protocol, endpointId, tokenFile, pid, writtenAt }
//
// `endpointId` is a per-bind random id that the bridge also returns from `GET /health`. A client that resolved through
// the file must see the same id, which catches the other half of the problem: a stale file pointing at a port that
// some other process now owns. Identity is checked before a prompt, never after.

import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

import { CODES, DirectError } from './protocol.mjs';

export const ENDPOINT_FILE_VERSION = 1;
export const EXPECTED_KIND = 'cordis_session_controller';
export const EXPECTED_PROTOCOL = 'dsh-api-session-controller@0.2.0-rc.2';

const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{1,5})$/;
export const MIN_PRIVILEGED_FREE_PORT = 1024;

export function isLoopbackBase(value) {
  return typeof value === 'string' && LOOPBACK_URL.test(value);
}

export function portOf(base) {
  const match = LOOPBACK_URL.exec(base);
  return match ? Number(match[2]) : null;
}

/** Build the descriptor the plugin writes once, after `listen` succeeded. */
export function buildEndpoint({ host = '127.0.0.1', port, kind, protocol, endpointId, tokenFile = null,
  now = Date.now(), pid = process.pid } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DirectError(CODES.invalid_arguments, 'endpoint needs a real bound port', { port });
  }
  return {
    version: ENDPOINT_FILE_VERSION,
    base: 'http://' + host + ':' + port,
    host,
    port,
    kind: typeof kind === 'string' ? kind : null,
    protocol: typeof protocol === 'string' ? protocol : null,
    endpointId: typeof endpointId === 'string' && endpointId ? endpointId : randomUUID(),
    tokenFile: typeof tokenFile === 'string' ? tokenFile : null,
    pid,
    writtenAt: now,
  };
}

/** Reject a descriptor that could not have been written by this package. */
export function validateEndpoint(value, { file = null } = {}) {
  const where = file ? { file } : {};
  if (!value || typeof value !== 'object') {
    throw new DirectError(CODES.invalid_arguments, 'the endpoint file is not a JSON object', where);
  }
  if (value.version !== ENDPOINT_FILE_VERSION) {
    throw new DirectError(CODES.invalid_arguments, 'unsupported endpoint file version', { ...where,
      version: value.version === undefined ? null : value.version, supported: ENDPOINT_FILE_VERSION });
  }
  if (!isLoopbackBase(value.base)) {
    throw new DirectError(CODES.invalid_arguments, 'the endpoint base must be a loopback http URL', { ...where,
      base: value.base === undefined ? null : value.base });
  }
  const port = portOf(value.base);
  if (Number.isInteger(value.port) && value.port !== port) {
    throw new DirectError(CODES.invalid_arguments, 'the endpoint port disagrees with its base URL', { ...where,
      port: value.port, base: value.base });
  }
  if (port < MIN_PRIVILEGED_FREE_PORT) {
    // A bound port below 1024 would mean something ran with elevated rights; on Windows any local user can take them,
    // so a low port here is a sign the file was written by something else.
    throw new DirectError(CODES.invalid_arguments, 'the endpoint binds a privileged port', { ...where, port });
  }
  if (typeof value.endpointId !== 'string' || value.endpointId.length < 8) {
    throw new DirectError(CODES.invalid_arguments, 'the endpoint has no endpointId to identify the process that bound '
      + 'it', where);
  }
  return { ...value, port };
}

export function writeEndpointFile(file, descriptor) {
  const text = JSON.stringify(descriptor, null, 2) + '\n';
  const tmp = file + '.tmp-' + process.pid;
  // 0600 is honoured on POSIX; on Windows the install steps restrict the directory with icacls, because Node cannot set
  // a Windows ACL. The token itself is never in this file -- only its path.
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

export function readEndpointFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new DirectError(CODES.host_unreachable, 'cannot read the endpoint file the plugin writes at bind time',
      { file, reason: err && err.code ? err.code : 'read_failed' });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DirectError(CODES.invalid_arguments, 'the endpoint file is not valid JSON', { file });
  }
  return validateEndpoint(parsed, { file });
}

/** Remove the descriptor only if it still describes the endpoint that is closing, so a successor's file survives. */
export function removeEndpointFile(file, endpointId = null) {
  let current;
  try {
    current = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (endpointId && current && current.endpointId !== endpointId) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exactly one locator. A literal URL is for a fixed port the operator pinned by hand; a file is for a plugin that may
 * rebind. Accepting both would leave the caller unable to say which one wins.
 */
export function resolveEndpoint({ hostUrl, endpointFile } = {}) {
  const hasUrl = hostUrl !== undefined && hostUrl !== null && hostUrl !== '';
  const hasFile = endpointFile !== undefined && endpointFile !== null && endpointFile !== '';
  if (hasUrl && hasFile) {
    throw new DirectError(CODES.invalid_arguments, 'give either config.hostUrl or config.endpointFile, not both',
      { hostUrl, endpointFile });
  }
  if (!hasUrl && !hasFile) {
    throw new DirectError(CODES.invalid_arguments, 'config.hostUrl or config.endpointFile is required (the MCP side '
      + 'cannot guess where the plugin bound)', {});
  }
  if (hasUrl) {
    if (!isLoopbackBase(hostUrl)) {
      throw new DirectError(CODES.invalid_arguments, 'config.hostUrl must be a loopback http URL', { hostUrl });
    }
    const port = portOf(hostUrl);
    if (port < MIN_PRIVILEGED_FREE_PORT) {
      throw new DirectError(CODES.invalid_arguments, 'config.hostUrl names a privileged port', { hostUrl, port });
    }
    return { base: hostUrl, port, source: 'hostUrl', endpointId: null, tokenFile: null, kind: null, protocol: null };
  }
  const descriptor = readEndpointFile(endpointFile);
  return { base: descriptor.base, port: descriptor.port, source: 'endpointFile', endpointId: descriptor.endpointId,
    tokenFile: descriptor.tokenFile, kind: descriptor.kind, protocol: descriptor.protocol, descriptor };
}

export function sameEndpointIdentity(left, right) {
  if (!left || !right) return false;
  if (left.base !== right.base) return false;
  if (left.endpointId && right.endpointId && left.endpointId !== right.endpointId) return false;
  return true;
}

/**
 * Verify `GET /health` before anything is sent. A stale descriptor pointing at an unrelated local server is the
 * failure this exists for: `/health` is unauthenticated, so a stranger answering 200 must not be treated as our Host.
 */
export function assertHealthIdentity(health, expected = {}) {
  const wantKind = expected.kind || EXPECTED_KIND;
  const wantProtocol = expected.protocol || EXPECTED_PROTOCOL;
  const got = health && typeof health === 'object' ? health : {};
  if (got.ok !== true || got.loopbackOnly !== true) {
    throw new DirectError(CODES.host_identity_mismatch, 'the endpoint did not answer as a loopback DSH bridge',
      { expected: { kind: wantKind, protocol: wantProtocol }, got: { ok: got.ok === true, loopbackOnly: got.loopbackOnly === true } });
  }
  if (got.kind !== wantKind) {
    throw new DirectError(CODES.host_identity_mismatch, 'the endpoint is a different kind of Host than expected',
      { expected: { kind: wantKind }, got: { kind: got.kind === undefined ? null : got.kind } });
  }
  if (wantProtocol && got.protocol !== wantProtocol) {
    throw new DirectError(CODES.host_identity_mismatch, 'the endpoint speaks a different protocol than expected',
      { expected: { protocol: wantProtocol }, got: { protocol: got.protocol === undefined ? null : got.protocol } });
  }
  if (expected.endpointId && got.endpointId !== expected.endpointId) {
    throw new DirectError(CODES.host_identity_mismatch, 'the port is now owned by a different bridge instance',
      { expected: { endpointId: expected.endpointId }, got: { endpointId: got.endpointId === undefined ? null : got.endpointId } });
  }
  return true;
}
