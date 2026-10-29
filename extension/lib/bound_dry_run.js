// T054: pure, offline dry-run policy joining a T053 binding to a simulated
// terminal event. It never sends, writes a page, reads page text, talks to the
// Native Host, or imports the T051 send gate.
//
// The output has two deliberate properties:
//   - `reviewAllowed` only means a human may look at a proposal. It is never a
//     write/send authorization.
//   - every failed condition is reported, not just the first one, so the UI can
//     explain why a proposal was blocked.

export const ALLOWED_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);
export const PROPOSAL_MAX_AGE_MS = 5 * 60 * 1000;
export const BINDING_REVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const ALLOWED_EVENT_FIELDS = Object.freeze(['runId', 'status', 'proposalId']);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROPOSAL_ID =
  /^dryrun-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-(?:completed|failed|cancelled)-[1-9][0-9]{0,5}$/;
const ALLOWED_ORIGINS = new Set([
  'https://chatgpt.com',
  'https://chat.openai.com',
]);
const STATUS_LABEL = Object.freeze({
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
});
const HEALTH_CODES = Object.freeze({
  tab_unavailable: 'target_tab_unavailable',
  tab_changed_during_probe: 'target_tab_changed',
  window_changed_during_probe: 'target_window_changed',
  discarded: 'target_discarded',
  discarded_during_probe: 'target_discarded',
  frozen: 'target_frozen',
  frozen_during_probe: 'target_frozen',
  frozen_state_unknown: 'frozen_state_unknown',
  route_changed_during_probe: 'route_changed',
  navigation_in_progress: 'route_changed',
  navigation_during_health_check: 'route_changed',
  conversation_identity_mismatch: 'conversation_identity_mismatch',
  binding_identity_mismatch: 'binding_identity_mismatch',
  probe_timeout: 'probe_timeout',
  content_unavailable: 'content_unavailable',
  probe_stale: 'probe_stale',
  probe_unavailable: 'probe_unavailable',
});

function canonicalConversationUrl(url, conversationId) {
  if (typeof url !== 'string' || typeof conversationId !== 'string') return false;
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

function unique(items) {
  return Array.from(new Set(items));
}

function issue(code, detail) {
  return { code, detail: detail || code };
}

function recordInvalid(binding) {
  if (!binding || typeof binding !== 'object') return true;
  return !Number.isSafeInteger(binding.tabId) || binding.tabId < 0 ||
    !Number.isSafeInteger(binding.windowId) || binding.windowId < 0 ||
    !Number.isSafeInteger(binding.revision) || binding.revision < 1 ||
    typeof binding.url !== 'string' ||
    typeof binding.conversationId !== 'string' ||
    !UUID.test(binding.conversationId) ||
    !canonicalConversationUrl(binding.url, binding.conversationId) ||
    typeof binding.documentInstanceId !== 'string' ||
    binding.documentInstanceId.length < 16 ||
    binding.documentInstanceId.length > 128 ||
    binding.accountVerified !== false ||
    binding.manuallyConfirmed !== true;
}

export function validateSimulatedEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, issues: [issue('event_invalid')] };
  }
  const keys = Object.keys(event).sort();
  const allowed = ALLOWED_EVENT_FIELDS.slice().sort();
  if (keys.some((key) => !allowed.includes(key))) {
    return { ok: false, issues: [issue('event_fields_not_allowed',
      keys.filter((key) => !allowed.includes(key)).join(','))] };
  }
  const issues = [];
  if (typeof event.runId !== 'string' || !UUID.test(event.runId)) {
    issues.push(issue('run_id_invalid'));
  }
  if (!ALLOWED_STATUSES.includes(event.status)) {
    issues.push(issue('event_status_not_allowed'));
  }
  if (event.proposalId !== undefined &&
      (typeof event.proposalId !== 'string' ||
       !PROPOSAL_ID.test(event.proposalId))) {
    issues.push(issue('proposal_id_invalid'));
  }
  return issues.length
    ? { ok: false, issues }
    : { ok: true, event: {
      runId: event.runId,
      status: event.status,
      proposalId: event.proposalId || null,
    } };
}

export function proposalText(event) {
  const valid = validateSimulatedEvent(event);
  if (!valid.ok) return null;
  return 'DSH task ' + valid.event.runId + ' ' +
    STATUS_LABEL[valid.event.status] + '.';
}

export function createProposalId(runId, status, sequence) {
  if (typeof runId !== 'string' || !UUID.test(runId) ||
      !ALLOWED_STATUSES.includes(status) ||
      !Number.isSafeInteger(sequence) || sequence < 1) return null;
  // Deterministic, local-only identity. It is not a send idempotency key.
  return 'dryrun-' + runId + '-' + status + '-' + sequence;
}

