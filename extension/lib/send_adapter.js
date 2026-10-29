// T058: the page-write adapter Plan A was missing.
//
// This is the only file in the project that types into a ChatGPT conversation,
// so its shape is chosen for one property above all: every refusal happens
// *before* the irreversible step, and the irreversible step happens at most
// once per call.
//
// What it will not do, on purpose:
//   * it never retries -- not on a missing button, not on a failed read-back,
//     not on an unconfirmed result. A retry after a partial write is how a
//     conversation receives the same notice twice;
//   * it never falls back to pressing Enter. Enter is a second write path whose
//     outcome differs by UI version; one path is auditable, two are not;
//   * it never appends to a non-empty composer. A human's half-written draft is
//     not ours to merge with;
//   * it never composes free text. The notice is derived from
//     `send_gate.fixedTemplate`, so a caller cannot smuggle prose in.
//
// The DOM is injected (`document` plus an optional `send` callback) so the whole
// thing is testable offline against a fake page, and so this module needs no
// Chrome API of its own.
import { fixedTemplate } from './send_gate.js';

export const COMPOSER_SELECTORS = [
  'div[contenteditable="true"][data-testid="prompt-textarea"]',
  'div[contenteditable="true"].ProseMirror',
  'textarea[data-testid="prompt-textarea"]',
  'form div[contenteditable="true"]',
];

const SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="发送"]',
  'form button[type="submit"]',
];

export const MAX_COMPOSER_CHARS = 4096;

// T079: markers that mean "this control does not send".
//
// A composer inside a streaming conversation often carries a stop control that
// also matches `form button[type="submit"]`. Clicking it aborts a generation
// instead of posting a notice, which is worse than refusing, so those candidates
// are dropped rather than ranked.
const NON_SEND_MARKERS = ['stop', 'abort', 'cancel', '停止', '中止', '取消',
  // T081: the controls measured next to the composer while it was empty. None of
  // them sends, and three of them are destructive if mistaken for send (voice
  // starts a recording, dictate starts dictation, attach opens a file picker).
  'voice', 'dictate', 'microphone', '录音', '语音', '听写', 'attach', 'upload',
  '文件', 'model', '模型'];

// T081: controls that identify the composer's own input area. Their presence is the
// evidence that "a send control is expected here but does not exist yet" -- the
// current UI creates the send button only once the composer has text, so requiring
// one up front refused a page that can send perfectly well.
//
// This is a *preflight anchor*, never a click target: `deliverInto` only ever
// clicks a control that passed the send selectors and the uniqueness check.
export const INPUT_AREA_MARKERS = ['添加文件', '附件', '文件', 'attach', 'file',
  '模型', 'model', '听写', 'dictate', '语音', 'voice', 'microphone'];
// One identifiable input-area control is enough to prove the cluster; demanding
// more would refuse layouts that hide the attach button behind a menu.
export const MIN_ANCHOR_CONTROLS = 1;

// How long the send control may take to become usable *after* the composer is
// written. Frameworks enable it on the render that follows the input event, so a
// same-tick read is a race the adapter used to lose. Bounded, because an unbounded
// wait turns "not ready" into a hang instead of a stop.
export const BUTTON_READY_TIMEOUT_MS = 1500;

// T079: the three outcomes are different facts and must never be reported as one.
//
//   never_written        nothing was typed; the page is exactly as it was found
//   written_not_clicked  the notice is in the composer, no click happened
//   clicked_unknown      the click landed; only the page can now say what happened
//
// The mapping is by reason code and is deliberately closed: an unrecognised reason
// returns `null` rather than a guess, because guessing here is what turns "we do
// not know" into a false claim.
export const NEVER_WRITTEN = 'never_written';
export const WRITTEN_NOT_CLICKED = 'written_not_clicked';
export const CLICKED_UNKNOWN = 'clicked_unknown';

const NEVER_WRITTEN_REASONS = [
  'composer_unavailable', 'composer_unreadable', 'composer_not_empty',
  'send_control_missing', 'send_control_ambiguous', 'target_focus_lost',
  'conversation_route_changed', 'conversation_changed_at_page',
  'notice_too_long', 'notice_template_invalid',
  // T052: the document is not the one the grant was bound to. Caught before the
  // composer is touched, so the caller records a refusal rather than an attempt.
  'document_instance_changed', 'document_identity_unavailable',
  // T051: an open dialog over the composer. Nothing was typed, so this belongs to
  // the "page is exactly as it was found" class and not to the attempt class.
  'modal_open',
];
const WRITTEN_NOT_CLICKED_REASONS = [
  'insert_mismatch', 'insert_lost_before_click',
  'send_button_not_ready', 'send_button_hidden',
  'send_button_missing_after_write', 'send_control_changed_before_click',
  'conversation_changed_before_click', 'target_lost_focus_before_click',
  // T051: the dialog appeared after the notice was in the box. Typed but not
  // clicked, which is the honest description and must not be read as a send.
  'modal_open_before_click',
  // T052: the same fact, discovered after the notice was already in the box.
  'document_instance_changed_before_click',
  'document_identity_unavailable_before_click',
];
const CLICKED_REASONS = [
  'conversation_changed_during_receipt', 'duplicate_message_appeared',
  'delivery_not_confirmed', 'adapter_error',
];

