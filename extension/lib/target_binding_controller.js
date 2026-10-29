// Session-scoped manual target binding controller; read-only only.
import { probeSpecificTab, runReadonlyProbeAllWindows } from
  './readonly_preflight.js';
import {
  assessBindingCandidate,
  assessBindingHealth,
  bindingConfirmation,
  bindingClearConfirmation,
  createBindingRecord,
} from './target_binding.js';

export const TARGET_BINDING_SESSION_KEY = 't053TargetBindingState';
export const CANDIDATE_TTL_MS = 5 * 60 * 1000;

function publicState(state) {
  const binding = state && state.binding ? state.binding : null;
  return {
    ok: true,
    status: !binding ? 'not_bound' : binding.invalidatedReason
      ? 'binding_invalidated' : 'bound_saved',
    binding,
    candidates: state && Array.isArray(state.candidates)
      ? state.candidates : [],
    candidateScannedAt: state ? state.candidateScannedAt : null,
    sendEligible: false,
    accountIdentity: 'unverified',
  };
}

// Diagnostics for a dropped tab. Whitelisted fields only -- this is shown in the
// popup, so it must never carry page text, tokens or anything the scan did not
// already hold.
function diagnose(snapshot, reason) {
  const snap = snapshot || {};
  return {
    tabId: Number.isSafeInteger(snap.tabId) ? snap.tabId : null,
    windowId: Number.isSafeInteger(snap.windowId) ? snap.windowId : null,
    status: typeof snap.status === 'string' ? snap.status : 'unknown',
    reason,
    conversationId: typeof snap.conversationId === 'string'
      ? snap.conversationId : null,
    frozen: typeof snap.frozen === 'boolean' ? snap.frozen : null,
    frozenStateKnown: snap.frozenStateKnown === true,
    frozenStateSource: typeof snap.frozenStateSource === 'string'
      ? snap.frozenStateSource : 'unknown',
    observedAt: Number.isSafeInteger(snap.observedAt) ? snap.observedAt : null,
    visibilityState: typeof snap.visibilityState === 'string'
      ? snap.visibilityState : 'unknown',
    hasFocus: snap.hasFocus === true,
    composerPresent: snap.composerPresent === true,
    pageLoaded: snap.pageLoaded === true,
    active: snap.active === true,
    discarded: snap.discarded === true,
    hasDocumentInstance: typeof snap.documentInstanceId === 'string' &&
      snap.documentInstanceId.length >= 16,
  };
}

function initialState() {
  return { version: 1, revision: 0, binding: null, candidates: [],    candidateScannedAt: null };
}

function validStoredState(state) {
  if (!state || state.version !== 1 ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Array.isArray(state.candidates) ||
      !(state.candidateScannedAt === null ||
        Number.isSafeInteger(state.candidateScannedAt))) return false;
  if (state.binding !== null && (!state.binding ||
      !Number.isSafeInteger(state.binding.tabId) ||
      !Number.isSafeInteger(state.binding.windowId) ||
      !Number.isSafeInteger(state.binding.revision) ||
      typeof state.binding.url !== 'string' ||
      typeof state.binding.conversationId !== 'string' ||
      typeof state.binding.documentInstanceId !== 'string')) return false;
  return state.candidates.every((item) => item &&
    typeof item.token === 'string' && Number.isSafeInteger(item.tabId) &&
    Number.isSafeInteger(item.windowId) && typeof item.url === 'string' &&
    typeof item.conversationId === 'string' &&
    typeof item.documentInstanceId === 'string');
}

