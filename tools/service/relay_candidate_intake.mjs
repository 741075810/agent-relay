#!/usr/bin/env node
// T205: relay candidates into the extension's existing candidate store, then out through its existing consumption entry.
//
// The extension's acquisition path stores what its host answered under `terminalCandidates` in `chrome.storage.local`,
// and `autosend_chrome_wiring.readCandidates()/consumeCandidate()` is what the background script uses to read and
// consume them. This intake speaks the host's framed protocol to the Relay-backed host, admits each candidate through
// the extension's own `admit()`, and writes the survivors into a storage store with that exact key -- so the next
// caller is the real wiring module, not another validator of mine.
//
// Nothing is sent. There is no page writer here, no arm, no binding: `pageDelivery` stays `unknown` and the intake
// reports `deliverable: false`.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTriggerState, admit } from '../../extension/lib/terminal_trigger.js';

export const CANDIDATES_KEY = 'terminalCandidates';

export function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length, 0);
  return Buffer.concat([prefix, body]);
}

export function takeFrame(buffer) {
  if (buffer.length < 4) return null;
  const length = buffer.readUInt32LE(0);
  if (buffer.length < 4 + length) return null;
  return { message: JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')),
    rest: buffer.subarray(4 + length) };
}

/** Ask the Relay-backed host for its `terminal-list` answer, over the real wire format. */
export function askTerminalList(host, { timeoutMs = 15000 } = {}) {
  const extra = Array.isArray(host.args) ? host.args : [];
  // The stand-in host takes the relay endpoint as flags. The real host does not: it takes its own manifest / ledger /
  // native roots, and the relay is configured there too. So explicit host arguments mean the caller knows its host,
  // and nothing is appended behind its back.
  const relayFlags = extra.length === 0
    ? ['--service-url', host.serviceUrl, '--service-token-file', host.tokenFile]
    : [];
  const args = [host.script, ...extra, ...relayFlags];
  return new Promise((resolve) => {
    const child = spawn(host.python, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = Buffer.alloc(0);
    let stderr = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => done({ ok: false, code: 'host_timeout', stderr }), timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let framed;
      try { framed = takeFrame(buffer); } catch (err) {
        done({ ok: false, code: 'host_frame_invalid', detail: String(err.message), stderr });
        return;
      }
      if (!framed) return;
      const message = framed.message;
      if (!message || message.ok !== true) {
        done({ ok: false, code: (message && message.error && message.error.code) || 'host_refused', stderr });
        return;
      }
      done({ ok: true, code: null, result: message.result, stderr });
    });
    child.once('error', (err) => done({ ok: false, code: 'host_spawn_failed', detail: String(err.message), stderr }));
    child.once('exit', (code) => done({ ok: false, code: 'host_exited', detail: 'exit ' + code, stderr }));
    child.stdin.write(encode({ v: 1, id: 'intake-1', op: 'terminal-list', args: {} }));
    child.stdin.end();
  });
}

/**
 * Merge candidates into a storage-shaped document the way the extension does: one entry per `runId|status`, existing
 * entries untouched, so a replay cannot duplicate and a changed status replaces rather than appends.
 */
export function mergeIntoStore(existing, admitted, now = Date.now()) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  const keyOf = (item) => item && (item.key || (item.runId + '|' + item.status));
  const known = new Set(list.map(keyOf));
  let added = 0;
  for (const candidate of admitted) {
    const key = keyOf(candidate);
    if (known.has(key)) continue;
    known.add(key);
    list.push({ ...candidate, key, storedAt: now });
    added += 1;
  }
  return { list, added };
}

/** One intake pass: wire -> admit -> store. Returns what it did, and refuses to claim delivery.
 *
 * `triggerState` is the extension's dedupe memory (`seen`), not something invented here: `admit()` refuses a run it has
 * already journalled, so without it a later pass would re-queue a candidate the operator has long consumed.
 */
