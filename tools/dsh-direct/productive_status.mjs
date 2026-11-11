// The read-only status a future 24/7 owner would ask for before doing anything.
//
// `resumeCampaign()` answers from the campaign journal alone. This adds the one other
// source that can say something exact about a reserved dispatch -- the task ledger the
// dispatching process itself wrote -- and nothing else. It never turns a blocked campaign
// into a dispatchable one: a reserved request stays blocked whether the ledger knows it,
// does not know it, or cannot be read, because "the ledger says nothing" and "the ledger
// could not be read" are different facts and neither is proof that the request was never
// admitted.
//
// Writes nothing. No ledger repair, no journal append, no campaign creation.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resumeCampaign } from './productive_resume.mjs';

const STATE_VERSION = 1;

function observe(stateDir, requestId) {
  const path = join(resolve(stateDir), 'tasks.json');
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // Absent file and unreadable file must not collapse into one message.
    return error && error.code === 'ENOENT'
      ? { status: 'absent', code: 'ledger_file_absent', path, requestKnown: null, observed: null }
      : { status: 'unreadable', code: 'ledger_unreadable', path, requestKnown: null, observed: null };
  }
  if (!doc || doc.version !== STATE_VERSION || !Array.isArray(doc.tasks)
    || typeof doc.requestIds !== 'object' || doc.requestIds === null) {
    return { status: 'unreadable', code: 'ledger_invalid', path, requestKnown: null, observed: null };
  }
  const view = { status: 'read', code: null, path, tasks: doc.tasks.length,
    requestKnown: null, observed: null };
  if (!requestId) return view;
  const taskId = Object.hasOwn(doc.requestIds, requestId) ? doc.requestIds[requestId] : null;
  view.requestKnown = typeof taskId === 'string';
  if (!view.requestKnown) return view;
  const task = doc.tasks.find(row => row && row.taskId === taskId) ?? null;
  if (!task) { view.code = 'ledger_row_missing'; return view; }
  view.observed = { requestId, taskId, state: task.state ?? null,
    requiresReconcile: task.requiresReconcile ?? null, turnId: task.turnId ?? null,
    unknownReason: task.unknownReason ?? null };
  return view;
}

/**
 * Journal state plus whatever the task ledger can say about the blocked request.
 *
 * `blocked` is non-null exactly when some request may have been admitted without a
 * recorded terminal; `ledger.observed` then says what the ledger knows about that exact
 * requestId, and `dispatchAllowed` is still false either way.
 */
export function campaignStatus({ campaignDir, stateDir = null } = {}) {
  const view = resumeCampaign(campaignDir);
  const out = { ...view, blocked: null, ledger: { status: 'not_requested', path: null,
    requestKnown: null, observed: null } };
  if (view.code === 'reservation_unsettled') {
    out.blocked = { code: view.code, requestId: view.requestId ?? null, pending: view.pending === true };
  }
  if (!stateDir) return out;
  out.ledger = observe(stateDir, out.blocked?.requestId ?? null);
  if (out.blocked && out.ledger.observed) out.blocked.ledgerState = out.ledger.observed.state;
  return out;
}
