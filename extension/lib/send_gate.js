// Isolated, mock-only policy for a future user-approved send channel.
// This module is intentionally not imported by background.js and has no DOM,
// Chrome, network, tab-activation, or send API.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROPOSAL_CHANNEL = 'dsh-chat-send-proposal-v1';
const PROPOSAL_ID = /^[0-9a-f]{64}$/;
const ACCOUNT_FINGERPRINT = /^[0-9a-f]{64}$/;
const PROPOSAL_FIELDS = ['channel', 'proposalId', 'runId', 'status'];
const ALLOWED_ORIGINS = new Set([
  'https://chatgpt.com',
  'https://chat.openai.com',
]);
const STATUS_TO_NAME = Object.freeze({
  completed: 'task.completed',
  failed: 'task.failed',
  cancelled: 'task.interrupted',
});
const STATUS_LABEL = Object.freeze({
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
});
const APPROVAL_TTL_MS = 60 * 1000;
const PROBE_MAX_AGE_MS = 5000;
export const MAX_ITEMS = 1000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function refuse(code, detail) {
  return { ok: false, code, detail: detail || code };
}

function canonicalConversationUrl(url, conversationId) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return ALLOWED_ORIGINS.has(parsed.origin) &&
      parsed.pathname === '/c/' + conversationId &&
      parsed.search === '' && parsed.hash === '' &&
      parsed.username === '' && parsed.password === '' &&
      url === parsed.origin + parsed.pathname;
  } catch (_err) {
    return false;
  }
}

export function createSendState() {
  return {
    version: 1,
    enabled: false,
    revision: 0,
    binding: null,
    items: {},
    lastError: null,
  };
}

function validateBinding(input) {
  if (!input || typeof input !== 'object') {
    return refuse('binding_missing');
  }
  if (typeof input.conversationId !== 'string' ||
      !UUID.test(input.conversationId)) {
    return refuse('conversation_id_invalid');
  }
  if (!canonicalConversationUrl(input.url, input.conversationId)) {
    return refuse('conversation_url_mismatch');
  }
  if (!Number.isSafeInteger(input.tabId) || input.tabId < 0 ||
      !Number.isSafeInteger(input.windowId) || input.windowId < 0) {
    return refuse('tab_binding_invalid');
  }
  if (typeof input.accountFingerprint !== 'string' ||
      !ACCOUNT_FINGERPRINT.test(input.accountFingerprint)) {
    return refuse('account_identity_unavailable');
  }
  if (input.accountVerified !== true) {
    return refuse('account_identity_not_confirmed');
  }
  return { ok: true };
}

export function bindTarget(state, input, confirmation, userGesture) {
  const valid = validateBinding(input);
  if (!valid.ok) return { state, result: valid };
  if (userGesture !== true) {
    return { state, result: refuse('binding_user_gesture_required') };
  }
  if (confirmation !== 'BIND ' + input.conversationId) {
    return { state, result: refuse('binding_confirmation_mismatch') };
  }
  const next = clone(state || createSendState());
  next.revision += 1;
  next.enabled = false;
  next.binding = {
    conversationId: input.conversationId,
    url: input.url,
    tabId: input.tabId,
    windowId: input.windowId,
    accountFingerprint: input.accountFingerprint,
    accountVerified: true,
    manuallyConfirmed: true,
    revision: next.revision,
  };
  for (const item of Object.values(next.items)) {
    if (item.statusState === 'pending') {
      item.approval = null;
      item.bindingRevision = null;
    } else if (item.statusState === 'attempting') {
      item.statusState = 'ambiguous';
      item.ambiguousAt = Date.now();
      item.approval = null;
      item.reason = 'binding_changed_during_attempt; do not retry blindly';
    }
  }
  return { state: next, result: { ok: true, binding: next.binding } };
}

export function enableSending(state, confirmation, userGesture) {
  const next = clone(state || createSendState());
  if (!next.binding || !next.binding.manuallyConfirmed) {
    return { state, result: refuse('target_not_bound') };
  }
  if (userGesture !== true) {
    return { state, result: refuse('enable_user_gesture_required') };
  }
  if (confirmation !== 'ENABLE CHAT SEND') {
    return { state, result: refuse('enable_confirmation_mismatch') };
  }
  next.enabled = true;
  next.lastError = null;
  return { state: next, result: { ok: true, enabled: true } };
}

export function disableSending(state, now = Date.now()) {
  const next = clone(state || createSendState());
  next.enabled = false;
  next.lastError = null;
  for (const item of Object.values(next.items)) {
    item.approval = null;
    if (item.statusState === 'attempting') {
      item.statusState = 'ambiguous';
      item.ambiguousAt = now;
      item.reason = 'disabled_during_attempt';
    }
  }
  return { state: next, result: { ok: true, enabled: false } };
}

function validateProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return refuse('proposal_invalid');
  }
  const keys = Object.keys(proposal).sort();
  const expected = PROPOSAL_FIELDS.slice().sort();
  if (keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index])) {
    return refuse('proposal_fields_not_allowed');
  }
  if (proposal.channel !== PROPOSAL_CHANNEL) {
    return refuse('proposal_channel_invalid');
  }
  if (typeof proposal.proposalId !== 'string' ||
      !PROPOSAL_ID.test(proposal.proposalId)) {
    return refuse('proposal_id_invalid');
  }
  if (typeof proposal.runId !== 'string' || !UUID.test(proposal.runId)) {
    return refuse('run_id_invalid');
  }
  if (!Object.prototype.hasOwnProperty.call(STATUS_TO_NAME, proposal.status)) {
    return refuse('event_type_not_allowed');
  }
  return { ok: true };
}

export function createProposal(proposalId, runId, status) {
  const proposal = {
    channel: PROPOSAL_CHANNEL,
    proposalId,
    runId,
    status,
  };
  const valid = validateProposal(proposal);
  return valid.ok ? { ok: true, proposal } : valid;
}

export function fixedTemplate(proposal) {
  const valid = validateProposal(proposal);
  if (!valid.ok) return valid;
  const label = STATUS_LABEL[proposal.status];
  return {
    ok: true,
    text: 'DSH task ' + proposal.runId + ' ' + label + '.',
  };
}

export function addPending(state, proposal, now = Date.now()) {
  const valid = validateProposal(proposal);
  if (!valid.ok) return { state, result: valid };
  const template = fixedTemplate(proposal);
  const next = clone(state || createSendState());
  const existing = next.items[proposal.proposalId];
  if (existing) {
    if (existing.runId !== proposal.runId ||
        existing.status !== proposal.status) {
      return { state, result: refuse('proposal_id_collision') };
    }
    return { state, result: { ok: true, duplicate: true, item: existing } };
  }
  if (Object.keys(next.items).length >= MAX_ITEMS) {
    return { state, result: refuse('send_state_capacity_reached') };
  }
  next.items[proposal.proposalId] = {
    proposalId: proposal.proposalId,
    runId: proposal.runId,
    status: proposal.status,
    template: template.text,
    statusState: 'pending',
    attemptCount: 0,
    bindingRevision: null,
    approval: null,
    createdAt: now,
    lastPreflightFailure: null,
    reason: null,
  };
  return { state: next, result: { ok: true, duplicate: false,
    item: next.items[proposal.proposalId] } };
}

export function preflight(binding, reports, requestedTabId, now = Date.now()) {
  const valid = validateBinding(binding);
  if (!valid.ok || !binding.manuallyConfirmed) {
    return valid.ok ? refuse('target_not_manually_bound') : valid;
  }
  if (requestedTabId !== binding.tabId) return refuse('wrong_tab');
  if (!Array.isArray(reports)) return refuse('probe_unavailable');
  const matches = reports.filter((report) => report &&
    report.tabId === binding.tabId);
  if (matches.length !== 1) {
    return refuse(matches.length ? 'ambiguous_target_tab' : 'target_tab_unavailable');
  }
  const report = matches[0];
  if (!Number.isSafeInteger(report.observedAt) ||
      now - report.observedAt < 0 || now - report.observedAt > PROBE_MAX_AGE_MS) {
    return refuse('probe_stale');
  }
  if (report.windowId !== binding.windowId) return refuse('wrong_window');
  if (report.discarded === true) return refuse('target_discarded');
  if (report.url !== binding.url) return refuse('redirect_or_url_mismatch');
  if (report.conversationId !== binding.conversationId) {
    return refuse('conversation_identity_mismatch');
  }
  if (typeof report.accountFingerprint !== 'string') {
    return refuse('account_identity_unavailable');
  }
  if (report.accountFingerprint !== binding.accountFingerprint) {
    return refuse('account_identity_mismatch');
  }
  if (report.active !== true || report.hasFocus !== true ||
      report.visibilityState !== 'visible') {
    return refuse('target_not_visible_and_focused');
  }
  if (report.composerPresent !== true) return refuse('composer_unavailable');
  if (report.redirected === true) return refuse('page_redirected');
  return { ok: true, report: {
    tabId: report.tabId,
    windowId: report.windowId,
    conversationId: report.conversationId,
    observedAt: report.observedAt,
    url: report.url,
    active: true,
    visible: true,
    composerPresent: true,
    accountFingerprintMatched: true,
  } };
}

