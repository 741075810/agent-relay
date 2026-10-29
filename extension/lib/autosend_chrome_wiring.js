// T059: the Chrome-side wiring, extracted so it can be tested against a fake
// `chrome` instead of only being asserted by reading background.js.
//
// Everything here is dependency injection in one direction: the controller asks
// for a binding, a probe, and a write, and this file is the only place that
// knows those come from `chrome.tabs` and `chrome.storage.local`.
//
// Two rules this file exists to keep visible:
//   1. it never activates, focuses or switches a tab -- there is no
//      `tabs.update` and no `windows.update` anywhere below, so "occupied"
//      can only ever end in a stop;
//   2. the fetched tab is re-read *after* the probe, so a tab that navigated
//      mid-probe cannot be written to on the strength of the old snapshot.
import { createAutoSendController } from './autosend_controller.js';

export const TRIGGER_CANDIDATES_KEY = 'terminalCandidates';

export function createChromeAutoSend(chromeApi, deps) {
  const probeSpecificTab = deps.probeSpecificTab;
  // The same clock the controller decides with. Using `Date.now()` here would
  // stamp a synthetic observation with the wall clock while `decide` compares it
  // against the injected one, which reads as a stale (in fact future-dated)
  // probe. The injected clock exists precisely so these two cannot disagree.
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

  async function readBinding() {
    const snapshot = await deps.getBindingState();
    return snapshot && snapshot.binding ? snapshot.binding : null;
  }

  async function probe(binding) {
    if (!binding) return null;
    const tab = await chromeApi.tabs.get(binding.tabId).catch(() => null);
    if (!tab) return null;
    // `probeSpecificTab` takes a *target* `{tabId, windowId}`, not a tab object.
    // Passing the tab here made every real probe fall into the same catch and
    // report `tab_unavailable`; the injected fake in the unit test hid it, and
    // only the end-to-end run against the real preflight code showed it.
    const result = await probeSpecificTab(chromeApi, {
      tabId: binding.tabId,
      windowId: binding.windowId,
    });
    if (!result) return null;
    // T048: a dropped or frozen tab used to collapse into `null`, which `decide`
    // reports as the generic `probe_unavailable` -- a deferral with no cause, and
    // therefore nothing an operator could act on or a popup could explain. The
    // facts are passed through instead, so the refusal names what is actually
    // wrong while remaining a pre-write refusal either way.
    if (result.status === 'discarded' || result.status === 'frozen') {
      return {
        tabId: binding.tabId, windowId: binding.windowId, url: binding.url,
        conversationId: binding.conversationId,
        documentInstanceId: binding.documentInstanceId,
        discarded: result.status === 'discarded',
        frozen: result.status === 'frozen',
        visibilityState: result.status === 'discarded' ? 'unloaded' : 'hidden',
        observedAt: now(),
        unobservable: result.status,
      };
    }
    if (result.status !== 'background_observable') return null;
    // Re-read: the probe takes time, and a tab that moved during it is not the
    // tab that was measured.
    const after = await chromeApi.tabs.get(binding.tabId).catch(() => null);
    if (!after || after.url !== tab.url || after.id !== tab.id) return null;
    return Object.assign({}, result, {
      active: after.active === true,
      // The tab's own liveness, read from Chrome rather than inferred from the
      // document's visibility: a hidden tab is expected here, a frozen one is not.
      discarded: after.discarded === true,
      frozen: after.frozen === true,
      // `composerEmpty` is only present when the probe observed the composer;
      // absent means "unknown", which the policy treats as not-occupied.
      composerEmpty: typeof result.composerEmpty === 'boolean'
        ? result.composerEmpty : undefined,
    });
  }

  async function write(candidate, binding, deliveryMode) {
    const reply = await chromeApi.tabs.sendMessage(binding.tabId, {
      type: 't058-write-notice', runId: candidate.runId, status: candidate.status,
      // The gate already compared the probe with the binding, but the page can
      // still navigate during the round trip to the content script. Handing the
      // expected id down lets the adapter refuse *before* typing, instead of
      // discovering the mismatch in the evidence afterwards -- by then the notice
      // is already in whatever conversation the tab moved to.
      expectedConversationId: binding.conversationId,
      // T052: the same argument, for the document instead of the route. A
      // same-URL reload keeps the conversation id but replaces the document, and
      // the content script that answers this message may be the new one. Without
      // this field the page layer has nothing to compare and a reload in this
      // window gets the notice.
      expectedDocumentInstanceId: binding.documentInstanceId,
      // T048: which grant authorised this write. The content script re-checks the
      // mode against the live page instead of assuming the worker got it right.
      deliveryMode: deliveryMode === 'background' ? 'background' : 'foreground',
    });
    if (!reply || reply.ok !== true || !reply.result) {
      return { status: 'unconfirmed',
        reason: 'content_refused:' + (reply && reply.error ? reply.error : 'no_reply') };
    }
    return reply.result;
  }

  const controller = createAutoSendController({
    now: deps.now,
    load: async () => (await chromeApi.storage.local.get({ autosend: null })).autosend,
    save: async (state) => { await chromeApi.storage.local.set({ autosend: state }); },
    readBinding,
    probe,
    write,
  });

  async function readCandidates() {
    const stored = await chromeApi.storage.local.get({ [TRIGGER_CANDIDATES_KEY]: [] });
    const list = stored[TRIGGER_CANDIDATES_KEY];
    return Array.isArray(list) ? list : [];
  }

  // Draining is explicit: a candidate is removed only after it was attempted, so
  // a crash mid-flight leaves it in the list *and* in the journal. The journal
  // is what stops the retry, not the list.
  async function consumeCandidate(predicate) {
    const list = await readCandidates();
    const kept = list.filter((item) => !predicate(item));
    if (kept.length !== list.length) {
      await chromeApi.storage.local.set({ [TRIGGER_CANDIDATES_KEY]: kept });
    }
    return kept;
  }

  return { controller, readBinding, probe, write, readCandidates, consumeCandidate };
}