export function createTargetBindingController(api, options = {}) {
  const now = options.now || (() => Date.now());
  const makeToken = options.makeToken || (() =>
    'candidate-' + now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 12));
  const epochs = new Map();
  let writeTail = Promise.resolve();
  const probeOptions = { now, timeoutMs: options.timeoutMs };

  async function read() {
    if (!api.session || typeof api.session.get !== 'function' ||
        typeof api.session.set !== 'function') {
      throw new Error('session_storage_unavailable');
    }
    const stored = await api.session.get({ [TARGET_BINDING_SESSION_KEY]: null });
    const value = stored[TARGET_BINDING_SESSION_KEY];
    if (value === null || value === undefined) return initialState();
    if (!validStoredState(value)) throw new Error('binding_state_invalid');
    return value;
  }

  function mutate(mutator) {
    const operation = writeTail.then(async () => {
      const state = await read();
      const changed = await mutator(state);
      if (!changed || changed.save === false) return changed && changed.value;
      await api.session.set({ [TARGET_BINDING_SESSION_KEY]: changed.state });
      return changed.value;
    });
    writeTail = operation.catch(() => {});
    return operation;
  }

  async function getState() {
    try {
      await writeTail;
      return publicState(await read());
    } catch (err) {
      const status = err && err.message === 'binding_state_invalid'
        ? 'binding_state_invalid' : 'session_storage_unavailable';
      return { ok: false, status,
        binding: null, candidates: [], sendEligible: false,
        accountIdentity: 'unverified' };
    }
  }

  async function clear(confirmation) {
    let current;
    try {
      current = await read();
    } catch (err) {
      return { ok: false,
        status: err && err.message === 'binding_state_invalid'
          ? 'binding_state_invalid' : 'session_storage_unavailable',
        sendEligible: false, accountIdentity: 'unverified' };
    }
    const binding = current.binding;
    if (!binding || confirmation !== bindingClearConfirmation(binding)) {
      return { ok: false, status: 'binding_clear_confirmation_mismatch',
        sendEligible: false, accountIdentity: 'unverified' };
    }
    return mutate((state) => {
      if (!state.binding || state.binding.revision !== binding.revision ||
          state.binding.tabId !== binding.tabId ||
          state.binding.windowId !== binding.windowId) {
        return { save: false, value: { ok: false,
          status: 'binding_changed_before_clear', sendEligible: false } };
      }
      return {
        state: Object.assign({}, initialState(), { revision: state.revision + 1 }),
        value: { ok: true, status: 'binding_cleared', sendEligible: false,
          accountIdentity: 'unverified' },
      };
    });
  }

  async function scan() {
    await writeTail;
    const scanEpochs = new Map(epochs);
    let scan;
    try {
      scan = await runReadonlyProbeAllWindows(api, probeOptions);
    } catch (_err) {
      try {
        await mutate((state) => ({
          state: Object.assign({}, state, {
            candidates: [],
            candidateScannedAt: null,
          }),
          value: true,
        }));
      } catch (_storageErr) {
        return { error: 'candidate_storage_failed', tabs: [], candidates: [],
          sendEligible: false, accountIdentity: 'unverified' };
      }
      return { error: 'probe_unavailable', tabs: [], candidates: [],
        sendEligible: false, accountIdentity: 'unverified' };
    }
    if (scan.error) {
      try {
        await mutate((state) => ({
          state: Object.assign({}, state, {
            candidates: [],
            candidateScannedAt: null,
          }),
          value: true,
        }));
      } catch (_err) {
        return { error: 'candidate_storage_failed', tabs: [], candidates: [],
          sendEligible: false, accountIdentity: 'unverified' };
      }
      return Object.assign({}, scan, {
        candidates: [],
        sendEligible: false,
        accountIdentity: 'unverified',
      });
    }
    const candidates = [];
    // Per-tab verdicts, kept so the popup can say *why* each tab was dropped
    // instead of a generic "no candidates". Nothing here is page content: it is
    // the tab identity, the probe status, the frozen evidence and the rejection
    // code -- the same fields the scan already computed and then threw away.
    const rejected = [];
    for (const snapshot of scan.tabs) {
      if (snapshot.status !== 'background_observable') {
        // The probe status is already a code (`content_unavailable`,
        // `probe_stale`, `frozen`, ...); prefixing it again produced
        // `probe_probe_stale`.
        rejected.push(diagnose(snapshot, snapshot.status));
        continue;
      }
      const eligible = assessBindingCandidate(snapshot, scan.generatedAt);
      if (!eligible.ok) {
        rejected.push(diagnose(snapshot, eligible.status));
        continue;
      }
      const navigationEpoch = scanEpochs.get(eligible.tabId) || 0;
      if ((epochs.get(eligible.tabId) || 0) !== navigationEpoch) {
        rejected.push(diagnose(snapshot, 'navigated_during_scan'));
        continue;
      }
      candidates.push(Object.assign({}, eligible, {
        status: 'candidate_eligible',
        token: makeToken(),
        navigationEpoch,
      }));
    }
    let persistedCandidates = [];
    let value;
    try {
      value = await mutate((state) => {
        persistedCandidates = candidates.filter((candidate) =>
          (epochs.get(candidate.tabId) || 0) === candidate.navigationEpoch);
        return {
          state: Object.assign({}, state, {
            candidates: persistedCandidates,
            candidateScannedAt: scan.generatedAt,
          }),
          value: true,
        };
      });
    } catch (_err) {
      return { error: 'candidate_storage_failed', tabs: scan.tabs,
        candidates: [], sendEligible: false, accountIdentity: 'unverified' };
    }
    if (!value) return { error: 'candidate_storage_failed', tabs: scan.tabs };
    return Object.assign({}, scan, {
      candidates: persistedCandidates,
      rejected,
      accountIdentity: 'unverified',
      sendEligible: false,
    });
  }

  async function bind(token, confirmation) {
    await writeTail;
    const state = await read();
    const candidate = state.candidates.find((item) => item.token === token);
    if (!candidate || typeof token !== 'string') {
      return { ok: false, status: 'candidate_not_found', sendEligible: false };
    }
    if (!Number.isSafeInteger(state.candidateScannedAt) ||
        now() - state.candidateScannedAt > CANDIDATE_TTL_MS ||
        now() < state.candidateScannedAt) {
      return { ok: false, status: 'candidate_scan_expired', sendEligible: false };
    }
    const expectedConfirmation = bindingConfirmation(state.binding, candidate);
    if (confirmation !== expectedConfirmation) {
      return { ok: false, status: 'binding_confirmation_mismatch',
        expectedConfirmation, sendEligible: false };
    }
    if (candidate.invalidatedDuringScan ||
        (epochs.get(candidate.tabId) || 0) !== candidate.navigationEpoch) {
      return { ok: false, status: 'navigation_since_candidate_scan',
        sendEligible: false };
    }
    const epoch = candidate.navigationEpoch;
    const snapshot = await probeSpecificTab(api, candidate, probeOptions);
    if ((epochs.get(candidate.tabId) || 0) !== epoch) {
      return { ok: false, status: 'navigation_during_binding',
        sendEligible: false };
    }
    if (!snapshot || snapshot.status !== 'background_observable') {
      return { ok: false,
        status: (snapshot && snapshot.status) || 'probe_unavailable',
        sendEligible: false, accountIdentity: 'unverified' };
    }
    const eligible = assessBindingCandidate(snapshot, now());
    if (!eligible.ok) return Object.assign({}, eligible, { sendEligible: false });
    if (eligible.tabId !== candidate.tabId ||
        eligible.windowId !== candidate.windowId ||
        eligible.url !== candidate.url ||
        eligible.conversationId !== candidate.conversationId ||
        eligible.documentInstanceId !== candidate.documentInstanceId) {
      return { ok: false, status: 'candidate_identity_changed',
        sendEligible: false };
    }

    const expectedRevision = state.binding ? state.binding.revision : 0;
    return mutate((latest) => {
      const stillCandidate = latest.candidates.some((item) =>
        item.token === token && item.tabId === candidate.tabId &&
        item.windowId === candidate.windowId && item.url === candidate.url &&
        item.documentInstanceId === candidate.documentInstanceId);
      if (!stillCandidate ||
          (latest.binding ? latest.binding.revision : 0) !== expectedRevision ||
          (epochs.get(candidate.tabId) || 0) !== epoch) {
        return { save: false, value: {
          ok: false,
          status: 'binding_changed_during_confirmation',
          sendEligible: false,
        } };
      }
      const record = createBindingRecord(snapshot, now(), expectedRevision + 1);
      if (!record.ok) return { save: false, value: record };
      const next = Object.assign({}, latest, {
        revision: expectedRevision + 1,
        binding: record.binding,
        candidates: [],
        candidateScannedAt: null,
      });
      return { state: next, value: {
        ok: true,
        status: 'bound_saved',
        binding: record.binding,
        accountIdentity: 'unverified',
        sendEligible: false,
      } };
    });
  }

  async function invalidate(tabId, reason) {
    epochs.set(tabId, (epochs.get(tabId) || 0) + 1);
    return mutate((state) => {
      const candidates = state.candidates.filter((item) => item.tabId !== tabId);
      const candidatesChanged = candidates.length !== state.candidates.length;
      const bindingMatches = state.binding && state.binding.tabId === tabId &&
        !state.binding.invalidatedReason;
      if (!candidatesChanged && !bindingMatches) {
        return { save: false, value: false };
      }
      const binding = bindingMatches
        ? Object.assign({}, state.binding, {
          invalidatedReason: reason,
          invalidatedAt: now(),
        })
        : state.binding;
      return {
        state: Object.assign({}, state, { binding, candidates }),
        value: true,
      };
    });
  }

  function onUpdated(tabId, changeInfo) {
    if (changeInfo && (changeInfo.status === 'loading' ||
        Object.prototype.hasOwnProperty.call(changeInfo, 'url'))) {
      return invalidate(tabId, 'navigation_or_redirect');
    }
    return Promise.resolve(false);
  }

  async function health() {
    let state;
    try {
      state = await read();
    } catch (err) {
      return { ok: false,
        status: err && err.message === 'binding_state_invalid'
          ? 'binding_state_invalid' : 'session_storage_unavailable',
        sendEligible: false, accountIdentity: 'unverified' };
    }
    const binding = state.binding;
    if (!binding) return assessBindingHealth(null, null, now());
    if (binding.invalidatedReason) {
      return assessBindingHealth(binding, null, now());
    }
    const epoch = epochs.get(binding.tabId) || 0;
    let snapshot;
    try {
      snapshot = await probeSpecificTab(api, binding, probeOptions);
    } catch (_err) {
      snapshot = { status: 'probe_unavailable' };
    }
    if ((epochs.get(binding.tabId) || 0) !== epoch) {
      await invalidate(binding.tabId, 'navigation_during_health_check');
      const latest = await read();
      return assessBindingHealth(latest.binding, null, now());
    }
    const latest = await read();
    if (!latest.binding || latest.binding.revision !== binding.revision) {
      return { ok: false, status: 'binding_changed_during_health_check',
        sendEligible: false, accountIdentity: 'unverified' };
    }
    if (latest.binding.invalidatedReason) {
      return assessBindingHealth(latest.binding, null, now());
    }
    const assessed = assessBindingHealth(latest.binding, snapshot, now());
    if (assessed.status === 'binding_invalidated') {
      await invalidate(binding.tabId, assessed.reason || 'binding_identity_mismatch');
      const invalid = await read();
      return assessBindingHealth(invalid.binding, null, now());
    }
    return assessed;
  }

  return {
    getState,
    scan,
    bind,
    health,
    clear,
    onUpdated,
    onRemoved: (tabId) => invalidate(tabId, 'tab_closed'),
    onReplaced: async (addedTabId, removedTabId) => {
      await invalidate(removedTabId, 'tab_replaced');
      if (addedTabId !== removedTabId) {
        await invalidate(addedTabId, 'tab_replaced');
      }
    },
    onDetached: (tabId) => invalidate(tabId, 'window_detached'),
    onAttached: (tabId) => invalidate(tabId, 'window_attached'),
  };
}
