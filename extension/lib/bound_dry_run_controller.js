// T054 orchestration: join the T053 binding to one *simulated* terminal event
// and produce a read-only review decision.
//
// Deliberate properties:
//   - the only input from Chrome's tab world is T053's read-only health probe;
//   - the event is supplied by the caller and never read from the Native Host;
//   - history is stored in session storage so a page reload of the popup cannot
//     silently re-propose the same event; Chrome restart clears it by design;
//   - no function here authorizes a page write or a message send.

import {
  createProposalId,
  evaluateBoundDryRun,
  validateSimulatedEvent,
} from './bound_dry_run.js';

export const DRY_RUN_HISTORY_KEY = 't054DryRunHistory';
export const MAX_HISTORY = 50;

function issue(code) {
  return { code };
}

function historyValid(value) {
  if (!Array.isArray(value)) return false;
  return value.every((item) => item && item.kind === 't054-dry-run' &&
    typeof item.runId === 'string' && typeof item.status === 'string' &&
    typeof item.proposalId === 'string' && Number.isSafeInteger(item.at));
}

export function createBoundDryRunController(api, options = {}) {
  const now = options.now || Date.now;
  const targetBinding = options.targetBinding;
  const session = options.session || (api && api.session);
  let tail = Promise.resolve();

  if (!targetBinding || typeof targetBinding.getState !== 'function' ||
      typeof targetBinding.health !== 'function') {
    throw new TypeError('bound dry-run needs the T053 target binding controller');
  }

  async function readHistory() {
    if (!session || typeof session.get !== 'function' ||
        typeof session.set !== 'function') {
      throw new Error('session_storage_unavailable');
    }
    const stored = await session.get({ [DRY_RUN_HISTORY_KEY]: [] });
    const value = stored[DRY_RUN_HISTORY_KEY];
    if (value === null || value === undefined) return [];
    if (!historyValid(value)) throw new Error('dry_run_history_invalid');
    return value;
  }

  function mutateHistory(mutator) {
    const operation = tail.then(async () => {
      const current = await readHistory();
      const changed = await mutator(current);
      if (!changed || changed.save === false) return changed && changed.value;
      await session.set({
        [DRY_RUN_HISTORY_KEY]: changed.history.slice(-MAX_HISTORY),
      });
      return changed.value;
    });
    tail = operation.catch(() => {});
    return operation;
  }

  function nextSequence(history, runId, status) {
    let max = 0;
    const prefix = 'dryrun-' + runId + '-' + status + '-';
    for (const item of history) {
      if (typeof item.proposalId === 'string' &&
          item.proposalId.startsWith(prefix)) {
        const parsed = Number(item.proposalId.slice(prefix.length));
        if (Number.isSafeInteger(parsed) && parsed > max) max = parsed;
      }
    }
    return max + 1;
  }

  async function state() {
    try {
      await tail;
      const history = await readHistory();
      return { ok: true, history,
        accountIdentity: 'unverified', sendEligible: false,
        pageWriteEligible: false };
    } catch (err) {
      return { ok: false,
        status: err && err.message === 'dry_run_history_invalid'
          ? 'dry_run_history_invalid' : 'session_storage_unavailable',
        history: [], accountIdentity: 'unverified', sendEligible: false,
        pageWriteEligible: false };
    }
  }

  async function run(event) {
    const callTail = tail;
    const valid = validateSimulatedEvent(event);
    if (!valid.ok) {
      return { ok: false, status: 'event_invalid', issues: valid.issues,
        sendEligible: false, pageWriteEligible: false,
        accountIdentity: 'unverified' };
    }
    await callTail;
    let history;
    try {
      history = await readHistory();
    } catch (err) {
      return { ok: false,
        status: err && err.message === 'dry_run_history_invalid'
          ? 'dry_run_history_invalid' : 'session_storage_unavailable',
        sendEligible: false, pageWriteEligible: false,
        accountIdentity: 'unverified' };
    }

    let bindingState;
    let health;
    try {
      bindingState = await targetBinding.getState();
      if (!bindingState || bindingState.ok !== true ||
          !bindingState.binding) {
        health = null;
      } else {
        health = await targetBinding.health();
      }
    } catch (_err) {
      bindingState = { ok: false, status: 'binding_state_invalid', binding: null };
      health = null;
    }

    const proposalId = typeof event.proposalId === 'string' && event.proposalId
      ? event.proposalId
      : createProposalId(event.runId, event.status,
        nextSequence(history, event.runId, event.status));
    if (!proposalId) {
      return { ok: false, status: 'proposal_id_invalid',
        sendEligible: false, pageWriteEligible: false,
        accountIdentity: 'unverified' };
    }

    const evaluatedAt = now();
    const decision = evaluateBoundDryRun({
      now: evaluatedAt,
      binding: bindingState && bindingState.ok === true
        ? bindingState.binding : null,
      health,
      event: { runId: event.runId, status: event.status, proposalId },
      history,
    });
    decision.ok = true;
    decision.bindingStatus = bindingState && bindingState.status
      ? bindingState.status : 'binding_unavailable';
    decision.historyRecorded = false;
    decision.historyError = null;

    if (decision.reviewAllowed) {
      try {
        const stored = await mutateHistory((current) => {
          const duplicate = current.some((item) =>
            item.runId === event.runId && item.status === event.status);
          if (duplicate) {
            return { save: false, value: {
              recorded: false, duplicate: true,
              proposalId,
            } };
          }
          if (current.some((item) => item.proposalId === proposalId)) {
            return { save: false, value: {
              recorded: false, duplicate: true,
              collision: true,
              proposalId,
            } };
          }
          return {
            history: current.concat([{
              kind: 't054-dry-run',
              runId: event.runId,
              status: event.status,
              proposalId,
              at: evaluatedAt,
            }]),
            value: { recorded: true, duplicate: false, proposalId },
          };
        });
        if (stored.duplicate) {
          decision.reviewAllowed = false;
          decision.blocked = true;
          decision.reasons = decision.reasons.concat([stored.collision
            ? 'proposal_id_collision' : 'duplicate_event']);
          decision.issues = decision.issues.concat([issue(stored.collision
            ? 'proposal_id_collision' : 'duplicate_event')]);
          decision.note = 'blocked_no_send_or_page_write';
        }
        decision.historyRecorded = stored.recorded === true;
      } catch (_err) {
        // A review that cannot be recorded must not look repeatable.
        decision.reviewAllowed = false;
        decision.blocked = true;
        decision.reasons = decision.reasons.concat(['review_history_unavailable']);
        decision.issues = decision.issues.concat(
          [issue('review_history_unavailable')]);
        decision.historyError = 'review_history_unavailable';
        decision.note = 'blocked_no_send_or_page_write';
      }
    }

    decision.sendEligible = false;
    decision.wouldSend = false;
    decision.pageWriteEligible = false;
    decision.accountIdentity = 'unverified';
    decision.deliveryReceipt = 'unsupported';
    return decision;
  }

  return { run, state };
}
