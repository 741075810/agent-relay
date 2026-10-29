// T055: metadata-only review of legacy display records. No provenance verifier
// exists in this schema; neither labels nor caller-supplied claims confer trust.
import { evaluateBoundDryRun, validateSimulatedEvent } from './bound_dry_run.js';
import { assessBindingHealth } from './target_binding.js';
import { probeSpecificTab } from './readonly_preflight.js';

export const SELECTION_TTL_MS = 60000;
export const RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const META = ['eventId', 'name', 'runId', 'status', 'createdAt', 'receivedAt'];
const RECORD_KEYS = new Set([...META, 'message', 'replay']);
const IDENTITY = ['version', 'revision', 'boundAt', 'tabId', 'windowId', 'url',
  'conversationId', 'documentInstanceId', 'manuallyConfirmed', 'accountVerified',
  'invalidatedReason', 'invalidatedAt'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bindingKey = (b) => b ? IDENTITY.map((key) => b[key] ?? null) : null;
const flags = () => ({ reviewAllowed: false, blocked: true,
  provenance: 'unverified', eventKind: 'received_record_unverified',
  sendEligible: false, pageWriteEligible: false, wouldSend: false,
  accountIdentity: 'unverified', deliveryReceipt: 'unsupported',
  historyRecorded: false });
const refusal = (reason) => ({ ok: false, ...flags(), reasons: [reason] });

function metadata(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const out = {};
  for (const key of META) {
    const value = row[key];
    const patterns = {
      eventId: /^[A-Za-z0-9_.:-]{1,128}$/,
      runId: /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|sim-run-[0-9]{1,12})$/i,
      status: /^(completed|failed|cancelled|interrupted|aborted|running)$/,
      name: /^task\.(completed|failed|cancelled|interrupted|aborted|running)$/,
      createdAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
      receivedAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    };
    out[key] = typeof value === 'string' && patterns[key].test(value) ? value : null;
  }
  return out;
}
function recordReasons(row, now) {
  const reasons = [];
  if (Object.keys(row).some((key) => !RECORD_KEYS.has(key))) {
    reasons.push('record_fields_not_allowed');
  }
  const m = metadata(row);
  if (!m || META.some((key) => !m[key]) ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(m.eventId || '')) {
    reasons.push('record_metadata_invalid');
  }
  const event = validateSimulatedEvent({ runId: m?.runId, status: m?.status });
  if (!event.ok) reasons.push(...event.issues.map((item) => item.code));
  if (m?.name !== 'task.' + m?.status) reasons.push('record_name_status_mismatch');
  if (m?.status === 'interrupted') reasons.push('original_terminal_status_lost');
  const received = Date.parse(m?.receivedAt);
  const created = Date.parse(m?.createdAt);
  if (!Number.isFinite(received) || !Number.isFinite(created) ||
      received > now || created > received) reasons.push('record_timestamp_invalid');
  else if (now - received > RECORD_MAX_AGE_MS) reasons.push('record_expired');
  return reasons;
}