/** `never_written` | `written_not_clicked` | `clicked_unknown` | null. */
export function classifySendReason(reason) {
  if (typeof reason !== 'string' || reason === '') return null;
  const code = reason
    .replace(/^(?:stopped|blocked|ambiguous_stop):/, '')
    .replace(/_after_\d+_deferrals$/, '')
    .replace(/^adapter_error:.*$/, 'adapter_error');
  if (CLICKED_REASONS.includes(code)) return CLICKED_UNKNOWN;
  if (WRITTEN_NOT_CLICKED_REASONS.includes(code)) return WRITTEN_NOT_CLICKED;
  if (NEVER_WRITTEN_REASONS.includes(code)) return NEVER_WRITTEN;
  return null;
}

// How long a receipt may take before the click is called unconfirmed. Bounded on
// purpose: an unbounded wait would keep the content script alive indefinitely and
// turn a missing confirmation into a silent hang instead of a stop.
export const RECEIPT_TIMEOUT_MS = 4000;

// The notice is a fixed sentence plus the run id. Nothing else may reach a page.
export function composeNotice(runId, status) {
  const template = fixedTemplate({ channel: 'dsh-chat-send-proposal-v1',
    proposalId: 'a'.repeat(64), runId, status });
  if (!template.ok) return { ok: false, reason: template.code };
  return { ok: true, text: template.text };
}

function visible(node) {
  try {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  } catch (_err) {
    return false;
  }
}

export function findComposer(doc) {
  for (const selector of COMPOSER_SELECTORS) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(selector);
    } catch (_err) {
      continue;
    }
    for (const node of nodes || []) {
      if (visible(node)) return node;
    }
  }
  return null;
}

// T051: is the page showing a dialog that owns the operator's attention?
//
// The background worker has a `session_occupied_by_dialog` rule, but it reads
// `probe.modalOpen` and the read-only probe never reports that field -- so in the
// served build the rule could never fire. That left the page-side writer with no
// dialog check at all, and a dialog does not stop anything by itself: assigning
// `.value` and calling `button.click()` are direct dispatches that never consult an
// overlay. Without this, a notice is typed into the composer *behind* an open
// dialog and posted into the conversation while the operator is in the middle of
// something else. Measured: one click, one message, dialog still open.
//
// Only the two unambiguous "the browser says this is modal" signals count:
//
//   [aria-modal="true"]  the ARIA contract; what the dialog primitives this page
//                        uses (Radix and friends) set on the content node.
//   dialog:modal         a native <dialog> opened with showModal(), i.e. in the
//                        top layer with the rest of the page inert.
//
// A bare `role="dialog"` is deliberately NOT enough: non-modal popovers carry it
// too, and mistaking one of those for a modal would refuse every delivery for as
// long as it happened to be rendered. Both selectors also require the node to be
// *visible*, because portals are left in the DOM after closing, hidden by
// `display:none`.
export const MODAL_SELECTORS = Object.freeze([
  '[aria-modal="true"]',
  'dialog:modal',
]);

/**
 * T052: does the document holding this composer match the authorised one?
 *
 * `expected` is what the grant was bound to; `deps.documentInstanceId` is what the
 * script running in this document says it is. Three outcomes:
 *
 *   no identity supplied at all  -> { ok: true }, nothing to compare. This keeps
 *                                   direct callers unchanged; the product path
 *                                   (content script -> here) always supplies it.
 *   identity present, expected   -> `document_instance_changed`. Same code the
 *     absent or different           worker uses for the same fact at probe time,
 *                                   so one fact never has two verdicts.
 *   other                        -> `document_identity_unavailable`, also refused:
 *                                   an expected id we cannot verify is not
 *                                   evidence of anything.
 */
function documentIdentityCheck(expected, deps) {
  const live = deps && typeof deps.documentInstanceId === 'string'
    ? deps.documentInstanceId : null;
  if (live === null || live === '') return { ok: true };
  if (typeof expected !== 'string' || expected === '') {
    return { ok: false, reason: 'document_identity_unavailable',
      detail: { expected: null, live } };
  }
  if (expected !== live) {
    return { ok: false, reason: 'document_instance_changed',
      detail: { expected, live } };
  }
  return { ok: true };
}

/** The selector that proved a dialog is open, or null. Read-only. */
export function blockingDialog(doc) {
  for (const selector of MODAL_SELECTORS) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(selector);
    } catch (_err) {
      // An engine that does not know `:modal` throws; that is not a dialog.
      continue;
    }
    for (const node of nodes || []) {
      if (visible(node)) return selector;
    }
  }
  return null;
}

function attributeOf(node, name) {
  try {
    if (node && typeof node.getAttribute === 'function') return node.getAttribute(name);
  } catch (_err) { /* detached or exotic node */ }
  return null;
}

function isNonSendControl(node) {
  const probe = String(attributeOf(node, 'data-testid') || '') + ' '
    + String(attributeOf(node, 'aria-label') || '');
  const lower = probe.toLowerCase();
  return NON_SEND_MARKERS.some((marker) => lower.includes(marker));
}

function closestForm(node) {
  try {
    if (node && typeof node.closest === 'function') return node.closest('form');
  } catch (_err) { /* no closest: treat as form-less */ }
  return null;
}

// A disabled attribute is only one of the two ways a control advertises itself as
// unusable; `aria-disabled` is the other, and it is not reflected in `.disabled`.
function isEnabled(node) {
  if (!node) return false;
  if (node.disabled === true) return false;
  return attributeOf(node, 'aria-disabled') !== 'true';
}

