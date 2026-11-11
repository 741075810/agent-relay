// A read-only answer to one question: what does the persisted ledger prove about this
// exact request?
//
// It proves only what it recorded. Four classifications, and the weakest one is not a
// negative: `NO_RECORD_LEGACY_AMBIGUOUS` means this ledger holds no row for the request,
// which is not evidence that no Host, no other writer and no older ledger ever admitted it.
// Callers may use `PROVEN_UNSENT` to skip a duplicate prompt. Nothing else may be read as
// permission, and nothing here writes, locks, repairs or re-derives a missing row.
//
// It also cannot speak for the Host: every fact below is local ledger state. Host-wide
// writer fencing is a separate, unresolved question and this module never claims it.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isProvablyUnsent } from './store.mjs';

const STATE_VERSION = 1;
const PROMPT_STAGES = Object.freeze(['host_prompt_sent', 'host_reprompt_sent']);
const ABSENCE_NOTE = 'absence_of_a_record_is_not_evidence_that_nothing_was_admitted';

export const CLASSIFICATIONS = Object.freeze({
  PROVEN_UNSENT: 'PROVEN_UNSENT',
  SENT_OR_UNCERTAIN: 'SENT_OR_UNCERTAIN',
  EXACT_COMPLETED: 'EXACT_COMPLETED',
  NO_RECORD_LEGACY_AMBIGUOUS: 'NO_RECORD_LEGACY_AMBIGUOUS',
});

function stageNames(row) {
  return Array.isArray(row?.stages) ? row.stages.map((step) => (step && step.stage) || null) : [];
}

function facts(row, query, ledger) {
  const stages = stageNames(row);
  return {
    readOnly: true,
    ledger,
    present: Boolean(row),
    requestId: query.requestId ?? null,
    querySessionId: query.sessionId ?? null,
    expectedPromptSha256: query.promptSha256 ?? null,
    taskId: row?.taskId ?? null,
    rowSessionId: row?.sessionId ?? null,
    rowRequestId: row?.requestId ?? null,
    promptSha256: row?.promptSha256 ?? null,
    reservationProtocol: row?.reservation?.protocol ?? null,
    state: row?.state ?? null,
    unknownReason: row?.unknownReason ?? null,
    stages,
    promptAttempted: stages.some((name) => PROMPT_STAGES.includes(name)),
    terminalEvidence: null,
  };
}

/**
 * Classify one persisted row. `query.sessionId` and `query.promptSha256` are expectations,
 * not inputs to be reconciled: a mismatch makes the answer ambiguous, never PROVEN_UNSENT.
 */
export function classifyAdmission(row, query = {}, ledger = 'read') {
  const view = facts(row, query, ledger);
  const ambiguous = (reason, note = null) => ({ ...view,
    classification: CLASSIFICATIONS.NO_RECORD_LEGACY_AMBIGUOUS, reason, note });

  if (!row) return ambiguous('no_ledger_row_for_request', ABSENCE_NOTE);
  if (query.requestId && row.requestId !== query.requestId) return ambiguous('row_request_id_mismatch');
  if (query.sessionId && row.sessionId !== query.sessionId) return ambiguous('request_belongs_to_another_session');
  if (query.promptSha256 && query.promptSha256 !== row.promptSha256) return ambiguous('prompt_digest_mismatch');
  if (isProvablyUnsent(row)) {
    return { ...view, classification: CLASSIFICATIONS.PROVEN_UNSENT, reason: 'reservation_recorded_before_first_prompt',
      note: 'no prompt stage exists on a row whose reservation was written durably first' };
  }
  if (row.state === 'succeeded' && typeof row.turnId === 'string' && row.turnId.length
      && view.stages.includes('state_succeeded')) {
    return { ...view, classification: CLASSIFICATIONS.EXACT_COMPLETED, reason: 'succeeded_with_turn',
      terminalEvidence: { turnId: row.turnId, state: 'succeeded',
        admissionSeq: row.result?.admission?.seq ?? null, collectedPolls: row.result?.polls ?? null } };
  }
  // Everything else -- running, unsettled, unknown, failed, and any row old enough to lack
  // the reservation marker -- may have reached the Host. Fail closed, and say which.
  return { ...view, classification: CLASSIFICATIONS.SENT_OR_UNCERTAIN,
    reason: 'state_' + String(row.state) + (view.promptAttempted ? '_after_prompt_call' : '') };
}

function readDocument(path) {
  let raw;
  try {
    raw = readFileSync(path);
  } catch (error) {
    return { ledger: error && error.code === 'ENOENT' ? 'absent' : 'unreadable', doc: null,
      code: error && error.code === 'ENOENT' ? 'ledger_file_absent' : 'ledger_unreadable' };
  }
  let doc;
  try { doc = JSON.parse(raw.toString('utf8')); }
  catch { return { ledger: 'invalid', doc: null, code: 'ledger_invalid' }; }
  if (!doc || doc.version !== STATE_VERSION || !Array.isArray(doc.tasks)
    || typeof doc.requestIds !== 'object' || doc.requestIds === null) {
    return { ledger: 'invalid', doc: null, code: 'ledger_invalid' };
  }
  return { ledger: 'read', doc, code: null };
}

/** Read `tasks.json` and answer for one request. Opens the file for reading and nothing else. */
export function readAdmission(stateDir, query = {}) {
  const path = join(resolve(stateDir), 'tasks.json');
  const loaded = readDocument(path);
  if (!loaded.doc) {
    // An unreadable or absent ledger is not an empty one.
    return { ...classifyAdmission(null, query, loaded.ledger), path, code: loaded.code };
  }
  const map = loaded.doc.requestIds;
  const taskId = query.requestId && Object.hasOwn(map, query.requestId) ? map[query.requestId] : null;
  const row = taskId ? loaded.doc.tasks.find((task) => task && task.taskId === taskId) ?? null : null;
  return { ...classifyAdmission(row, query, 'read'), path,
    code: taskId && !row ? 'ledger_row_missing' : null };
}
