#!/usr/bin/env node
// T203: AgentRelay's real terminal-candidate mirror.
//
// What this is: a sidecar that speaks the Native Host's own wire protocol (4-byte little-endian length prefix +
// ASCII-safe JSON, `protocol.py`) and asks the new read-only `terminal-mirror` op which runs finished and with what
// status. It then forwards each candidate to the local AgentRelay service with its status and its provenance.
//
// What this is not: it does not open Chrome, does not touch the extension, the Bridge or DSH, and never calls
// `terminal-list`/`terminal-ack`. Those are the send path: `terminal-list` moves the host's `pendingIds` forward and
// `terminal-ack` consumes them, so an observer calling them would change what gets auto-sent. `terminal-mirror` writes
// nothing, which is why it is the only op this process uses.
//
// And it must not overstate what it knows: `status` is the terminal status the host resolved (ledger + Bridge facts),
// `hostAck` is the host's own bookkeeping, and `pageDelivery` stays `unknown` for ever -- an ACK is not a delivered
// page, and this process cannot see the page at all.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_FRAME = 1024 * 1024;

/** One JSON message, framed the way `protocol.encode` frames it. */
export function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length, 0);
  return Buffer.concat([prefix, body]);
}

/** Read exactly one framed message from a buffer, or null when it is still incomplete. */
export function takeFrame(buffer) {
  if (buffer.length < 4) return null;
  const length = buffer.readUInt32LE(0);
  if (length > MAX_FRAME) throw new Error('frame too large: ' + length);
  if (buffer.length < 4 + length) return null;
  const body = buffer.subarray(4, 4 + length).toString('utf8');
  return { message: JSON.parse(body), rest: buffer.subarray(4 + length) };
}

/**
 * Ask the real host for one mirror sample.
 *
 * `host` is `{ python, script, origin, stateDir, ledgerRoot, bridgeDb, nativeRoot }` -- the same arguments Chrome
 * passes in production, so the code path is the production one and nothing needs modifying to attach.
 */
export function mirrorFromHost(host, { timeoutMs = 20000 } = {}) {
  const args = ['-B', host.script, host.origin, '--state-dir', host.stateDir];
  if (host.ledgerRoot) args.push('--ledger-root', host.ledgerRoot);
  if (host.bridgeDb) args.push('--bridge-db', host.bridgeDb);
  if (host.nativeRoot) args.push('--native-root', host.nativeRoot);
  // Production passes the real manifest; a fixture passes its own throwaway one. Both travel in the argv the extension
  // uses, so the mirror exercises the shipping code path.
  if (host.manifest) args.push('--manifest', host.manifest);
  if (host.bridgeFixture) args.push('--bridge-db-fixture', host.bridgeFixture);

  return new Promise((resolve) => {
    // windowsHide: this sidecar has no console, so a child console program is given a new one -- a window that
    // appears and disappears every poll. Node's default is false, and only this flag asks Windows for no window.
    const child = spawn(host.python, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = Buffer.alloc(0);
    let stderr = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already gone */ }
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done({ ok: false, code: 'host_timeout', stderr, report: null }), timeoutMs);

    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let framed;
      try {
        framed = takeFrame(buffer);
      } catch (err) {
        done({ ok: false, code: 'host_frame_invalid', detail: String(err.message), stderr, report: null });
        return;
      }
      if (!framed) return;
      const { message } = framed;
      if (!message || message.ok !== true) {
        done({ ok: false, code: (message && message.error && message.error.code) || 'host_refused',
          detail: message && message.error ? message.error.message : null, stderr, report: null });
        return;
      }
      done({ ok: true, code: null, stderr, report: message.result });
    });
    child.once('error', (err) => done({ ok: false, code: 'host_spawn_failed', detail: String(err.message), stderr,
      report: null }));
    child.once('exit', (code) => done({ ok: false, code: 'host_exited', detail: 'exit ' + code, stderr, report: null }));

    child.stdin.write(encode({ v: 1, id: 'mirror-1', op: 'terminal-mirror', args: {} }));
    child.stdin.end();
  });
}

