// Read-only, idempotent view of an interrupted campaign.
//
// `openCampaign()` is exclusive on purpose: a fresh start must refuse an existing
// campaign, because the evidence of what was already admitted is the only thing that
// stops a double submit. That left an operator whose campaign was interrupted with one
// option -- abandon the evidence and lose the campaign. This module supplies the other
// one, without weakening the exclusive creation: it only reads.
//
// It writes nothing. No `mkdir`, no `'wx'` creation, no append, no truncation, no repair.
// It trusts exactly what was persisted: immutable request/task/turn IDs and the plan, never
// timing, prompt text or "it looks like the same task".
//
// A job whose dispatch was reserved but never observed as terminal stays unresumable,
// because that request may have been admitted. Dependent work is admitted only after the
// exact terminal was recorded for the job before it.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from './productive_manifest.mjs';
import { readControl } from './productive_state.mjs';

// The same code `admissionGate()` returns. Kept as a literal rather than imported so this
// module cannot be used to build a dispatch path; `test_t348_campaign_resume.mjs` asserts
// the two strings are still equal, so a future gate change cannot silently diverge.
export const DISPATCH_GATE = 'writer_fencing_unavailable';

const STAGES = new Set(['activation', 'control_observed', 'source_completed', 'admissible',
  'dispatch_reserved', 'receipt_observed', 'terminal', 'artifact_verified',
  'campaign_verified', 'stopped']);
const TERMINAL_STATE = 'succeeded';
const REQUEST = /^productive-[a-f0-9]{64}$/;
const TASK = /^dshd-[a-f0-9]{16}$/;

function read(file) {
  return readFileSync(file, 'utf8');
}

function refuse(code, extra) {
  return { ok: false, code, resumable: false, dispatchAllowed: false,
    gate: DISPATCH_GATE, ...extra };
}

function journal(root, planSha256) {
  const text = read(join(root, 'events.jsonl'));
  const rows = [];
  let expected = 1;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let row;
    try { row = JSON.parse(line); } catch { return { code: 'journal_unparsable' }; }
    if (!row || typeof row.stage !== 'string' || !STAGES.has(row.stage)) {
      return { code: 'journal_unrecognised_stage', detail: row?.stage ?? null };
    }
    // A row from another generation of this campaign is not evidence about this one.
    if (typeof row.planSha256 !== 'string' || row.planSha256 !== planSha256) {
      return { code: 'journal_foreign_generation', sequence: row.sequence ?? null };
    }
    if (row.sequence !== expected) return { code: 'journal_sequence_gap', expected };
    expected += 1;
    rows.push(row);
  }
  return { rows };
}

