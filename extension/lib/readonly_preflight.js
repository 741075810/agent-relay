// Pure read-only target assessment for a manual background probe.
// This module never sends pages, reads page text, or treats a probe as delivery.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ORIGINS = new Set([
  'https://chatgpt.com',
  'https://chat.openai.com',
]);
export const PROBE_MAX_AGE_MS = 5000;
export const MAX_PROBE_TABS = 20;

function result(code, extra = {}) {
  return Object.assign({
    ok: false,
    status: code,
    backgroundObservable: false,
    sendEligible: false,
    accountIdentity: 'unavailable',
    deliveryReceipt: 'unsupported',
  }, extra);
}

function dryRunResult(tabs, generatedAt, extra = {}) {
  return Object.assign({
    mode: 'manual-readonly-dry-run',
    generatedAt,
    accountIdentity: 'unavailable',
    deliveryReceipt: 'unsupported',
    sendEligible: false,
    tabs,
  }, extra);
}

export function parseConversationUrl(url) {
  if (typeof url !== 'string' || !url) {
    return { ok: false, code: 'url_unavailable' };
  }
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/c\/([0-9a-f-]{36})$/i);
    if (!ALLOWED_ORIGINS.has(parsed.origin) || !match ||
        !UUID.test(match[1]) || parsed.search !== '' || parsed.hash !== '' ||
        parsed.username !== '' || parsed.password !== '') {
      return { ok: false, code: 'not_an_exact_conversation_url' };
    }
    return {
      ok: true,
      origin: parsed.origin,
      conversationId: match[1],
      url: parsed.origin + parsed.pathname,
    };
  } catch (_err) {
    return { ok: false, code: 'url_invalid' };
  }
}

export function classifyTab(tab) {
  if (!tab || !Number.isSafeInteger(tab.id) || tab.id < 0) {
    return result('tab_unavailable');
  }
  if (tab.discarded === true) {
    return result('discarded', {
      tabId: tab.id,
      windowId: tab.windowId,
      active: tab.active === true,
      discarded: true,
      frozen: tab.frozen === true,
      reason: 'content_unloaded_until_activation',
    });
  }
  if (tab.frozen === true) {
    return result('frozen', {
      tabId: tab.id,
      windowId: tab.windowId,
      active: tab.active === true,
      discarded: false,
      frozen: true,
      reason: 'frozen_tabs_cannot_execute_tasks',
    });
  }
  const parsed = parseConversationUrl(tab.url);
  if (!parsed.ok) {
    return result(parsed.code, {
      tabId: tab.id,
      windowId: tab.windowId,
      active: tab.active === true,
      discarded: false,
      frozen: false,
    });
  }
  return {
    ok: false,
    status: 'probe_required',
    backgroundObservable: false,
    sendEligible: false,
    accountIdentity: 'unavailable',
    deliveryReceipt: 'unsupported',
    tabId: tab.id,
    windowId: tab.windowId,
    active: tab.active === true,
    discarded: false,
    frozen: tab.frozen === true,
    frozenStateKnown: typeof tab.frozen === 'boolean',
    url: parsed.url,
    conversationId: parsed.conversationId,
  };
}

function checkFresh(observedAt, now) {
  return Number.isSafeInteger(observedAt) &&
    observedAt <= now && now - observedAt <= PROBE_MAX_AGE_MS;
}

