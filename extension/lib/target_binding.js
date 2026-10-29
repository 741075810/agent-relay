// Pure policy for a manually selected, read-only target binding.
// A binding records a page identity; it never authenticates an account or sends.
import { PROBE_MAX_AGE_MS, parseConversationUrl } from './readonly_preflight.js';

const INVALIDATING_PROBE_STATES = new Set([
  'tab_unavailable',
  'tab_changed_during_probe',
  'window_changed_during_probe',
  'discarded',
  'discarded_during_probe',
  'frozen',
  'frozen_during_probe',
  'frozen_state_unknown',
  'route_changed_during_probe',
  'conversation_identity_mismatch',
  'document_instance_missing',
  'not_an_exact_conversation_url',
  'url_unavailable',
  'url_invalid',
  'binding_identity_mismatch',
  'navigation_in_progress',
]);

function result(status, extra = {}) {
  return Object.assign({
    ok: false,
    status,
    sendEligible: false,
    accountIdentity: 'unverified',
  }, extra);
}

function isFresh(at, now) {
  return Number.isSafeInteger(at) && at <= now && now - at <= PROBE_MAX_AGE_MS;
}

export function assessBindingCandidate(snapshot, now = Date.now()) {
  if (!snapshot || snapshot.status !== 'background_observable') {
    return result('candidate_not_preflighted');
  }
  if (!Number.isSafeInteger(snapshot.tabId) || snapshot.tabId < 0 ||
      !Number.isSafeInteger(snapshot.windowId) || snapshot.windowId < 0) {
    return result('candidate_identity_missing');
  }
  const page = parseConversationUrl(snapshot.url);
  if (!page.ok || page.conversationId !== snapshot.conversationId) {
    return result('candidate_route_mismatch');
  }
  if (snapshot.discarded !== false) return result('candidate_discarded');
  if (snapshot.frozenStateKnown !== true || snapshot.frozen !== false) {
    return result('frozen_state_unknown');
  }
  if (snapshot.routeStable !== true || !isFresh(snapshot.observedAt, now)) {
    return result('candidate_snapshot_stale');
  }
  if (typeof snapshot.documentInstanceId !== 'string' ||
      snapshot.documentInstanceId.length < 16 ||
      snapshot.documentInstanceId.length > 128) {
    return result('document_instance_missing');
  }
  if (snapshot.pageLoaded !== true || snapshot.composerPresent !== true ||
      typeof snapshot.hasFocus !== 'boolean' ||
      typeof snapshot.active !== 'boolean' ||
      !['visible', 'hidden', 'prerender', 'unloaded'].includes(
        snapshot.visibilityState)) {
    return result('candidate_page_state_incomplete');
  }
  return {
    ok: true,
    status: 'candidate_eligible',
    tabId: snapshot.tabId,
    windowId: snapshot.windowId,
    url: page.url,
    conversationId: page.conversationId,
    documentInstanceId: snapshot.documentInstanceId,
    observedAt: snapshot.observedAt,
    active: snapshot.active,
    discarded: false,
    frozen: false,
    frozenStateKnown: true,
    visibilityState: snapshot.visibilityState,
    hasFocus: snapshot.hasFocus,
    composerPresent: true,
    pageLoaded: true,
    accountIdentity: 'unverified',
    sendEligible: false,
  };
}

function confirmationIdentity(candidate) {
  return 'tab=' + candidate.tabId + ' window=' + candidate.windowId +
    ' url=' + candidate.url + ' conversation=' + candidate.conversationId;
}

export function bindingConfirmation(currentBinding, candidate) {
  if (!candidate || typeof candidate.conversationId !== 'string') return '';
  const selected = confirmationIdentity(candidate);
  if (!currentBinding) return 'BIND ' + selected;
  const previous = confirmationIdentity(currentBinding);
  return 'REPLACE ' + previous + ' WITH ' + selected;
}

export function bindingClearConfirmation(binding) {
  if (!binding) return '';
  return 'UNBIND tab=' + binding.tabId + ' window=' + binding.windowId +
    ' url=' + binding.url + ' conversation=' + binding.conversationId;
}

export function createBindingRecord(candidate, boundAt, revision) {
  const eligible = assessBindingCandidate(candidate, boundAt);
  if (!eligible.ok) return eligible;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return result('binding_revision_invalid');
  }
  return {
    ok: true,
    status: 'bound_saved',
    binding: {
      version: 1,
      revision,
      boundAt,
      tabId: eligible.tabId,
      windowId: eligible.windowId,
      url: eligible.url,
      conversationId: eligible.conversationId,
      documentInstanceId: eligible.documentInstanceId,
      accountIdentity: 'unverified',
      accountVerified: false,
      manuallyConfirmed: true,
      invalidatedReason: null,
      invalidatedAt: null,
    },
  };
}

export function assessBindingHealth(binding, probe, now = Date.now(),
                                   invalidatedReason = null) {
  if (!binding) return result('not_bound');
  if (invalidatedReason || binding.invalidatedReason) {
    return result('binding_invalidated', {
      reason: invalidatedReason || binding.invalidatedReason,
      binding,
    });
  }
  if (!Number.isSafeInteger(binding.tabId) ||
      !Number.isSafeInteger(binding.windowId) ||
      typeof binding.documentInstanceId !== 'string' ||
      !parseConversationUrl(binding.url).ok ||
      parseConversationUrl(binding.url).conversationId !== binding.conversationId) {
    return result('binding_record_invalid', { binding });
  }
  if (!probe || probe.status !== 'background_observable') {
    const status = probe && probe.status ? probe.status : 'probe_unavailable';
    return result(INVALIDATING_PROBE_STATES.has(status)
      ? 'binding_invalidated' : 'binding_unavailable', {
      reason: status,
      binding,
    });
  }
  if (probe.tabId !== binding.tabId || probe.windowId !== binding.windowId ||
      probe.url !== binding.url ||
      probe.conversationId !== binding.conversationId ||
      probe.documentInstanceId !== binding.documentInstanceId) {
    return result('binding_invalidated', {
      reason: 'binding_identity_mismatch',
      binding,
      observed: {
        tabId: probe.tabId,
        windowId: probe.windowId,
        url: probe.url,
        conversationId: probe.conversationId,
        documentInstanceId: probe.documentInstanceId,
      },
    });
  }
  if (probe.discarded !== false) {
    return result('binding_invalidated', { reason: 'discarded', binding });
  }
  if (probe.frozenStateKnown !== true || probe.frozen !== false) {
    return result('binding_unavailable', {
      reason: 'frozen_state_unknown',
      binding,
    });
  }
  if (!probe.routeStable || !isFresh(probe.observedAt, now) ||
      probe.pageLoaded !== true || probe.composerPresent !== true ||
      typeof probe.hasFocus !== 'boolean' ||
      typeof probe.active !== 'boolean' ||
      !['visible', 'hidden', 'prerender', 'unloaded'].includes(
        probe.visibilityState)) {
    return result('binding_unavailable', {
      reason: 'probe_snapshot_incomplete_or_stale',
      binding,
    });
  }
  return {
    ok: true,
    status: 'bound_healthy',
    binding,
    observedAt: probe.observedAt,
    active: probe.active,
    visibilityState: probe.visibilityState,
    hasFocus: probe.hasFocus,
    discarded: false,
    frozen: false,
    frozenStateKnown: true,
    accountIdentity: 'unverified',
    sendEligible: false,
  };
}