export function dryRun(state, proposal, reports, requestedTabId,
                       now = Date.now()) {
  const template = fixedTemplate(proposal);
  if (!template.ok) {
    return { ok: false, wouldSend: false, reason: template.code };
  }
  if (!state || !state.binding) {
    return { ok: true, wouldSend: false, eligible: false,
             reason: 'target_not_bound', template: template.text,
             stateWritten: false };
  }
  const check = preflight(state.binding, reports, requestedTabId, now);
  if (!check.ok) {
    return { ok: true, wouldSend: false, eligible: false,
             reason: check.code, template: template.text,
             stateWritten: false };
  }
  if (state.enabled !== true) {
    return { ok: true, wouldSend: false, eligible: false,
             reason: 'send_disabled', target: check.report,
             template: template.text, stateWritten: false };
  }
  const item = state.items && state.items[proposal.proposalId];
  if (!item) {
    return { ok: true, wouldSend: false, eligible: false,
             reason: 'proposal_not_pending', target: check.report,
             template: template.text, stateWritten: false };
  }
  if (item.statusState !== 'pending') {
    return { ok: true, wouldSend: false, eligible: false,
             reason: 'item_' + item.statusState, target: check.report,
             template: template.text, stateWritten: false };
  }
  return { ok: true, wouldSend: false, eligible: true,
           reason: 'dry_run_only_manual_approval_required',
           target: check.report, template: template.text,
           stateWritten: false };
}

export function approvePending(state, proposalId, confirmation, userGesture,
                               now = Date.now()) {
  const next = clone(state || createSendState());
  const item = next.items[proposalId];
  if (next.enabled !== true) return { state, result: refuse('send_disabled') };
  if (!next.binding || !next.binding.manuallyConfirmed) {
    return { state, result: refuse('target_not_bound') };
  }
  if (!item || item.statusState !== 'pending') {
    return { state, result: refuse('event_not_pending') };
  }
  if (userGesture !== true || confirmation !== 'SEND ' + item.runId) {
    return { state, result: refuse('manual_approval_required') };
  }
  item.bindingRevision = next.binding.revision;
  item.approval = {
    approvedAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    bindingRevision: next.binding.revision,
  };
  return { state: next, result: { ok: true, expiresAt: item.approval.expiresAt } };
}

export function beginAttempt(state, proposalId, probe, now = Date.now()) {
  const next = clone(state || createSendState());
  const item = next.items[proposalId];
  if (next.enabled !== true) return { state, result: refuse('send_disabled') };
  if (!item || item.statusState !== 'pending') {
    return { state, result: refuse('event_not_pending') };
  }
  const check = preflight(next.binding, probe && probe.reports,
                         probe && probe.requestedTabId, now);
  if (!check.ok) {
    item.lastPreflightFailure = { code: check.code, at: now };
    item.approval = null;
    item.bindingRevision = null;
    return { state: next, result: refuse(check.code) };
  }
  if (!item.approval || item.approval.expiresAt < now ||
      item.approval.bindingRevision !== next.binding.revision ||
      item.bindingRevision !== next.binding.revision) {
    item.approval = null;
    return { state: next, result: refuse('fresh_manual_approval_required') };
  }
  item.statusState = 'attempting';
  item.attemptCount += 1;
  item.attemptedAt = now;
  item.targetSnapshot = check.report;
  item.approval = null;
  // The caller must persist this state before any page write. This prototype
  // returns a template for simulation only; it has no transport adapter.
  return { state: next, result: { ok: true, started: true,
                                  template: item.template,
                                  target: check.report } };
}

export function finishAttempt(state, proposalId, evidence, now = Date.now()) {
  const next = clone(state || createSendState());
  const item = next.items[proposalId];
  if (!item || item.statusState !== 'attempting') {
    return { state, result: refuse('event_not_attempting') };
  }
  const binding = next.binding;
  const freshEvidence = evidence && Number.isSafeInteger(evidence.observedAt) &&
    evidence.observedAt >= item.attemptedAt && evidence.observedAt <= now &&
    now - evidence.observedAt <= PROBE_MAX_AGE_MS;
  const confirmed = binding && freshEvidence &&
    evidence.kind === 'confirmed' &&
    evidence.proposalId === item.proposalId && evidence.runId === item.runId &&
    evidence.conversationId === binding.conversationId &&
    evidence.tabId === binding.tabId &&
    evidence.windowId === binding.windowId &&
    evidence.url === binding.url &&
    evidence.accountFingerprint === binding.accountFingerprint &&
    evidence.visible === true && evidence.hasFocus === true &&
    evidence.exactTemplateMatched === true && evidence.composerEmpty === true;
  if (confirmed) {
    item.statusState = 'confirmed';
    item.confirmedAt = now;
    item.confirmation = 'matching target and exact user-message evidence';
    return { state: next, result: { ok: true, status: 'confirmed' } };
  }
  item.statusState = 'ambiguous';
  item.ambiguousAt = now;
  item.reason = (evidence && evidence.reason) ||
    (evidence && evidence.kind === 'timeout'
      ? 'confirmation_timeout; do not retry blindly'
      : 'send_outcome_unconfirmed; do not retry blindly');
  return { state: next, result: refuse('ambiguous', item.reason) };
}

