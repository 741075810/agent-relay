// T044 prototype: read-only detection inside a ChatGPT tab.
//
// This file contains no write path at all. It does not focus the composer, does
// not set its value, does not dispatch input events, does not click send, and
// does not call form.submit(). Its entire job is to answer "what is on this
// page right now" so the operator -- and the popup -- can tell whether the tab
// would even be usable.
//
// The absence of a write path is the point, not an oversight. The reason the
// earlier UIA and CDP routes needed so much machinery (foreground refusal,
// write-then-read-back, bubble confirmation, an unretryable AMBIGUOUS state) is
// that typing into a live conversation is irreversible. A prototype that could
// type would inherit all of that risk before the read-only half had been shown
// to work.

const COMPOSER_SELECTORS = [
  'div[contenteditable="true"][data-testid="prompt-textarea"]',
  'div[contenteditable="true"].ProseMirror',
  'textarea[data-testid="prompt-textarea"]',
  'form div[contenteditable="true"]',
];

const OWN_MESSAGE_SELECTOR = '[data-message-author-role="user"]';

// T095B76: the document id has to survive a *re-injection into the same document*.
//
// It used to be `crypto.randomUUID()` per evaluation, which made it an id for this
// script instance rather than for the document. That was invisible while a content
// script only ever ran once per document. It stopped being invisible when the
// extension started reconnecting content scripts after a reload (T095B76): the
// re-injected script announced a brand new id, the binding it was meant to satisfy
// said `document_instance_changed`, and the operator was asked to bind again -- the
// exact step the reconnect existed to avoid.
//
// `performance.timeOrigin` is fixed when the document is created, so it is the
// document's own identity rather than any script's. Two evaluations in the same
// document reproduce it exactly; a reload or a navigation starts a new document and
// therefore a new value. T052's rule is untouched: a same-URL reload still changes
// the id, because the reload creates a new document.
//
// Read from the isolated world, where the page's own JavaScript cannot reach or
// rewind it, and mixed with a fixed tag so the value stays opaque rather than
// publishing the document's creation time wherever an id is displayed.
function stableDocumentId() {
  let origin;
  try {
    origin = typeof performance !== 'undefined' &&
      Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : null;
  } catch (_err) {
    origin = null;
  }
  if (origin === null) {
    // No time origin to key on: fall back to a per-instance id, which means a
    // reconnect cannot prove sameness and the binding will ask for a re-bind.
    // Degrading to today's behaviour is the safe direction; inventing a stable
    // value from the clock or the URL would be a guess dressed as proof.
    return crypto.randomUUID();
  }
  // Microseconds keep two documents that start in the same millisecond apart.
  const seed = 'dsh-doc-v1\u0000' + String(Math.round(origin * 1000));
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < seed.length; i += 1) {
    const code = seed.charCodeAt(i);
    a ^= code;
    a = Math.imul(a, 0x01000193) >>> 0;
    b = (b + code) >>> 0;
    b = Math.imul(b ^ (b >>> 13), 0x85ebca6b) >>> 0;
  }
  const hex = (n) => n.toString(16).padStart(8, '0');
  const left = hex(a) + hex(b);
  let c = 0xc2b2ae35;
  let d = 0x27d4eb2f;
  for (let i = seed.length - 1; i >= 0; i -= 1) {
    const code = seed.charCodeAt(i);
    c ^= code;
    c = Math.imul(c, 0x85ebca6b) >>> 0;
    d = (d + Math.imul(code, 0x9e3779b1)) >>> 0;
  }
  return 'doc-' + left + hex(c) + hex(d);
}

const DOCUMENT_INSTANCE_ID = stableDocumentId();

// Kept byte-identical in spirit to the README claim it supports: nothing here
// reads message text. `count` is a number; no innerText is ever returned.
function countOwnMessages() {
  try {
    return document.querySelectorAll(OWN_MESSAGE_SELECTOR).length;
  } catch (err) {
    return -1;                        // -1 means "could not count", never 0
  }
}

function findComposer() {
  for (const selector of COMPOSER_SELECTORS) {
    const nodes = document.querySelectorAll(selector);
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { selector, width: Math.round(rect.width),
                 height: Math.round(rect.height) };
      }
    }
  }
  return null;
}

function detect() {
  const composer = findComposer();
  const url = location.href;
  const path = location.pathname;
  return {
    url,
    conversationId: (path.match(/\/c\/([0-9a-f-]{36})/) || [])[1] || null,
    // A visible input is only a page-state signal, not account authentication.
    composerPresent: composer !== null,
    composer: composer,
    ownMessageCount: countOwnMessages(),
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    at: new Date().toISOString(),
  };
}