export async function intakeOnce({ host, now = Date.now(), triggerState = null }) {
  const answer = await askTerminalList(host);
  if (!answer.ok) {
    return { ok: false, code: answer.code, admitted: [], refused: [], stored: 0, added: 0,
      pageDelivery: 'unknown', deliverable: false };
  }
  // A protocol-level success can still carry a source failure: the relay host answers `ok:false` inside the frame when
  // the service is unreachable, and "the relay is down" must not be reported as "nothing finished".
  if (answer.result && answer.result.ok === false) {
    return { ok: false, code: answer.result.code || 'relay_unavailable', admitted: [], refused: [], stored: 0,
      added: 0, pageDelivery: 'unknown', deliverable: false };
  }
  const candidates = (answer.result && answer.result.candidates) || [];
  let state = triggerState && typeof triggerState === 'object'
    ? { ...createTriggerState(), enabled: true, armedAt: now, ...triggerState }
    : { ...createTriggerState(), enabled: true, armedAt: now };
  const admitted = [];
  const refused = [];
  for (const candidate of candidates) {
    const verdict = admit(state, candidate, now);
    if (verdict && verdict.admit === true) {
      admitted.push(candidate);
      if (verdict.state) state = verdict.state;
      else {
        // The extension journals a completed attempt under `runId|status`; record the same key so the next pass sees it.
        state = { ...state, seen: { ...(state.seen || {}),
          [candidate.runId + '|' + candidate.status]: { runId: candidate.runId, status: candidate.status,
            state: 'attempted', at: now } } };
      }
    }
    else refused.push({ runId: candidate.runId || null, status: candidate.status || null,
      code: (verdict && verdict.code) || 'unknown' });
  }
  return { ok: true, code: null, admitted, refused, received: candidates.length,
    requiresAck: answer.result.requiresAck === true, pageDelivery: 'unknown', deliverable: false,
    triggerState: state };
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
  const argvHostArgs = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--host-arg') argvHostArgs.push(argv[i + 1]);
  }
  const host = {
    python: value('--python') || process.env.PYTHON || 'python',
    script: value('--host-script'),
    serviceUrl: value('--service-url'),
    tokenFile: value('--service-token-file'),
    // For the real host: origin first, then --state-dir/--ledger-root/--manifest/... before the relay flags.
    args: argvHostArgs.filter((item) => typeof item === 'string'),
  };
  const storePath = value('--store');
  if (!host.script || !host.serviceUrl || !host.tokenFile || !storePath) {
    process.stderr.write('usage: relay_candidate_intake.mjs --host-script <py> --service-url <url> '
      + '--service-token-file <file> --store <json>\n');
    process.exitCode = 2;
    return;
  }
  const statePath = value('--trigger-state');
  let triggerState = null;
  if (statePath) {
    try { triggerState = JSON.parse(readFileSync(statePath, 'utf8')); } catch { triggerState = null; }
  }
  const pass = await intakeOnce({ host, triggerState });
  if (!pass.ok) {
    process.stdout.write(JSON.stringify({ ok: false, code: pass.code }) + '\n');
    process.exitCode = 4;
    return;
  }
  let store = { [CANDIDATES_KEY]: [] };
  try { store = JSON.parse(readFileSync(storePath, 'utf8')); } catch { store = { [CANDIDATES_KEY]: [] }; }
  const merged = mergeIntoStore(store[CANDIDATES_KEY], pass.admitted);
  store[CANDIDATES_KEY] = merged.list;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
  if (statePath) writeFileSync(statePath, JSON.stringify(pass.triggerState, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify({ ok: true, received: pass.received, admitted: pass.admitted.length,
    refused: pass.refused, added: merged.added, stored: merged.list.length,
    pageDelivery: 'unknown', deliverable: false }) + '\n');
}

// T265: exact-path identity, never a suffix test on the basename. The previous
// `new URL(import.meta.url).pathname.endsWith(basename)` form ran `main()` whenever an importer's own file name
// happened to be a suffix of this one (`intake.mjs`), and `main()` spawns the host and writes the candidate store
// and trigger state. Same form as `relay_service.mjs` / `host_ingest.mjs` / `bridge_loop_acceptance.mjs`.
const invokedDirectly = typeof process.argv[1] === 'string'
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