export function evaluateBoundDryRun(input) {
  const now = input && Number.isSafeInteger(input.now) ? input.now : Date.now();
  const event = input && input.event;
  const binding = input && input.binding;
  const health = input && input.health;
  const history = input && Array.isArray(input.history) ? input.history : [];
  const issues = [];
  const checks = [];

  function fail(code, detail) {
    issues.push(issue(code, detail));
    checks.push({ code, ok: false, detail: detail || code });
  }
  function pass(code, detail) {
    checks.push({ code, ok: true, detail: detail || code });
  }

  const validatedEvent = validateSimulatedEvent(event);
  if (!validatedEvent.ok) {
    for (const item of validatedEvent.issues) fail(item.code, item.detail);
  } else {
    pass('event_shape');
  }

  if (!binding) {
    fail('target_not_bound');
  } else if (recordInvalid(binding)) {
    fail('binding_record_invalid');
  } else {
    pass('binding_record');
  }

  if (binding && binding.invalidatedReason) {
    fail('binding_invalidated', binding.invalidatedReason);
  } else if (binding) {
    pass('binding_not_invalidated');
  }

  if (!health) {
    fail('health_unavailable');
  } else if (health.status !== 'bound_healthy' || health.ok !== true) {
    const probeReason = health.reason || health.status || 'unknown';
    if (health.status === 'binding_invalidated') {
      fail('binding_invalidated', probeReason);
    } else {
      fail(HEALTH_CODES[probeReason] || 'health_unavailable', probeReason);
    }
  } else {
    pass('binding_healthy');
  }

  if (binding && health && health.status === 'bound_healthy') {
    const identityPairs = [
      ['tabId', 'binding_tab_mismatch'],
      ['windowId', 'binding_window_mismatch'],
      ['url', 'binding_url_mismatch'],
      ['conversationId', 'binding_conversation_mismatch'],
      ['documentInstanceId', 'binding_document_mismatch'],
    ];
    for (const [field, code] of identityPairs) {
      if (health[field] !== undefined && health[field] !== binding[field]) {
        fail(code);
      }
    }
    const probeBinding = health.binding;
    if (!probeBinding || typeof probeBinding !== 'object') {
      fail('health_binding_evidence_missing');
    } else {
      for (const [field, code] of identityPairs) {
        if (probeBinding[field] !== binding[field]) fail(code);
      }
      if (probeBinding.revision !== binding.revision) {
        fail('binding_revision_changed');
      }
    }
    if (typeof health.observedAt !== 'number' ||
        !Number.isSafeInteger(health.observedAt) ||
        health.observedAt < 0 || health.observedAt > now ||
        now - health.observedAt > PROPOSAL_MAX_AGE_MS) {
      fail('health_stale');
    } else {
      pass('health_fresh');
    }
    if (health.discarded === true) fail('target_discarded');
    if (health.frozenStateKnown === false) fail('frozen_state_unknown');
    if (health.frozen === true) fail('target_frozen');
    // bound_healthy already requires composer/route stability inside T053's
    // assessBindingHealth. Those fields are therefore optional here: only an
    // explicit contradiction is a failure, never their absence.
    if (health.composerPresent === false) fail('composer_unavailable');
    if (health.routeStable === false) fail('route_changed');
    if (typeof binding.boundAt === 'number') {
      if (!Number.isSafeInteger(binding.boundAt) || binding.boundAt < 0 ||
          binding.boundAt > now) {
        fail('binding_timestamp_invalid');
      } else if (now - binding.boundAt > BINDING_REVIEW_MAX_AGE_MS) {
        fail('binding_expired');
      } else {
        pass('binding_fresh');
      }
    }
  }

  if (validatedEvent.ok) {
    const duplicate = history.find((item) => item &&
      item.kind === 't054-dry-run' &&
      item.runId === validatedEvent.event.runId &&
      item.status === validatedEvent.event.status);
    if (duplicate) {
      fail('duplicate_event', duplicate.proposalId || 'seen');
    } else {
      pass('event_not_seen_in_session');
    }
  }

  const result = {
    mode: 't054-bound-dry-run',
    reviewAllowed: issues.length === 0,
    blocked: issues.length > 0,
    issues,
    checks,
    sendEligible: false,
    wouldSend: false,
    pageWriteEligible: false,
    deliveryReceipt: 'unsupported',
    accountIdentity: 'unverified',
    target: binding ? {
      tabId: binding.tabId,
      windowId: binding.windowId,
      url: binding.url,
      conversationId: binding.conversationId,
      documentInstanceId: binding.documentInstanceId,
      revision: binding.revision,
    } : null,
    proposal: validatedEvent.ok ? {
      runId: validatedEvent.event.runId,
      status: validatedEvent.event.status,
      proposalId: validatedEvent.event.proposalId || null,
      text: proposalText(validatedEvent.event),
      simulated: true,
    } : null,
    observedAt: health && Number.isSafeInteger(health.observedAt)
      ? health.observedAt : null,
    evaluatedAt: now,
    reasons: unique(issues.map((item) => item.code)),
    note: issues.length === 0
      ? 'human_review_only_no_send_or_page_write'
      : 'blocked_no_send_or_page_write',
  };
  return result;
}

export function assessProposalAdmission(input) {
  return evaluateBoundDryRun(input);
}