function readonlyProbe(requestId) {
  const beforeUrl = location.href;
  const composerPresent = findComposer() !== null;
  const visibilityState = document.visibilityState;
  const hasFocus = document.hasFocus();
  const afterUrl = location.href;
  const parsed = new URL(afterUrl);
  const match = parsed.pathname.match(/^\/c\/([0-9a-f-]{36})$/i);
  return {
    type: 'readonly-probe-response',
    requestId,
    documentInstanceId: DOCUMENT_INSTANCE_ID,
    routeStable: beforeUrl === afterUrl,
    observedAt: Date.now(),
    url: afterUrl,
    conversationId: match ? match[1] : null,
    visibilityState,
    hasFocus,
    composerPresent,
    pageLoaded: document.readyState === 'complete',
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'readonly-probe' &&
      typeof msg.requestId === 'string' && msg.requestId.length > 0) {
    sendResponse(readonlyProbe(msg.requestId));
    return true;
  }
  // T058: the only write path in this file, and it is opt-in per message.
  //
  // The read-only half above is untouched. This branch exists because the
  // browser will not run an ES module as a content script, so the adapter --
  // which owns every refusal rule -- is loaded dynamically instead of being
  // reimplemented here. Duplicating those rules would give the project two
  // definitions of "safe to type", which is how they drift apart.
  //
  // It refuses anything that is not a `{runId, status}` pair, and the adapter
  // itself re-derives the text from the fixed template, so a caller cannot
  // smuggle prose through this channel.
  if (msg && msg.type === 't058-write-notice') {
    // T052: prove this is still the document the grant was authorised for,
    // BEFORE the dynamic import below and before anything touches the page.
    //
    // The worker already compares the probe's document instance with the binding,
    // but the tab can finish a same-URL reload during the round trip to this
    // script. A reload keeps the conversation id and gives this file a brand new
    // `DOCUMENT_INSTANCE_ID`, so every route check downstream would still pass
    // while the document underneath is not the one that was approved. The check
    // has to live here because this constant is the only honest source of truth
    // about which document is currently running.
    //
    // Both answers are deterministic pre-write refusals with `composerTouched`
    // false, so the worker records "nothing was written" instead of an attempt it
    // can never retry. Missing means a caller that does not know about this gate:
    // refused rather than trusted, because an unprovable identity is the hazard
    // this check exists to remove.
    if (typeof msg.expectedDocumentInstanceId !== 'string' ||
        msg.expectedDocumentInstanceId === '') {
      sendResponse({ ok: true, result: {
        status: 'refused', reason: 'document_identity_unavailable',
        composerTouched: false, composerWritten: false, clickPerformed: false,
        evidence: { precheckOnly: true, expected: null,
                    live: DOCUMENT_INSTANCE_ID },
      } });
      return true;
    }
    if (msg.expectedDocumentInstanceId !== DOCUMENT_INSTANCE_ID) {
      sendResponse({ ok: true, result: {
        status: 'refused', reason: 'document_instance_changed',
        composerTouched: false, composerWritten: false, clickPerformed: false,
        evidence: { precheckOnly: true, expected: msg.expectedDocumentInstanceId,
                    live: DOCUMENT_INSTANCE_ID },
      } });
      return true;
    }
    // T095B76: one writer per document, even if this file somehow runs twice in the
    // same isolated world. Before T095B76 that could not happen -- a content script
    // ran once per document and that was the end of it. Reconnecting a lost script
    // introduces a second evaluation, so the guarantee has to be stated rather than
    // assumed: the latch is set synchronously, before the first await, so a second
    // listener cannot slip past it. Two writers here would mean two notices in the
    // same conversation, which is precisely the damage the rest of this file spends
    // its time preventing.
    if (globalThis.__dshWriteInFlight === true) {
      sendResponse({ ok: true, result: {
        status: 'refused', reason: 'concurrent_write_in_flight',
        composerTouched: false, composerWritten: false, clickPerformed: false,
        evidence: { precheckOnly: true, documentInstanceId: DOCUMENT_INSTANCE_ID },
      } });
      return true;
    }
    globalThis.__dshWriteInFlight = true;
    (async () => {
      try {
        const adapter = await import(chrome.runtime.getURL('lib/send_adapter.js'));
        // `deliverInto` now waits for a bounded receipt, so the answer must be
        // awaited: sending the pending Promise through `sendResponse` would not
        // survive structured cloning, and the caller would see a refusal-shaped
        // reply for a notice that did get written.
        const result = await adapter.deliverInto(document, {
          runId: msg.runId, status: msg.status,
          expectedConversationId: msg.expectedConversationId,
          // T048: which grant this write came from. The adapter re-checks the mode
          // against the live document, so a bug in the worker cannot make a
          // background write behave like a foreground one, or the reverse.
          deliveryMode: msg.deliveryMode,
          // T052: handed down so the adapter can re-ask at its own pre-write and
          // pre-click gates, rather than trusting that this check happened.
          expectedDocumentInstanceId: msg.expectedDocumentInstanceId,
        }, Date.now(), { documentInstanceId: DOCUMENT_INSTANCE_ID });
        sendResponse({ ok: true, result });
      } catch (err) {
        // A missing module, a CSP refusal or a changed page all land here, and
        // all of them mean "do not send". The caller records it as unconfirmed.
        sendResponse({ ok: false,
          error: String(err && err.message ? err.message : err) });
      } finally {
        // Released on every path, including a refusal thrown from inside the
        // adapter, so one failed attempt cannot wedge the document for good.
        globalThis.__dshWriteInFlight = false;
      }
    })();
    return true;
  }
  return false;
});

function report() {
  try {
    chrome.runtime.sendMessage({ type: 'content-report', report: detect() });
  } catch (err) {
    // The service worker may be asleep; that is expected and harmless for a
    // read-only probe. Nothing is retried, because nothing is at stake.
  }
}

// Report on load, and once more if the tab becomes visible again. No polling
// loop: a busy content script in every ChatGPT tab would be its own problem.
report();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    report();
  }
});