export function assessProbe(tabBefore, response, tabAfter, now = Date.now(), expectedRequestId) {
  const before = classifyTab(tabBefore);
  if (before.status !== 'probe_required') return before;
  if (!tabAfter || tabAfter.id !== tabBefore.id) {
    return result('tab_changed_during_probe', { tabId: tabBefore.id });
  }
  if (tabAfter.windowId !== tabBefore.windowId) {
    return result('window_changed_during_probe', {
      tabId: tabBefore.id,
      windowId: tabAfter.windowId,
    });
  }
  if (tabAfter.discarded === true) {
    return result('discarded_during_probe', { tabId: tabBefore.id });
  }
  if (tabAfter.frozen === true) {
    return result('frozen_during_probe', { tabId: tabBefore.id });
  }
  if (tabAfter.url !== tabBefore.url) {
    return result('route_changed_during_probe', {
      tabId: tabBefore.id,
      beforeUrl: tabBefore.url,
      afterUrl: tabAfter.url,
    });
  }
  if (!response || typeof expectedRequestId !== 'string' ||
      response.requestId !== expectedRequestId) {
    return result('probe_response_mismatch', { tabId: tabBefore.id });
  }
  if (response.routeStable !== true) {
    return result('route_changed_during_probe', { tabId: tabBefore.id });
  }
  if (!checkFresh(response.observedAt, now)) {
    return result('probe_stale', {
      tabId: tabBefore.id,
      observedAt: response.observedAt,
    });
  }
  if (response.url !== tabBefore.url) {
    return result('route_changed_during_probe', {
      tabId: tabBefore.id,
      beforeUrl: tabBefore.url,
      responseUrl: response.url,
    });
  }
  if (typeof response.documentInstanceId !== 'string' ||
      response.documentInstanceId.length < 16 ||
      response.documentInstanceId.length > 128) {
    return result('document_instance_missing', { tabId: tabBefore.id });
  }
  const page = parseConversationUrl(response.url);
  if (!page.ok || response.conversationId !== page.conversationId) {
    return result('conversation_identity_mismatch', { tabId: tabBefore.id });
  }
  return {
    ok: true,
    status: 'background_observable',
    backgroundObservable: true,
    // A background probe is observation only. It never authorizes page writes.
    sendEligible: false,
    accountIdentity: 'unavailable',
    deliveryReceipt: 'unsupported',
    tabId: tabBefore.id,
    windowId: tabBefore.windowId,
    active: tabAfter.active === true,
    discarded: false,
    frozen: false,
    // Reaching here means a content script answered *this* request, with a
    // matching id, url and document instance, inside the freshness window --
    // and both tab snapshots had `discarded !== true` and `frozen !== true`.
    // A frozen document cannot run a script, so that answer is positive
    // evidence the tab is not frozen, even on Chrome builds whose
    // `tabs.Tab` carries no `frozen` boolean at all. Previously
    // `frozenStateKnown` reported only whether the property existed, so those
    // builds produced `frozenStateKnown: false` and the binding scan dropped a
    // target whose probe had just succeeded.
    frozenStateKnown: true,
    frozenStateSource: typeof tabBefore.frozen === 'boolean'
      ? 'tab_property' : 'live_probe',
    url: page.url,
    conversationId: page.conversationId,
    documentInstanceId: response.documentInstanceId,
    observedAt: response.observedAt,
    visibilityState: response.visibilityState || 'unknown',
    hasFocus: response.hasFocus === true,
    // T048: active/hidden/focus are *facts about where the operator is looking*,
    // not risk signals. They are reported under one key so no caller can mistake
    // `hasFocus: false` for "the page is in trouble": in a background tab that is
    // the normal, expected state and the whole reason this mode exists.
    focusEvidence: {
      active: tabAfter.active === true,
      hasFocus: response.hasFocus === true,
      visibilityState: response.visibilityState || 'unknown',
      operatorElsewhere: tabAfter.active !== true
        || response.hasFocus !== true
        || response.visibilityState !== 'visible',
    },
    // Whether a *background* delivery could be attempted at all: a document the
    // browser is running (visible or merely hidden) with a reachable composer.
    // Frozen/discarded tabs never reach this branch; prerender/unloaded do, and
    // they are excluded here for the same reason the tab-level checks exclude them.
    backgroundDeliverable: ['visible', 'hidden'].includes(response.visibilityState)
      && response.composerPresent === true && response.pageLoaded === true,
    composerPresent: response.composerPresent === true,
    pageLoaded: response.pageLoaded === true,
    reason: 'snapshot_not_account_or_send_verification',
    routeStable: true,
    routeNote: response.hasFocus === true && response.visibilityState === 'visible'
      ? 'visible_snapshot'
      // Deliberately unchanged by T048. The sentence T048 wants to make -- "being
      // in the background is expected, not a fault" -- is carried by
      // `focusEvidence.operatorElsewhere` and `backgroundDeliverable` above. This
      // string describes *where the probe was taken*, which is still true, and an
      // existing regression asserts it; renaming it would have been churn.
      : 'background_snapshot_not_foreground',
  };
}