export function createReceivedReview({ readReceived, getBindingState,
  readDryRunState, tabs, now = Date.now, makeToken = () => crypto.randomUUID(),
  timeoutMs = 1500 }) {
  // Only transient selection capabilities are retained. No durable write API
  // is provided. A new list or a worker restart invalidates old selections.
  let selections = new Map();
  let generation = 0;
  let navigationEpoch = 0;
  const invalidate = () => { navigationEpoch += 1; };

  async function rows() {
    const value = await readReceived();
    if (!Array.isArray(value) || value.length > 100 ||
        value.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error('received_records_invalid');
    }
    return value;
  }
  async function list() {
    const ticket = ++generation;
    selections = new Map();
    try {
      const records = await rows();
      const state = await getBindingState();
      if (!state?.ok) return refusal('binding_state_unavailable');
      if (ticket !== generation) return refusal('list_superseded');
      const issuedAt = now();
      const items = records.map((row) => {
        const token = makeToken();
        const m = metadata(row);
        selections.set(token, { m, binding: bindingKey(state.binding), issuedAt,
          epoch: navigationEpoch, generation: ticket });
        return { token, ...m, source: 'extension_local_received',
          provenance: 'unverified', eventKind: 'received_record_unverified',
          reasons: ['provenance_unverified', ...recordReasons(row, issuedAt)] };
      });
      return { ok: true, ...flags(), items, generatedAt: issuedAt,
        selectionExpiresAt: issuedAt + SELECTION_TTL_MS };
    } catch (_err) { return refusal('received_or_binding_state_unavailable'); }
  }

  async function review(token) {
    if (typeof token !== 'string' || !selections.has(token)) {
      return refusal('selection_missing_consumed_or_worker_restarted');
    }
    const selected = selections.get(token);
    selections.delete(token); // Consume before the first await, including failures.
    const reasons = ['provenance_unverified'];
    const checkSelection = () => {
      if (now() < selected.issuedAt || now() - selected.issuedAt > SELECTION_TTL_MS) {
        reasons.push('selection_expired');
      }
      if (selected.generation !== generation) reasons.push('selection_superseded');
      if (selected.epoch !== navigationEpoch) reasons.push('target_context_changed');
    };
    checkSelection();
    try {
      const find = (records) => {
        const matches = records.filter((r) => r.eventId === selected.m.eventId);
        if (matches.length !== 1) {
          reasons.push(matches.length ? 'record_id_ambiguous' : 'record_missing');
          return null;
        }
        const row = matches[0];
        if (!same(metadata(row), selected.m)) reasons.push('record_changed');
        reasons.push(...recordReasons(row, now()));
        return row;
      };
      const row = find(await rows());
      const before = await getBindingState();
      if (!before?.ok) reasons.push('binding_state_unavailable');
      const binding = before?.ok ? before.binding : null;
      if (!same(bindingKey(binding), selected.binding)) reasons.push('binding_changed');
      if (binding && (!Number.isSafeInteger(binding.boundAt) || binding.boundAt < 0 ||
          binding.boundAt > now())) reasons.push('binding_timestamp_invalid');
      else if (binding && now() - binding.boundAt > RECORD_MAX_AGE_MS) reasons.push('binding_expired');
      let snapshot = null;
      // Invalid selections do not probe a page, but the pure policy still
      // explains missing/invalid bindings and malformed terminal metadata.
      if (row && binding && !binding.invalidatedReason && reasons.length === 1) {
        snapshot = await probeSpecificTab({ tabs }, binding, { now, timeoutMs });
      }
      find(await rows());
      const history = await readDryRunState();
      const after = await getBindingState();
      if (!after?.ok) reasons.push('binding_state_unavailable');
      if (!same(bindingKey(after?.binding), selected.binding)) reasons.push('binding_changed');
      if (!history?.ok || !Array.isArray(history.history)) reasons.push('review_history_unavailable');
      checkSelection();
      // Reassess freshness after all asynchronous reads (T053 uses 5 seconds).
      const health = assessBindingHealth(binding, snapshot, now());
      const decision = evaluateBoundDryRun({ now: now(), binding, health,
        event: { runId: selected.m.runId, status: selected.m.status },
        history: history?.ok ? history.history : [] });
      const all = [...new Set([...reasons, ...decision.reasons])];
      return { ok: true, ...flags(), record: selected.m,
        source: 'extension_local_received', createdAtMeaning: 'source_created_or_started_not_finished',
        target: decision.target, targetConsistent: health.ok === true &&
          !all.some((r) => ['binding_changed', 'target_context_changed'].includes(r)),
        bindingStatus: health.status, observedAt: decision.observedAt,
        evaluatedAt: now(), reasons: all, proposal: null,
        duplicate: all.includes('duplicate_event'),
        deduplication: history?.ok ? 't054_session_history_read_only' : 'unavailable' };
    } catch (_err) { return refusal('review_dependencies_unavailable'); }
  }
  return { list, review, invalidate };
}

export async function handleReceivedReviewMessage(controller, msg, sender, runtime) {
  if (!sender || sender.id !== runtime.id ||
      sender.url !== runtime.getURL('popup.html') || sender.tab) {
    return refusal('extension_popup_required');
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return refusal('request_invalid');
  const keys = msg.type === 't055-list' ? ['type'] : ['type', 'token'];
  if (Object.keys(msg).some((key) => !keys.includes(key))) return refusal('request_fields_not_allowed');
  if (msg.type === 't055-list') return controller.list();
  if (msg.type === 't055-review') return controller.review(msg.token);
  return refusal('unknown_t055_request');
}