/** Turn a host report into the service payload. Refuses rather than guessing when the source is missing. */
export function candidatesFromMirror(report) {
  if (!report || report.ok !== true) {
    return { ok: false, code: (report && report.code) || 'mirror_unavailable', candidates: [] };
  }
  const candidates = (report.candidates || []).map((item) => ({
    runId: item.runId,
    terminalStatus: item.status,
    statusSource: item.statusSource || 'bridge_ledger.status',
    hostSource: report.source || 'native_host.terminal-mirror',
    hostAck: item.hostAck || 'unseen',
    origin: item.origin || 'unknown',
    startedAt: item.startedAt,
    // T211: the completion instant the host resolved, and where it came from. Forwarded verbatim -- `null` means the
    // host could not prove one, and the service must not fill it in or derive it from `startedAt`.
    completedAt: Number.isFinite(item.completedAt) ? item.completedAt : null,
    completedAtSource: item.completedAtSource || 'unknown',
  }));
  return { ok: true, code: null, candidates, counts: report.counts || {}, pageDelivery: 'unknown' };
}

async function push(serviceUrl, tokenFile, batch) {
  const token = readFileSync(tokenFile, 'utf8').trim();
  const response = await fetch(serviceUrl.replace(/\/+$/, '') + '/host/terminal-candidates', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ candidates: batch.candidates, pageDelivery: 'unknown' }),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
  const host = {
    python: value('--python') || process.env.PYTHON || 'python',
    script: value('--host-script'),
    origin: value('--origin') || 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',
    stateDir: value('--state-dir'),
    ledgerRoot: value('--ledger-root'),
    bridgeDb: value('--bridge-db'),
    nativeRoot: value('--native-root'),
    manifest: value('--manifest'),
    bridgeFixture: value('--bridge-db-fixture'),
  };
  const serviceUrl = value('--service-url');
  const tokenFile = value('--service-token-file');
  if (!host.script || !host.stateDir || !serviceUrl || !tokenFile) {
    process.stderr.write('usage: host_mirror.mjs --host-script host.py --state-dir <dir> --service-url <url> '
      + '--service-token-file <file> [--ledger-root <dir>] [--bridge-db <db>] [--native-root <dir>]\n');
    process.exitCode = 2;
    return;
  }
  const pollMs = Number(value('--poll-ms') || 0);
  const once = argv.includes('--once') || !pollMs;

  const run = async () => {
    const sample = await mirrorFromHost(host);
    if (!sample.ok) {
      process.stdout.write(JSON.stringify({ ok: false, code: sample.code, detail: sample.detail || null }) + '\n');
      return 4;
    }
    const batch = candidatesFromMirror(sample.report);
    if (!batch.ok) {
      process.stdout.write(JSON.stringify({ ok: false, code: batch.code }) + '\n');
      return 4;
    }
    try {
      const result = await push(serviceUrl, tokenFile, batch);
      process.stdout.write(JSON.stringify({ ok: result.status === 200, status: result.status,
        candidates: batch.candidates.length, counts: batch.counts,
        accepted: Array.isArray(result.body.accepted) ? result.body.accepted.length : 0,
        rejected: result.body.rejected || [] }) + '\n');
      return result.status === 200 ? 0 : 3;
    } catch (err) {
      process.stdout.write(JSON.stringify({ ok: false, code: 'service_unreachable',
        detail: String(err && err.message ? err.message : err) }) + '\n');
      return 3;
    }
  };

  if (once) { process.exitCode = await run(); return; }
  process.stdout.write(JSON.stringify({ started: true, pollMs }) + '\n');
  for (;;) { await run(); await new Promise((r) => setTimeout(r, pollMs)); }
}

const invokedDirectly = process.argv[1]
  && new URL(import.meta.url).pathname.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) main();