/**
 * Every control that could be the send button for *this* composer.
 *
 * The count matters more than the order. Two distinct controls mean the page has
 * not told us which one sends, and picking the first is how a notice ends up
 * aborting a generation; so callers must treat `length > 1` as "unknown", never as
 * "use the first".
 *
 * Ownership is proved by the enclosing form when the composer has one. A candidate
 * inside a *different* form is never ours. When the composer's own form yields
 * nothing, a candidate outside every form is still considered -- some layouts
 * portal the button out of the form -- but a candidate in another form never is.
 */
export function sendControlCandidates(doc, composer) {
  const scope = closestForm(composer);
  const seen = new Set();
  const owned = [];
  const formless = [];
  for (const selector of SEND_SELECTORS) {
    let nodes;
    try {
      nodes = doc.querySelectorAll(selector);
    } catch (_err) {
      continue;
    }
    for (const node of nodes || []) {
      if (!node || seen.has(node)) continue;
      seen.add(node);
      if (!visible(node)) continue;
      if (isNonSendControl(node)) continue;
      const form = closestForm(node);
      if (scope ? form === scope : form === null) {
        owned.push(node);
      } else if (form === null) {
        formless.push(node);
      }
    }
  }
  return owned.length > 0 ? owned : formless;
}

/**
 * Visible controls in the composer's own form that identify the input area.
 *
 * Read-only, preflight only. A non-empty result is evidence that this composer has
 * a control cluster and will grow a send control once it holds text; it is never
 * used as a click target.
 */
export function inputAreaAnchors(doc, composer) {
  const scope = closestForm(composer);
  if (!scope) return [];
  let nodes;
  try {
    nodes = doc.querySelectorAll('button');
  } catch (_err) {
    return [];
  }
  const out = [];
  for (const node of nodes || []) {
    if (!node || !visible(node)) continue;
    if (closestForm(node) !== scope) continue;
    const probe = (String(attributeOf(node, 'aria-label') || '') + ' '
      + String(attributeOf(node, 'data-testid') || '') + ' '
      + String(attributeOf(node, 'title') || '')).toLowerCase();
    if (!INPUT_AREA_MARKERS.some((marker) => probe.includes(marker))) continue;
    out.push(node);
  }
  return out;
}

/**
 * Read-only answer to "could this page be sent from at all?".
 *
 * Runs before the composer is touched, so a refusal leaves no draft behind.
 *
 * Two ways to pass, and they are not the same:
 *
 *   mode 'present'  exactly one identifiable send control already exists. A
 *                   *disabled* one is fine here: an empty composer is exactly when
 *                   a framework disables it, and the wait after the write handles
 *                   that.
 *   mode 'dynamic'  no send control yet, but the composer's own form carries
 *                   input-area controls, so the current UI is expected to create
 *                   the send control once the composer has text. Typing is allowed
 *                   and the control is then awaited; a control that never appears
 *                   is a written-not-clicked stop, never a silent retry.
 *
 * Zero candidates and zero anchors is still `send_control_missing`: without both
 * there is nothing to prove the page will ever offer a button.
 */
export function inspectSendControl(doc, composer) {
  const candidates = sendControlCandidates(doc, composer);
  if (candidates.length === 1) {
    const node = candidates[0];
    return { ok: true, mode: 'present', reason: null, candidates: 1, node,
      readyNow: isEnabled(node),
      anchors: inputAreaAnchors(doc, composer).length };
  }
  if (candidates.length > 1) {
    return { ok: false, mode: 'present', reason: 'send_control_ambiguous',
      candidates: candidates.length, node: null, anchors: 0 };
  }
  const anchors = inputAreaAnchors(doc, composer);
  if (anchors.length >= MIN_ANCHOR_CONTROLS) {
    return { ok: true, mode: 'dynamic', reason: null, candidates: 0, node: null,
      readyNow: false, anchors: anchors.length };
  }
  return { ok: false, mode: 'none', reason: 'send_control_missing',
    candidates: 0, node: null, anchors: anchors.length };
}

export function readComposer(composer) {
  if (!composer) return null;
  if (typeof composer.value === 'string') return composer.value;
  if (typeof composer.textContent === 'string') return composer.textContent;
  return null;
}

// T048: the write path, now mode-aware.
//
// Two strategies are needed because the modes differ in what they may rely on.
// Foreground delivery focuses the box and uses `execCommand('insertText')`, which
// is the closest thing to real typing and is what the served page accepts.
//
// Background delivery deliberately does neither. `element.focus()` does not by
// itself raise a tab, but `execCommand` and anything downstream of focus can
// depend on the document being the active one, and a refusal there is
// indistinguishable from the front end rejecting the write. So the background path
// only does what a paste ultimately does: set the value and dispatch the input
// event the page listens for. If the page still refuses to adopt the text, the
// result is `insert_mismatch` -- reported, never retried, never sent.
function writeComposer(doc, composer, text, mode) {
  const background = mode === 'background';
  if (!background && typeof composer.focus === 'function') composer.focus();
  if (!background && typeof doc.execCommand === 'function' &&
      doc.execCommand('insertText', false, text) === true) {
    return true;
  }
  if (typeof composer.value === 'string') {
    composer.value = text;
  } else {
    composer.textContent = text;
  }
  if (typeof composer.dispatchEvent === 'function' &&
      typeof doc.createEvent === 'function') {
    const event = doc.createEvent('Event');
    event.initEvent('input', true, true);
    composer.dispatchEvent(event);
  }
  return true;
}