function identity(row, field) {
  const value = row?.[field];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * What is known about one campaign directory, and whether work may continue in it.
 *
 * Returns `{ok, code, resumable, dispatchAllowed, gate, campaignId, planSha256, settled,
 * alreadyAdmitted, nextJobIndex, control, awaiting}`. `dispatchAllowed` is always false:
 * this module reports state, and `writer_fencing_unavailable` still blocks every dispatch.
 *
 * Codes: `ready`, `paused`, `campaign_complete`, `operator_stop`, `plan_unreadable`,
 * `control_invalid`, `journal_missing`, `journal_unparsable`,
 * `journal_unrecognised_stage`, `journal_foreign_generation`, `journal_sequence_gap`,
 * `plan_invalid`, `reservation_unsettled`, `ambiguous_pending`,
 * `terminal_identity_mismatch`.
 */
export function resumeCampaign(directory) {
  const root = resolve(directory);
  let plan;
  try { plan = JSON.parse(read(join(root, 'plan.json'))); } catch { return refuse('plan_unreadable'); }
  if (!plan || typeof plan !== 'object' || typeof plan.campaignId !== 'string'
    || !/^[a-z0-9-]{1,64}$/.test(plan.campaignId)) return refuse('plan_invalid');
  let control;
  try { control = readControl(join(root, 'control.json')); } catch { return refuse('control_invalid'); }
  const planSha256 = sha256(JSON.stringify(plan));
  let scanned;
  try { scanned = journal(root, planSha256); } catch (error) {
    return refuse(error.code === 'ENOENT' ? 'journal_missing' : 'journal_unreadable');
  }
  if (scanned.code) return refuse(scanned.code, { detail: scanned.detail ?? null });
  const rows = scanned.rows;
  const campaign = { campaignId: plan.campaignId, planSha256, control };
  // An operator stop is honoured before any evidence is interpreted: it must not matter
  // whether the campaign looks resumable.
  if (control.mode === 'stop') return refuse('operator_stop', campaign);

  const byRequest = new Map();
  for (const row of rows) {
    const requestId = identity(row, 'requestId');
    if (!requestId) continue;
    if (!REQUEST.test(requestId)) return refuse('journal_request_invalid', campaign);
    const seen = byRequest.get(requestId) ?? { requestId, reserved: null, receipt: null, terminal: null, verified: null };
    if (row.stage === 'dispatch_reserved') seen.reserved = row;
    if (row.stage === 'receipt_observed') seen.receipt = row;
    if (row.stage === 'terminal') seen.terminal = row;
    if (row.stage === 'artifact_verified') seen.verified = row;
    byRequest.set(requestId, seen);
  }
  const planned = Array.isArray(plan.jobs) ? plan.jobs : [];
  const order = planned.length ? planned.map(job => job.requestId)
    : [...byRequest.keys()];

  const settled = [], alreadyAdmitted = [];
  let next = null, unsettled = null, mismatched = null;
  for (const [index, requestId] of order.entries()) {
    const job = byRequest.get(requestId) ?? { requestId };
    // Any reservation is an admission, whether or not it was observed. Never replayed.
    if (job.reserved || job.receipt) alreadyAdmitted.push(requestId);
    if (job.terminal) {
      const turnId = identity(job.terminal, 'turnId');
      const receiptTurn = job.receipt ? identity(job.receipt, 'turnId') : null;
      const taskId = job.receipt ? identity(job.receipt, 'taskId') : null;
      if (job.terminal.state !== TERMINAL_STATE || !turnId || !receiptTurn || turnId !== receiptTurn
        || (taskId && !TASK.test(taskId)) || !job.terminal.admission) {
        mismatched = mismatched ?? requestId;
        continue;
      }
      settled.push(requestId);
      continue;
    }
    if (job.reserved || job.receipt) { unsettled = unsettled ?? requestId; continue; }
    if (next === null) next = index;
    continue;
  }
  const last = rows.at(-1);
  // A stop that left a dispatch in flight is the one case where "reserved" and "admitted"
  // are not distinguishable from this evidence; it stays refused as well.
  const ambiguous = rows.some(row => row.stage === 'stopped' && row.pending === true);
  const base = { ...campaign, settled, alreadyAdmitted, nextJobIndex: next,
    lastStage: last ? last.stage : null };

  if (mismatched) return refuse('terminal_identity_mismatch', { ...base, requestId: mismatched });
  if (rows.some(row => row.stage === 'campaign_verified')) {
    // Idempotent: re-running a finished campaign does nothing and admits nothing.
    return { ok: true, code: 'campaign_complete', resumable: false, dispatchAllowed: false,
      gate: DISPATCH_GATE, ...base };
  }
  if (unsettled || ambiguous) {
    // `pending` is true whenever a dispatch may have been admitted: an unsettled
    // reservation is one by definition, and a stop row that recorded `pending` says the
    // same thing from the other direction.
    return refuse('reservation_unsettled',
      { ...base, requestId: unsettled, pending: Boolean(unsettled) || ambiguous });
  }
  if (control.mode === 'pause') {
    return { ok: true, code: 'paused', resumable: true, dispatchAllowed: false,
      gate: DISPATCH_GATE, awaiting: 'control mode run', ...base };
  }
  return { ok: true, code: 'ready', resumable: true, dispatchAllowed: false,
    gate: DISPATCH_GATE, ...base };
}