export function recoverInterruptedAttempts(state, now = Date.now()) {
  const next = clone(state || createSendState());
  let recovered = 0;
  for (const item of Object.values(next.items)) {
    if (item.statusState === 'attempting') {
      item.statusState = 'ambiguous';
      item.ambiguousAt = now;
      item.reason = 'worker_restarted_during_attempt; do not retry blindly';
      item.approval = null;
      recovered += 1;
    }
  }
  return { state: next, result: { ok: true, recovered } };
}

export function probeReadOnly(documentLike, tab) {
  if (!documentLike || !tab || typeof documentLike.querySelectorAll !== 'function') {
    return refuse('probe_unavailable');
  }
  const url = String(documentLike.location && documentLike.location.href || '');
  let conversationId = null;
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/c\/([0-9a-f-]{36})$/i);
    conversationId = match ? match[1] : null;
  } catch (_err) {
    return refuse('page_url_invalid');
  }
  const selectors = [
    'div[contenteditable="true"][data-testid="prompt-textarea"]',
    'div[contenteditable="true"].ProseMirror',
    'textarea[data-testid="prompt-textarea"]',
    'form div[contenteditable="true"]',
  ];
  let composerPresent = false;
  for (const selector of selectors) {
    const nodes = documentLike.querySelectorAll(selector);
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) composerPresent = true;
    }
    if (composerPresent) break;
  }
  return {
    tabId: tab.tabId,
    windowId: tab.windowId,
    url,
    conversationId,
    accountFingerprint: tab.accountFingerprint || null,
    observedAt: Date.now(),
    active: tab.active === true,
    discarded: tab.discarded === true,
    visibilityState: documentLike.visibilityState,
    hasFocus: documentLike.hasFocus(),
    composerPresent,
    redirected: tab.redirected === true,
  };
}

// Storage adapter boundary for chrome.storage.local or an offline fake. All
// transitions are serialized and written under one key; no method sends pages.
export class PersistentSendPolicy {
  constructor(options) {
    const opts = options || {};
    if (typeof opts.get !== 'function' || typeof opts.set !== 'function') {
      throw new TypeError('PersistentSendPolicy needs get() and set()');
    }
    this.get = opts.get;
    this.set = opts.set;
    this.now = opts.now || (() => Date.now());
    this._tail = Promise.resolve();
  }

  async _read() {
    const stored = await this.get({ sendPolicyState: createSendState() });
    const state = stored.sendPolicyState || createSendState();
    if (state.version !== 1 || typeof state.enabled !== 'boolean' ||
        !state.items || typeof state.items !== 'object') {
      throw new Error('send policy state is corrupt; refusing to reset it');
    }
    return state;
  }

  _change(transition) {
    const current = this._tail.then(async () => {
      const before = await this._read();
      const changed = transition(before);
      if (changed.state !== before) {
        await this.set({ sendPolicyState: changed.state });
      }
      if (changed.result && changed.result.ok === true && changed.result.started) {
        return Object.assign({}, changed.result, { persisted: true });
      }
      return changed.result;
    });
    this._tail = current.catch(() => {});
    return current;
  }

  async snapshot() {
    await this._tail;
    return clone(await this._read());
  }

  bindTarget(input, confirmation, userGesture) {
    return this._change((state) => bindTarget(
      state, input, confirmation, userGesture));
  }

  enable(confirmation, userGesture) {
    return this._change((state) => enableSending(
      state, confirmation, userGesture));
  }

  disable() {
    return this._change((state) => disableSending(state, this.now()));
  }

  addPending(proposal) {
    return this._change((state) => addPending(state, proposal, this.now()));
  }

  approve(proposalId, confirmation, userGesture) {
    return this._change((state) => approvePending(
      state, proposalId, confirmation, userGesture, this.now()));
  }

  async dryRun(proposal, reports, requestedTabId) {
    await this._tail;
    const state = await this._read();
    return dryRun(state, proposal, reports, requestedTabId, this.now());
  }

  beginAttempt(proposalId, probe) {
    return this._change((state) => beginAttempt(
      state, proposalId, probe, this.now()));
  }

  finishAttempt(proposalId, evidence) {
    return this._change((state) => finishAttempt(
      state, proposalId, evidence, this.now()));
  }

  recoverInterruptedAttempts() {
    return this._change((state) => recoverInterruptedAttempts(
      state, this.now()));
  }
}