// T084: where a user message actually lives in the page we now get served.
//
// The measured DOM, read off a message that really did appear:
//
//   <div data-chatgpt-search-unit-key …>          level 8
//     …
//       <div class="bg-user-message bubble-vBnidZ"  level 5
//            data-user-message-bubble>              <- attribute PRESENCE
//         <div class="text-size-chat whitespace-pre-wrap">DSH task …</div>
//         <button aria-label="复制">…</button>       <- interactive siblings
//       </div>
//
// and, on the same page, `[data-message-author-role="user"]`,
// `[data-testid^="conversation-turn-"]`, `[data-testid="user-message"]`,
// `[data-role="user"]` and `main article` all returned 0. So T071's single
// selector was reading nothing: every real send would have timed out and been
// recorded as `delivery_not_confirmed` -- which is exactly the live result.
//
// The bubble is matched by the presence of its data attribute, never by the hashed
// class (`bubble-vBnidZ` changes between builds). The legacy selector is kept so
// older layouts and stored evidence still resolve, but the two are merged into one
// count, so a page where both match one message counts it once.
export const RECEIPT_SELECTORS = Object.freeze([
  '[data-user-message-bubble]',
  '[data-message-author-role="user"]',
]);

// A node with no geometry at all cannot be called hidden; a node that measures zero
// on both axes can. Kept separate from `visible()` so a legacy fixture without
// getBoundingClientRect is not silently excluded.
function measurable(node) {
  try {
    return typeof node.getBoundingClientRect === 'function';
  } catch (_err) {
    return false;
  }
}

function rendered(node) {
  if (!measurable(node)) return true;
  return visible(node);
}

// Exact comparison only. Whitespace at the edges of the rendered node is normalised
// because a renderer may wrap the text in empty text nodes; a superset, a prefix or
// a substring is *not* the notice and must never be accepted.
function isNoticeText(node, text) {
  const raw = readComposer(node);
  if (typeof raw !== 'string') return false;
  return raw === text || raw.trim() === text;
}

// Does this candidate carry the notice -- as its whole text, or as the whole text of
// one verifiable descendant?
//
// The descendant path is not a loosening: the real bubble also holds 复制/编辑
// buttons, so the bubble's own textContent is "DSH task … completed.复制编辑" and an
// exact match on the bubble alone would be a permanent false negative. A descendant
// whose entire text equals the template is the message body itself. Anything less
// exact (the template plus a suffix in the same node) still fails.
function carriesNotice(node, text) {
  if (isNoticeText(node, text)) return { ok: true, path: 'self', node };
  let descendants;
  try {
    descendants = typeof node.querySelectorAll === 'function'
      ? node.querySelectorAll('*') : [];
  } catch (_err) {
    return { ok: false, path: null, node: null };
  }
  for (const child of descendants || []) {
    if (isNoticeText(child, text)) return { ok: true, path: 'text', node: child };
  }
  return { ok: false, path: null, node: null };
}

function parentOf(node) {
  if (!node) return null;
  const direct = node.parentElement;
  if (direct) return direct;
  const list = node.parents;
  if (Array.isArray(list) && list.length > 0) return list[0];
  return null;
}

function isInside(node, maybeAncestor) {
  let cursor = parentOf(node);
  for (let depth = 0; cursor && depth < 128; depth += 1) {
    if (cursor === maybeAncestor) return true;
    cursor = parentOf(cursor);
  }
  return false;
}

/**
 * Every node on the page that carries this exact notice, one entry per message.
 *
 * Two selectors can point at the same message (a bubble inside a user turn), so the
 * match list is reduced to its outermost nodes before counting. Without that, one
 * real message would count as two and be reported as a duplicate.
 */
export function receiptProbe(doc, text) {
  const matched = [];
  const paths = [];
  let queried = 0;
  let failed = 0;
  for (const selector of RECEIPT_SELECTORS) {
    let nodes;
    queried += 1;
    try {
      nodes = doc.querySelectorAll(selector);
    } catch (_err) {
      failed += 1;
      continue;
    }
    for (const node of nodes || []) {
      if (!node || matched.includes(node)) continue;
      const hit = carriesNotice(node, text);
      if (!hit.ok) continue;
      // The element that actually holds the text must be rendered. A hidden copy of
      // the template -- a ghost bubble, a collapsed preview -- is not evidence that
      // this notice was posted.
      if (!rendered(hit.node)) continue;
      matched.push(node);
      paths.push(selector + ':' + hit.path);
    }
  }
  const outermost = matched.filter((node) => !matched.some(
    (other) => other !== node && isInside(node, other)));
  return {
    count: failed === queried ? -1 : outermost.length,
    matched: outermost.length,
    raw: matched.length,
    path: outermost.length > 0 ? paths.join('+') : null,
    selectors: RECEIPT_SELECTORS.length,
  };
}

function countOwnMessages(doc, text) {
  return receiptProbe(doc, text).count;
}


// The conversation the tab is actually showing, or null when the URL is not a
// conversation route. Read immediately before typing.
export function currentConversationId(doc) {
  try {
    const path = doc && doc.location && typeof doc.location.pathname === 'string'
      ? doc.location.pathname : null;
    if (path === null) return null;
    const match = path.match(/\/c\/([0-9a-f-]{36})/i);
    return match ? match[1].toLowerCase() : null;
  } catch (_err) {
    return null;
  }
}

