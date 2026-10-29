// T095B76: put a content script back into a tab that lost one.
//
// Reloading an extension in `chrome://extensions` tears down every content script it
// had injected into an already-open page. The page keeps running, the tab keeps its
// id, and nothing re-injects: declarative content scripts are injected at document
// idle, and a document that never navigates never reaches that point again. So the
// bound ChatGPT tab answers `tabs.sendMessage` with "no receiving end" until the
// operator reloads the page -- which this project is not allowed to do on its own.
//
// `chrome.scripting.executeScript` is the only way back in. It is used here for one
// narrow purpose and under conditions the caller has to meet:
//
//   * the target is the tab the operator already bound, one tab, named by id;
//   * its URL must still be the exact conversation URL in the binding -- this module
//     compares strings it was given and never decides what the target is;
//   * only after a probe has *definitively* reported no receiver. A timeout is not
//     that: a slow reply may mean a live script, and injecting then would run this
//     file twice in one document. `content.js` latches its write path against that,
//     but the cheaper answer is not to cause it;
//   * it only injects the read-only observer. The write path still goes through the
//     content script and the adapter, unchanged, so this adds no new way to type
//     into a page -- it adds a way to *look* at one again.
import { parseConversationUrl } from './readonly_preflight.js';

// The one status that means "there is no receiving end", as opposed to "the answer
// did not arrive". Chrome raises it when `tabs.sendMessage` has no listener.
export const NO_RECEIVER_STATUS = 'content_unavailable';

export const RECONNECT_CODES = {
  notNeeded: 'not_needed',
  injected: 'content_script_reinjected',
  unsupported: 'scripting_unavailable',
  urlChanged: 'reconnect_url_changed',
  notConversation: 'reconnect_not_a_conversation',
  tabGone: 'reconnect_tab_gone',
  badTab: 'reconnect_bad_tab_id',
  refused: 'reconnect_refused',
};

function code(code_, extra) {
  return Object.assign({ attempted: false, ok: false, code: code_ }, extra || {});
}

/**
 * Re-injects `content.js` into one tab, if and only if that is provably safe.
 *
 * @param {object} api  Chrome surface: `{ tabs, scripting }`.
 * @param {object} target `{ tabId, url, conversationId }` from the binding.
 * @returns {Promise<{attempted: boolean, ok: boolean, code: string}>}
 */
export async function ensureContentScript(api, target, options = {}) {
  if (!target || !Number.isSafeInteger(target.tabId)) return code(RECONNECT_CODES.tabGone);
  if (!api || !api.tabs || typeof api.tabs.get !== 'function') {
    return code(RECONNECT_CODES.unsupported);
  }
  // The conversation check runs on the *bound* url. A binding whose url was never an
  // exact conversation is not something to inject into on the strength of a prefix.
  const parsed = parseConversationUrl(target.url);
  if (!parsed.ok) return code(RECONNECT_CODES.notConversation);
  if (typeof target.conversationId === 'string' &&
      parsed.conversationId !== target.conversationId) {
    return code(RECONNECT_CODES.notConversation);
  }

  const tab = await api.tabs.get(target.tabId).catch(() => null);
  if (!tab) return code(RECONNECT_CODES.tabGone);
  // Exact string comparison against the tab as it is now. If the tab moved, the
  // binding is about a document that no longer exists and reconnecting to it would
  // be reconnecting to something else -- the caller's probe will invalidate instead.
  if (tab.url !== target.url) {
    return code(RECONNECT_CODES.urlChanged, { liveUrl: tab.url || null });
  }

  const scripting = api.scripting;
  if (!scripting || typeof scripting.executeScript !== 'function') {
    return code(RECONNECT_CODES.unsupported);
  }

  try {
    const results = await scripting.executeScript({
      target: { tabId: target.tabId },
      files: [options.file || 'content.js'],
    });
    // `executeScript` resolves with one entry per injected frame. An empty array or
    // a missing result means nothing ran, which must not be reported as success.
    if (!Array.isArray(results) || results.length === 0) {
      return code(RECONNECT_CODES.refused);
    }
    return { attempted: true, ok: true, code: RECONNECT_CODES.injected,
      frames: results.length };
  } catch (err) {
    return code(RECONNECT_CODES.refused, {
      error: String(err && err.message ? err.message : err),
    });
  }
}

/**
 * Reconnect one tab named by the operator, before anything is bound to it.
 *
 * The automatic path above can only repair a tab that is *already* bound, which leaves
 * a hole on the first reload after an upgrade: the mirror is empty, so there is no
 * binding to restore, so nothing automatic ever runs -- and `scan` reports every
 * ChatGPT tab `content_unavailable`, which means no candidate can be confirmed at all
 * and the only way forward is refreshing the page. That is the step this exists to
 * remove.
 *
 * It is not consent. It re-injects the read-only observer into one tab, and the tab is
 * named by the operator's own click in the popup; binding that tab still requires the
 * typed confirmation phrase afterwards. Nothing here can write to a page.
 */
export async function reconnectTabById(api, tabId, options = {}) {
  if (!Number.isSafeInteger(tabId)) return code(RECONNECT_CODES.badTab);
  if (!api || !api.tabs || typeof api.tabs.get !== 'function') {
    return code(RECONNECT_CODES.unsupported);
  }
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab) return code(RECONNECT_CODES.tabGone);
  const parsed = parseConversationUrl(tab.url);
  if (!parsed.ok) return code(RECONNECT_CODES.notConversation);
  // The URL is read here and re-checked inside `ensureContentScript` against the same
  // read, so the injection can only happen while the tab is showing that exact
  // conversation -- a navigation between the two reads is caught rather than ignored.
  return ensureContentScript(api,
    { tabId, url: tab.url, conversationId: parsed.conversationId }, options);
}

/**
 * A `probeSpecificTab`-shaped function that reconnects once when the receiver is
 * provably gone, then re-measures.
 *
 * The retry is deliberately a single extra probe and not a loop: if a freshly
 * injected script still does not answer, the problem is not a missing script, and
 * repeating the injection would only re-run the file.
 */
export function createResilientProbe(deps = {}) {
  const probeSpecificTab = deps.probeSpecificTab;
  const reconnect = deps.reconnect;
  if (typeof probeSpecificTab !== 'function') {
    throw new TypeError('createResilientProbe needs probeSpecificTab');
  }
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : () => {};

  return async function probeResilient(api, target, options = {}) {
    const first = await probeSpecificTab(api, target, options);
    if (!first || first.status !== NO_RECEIVER_STATUS) return first;
    if (typeof reconnect !== 'function') return first;

    const attempt = await reconnect(api, target, first);
    onEvent({ at: now(), tabId: target && target.tabId, attempt, cause: first.status });
    if (!attempt || attempt.ok !== true) {
      // Report the original fact, annotated with why the repair did not happen, so
      // a popup can say "the script is gone and could not be put back" instead of
      // the generic "unavailable".
      return Object.assign({}, first, {
        reconnect: { attempted: attempt ? attempt.attempted === true : false,
          ok: false, code: attempt ? attempt.code : 'reconnect_unavailable' },
      });
    }
    const second = await probeSpecificTab(api, target, options);
    return Object.assign({}, second, {
      reconnected: true,
      reconnect: { attempted: true, ok: true, code: attempt.code },
    });
  };
}
