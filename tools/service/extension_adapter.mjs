#!/usr/bin/env node
// T204: Relay records -> the shape the extension's auto-trigger already consumes, checked against that module itself.
//
// The adapter reads `/extension/terminal-candidates` from the local service and puts every candidate through the
// extension's **own** admission function (`extension/lib/terminal_trigger.js`, `admit`). Nothing here sends anything,
// binds anything or arms anything: it answers one question -- "would the existing consumer accept this candidate, and
// if not, which code does it refuse with" -- so a mismatch between the mirror and the consumer is found here instead
// of in a page write.
//
// Two facts it must not soften: `interrupted` is a real terminal status for the host but is *not* in the extension's
// `ALLOWED_STATUS`, and a host ack never means the page received anything (`pageDelivery` stays `unknown`).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTriggerState, admit } from '../../extension/lib/terminal_trigger.js';

export const DEFAULT_LEDGER = Object.freeze({ seen: {}, windowCount: 0, windowStartedAt: null,
  lastSentAt: null, triggers: 0, pendingAttempt: null });

/** A trigger state that is enabled but otherwise untouched: the consumer's own starting point. */
export function armedProbeState() {
  return { ...createTriggerState(), enabled: true, armedAt: Date.now() };
}

/** Run the extension's admission over one candidate, with its own state advanced so dedup is tested, not bypassed. */
export function admitAll(candidates, now = Date.now()) {
  let state = armedProbeState();
  const admitted = [];
  const refused = [];
  for (const candidate of candidates) {
    const verdict = admit(state, candidate, now);
    if (verdict && verdict.admit === true) {
      admitted.push({ runId: candidate.runId, status: candidate.status, next: verdict.next || null });
      if (verdict.state) state = verdict.state;
      else state = { ...state, seen: { ...(state.seen || {}),
        [candidate.runId + '|' + candidate.status]: now } };
    } else {
      refused.push({ runId: candidate.runId || null, status: candidate.status || null,
        code: (verdict && verdict.code) || 'unknown' });
    }
  }
  return { admitted, refused };
}

export async function fetchCandidates(serviceUrl, tokenFile) {
  const token = readFileSync(tokenFile, 'utf8').trim();
  const response = await fetch(serviceUrl.replace(/\/+$/, '') + '/extension/terminal-candidates', {
    headers: { authorization: 'Bearer ' + token },
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
  const serviceUrl = value('--service-url');
  const tokenFile = value('--service-token-file');
  if (!serviceUrl || !tokenFile) {
    process.stderr.write('usage: extension_adapter.mjs --service-url <url> --service-token-file <file>\n');
    process.exitCode = 2;
    return;
  }
  let response;
  try {
    response = await fetchCandidates(serviceUrl, tokenFile);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'service_unreachable',
      detail: String(err && err.message ? err.message : err) }) + '\n');
    process.exitCode = 3;
    return;
  }
  if (response.status !== 200) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'service_refused', status: response.status }) + '\n');
    process.exitCode = 3;
    return;
  }
  const candidates = response.body.candidates || [];
  const verdict = admitAll(candidates);
  process.stdout.write(JSON.stringify({
    ok: true,
    source: response.body.source,
    received: candidates.length,
    admitted: verdict.admitted.length,
    refused: verdict.refused.length,
    admittedRuns: verdict.admitted.map((item) => ({ runId: item.runId, status: item.status })),
    refusedRuns: verdict.refused,
    pageDelivery: 'unknown',
    deliverable: false,
  }) + '\n');
}

// T265: exact-path identity; the basename suffix test made `adapter.mjs` run `main()`, which issues an
// authenticated request to the local service, merely by importing `admitAll` from this module.
const invokedDirectly = typeof process.argv[1] === 'string'
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