// One reading of "has the page accepted the notice yet".
//
// `navigated` is terminal and is checked first: once the tab is no longer on the
// conversation we typed into, nothing observed afterwards can prove where the
// notice went, so the caller must never be told "submitted".
function readReceipt(doc, composer, text, baseline, startedIn) {
  const after = readComposer(composer);
  const here = currentConversationId(doc);
  const probe = receiptProbe(doc, text);
  const appeared = probe.count < 0 ? -1 : probe.count - baseline;
  const navigated = startedIn !== null && here !== startedIn;
  const composerEmpty = after !== null && after.trim() === '';
  // Success needs *both* halves: exactly one new message carrying the exact
  // template, and an emptied composer. One without the other keeps waiting, so a
  // page that renders the message a tick before the composer clears is not
  // reported as a failure.
  const success = appeared === 1 && composerEmpty;
  return {
    snapshot: { composerEmpty, appeared, conversationId: here, navigated,
      receiptPath: probe.path, receiptCandidates: probe.count,
      receiptBaseline: baseline, receiptRaw: probe.raw },
    // Navigated and duplicated are terminal without a success: neither can turn
    // into one, and waiting longer only delays the stop.
    done: navigated || appeared >= 2 || success,
  };
}

/**
 * Wait for one bounded receipt.
 *
 * The observer fires on any DOM change; the timer is the hard stop. Both are
 * released before returning, so a settled call leaves no listener and no pending
 * timer behind in a content script that lives as long as its tab.
 *
 * Nothing here clicks, types, or clears anything: it only reads.
 */
function waitForReceipt(doc, takeSnapshot, options) {
  const { timeoutMs, timers, Observer, clock } = options;
  const startedAt = clock();
  const first = takeSnapshot();
  if (first.done) {
    return Promise.resolve({ timedOut: false,
      snapshot: first.snapshot, waitedMs: 0 });
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let observer = null;
    const finish = (snapshot, timedOut) => {
      if (settled) return;
      settled = true;
      if (timer !== null) { try { timers.clearTimeout(timer); } catch (_err) { /* gone */ } }
      if (observer) { try { observer.disconnect(); } catch (_err) { /* gone */ } }
      resolve({ timedOut, snapshot, waitedMs: clock() - startedAt });
    };
    const evaluate = () => {
      const next = takeSnapshot();
      if (next.done) finish(next.snapshot, false);
    };
    if (Observer) {
      try {
        const target = doc.body || doc.documentElement || null;
        if (target) {
          observer = new Observer(evaluate);
          observer.observe(target, { childList: true, subtree: true, characterData: true });
        } else {
          observer = null;
        }
      } catch (_err) {
        observer = null;         // a page without an observable body: rely on the timer
      }
    }
    timer = timers.setTimeout(() => { finish(takeSnapshot().snapshot, true); }, timeoutMs);
  });
}

/**
 * Wait, bounded, for the send control to become usable.
 *
 * The node handed in is the one identified before typing. It is re-checked rather
 * than re-discovered: a re-query on every tick is what would let a different
 * button -- a stop control, another form's submit -- become "the send button".
 * Only if the original node is gone is one scoped re-query allowed, and then only
 * a *unique* candidate is accepted.
 *
 * Like `waitForReceipt`, nothing here writes: it reads, and it always releases its
 * observer and timer before returning.
 */
function waitForControl(doc, composer, initial, options) {
  const { timeoutMs, timers, Observer, clock } = options;
  const startedAt = clock();

  const stillOurs = (node) => {
    if (!node || node.isConnected === false) return false;
    if (isNonSendControl(node)) return false;
    const scope = closestForm(composer);
    const form = closestForm(node);
    return scope ? form === scope : form === null;
  };

  const check = () => {
    let node = stillOurs(initial) ? initial : null;
    let path = 'same_node';
    let candidates = 1;
    if (!node) {
      const found = sendControlCandidates(doc, composer);
      candidates = found.length;
      if (found.length === 0) {
        return { ready: false, reason: 'send_button_missing_after_write',
          candidates: 0, node: null, path: 'lost' };
      }
      if (found.length > 1) {
        return { ready: false, reason: 'send_control_ambiguous',
          candidates, node: null, path: 'lost' };
      }
      node = found[0];
      path = 'requeried_unique';
    }
    if (!visible(node)) {
      return { ready: false, reason: 'send_button_hidden', candidates, node: null,
        path };
    }
    if (!isEnabled(node)) {
      return { ready: false, reason: 'send_button_not_ready', candidates, node,
        path };
    }
    return { ready: true, node, candidates, path };
  };

  const first = check();
  if (first.ready) return Promise.resolve(Object.assign({}, first, { waitedMs: 0 }));

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let observer = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) { try { timers.clearTimeout(timer); } catch (_err) { /* gone */ } }
      if (observer) { try { observer.disconnect(); } catch (_err) { /* gone */ } }
      resolve(Object.assign({}, outcome, { waitedMs: clock() - startedAt }));
    };
    const evaluate = () => {
      const next = check();
      if (next.ready) finish(next);
    };
    if (Observer) {
      try {
        const target = doc.body || doc.documentElement || null;
        if (target) {
          observer = new Observer(evaluate);
          observer.observe(target, { childList: true, subtree: true,
            attributes: true, attributeFilter: ['disabled', 'aria-disabled',
              'data-testid', 'aria-label', 'type', 'style', 'class'] });
        }
      } catch (_err) {
        observer = null;          // unobservable page: the timer is still a bound
      }
    }
    timer = timers.setTimeout(() => { finish(check()); }, timeoutMs);
  });
}

