#!/usr/bin/env node
// T202: the Native Host -> AgentRelay sidecar.
//
// The host already publishes, read-only, what its terminal source saw: `terminal-source.json` (pending / acked /
// baseline run ids), `terminal-origin.json` (where those ids came from, e.g. `bridge-sqlite`) and
// `terminal-arm.json` (the consent snapshot). This process reads those files and forwards each run id to the local
// service with its host-reported state. It reads nothing else, writes nothing into the host's directory, and never
// talks to Chrome, the Bridge or DSH.
//
// What it must not pretend: a host ack means the host stored a candidate. It is not page delivery, it is not a DSH
// result, and this process does not create tasks. Every record it forwards carries `origin: native_host`.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const HOST_SOURCES = Object.freeze({
  source: 'native_host.terminal-source',
  origin: 'native_host.terminal-origin',
  arm: 'native_host.terminal-arm',
});
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/;
const MAX_PER_PUSH = 200;

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), problem: null };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { value: null, problem: 'absent' };
    return { value: null, problem: 'unreadable' };
  }
}

const ids = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string' && RUN_ID.test(id)) : []);

/**
 * Build the candidate list from the host artifacts. States are the host's own vocabulary:
 * `pending` (offered, not acknowledged), `acked` (host stored it), `baseline` (present before the baseline was taken).
 */
export function candidatesFromHostState(hostStateDir) {
  const dir = resolve(hostStateDir);
  const source = readJson(join(dir, 'terminal-source.json'));
  const origin = readJson(join(dir, 'terminal-origin.json'));
  const arm = readJson(join(dir, 'terminal-arm.json'));

  if (source.problem === 'absent' && origin.problem === 'absent' && arm.problem === 'absent') {
    return { ok: false, code: 'host_state_absent', dir, candidates: [], notes: {} };
  }
  if (source.problem === 'unreadable') {
    return { ok: false, code: 'host_state_unreadable', dir, candidates: [], notes: {} };
  }

  const seen = new Set();
  const candidates = [];
  const push = (runId, state, hostSource) => {
    if (seen.has(runId)) return;
    seen.add(runId);
    candidates.push({ runId, state, hostSource });
  };

  for (const runId of ids(source.value && source.value.pendingIds)) push(runId, 'pending', HOST_SOURCES.source);
  for (const runId of ids(source.value && source.value.ackedIds)) push(runId, 'acked', HOST_SOURCES.source);
  for (const runId of ids(source.value && source.value.baselineIds)) push(runId, 'baseline', HOST_SOURCES.source);
  for (const runId of ids(arm.value && arm.value.ids)) push(runId, 'acknowledged_to_arm', HOST_SOURCES.arm);

  return {
    ok: true,
    code: null,
    dir,
    // The origin file says where the host got its ids; it is forwarded as metadata, never invented.
    origin: origin.value && typeof origin.value.source === 'string' ? origin.value.source : null,
    candidates: candidates.filter((item) => item.state !== 'acknowledged_to_arm')
      .concat(candidates.filter((item) => item.state === 'acknowledged_to_arm')
        .map((item) => ({ ...item, state: 'baseline' })))
      .slice(0, MAX_PER_PUSH),
    notes: { source: source.problem, origin: origin.problem, arm: arm.problem },
  };
}

async function push(serviceUrl, tokenFile, batch) {
  const token = readFileSync(tokenFile, 'utf8').trim();
  const response = await fetch(serviceUrl.replace(/\/+$/, '') + '/host/candidates', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ candidates: batch.candidates, hostOrigin: batch.origin }),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
  const hostState = value('--host-state');
  const serviceUrl = value('--service-url');
  const tokenFile = value('--service-token-file');
  if (!hostState || !serviceUrl || !tokenFile) {
    process.stderr.write('usage: host_ingest.mjs --host-state <dir> --service-url <url> --service-token-file <file>\n');
    process.exitCode = 2;
    return;
  }
  const pollMs = Number(value('--poll-ms') || 0);
  const once = argv.includes('--once') || !pollMs;

  const run = async () => {
    const batch = candidatesFromHostState(hostState);
    if (!batch.ok) {
      process.stdout.write(JSON.stringify({ ok: false, code: batch.code, dir: batch.dir }) + '\n');
      return 4; // fail closed: absent or unreadable host state is reported, never guessed at
    }
    try {
      const result = await push(serviceUrl, tokenFile, batch);
      process.stdout.write(JSON.stringify({ ok: result.status === 200, status: result.status,
        candidates: batch.candidates.length, origin: batch.origin,
        accepted: result.body.accepted ? result.body.accepted.length : 0,
        rejected: result.body.rejected || [] }) + '\n');
      return result.status === 200 ? 0 : 3;
    } catch (err) {
      process.stdout.write(JSON.stringify({ ok: false, code: 'service_unreachable',
        detail: String(err && err.message ? err.message : err) }) + '\n');
      return 3;
    }
  };

  if (once) {
    process.exitCode = await run();
    return;
  }
  process.stdout.write(JSON.stringify({ started: true, pollMs }) + '\n');
  for (;;) {
    await run();
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedDirectly) main();