export function assessProbeFailure(tab, errorCode) {
  const base = classifyTab(tab);
  if (base.status !== 'probe_required') return base;
  return result(errorCode || 'content_unavailable', {
    tabId: tab.id,
    windowId: tab.windowId,
    active: tab.active === true,
    url: tab.url,
    // No answer from the content script means no evidence either way. State it
    // explicitly rather than leaving the field absent, so nothing downstream can
    // mistake "unknown" for "known to be fine".
    frozen: tab.frozen === true,
    frozenStateKnown: tab.frozen === false,
    frozenStateSource: tab.frozen === false ? 'tab_property' : 'unknown',
  });
}

function makeProbeId(now, options, tabId) {
  const makeId = options.makeRequestId || ((id) =>
    'readonly-' + String(id) + '-' + now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 8));
  return makeId(tabId);
}

function tabSnapshot(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    active: tab.active === true,
    discarded: tab.discarded === true,
    frozen: tab.frozen,
  };
}

async function probeTab(api, tab, options = {}) {
  const now = options.now || (() => Date.now());
  const before = tabSnapshot(tab);
  const preliminary = classifyTab(before);
  if (preliminary.status !== 'probe_required') return preliminary;
  const requestId = makeProbeId(now, options, tab.id);
  let timeout;
  try {
    const response = await Promise.race([
      api.tabs.sendMessage(tab.id, { type: 'readonly-probe', requestId }),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('probe_timeout')),
          options.timeoutMs || 1500);
      }),
    ]);
    const after = await api.tabs.get(tab.id);
    return assessProbe(before, response, tabSnapshot(after), now(), requestId);
  } catch (err) {
    const code = err && err.message === 'probe_timeout'
      ? 'probe_timeout' : 'content_unavailable';
    return assessProbeFailure(before, code);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function probeTabList(api, tabs, options = {}) {
  const now = options.now || (() => Date.now());
  if ((tabs || []).length > MAX_PROBE_TABS) {
    return dryRunResult([], now(), {
      error: 'too_many_chatgpt_tabs',
      tabCount: tabs.length,
    });
  }
  const results = await Promise.all((tabs || []).map((tab) =>
    probeTab(api, tab, options)));
  const generatedAt = now();
  for (const item of results) {
    if (item.status === 'background_observable' &&
        generatedAt - item.observedAt > PROBE_MAX_AGE_MS) {
      Object.assign(item, result('probe_stale', {
        tabId: item.tabId,
        observedAt: item.observedAt,
      }));
    }
  }
  return dryRunResult(results, generatedAt);
}

export async function probeSpecificTab(api, target, options = {}) {
  if (!api || !api.tabs || typeof api.tabs.get !== 'function' ||
      typeof api.tabs.sendMessage !== 'function') {
    return result('probe_api_unavailable');
  }
  try {
    const tab = await api.tabs.get(target.tabId);
    if (!tab || tab.id !== target.tabId) return result('tab_changed_during_probe', {
      tabId: target.tabId,
    });
    if (tab.windowId !== target.windowId) return result('window_changed_during_probe', {
      tabId: target.tabId,
      windowId: tab.windowId,
    });
    return probeTab(api, tab, options);
  } catch (_err) {
    return result('tab_unavailable', { tabId: target && target.tabId });
  }
}

async function checkProbeApi(api) {
  if (!api || !api.tabs || typeof api.tabs.query !== 'function' ||
      typeof api.tabs.sendMessage !== 'function' ||
      typeof api.tabs.get !== 'function') {
    return false;
  }
  return true;
}

export async function runReadonlyProbe(api, options = {}) {
  if (!await checkProbeApi(api)) {
    return dryRunResult([], Date.now(), { error: 'probe_api_unavailable' });
  }
  const activeTabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
  const anchor = Array.isArray(activeTabs) ? activeTabs[0] : null;
  if (!anchor || !Number.isSafeInteger(anchor.windowId)) {
    return dryRunResult([], Date.now(), { error: 'current_window_unavailable' });
  }
  const tabs = await api.tabs.query({
    windowId: anchor.windowId,
    url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  });
  return probeTabList(api, tabs, options);
}

export async function runReadonlyProbeAllWindows(api, options = {}) {
  if (!await checkProbeApi(api)) {
    return dryRunResult([], Date.now(), { error: 'probe_api_unavailable' });
  }
  const tabs = await api.tabs.query({
    url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  });
  return probeTabList(api, tabs, options);
}