/**
 * T081: bounded wait for a send control that the page creates *after* the write.
 *
 * There is no node to hold on to, so the rule is uniqueness instead of identity:
 * every check re-queries and accepts only a single same-form control that passes
 * the send selectors, is visible and is enabled. Two candidates, a candidate in
 * another form, a stop/voice control, or nothing at all are all "not ready" --
 * the last observed reason is what gets reported when the timer expires.
 *
 * Never widens the selector list and never clicks: it only decides whether a click
 * may be attempted, and by whom.
 */
function waitForDynamicControl(doc, composer, options) {
  const { timeoutMs, timers, Observer, clock } = options;
  const startedAt = clock();

  const check = () => {
    const found = sendControlCandidates(doc, composer);
    if (found.length === 0) {
      return { ready: false, reason: 'send_button_missing_after_write',
        candidates: 0, node: null, path: 'dynamic' };
    }
    if (found.length > 1) {
      return { ready: false, reason: 'send_control_ambiguous',
        candidates: found.length, node: null, path: 'dynamic' };
    }
    const node = found[0];
    if (!visible(node)) {
      return { ready: false, reason: 'send_button_hidden', candidates: 1, node,
        path: 'dynamic' };
    }
    if (!isEnabled(node)) {
      return { ready: false, reason: 'send_button_not_ready', candidates: 1, node,
        path: 'dynamic' };
    }
    return { ready: true, node, candidates: 1, path: 'dynamic' };
  };

  const first = check();
  if (first.ready) return Promise.resolve(Object.assign({}, first, { waitedMs: 0 }));

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let observer = null;
    let last = first;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) { try { timers.clearTimeout(timer); } catch (_err) { /* gone */ } }
      if (observer) { try { observer.disconnect(); } catch (_err) { /* gone */ } }
      resolve(Object.assign({}, outcome, { waitedMs: clock() - startedAt }));
    };
    const evaluate = () => {
      last = check();
      if (last.ready) finish(last);
    };
    if (Observer) {
      try {
        const target = doc.body || doc.documentElement || null;
        if (target) {
          observer = new Observer(evaluate);
          observer.observe(target, { childList: true, subtree: true,
            attributes: true, attributeFilter: ['disabled', 'aria-disabled',
              'data-testid', 'aria-label', 'type', 'style', 'class'] });
        }
      } catch (_err) {
        observer = null;          // unobservable page: the timer is still a bound
      }
    }
    timer = timers.setTimeout(() => {
      evaluate();                       // one last read at the deadline
      if (!settled) finish(last);
    }, timeoutMs);
  });
}

/**
 * Type one fixed notice and submit it, once.
 *
 * Returns `{ status, reason, evidence }` where status is:
 *   'refused'     nothing was written; `reason` says which check failed
 *   'submitted'   the click landed and exactly one exact-template message appeared
 *   'unconfirmed' the click was made but the page never proved it landed
 *
 * The receipt is awaited rather than sampled inside the click's own tick. A React
 * page renders asynchronously, and reading immediately reported
 * `delivery_not_confirmed` for sends that were in fact fine -- which then disabled
 * the trigger. The wait is bounded, and a timeout is still `unconfirmed`.
 *
 * 'unconfirmed' is a stop state. The caller must record it and disable itself;
 * it must not call this function again for the same notice.
 */
export async function deliverInto(doc,
  { runId, status, expectedConversationId, deliveryMode, expectedDocumentInstanceId },
  now = Date.now(), deps = {}) {
  // T048: the mode is a parameter of the *write*, not a page fact. Absent or
  // unrecognised means foreground, so every existing caller keeps its semantics.
  const mode = deliveryMode === 'background' ? 'background' : 'foreground';
  const notice = composeNotice(runId, status);
  if (!notice.ok) {
    return { status: 'refused', reason: notice.reason, evidence: null };
  }
  const text = notice.text;
  if (text.length > MAX_COMPOSER_CHARS) {
    return { status: 'refused', reason: 'notice_too_long', evidence: null };
  }

  // T052: is this still the document the grant was authorised for?
  //
  // The worker compares the probe's document instance with the binding, but the
  // page can finish a same-URL reload during the round trip to this script, and
  // a reload keeps the conversation id. Then every route check in this file
  // passes while the document underneath is a different one: a new content
  // script instance, a fresh composer, the operator's page replaced.
  //
  // The content script owns the authoritative id, so it hands it down in `deps`
  // and performs the same comparison itself before importing this module. Both
  // layers exist on purpose: the content script cannot be tricked into calling
  // out-of-band, and this function cannot be made to write by a caller that
  // simply forgot. Only enforced when an identity is actually available, so a
  // direct caller with nothing to compare is unchanged; the product path always
  // supplies it.
  const identity = documentIdentityCheck(expectedDocumentInstanceId, deps);
  if (!identity.ok) {
    return { status: 'refused', reason: identity.reason,
      composerTouched: false, composerWritten: false, clickPerformed: false,
      evidence: { observedAt: now, precheckOnly: true, deliveryMode: mode,
        document: identity.detail } };
  }

  // Last chance to notice a navigation. The decision was made in the background
  // against a probe; between that probe and this call the tab may have been
  // redirected, restored from a discarded state, or simply navigated by the
  // operator. Refusing here costs nothing, because nothing is typed yet.
  if (typeof expectedConversationId === 'string' && expectedConversationId) {
    const here = currentConversationId(doc);
    if (here === null) {
      return { status: 'refused', reason: 'conversation_route_changed', evidence: null };
    }
    if (here !== expectedConversationId.toLowerCase()) {
      return { status: 'refused', reason: 'conversation_changed_at_page',
        evidence: { observedAt: now, expected: expectedConversationId, found: here } };
    }
  }

  const composer = findComposer(doc);
  if (!composer) {
    return { status: 'refused', reason: 'composer_unavailable',
      composerTouched: false, composerWritten: false, clickPerformed: false,
      evidence: null };
  }
  const before = readComposer(composer);
  if (before === null) {
    return { status: 'refused', reason: 'composer_unreadable',
      composerTouched: false, composerWritten: false, clickPerformed: false,
      evidence: null };
  }
  if (before.trim() !== '') {
    // A non-empty composer belongs to whoever typed into it.
    return { status: 'refused', reason: 'composer_not_empty',
      composerTouched: false, composerWritten: false, clickPerformed: false,
      evidence: null };
  }

  // T051: a dialog over the page is a page the operator is using right now.
  //
  // Background only, on purpose. Foreground delivery already requires the tab to be
  // focused, visible and active, so the operator is looking at the composer; this
  // mode's whole premise is that nobody is looking, which is what makes an
  // unnoticed overlay dangerous. Refusing here costs nothing: nothing is typed yet,
  // and the code is a *deferral*, so the candidate stays queued and the next tick
  // after the dialog closes sends it.
  if (mode === 'background') {
    const dialog = blockingDialog(doc);
    if (dialog !== null) {
      return { status: 'refused', reason: 'modal_open',
        composerTouched: false, composerWritten: false, clickPerformed: false,
        evidence: { observedAt: now, precheckOnly: true, deliveryMode: mode,
          dialog } };
    }
  }

  // T079/T081: prove the page can be sent from *before* typing into it. Doing this
  // afterwards is what left a notice stranded in the composer and stopped the
  // trigger. Two ways to pass: one control is already there, or the composer's own
  // form carries input-area anchors and the control is expected to appear.
  const preflight = inspectSendControl(doc, composer);
  if (!preflight.ok) {
    return { status: 'refused', reason: preflight.reason,
      composerTouched: false, composerWritten: false, clickPerformed: false,
      evidence: { observedAt: now, candidates: preflight.candidates,
        anchors: preflight.anchors, controlMode: preflight.mode,
        precheckOnly: true } };
  }
  const control = preflight.node;
  const controlMode = preflight.mode;
  // T048: the page re-checks the mode's own precondition rather than trusting the
  // background worker's word for it. A document the browser is not running -- a
  // prerendered or unloaded one -- cannot be typed into, and saying so here means
  // the caller records a refusal instead of an uncertain write.
  if (mode === 'background') {
    const visibility = doc.visibilityState;
    if (visibility !== undefined && !['visible', 'hidden'].includes(visibility)) {
      return { status: 'refused', reason: 'target_background_unobservable',
        composerTouched: false, composerWritten: false, clickPerformed: false,
        evidence: { observedAt: now, precheckOnly: true, deliveryMode: mode,
          visibilityState: String(visibility) } };
    }
  }
  // Focus is re-verified here rather than trusted from the background probe: the
  // probe is a few hundred milliseconds old by now, and typing into a tab the
  // operator has since left is exactly the case worth refusing cheaply.
  //
  // T048: that reasoning holds for foreground delivery only. In background mode
  // the operator *is* elsewhere by design, so a false `hasFocus()` is the expected
  // state, not evidence of anything. Note what this was never claimed to be: a
  // focus check is not account authentication, and it never was.
  const focusedNow = () => (typeof doc.hasFocus === 'function'
    ? doc.hasFocus() !== false : true);
  if (mode === 'foreground' && !focusedNow()) {
    return { status: 'refused', reason: 'target_focus_lost',
      composerTouched: false, composerWritten: false, clickPerformed: false,
      evidence: { observedAt: now, precheckOnly: true, deliveryMode: mode } };
  }

  const baseline = countOwnMessages(doc, text);
  writeComposer(doc, composer, text, mode);
  if (readComposer(composer) !== text) {
    // The write was attempted but the page does not show the exact template.
    // Reported separately from "never touched" because it is not the same fact.
    return { status: 'refused', reason: 'insert_mismatch',
      composerTouched: true, composerWritten: false, clickPerformed: false,
      evidence: null };
  }

  // T079: the send control was identified *before* typing (see the preflight
  // above); from here on the same node is waited for, never re-chosen freely.
  const clock = typeof deps.clock === 'function' ? deps.clock : () => Date.now();
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
    ? deps.timeoutMs : RECEIPT_TIMEOUT_MS;
  const readyTimeoutMs = Number.isFinite(deps.readyTimeoutMs) && deps.readyTimeoutMs > 0
    ? deps.readyTimeoutMs : BUTTON_READY_TIMEOUT_MS;
  const timers = deps.timers || {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const Observer = deps.Observer !== undefined
    ? deps.Observer
    : (typeof MutationObserver === 'function' ? MutationObserver : null);

  // Class 2 of 3: the composer holds our notice but nothing has been clicked.
  // Whatever the reason, the caller must stop -- one write already happened.
  const writtenNoClick = (reason, extra) => ({
    status: 'unconfirmed', reason,
    composerTouched: true, composerWritten: true, clickPerformed: false,
    evidence: Object.assign({ observedAt: clock(), expectedConversationId:
      currentConversationId(doc), deliveryMode: mode }, extra || {}),
  });

  const readyWaiter = controlMode === 'dynamic'
    ? waitForDynamicControl(doc, composer,
      { timeoutMs: readyTimeoutMs, timers, Observer, clock })
    : waitForControl(doc, composer, control,
      { timeoutMs: readyTimeoutMs, timers, Observer, clock });
  const ready = await readyWaiter;
  if (!ready.ready) {
    return writtenNoClick(ready.reason, {
      composerEmpty: false,
      readyWaitedMs: ready.waitedMs,
      candidates: ready.candidates,
      buttonPath: ready.path,
      controlMode,
    });
  }

  // Everything that can still go wrong is checked once, before the single click.
  const here = currentConversationId(doc);
  if (typeof expectedConversationId === 'string' && expectedConversationId
      && here !== expectedConversationId.toLowerCase()) {
    return writtenNoClick('conversation_changed_before_click',
      { expected: expectedConversationId, found: here, controlMode });
  }
  // T051: an overlay that appeared during the ready-wait. Same hazard one step
  // later, and the same rule: never click while a dialog owns the page. This one
  // is *post*-write, so it is reported as `written_not_clicked` and the caller
  // must stop -- the composer holds our text, so a retry is not safe.
  if (mode === 'background') {
    const dialog = blockingDialog(doc);
    if (dialog !== null) {
      return writtenNoClick('modal_open_before_click', { dialog, controlMode });
    }
  }
  // T052: the same identity question, asked again at the last moment. Nothing in
  // this document can change its own instance id, so on the product path this is a
  // tautology -- which is exactly why it belongs here: if a future caller hands
  // down an expectation this document cannot satisfy, the click stops here rather
  // than in a claim about it afterwards.
  const finalIdentity = documentIdentityCheck(expectedDocumentInstanceId, deps);
  if (!finalIdentity.ok) {
    // Named for the moment it was caught. Reusing the pre-write code here would
    // make one reason string mean two different things -- "nothing was typed" and
    // "our text is in a document we do not own" -- and the classifier has to map a
    // reason to exactly one of those.
    const late = finalIdentity.reason === 'document_identity_unavailable'
      ? 'document_identity_unavailable_before_click'
      : 'document_instance_changed_before_click';
    return writtenNoClick(late, { document: finalIdentity.detail, controlMode });
  }
  if (mode === 'foreground' && !focusedNow()) {
    return writtenNoClick('target_lost_focus_before_click', { controlMode });
  }
  if (readComposer(composer) !== text) {
    return writtenNoClick('insert_lost_before_click', { controlMode });
  }
  // The click is permitted only while this node is the *only* candidate. If a
  // second control appeared, we can no longer prove which one sends, so we do not
  // click at all rather than guess.
  const finalCandidates = sendControlCandidates(doc, composer);
  if (finalCandidates.length !== 1 || finalCandidates[0] !== ready.node) {
    return writtenNoClick('send_control_changed_before_click',
      { candidates: finalCandidates.length, controlMode });
  }

  // The conversation this notice is meant for, read immediately before the click.
  // Everything the receipt reports is compared against this id, so a navigation
  // during the wait can never be mistaken for a delivery somewhere else.
  const startedIn = here;
  const button = ready.node;
  button.click();

  const outcome = await waitForReceipt(doc,
    () => readReceipt(doc, composer, text, baseline, startedIn),
    { timeoutMs, timers, Observer, clock });

  const evidence = {
    observedAt: clock(),
    composerEmpty: outcome.snapshot.composerEmpty,
    conversationId: outcome.snapshot.conversationId,
    expectedConversationId: startedIn,
    exactTemplateMatched: outcome.snapshot.appeared === 1,
    appeared: outcome.snapshot.appeared,
    waitedMs: outcome.waitedMs,
    readyWaitedMs: ready.waitedMs,
    buttonPath: ready.path,
    controlMode,
    deliveryMode: mode,
    // T084: which receipt rule matched, how many messages carried the notice, and
    // what the pre-click baseline was. Counts and selector names only -- the notice
    // text and any user message body are never copied into evidence.
    receiptPath: outcome.snapshot.receiptPath,
    receiptCandidates: outcome.snapshot.receiptCandidates,
    receiptBaseline: outcome.snapshot.receiptBaseline,
    receiptRaw: outcome.snapshot.receiptRaw,
    baselineUsed: baseline,
  };
  // Class 3 of 3: the click landed; only the page's own rendering can now prove
  // what happened. Every return below is `clickPerformed: true`.
  const clickEvidence = (extra) => Object.assign({
    composerTouched: true, composerWritten: true, clickPerformed: true,
  }, extra || {});
  if (outcome.snapshot.navigated) {
    return clickEvidence({ status: 'unconfirmed',
      reason: 'conversation_changed_during_receipt', evidence });
  }
  if (outcome.snapshot.appeared >= 2) {
    return clickEvidence({ status: 'unconfirmed',
      reason: 'duplicate_message_appeared', evidence });
  }
  if (outcome.timedOut) {
    return clickEvidence({ status: 'unconfirmed',
      reason: 'delivery_not_confirmed', evidence });
  }
  if (evidence.composerEmpty && evidence.exactTemplateMatched) {
    return clickEvidence({ status: 'submitted', reason: null, evidence });
  }
  return clickEvidence({ status: 'unconfirmed',
    reason: 'delivery_not_confirmed', evidence });
}
