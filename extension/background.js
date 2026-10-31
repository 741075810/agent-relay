// T044 prototype: background service worker.
//
// What this file does NOT do, deliberately:
//   - it never types into a page, clicks a control, or submits a form;
//   - it never asks the host for permission to deliver (the host has none);
//   - it never reads cookies, credentials or storage of the ChatGPT origin.
// Every "message" it receives is displayed in the extension UI and persisted as
// a record. `deliverable:false` on each event is enforced here as well, so even
// a future host that started emitting delivery hints could not act on one.
//
// Why an alarm instead of a long-lived port: an MV3 service worker is evicted
// after ~30s idle and Chrome gives a native host no way to wake it. A port
// opened at startup is closed when the worker dies, and messages produced while
// it is dead cannot be pushed. So delivery is extension-initiated polling, the
// host buffers durably, and the latency floor is the alarm period. Claiming
// "instant" would be false.

import { NativeClient } from './lib/native_client.js';
import { QueueDelivery } from './lib/queue_delivery.js';
import {
  classifyTab,
  probeSpecificTab,
  runReadonlyProbe,
} from './lib/readonly_preflight.js';
import { createTargetBindingController } from './lib/target_binding_controller.js';
import { createBoundDryRunController } from './lib/bound_dry_run_controller.js';
import { createReceivedReview, handleReceivedReviewMessage } from './lib/received_review.js';
import { createAutoSendController } from './lib/autosend_controller.js';
import { createChromeAutoSend } from './lib/autosend_chrome_wiring.js';
// T095B76: a reload destroys the content script in every open tab and clears the
// session-scoped binding. The first is repaired by re-injecting the read-only
// observer, the second by mirroring the binding into `local`. Neither widens what a
// notice may do: every send still re-probes the tab and re-checks the document.
import { createResilientProbe, ensureContentScript, reconnectTabById }
  from './lib/content_reconnect.js';
import { createMirroredSession, BINDING_RESTORED_AT_KEY } from './lib/binding_mirror.js';
// The limits themselves (defaults and hard bounds), so the popup reports the
// numbers the code actually enforces. Missing this import was a live defect: the
// constants were referenced but unbound, so every `t058-state` threw
// "autosend is not defined" and the popup showed a red read failure.
import * as autosend from './lib/autosend.js';
import * as terminalTrigger from './lib/terminal_trigger.js';
import { summariseChain, describeStage, hostLayer, authorizationLayer,
  triggerLayer, bindingLayer } from './lib/chain_status.js';
import { describeChainEvidence, describeEvidenceLine } from './lib/chain_evidence.js';
import { classifySendReason } from './lib/send_adapter.js';

// T095B76: the two reload-recovery seams, declared before anything that uses them.
//
// `bindingSession` is `chrome.storage.session` with a mirror in `local`, so a reload
// no longer erases the operator's confirmed target while leaving the grant that
// points at it.
const bindingSession = createMirroredSession(
  { session: chrome.storage.session, local: chrome.storage.local },
  { onRestore: (event) => {
    // Recorded because a restored binding is a *claim* about to be re-verified, and
    // the next person reading storage should be able to tell that apart from a
    // binding that was confirmed in this browser session.
    note({ kind: 'binding-restored', revision: event.revision,
      hasBinding: event.hasBinding, invalidatedReason: event.invalidatedReason })
      .catch(() => {});
  } },
);

// `resilientProbe` re-injects the read-only observer when a tab provably has no
// receiving end, then measures once more. Only the observer: `write` still goes
// through the content script, so this adds a way to look at the bound tab again and
// not a new way to type into it.
const resilientProbe = createResilientProbe({
  probeSpecificTab,
  reconnect: (api, target) => ensureContentScript(api, target, { file: 'content.js' }),
  onEvent: (event) => {
    const attempt = event.attempt || {};
    note({ kind: attempt.ok ? 'content-reconnected' : 'content-reconnect-failed',
      tabId: event.tabId === undefined ? null : event.tabId,
      cause: event.cause || null, code: attempt.code || null,
      error: attempt.error || null }).catch(() => {});
  },
});

const targetBinding = createTargetBindingController({
  tabs: chrome.tabs,
  // T095B76: the same `storage.session`-shaped area, backed by a mirror in `local`.
  // The controller is unchanged and still believes the binding is session-scoped; it
  // simply no longer disappears when a reload clears the session area.
  session: bindingSession,
  // Needed by the health-path reconnect: re-injecting the observer is a `scripting`
  // call, and the controller hands this same object to the probe it was given.
  scripting: chrome.scripting,
  // Health may put a lost content script back; a candidate bind may not.
  probeHealth: resilientProbe,
});

// T054: read-only decision only. It has no send path and never reads the queue.
const boundDryRun = createBoundDryRunController({}, {
  targetBinding,
  session: chrome.storage.session,
});

const receivedReview = createReceivedReview({
  readReceived: async () => (await chrome.storage.local.get({ received: [] })).received,
  getBindingState: () => targetBinding.getState(),
  readDryRunState: () => boundDryRun.state(),
  tabs: chrome.tabs,
});
// Conservative transient invalidation; no stored binding or history is changed.
chrome.tabs.onActivated.addListener(() => receivedReview.invalidate());
chrome.windows.onFocusChanged.addListener(() => receivedReview.invalidate());
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.status === 'loading' || Object.hasOwn(change, 'url')) receivedReview.invalidate();
});
chrome.tabs.onRemoved.addListener(() => receivedReview.invalidate());
chrome.tabs.onReplaced.addListener(() => receivedReview.invalidate());
chrome.tabs.onDetached.addListener(() => receivedReview.invalidate());
chrome.tabs.onAttached.addListener(() => receivedReview.invalidate());

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  targetBinding.onUpdated(tabId, changeInfo).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  targetBinding.onRemoved(tabId).catch(() => {});
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  targetBinding.onReplaced(addedTabId, removedTabId).catch(() => {});
});
chrome.tabs.onDetached.addListener((tabId) => {
  targetBinding.onDetached(tabId).catch(() => {});
});
chrome.tabs.onAttached.addListener((tabId) => {
  targetBinding.onAttached(tabId).catch(() => {});
});

// T058/T059: standing authorization for repeat notices. Off until armed; every
// send still re-probes the page, and the journal is written before the write.
//
// `write` goes through the content script rather than chrome.scripting, so the
// extension keeps its existing permissions. If the content script cannot load
// the adapter -- module missing, CSP, page changed -- the reply is an error and
// the controller settles the notice as ambiguous, which disarms everything.
const chromeAutoSend = createChromeAutoSend(chrome, {
  // T095B76: the send path gets the same reconnect-aware probe, because the tab that
  // lost its script is exactly the tab a notice is about to be written into. The
  // write itself is untouched: it is still a `tabs.sendMessage` to the content script,
  // which re-checks the document id before typing.
  probeSpecificTab: resilientProbe,
  getBindingState: () => targetBinding.getState(),
});
const autoSend = chromeAutoSend.controller;

const HOST_NAME = 'com.dsh.notify';const PROTOCOL_VERSION = 1;
const POLL_ALARM = 'dsh-notify-poll';
const RETRY_ALARM = 'dsh-notify-retry';// Chrome clamps alarms to >=30s (116+) or >=1min (older). 0.5 is the floor on
// current versions; the effective period is reported back in the UI.
const POLL_PERIOD_MINUTES = 0.5;
const MAX_STORED = 100;
// Separate from the poll alarm on purpose: notifications and auto-send have
// different failure meanings, and one timer doing both would make a stalled
// notification run look like a stalled send. Chrome's floor is 1 minute here,
// which is also a sane ceiling on how fast a run of finished tasks could fire.
const TERMINAL_ALARM = 'dsh-terminal-trigger';
const TERMINAL_PERIOD_MINUTES = 1;

// T044 hand-rolled the request/response correlation here and got the important
// part wrong: the promise had only a timeout, so when Chrome closed the port --
// host not found, host exited at once, origin rejected -- nothing rejected it and
// the UI said "no response within 10s" ten seconds later. That message describes
// the timer and hides Chrome's own reason, which is the only thing that would
// have identified the fault. T045 moved the logic into lib/native_client.js so it
// can be tested without a browser (test_t045_native_client.mjs), and this file
// now only supplies the chrome.* surface.
const client = new NativeClient({
  connect: () => chrome.runtime.connectNative(HOST_NAME),
  // Chrome only exposes lastError for the duration of the disconnect callback,
  // so the client reads it from inside that callback rather than afterwards.
  readLastError: () => (chrome.runtime.lastError
    ? chrome.runtime.lastError.message : null),
  onFailure: (err) => {
    // Recorded, not retried here: the caller owns the retry decision. Keeping the
    // wording verbatim is the point -- "Specified native messaging host not
    // found." is actionable, "no response within 10s" is not.
    note({ kind: 'host-failure', reason: err.kind, detail: err.message });
  },
});

function request(op, args) {
  return client.request(op, args);
}

async function note(entry) {
  const now = new Date().toISOString();
  const stored = await chrome.storage.local.get({ notes: [] });
  const notes = stored.notes.slice(-MAX_STORED);
  notes.push(Object.assign({ at: now }, entry));
  await chrome.storage.local.set({ notes });
}

const queueDelivery = new QueueDelivery({
  request,
  get: (defaults) => chrome.storage.local.get(defaults),
  set: (values) => chrome.storage.local.set(values),
  scheduleRetry: async (delay, callback) => {
    const retryAt = Date.now() + delay;
    await chrome.storage.local.set({ retryAt });
    await chrome.alarms.create(RETRY_ALARM, { when: retryAt });
    return RETRY_ALARM;
  },
  clearRetry: async () => {
    await chrome.alarms.clear(RETRY_ALARM);
    await chrome.storage.local.remove('retryAt');
  },
  onAdded: (added) => {
    // Badge only; no page or conversation is touched.
    chrome.action.setBadgeText({ text: String(added) });
    chrome.action.setBadgeBackgroundColor({ color: '#2b6cb0' });
  },
});

function storeEvents(events) {
  return queueDelivery.storeEvents(events);
}

function pollOnce() {
  return queueDelivery.poll();
}

// Read-only tab inspection. Uses the content script's reply; nothing is written.
async function inspectTabs() {
  const activeTabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const focusedWindowId = activeTabs[0] && activeTabs[0].windowId;
  if (!Number.isSafeInteger(focusedWindowId)) return [];
  const tabs = await chrome.tabs.query({
    windowId: focusedWindowId,
    url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  });
  return tabs.map((tab) => ({
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    active: tab.active === true,
    discarded: tab.discarded === true,
    frozen: tab.frozen === true,
    state: classifyTab(tab),
  }));
}

async function probeChatGPTTabs() {
  return runReadonlyProbe(chrome);
}

chrome.runtime.onInstalled.addListener(async () => {
  const alarm = await chrome.alarms.get(POLL_ALARM);
  if (!alarm) {
    chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MINUTES });
  }
  // T095B75: a reload clears the alarm table and fires *only* this hook -- `onStartup`
  // is reserved for a real browser start and does not run when a person presses reload
  // on chrome://extensions. The terminal trigger therefore came back from a reload with
  // `enabled: true` in storage and no alarm to wake it: it never ticked, sent nothing and
  // recorded no error, while the popup went on reporting the period it *would* have used.
  // Diagnosing that cost a whole investigation, from file mtimes, twice.
  //
  // The restore is deliberately narrow. `syncTerminalAlarm` reads the stored trigger and
  // creates or clears one alarm; it never enables a disabled trigger, never re-arms,
  // never writes consent, candidates or the journal, and never sends. Awaiting it here
  // is what makes the alarm exist before this handler returns -- the fire-and-forget
  // form cannot promise that, and a worker suspended mid-flight would leave the table
  // empty while reporting success.
  await restoreTerminalAlarm();
  const { retryAt } = await chrome.storage.local.get({ retryAt: null });
  if (Number.isFinite(retryAt) && retryAt > Date.now()) {
    chrome.alarms.create(RETRY_ALARM, { when: retryAt });
  }
  await note({ kind: 'installed', periodMinutes: POLL_PERIOD_MINUTES });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MINUTES });
  // The alarm table does not survive a restart but the stored authorization
  // does; without this the trigger would look armed and never tick.
  restoreTerminalAlarm().catch(() => {});
  chrome.storage.local.get({ retryAt: null }).then(({ retryAt }) => {
    if (Number.isFinite(retryAt) && retryAt > Date.now()) {
      chrome.alarms.create(RETRY_ALARM, { when: retryAt });
    } else if (Number.isFinite(retryAt)) {
      chrome.storage.local.remove('retryAt');
      queueDelivery.retryFromAlarm();
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) {
    queueDelivery.retryFromAlarm();
  } else if (alarm.name === POLL_ALARM) {
    pollOnce();
  } else if (alarm.name === TERMINAL_ALARM) {
    // Fire and forget: the guard inside decides whether anything may happen.
    runTerminalOnAlarm();
  }
});

// T059: the unattended tick.
//
// Three things this has to get right, in this order:
//   1. not run at all while unauthorized -- it must not even connect to the host,
//      so an unarmed extension never reads task history;
//   2. not re-enter itself. Chrome can deliver an alarm while the previous tick
//      is still awaiting the host, and two overlapping ticks would each see the
//      same candidate as new;
//   3. not touch tabs. There is no activation, focus or creation anywhere on this
//      path, so "the session is occupied" can only ever end in a stop.
let terminalTickInFlight = false;

async function runTerminalOnAlarm() {
  if (terminalTickInFlight) return { skipped: 'in_flight' };
  terminalTickInFlight = true;
  try {
    const stored = await chrome.storage.local.get({ terminalTrigger: null });
    const state = stored.terminalTrigger;
    if (!state || state.enabled !== true) return { skipped: 'trigger_disabled' };
    return await runTerminalTrigger({ limit: 3 });
  } catch (err) {
    // A throwing tick must not leave the flag stuck, and must not be retried
    // with the same state: disarm and let a human decide.
    try {
      const stored = await chrome.storage.local.get({ terminalTrigger: null });
      const base = stored.terminalTrigger || terminalTrigger.createTriggerState();
      const stopped = terminalTrigger.disable(base,
        'alarm_tick_failed:' + String(err && err.message ? err.message : err));
      await chrome.storage.local.set({ terminalTrigger: stopped.state });
    } catch (_ignored) { /* storage gone: nothing left to disarm */ }
    return { skipped: 'error' };
  } finally {
    terminalTickInFlight = false;
  }
}

// What a fresh manual authorization would get. Read-only, and reported next to
// the *current* grant so "what I have" and "what I would get" are never confused.
function t058Defaults() {
  return {
    ttlMs: autosend.DEFAULT_TTL_MS,
    ttlDays: autosend.DEFAULT_TTL_MS / 86400000,
    maxSends: autosend.DEFAULT_MAX_SENDS,
    maxTtlMs: autosend.MAX_TTL_MS,
    maxSendsCeiling: autosend.MAX_SENDS_CEILING,
    // T048: what each mode actually authorises, so the popup never has to restate
    // it. The phrases are built here from the same constants `arm` compares against.
    defaultDeliveryMode: autosend.DEFAULT_DELIVERY_MODE,
    deliveryModes: autosend.DELIVERY_MODES.slice(),
    confirmationPrefix: autosend.CONFIRM_PREFIX,
    backgroundConfirmationPrefix: autosend.BACKGROUND_CONFIRM_PREFIX,
  };
}

function t059Defaults() {
  return {
    minIntervalMs: terminalTrigger.DEFAULT_MIN_INTERVAL_MS,
    minIntervalFloorMs: terminalTrigger.MIN_INTERVAL_FLOOR_MS,
    maxIntervalCeilingMs: terminalTrigger.MAX_INTERVAL_CEILING_MS,
    maxPerHour: terminalTrigger.DEFAULT_MAX_PER_HOUR,
    maxPerHourCeiling: terminalTrigger.MAX_PER_HOUR_CEILING,
    // The counter is a fixed 60-minute block anchored at windowStartedAt (arm time,
    // or lazily on the first send past a boundary) -- NOT a sliding window. The
    // popup says so, because "100 per hour" would otherwise imply a rolling rate.
    windowMs: terminalTrigger.WINDOW_MS,
  };
}

// Chrome 120+ allows sub-minute alarm periods; 0.5 (30s) is the documented floor.
// Older Chrome clamps anything below its own minimum silently, which only makes the
// tick later -- never sooner -- so the rate limits stay intact either way.
const MIN_ALARM_PERIOD_MINUTES = 0.5;
const MAX_ALARM_PERIOD_MINUTES = 60;

function terminalAlarmPeriod(state) {
  // The tick may never be *faster* than the trigger's own interval, and never
  // below Chrome's floor. It used to be `Math.max(1, Math.ceil(ms/60000))`, which
  // turned a 30s interval into a 1-minute alarm -- the configured pacing then said
  // 30s and behaved like 60s. Round to hundredths to keep the value stable enough
  // to compare against what Chrome reports back.
  const intervalMs = Number.isSafeInteger(state && state.minIntervalMs)
    ? state.minIntervalMs : MIN_ALARM_PERIOD_MINUTES * 60000;
  const wanted = intervalMs / 60000;
  const clamped = Math.max(MIN_ALARM_PERIOD_MINUTES,
    Math.min(wanted, MAX_ALARM_PERIOD_MINUTES));
  return Math.round(clamped * 100) / 100;
}

async function syncTerminalAlarm() {
  const stored = await chrome.storage.local.get({ terminalTrigger: null });
  const state = stored.terminalTrigger;
  if (!state || state.enabled !== true) {
    await chrome.alarms.clear(TERMINAL_ALARM);
    return { armed: false };
  }
  const existing = await chrome.alarms.get(TERMINAL_ALARM);
  const periodInMinutes = terminalAlarmPeriod(state);
  // Compare with a tolerance: a fraction that round-trips through Chrome can come
  // back as 0.4999999, and re-creating the alarm every tick would reset its timer
  // and starve the trigger entirely.
  const drift = existing && Number.isFinite(existing.periodInMinutes)
    ? Math.abs(existing.periodInMinutes - periodInMinutes) : null;
  if (!existing || drift === null || drift > 0.001) {
    chrome.alarms.create(TERMINAL_ALARM, { periodInMinutes });
  }
  return { armed: true, periodInMinutes,
    resumed: Boolean(existing), currentPeriod: existing
      ? existing.periodInMinutes : null };
}

// T095B75: the lifecycle-safe wrapper both wake-up hooks use.
//
// `syncTerminalAlarm` can throw for reasons that have nothing to do with the trigger --
// a missing `alarms` permission, an API surface that changed, a storage read that
// failed. In `onInstalled` that would reject the whole install hook and take the queue
// poller's alarm down with it, so the failure is caught, recorded and returned instead.
//
// It records rather than swallows because "the trigger is armed but could not be
// scheduled" is exactly the fact that went missing the first time: everything else kept
// reporting health while nothing ticked. A note is the cheapest honest answer, and it
// costs nothing on the success path.
async function restoreTerminalAlarm() {
  try {
    return await syncTerminalAlarm();
  } catch (err) {
    const detail = String(err && err.message ? err.message : err);
    try {
      await note({ kind: 'terminal-alarm-restore-failed', detail });
    } catch (_ignored) { /* storage gone: nothing left to record it in */ }
    return { armed: false, error: detail };
  }
}

// Messages from the popup and the content script. Every handler is read-only
// except `simulate`, which only asks the host to enqueue synthetic events.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.type === 'hello') {
        sendResponse({ ok: true, result: await request('hello', {}) });
      } else if (msg && msg.type === 'status') {
        sendResponse({ ok: true, result: await request('status', {}) });
      } else if (msg && msg.type === 'poll') {
        sendResponse(await pollOnce());
      } else if (msg && msg.type === 'simulate') {
        sendResponse({ ok: true,
                       result: await request('simulate', { count: msg.count || 1 }) });
      } else if (msg && msg.type === 'tabs') {
        sendResponse({ ok: true, result: await inspectTabs() });
      } else if (msg && msg.type === 'readonly-dry-run') {
        sendResponse({ ok: true, result: await probeChatGPTTabs() });
      } else if (msg && msg.type && msg.type.startsWith('t053-binding-')) {
        if (sender.id !== chrome.runtime.id ||
            sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) {
          sendResponse({ ok: false, error: 'extension_popup_required' });
        } else if (msg.type === 't053-binding-state') {
          sendResponse({ ok: true, result: await targetBinding.getState() });
        } else if (msg.type === 't053-binding-scan') {
          sendResponse({ ok: true, result: await targetBinding.scan() });
        } else if (msg.type === 't053-binding-confirm') {
          sendResponse({ ok: true, result: await targetBinding.bind(
            msg.token, msg.confirmation) });
        } else if (msg.type === 't053-binding-health') {
          sendResponse({ ok: true, result: await targetBinding.health() });
        } else if (msg.type === 't053-binding-clear') {
          sendResponse({ ok: true, result: await targetBinding.clear(msg.confirmation) });
        } else if (msg.type === 't053-binding-reconnect') {
          // T095B76: the operator names one tab, in their own popup, to have its
          // observer put back. Without this the first reload after an upgrade is a
          // dead end -- no mirror yet, so nothing automatic runs, and every scanned
          // tab reports `content_unavailable`, which cannot be confirmed. The old
          // escape was refreshing the page.
          const attempt = await reconnectTabById(chrome, msg.tabId);
          await note({ kind: attempt.ok ? 'content-reconnected-by-operator'
            : 'content-reconnect-by-operator-failed',
          tabId: Number.isSafeInteger(msg.tabId) ? msg.tabId : null,
          code: attempt.code || null }).catch(() => {});
          sendResponse({ ok: true, result: attempt });
        } else {
          sendResponse({ ok: false, error: 'unknown_t053_binding_request' });
        }
      } else if (msg && msg.type && msg.type.startsWith('t054-')) {
        if (sender.id !== chrome.runtime.id ||
            sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) {
          sendResponse({ ok: false, error: 'extension_popup_required' });
        } else if (msg.type === 't054-state') {
          sendResponse({ ok: true, result: await boundDryRun.state() });
        } else if (msg.type === 't054-dry-run') {
          // Boundary validation mirrors the policy module instead of silently
          // dropping unknown fields: a caller that sends free text, logs or any
          // other extra key gets an explicit refusal, not a quiet downgrade.
          const allowed = new Set(['type', 'runId', 'status', 'proposalId']);
          const extra = Object.keys(msg).filter((key) => !allowed.has(key));
          if (extra.length) {
            sendResponse({ ok: true, result: {
              ok: false,
              status: 'event_invalid',
              issues: [{ code: 'event_fields_not_allowed',
                detail: extra.join(',') }],
              sendEligible: false,
              pageWriteEligible: false,
              accountIdentity: 'unverified',
            } });
          } else {
            sendResponse({ ok: true, result: await boundDryRun.run({
              runId: msg.runId,
              status: msg.status,
              proposalId: msg.proposalId,
            }) });
          }
        } else {
          sendResponse({ ok: false, error: 'unknown_t054_request' });
        }
      } else if (msg && typeof msg.type === 'string' && msg.type.startsWith('t055-')) {
        sendResponse({ ok: true, result: await handleReceivedReviewMessage(
          receivedReview, msg, sender, chrome.runtime) });
      } else if (msg && typeof msg.type === 'string' && msg.type.startsWith('t058-')) {
        // Same popup-only boundary as T053/T054/T055: a content script or a web
        // page must not be able to arm a standing authorization.
        if (sender.id !== chrome.runtime.id ||
            sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) {
          sendResponse({ ok: false, error: 'extension_popup_required' });
        } else if (msg.type === 't058-state') {
          // `defaults` travels with the state so the popup can show what the
          // *next* manual arm will grant without duplicating the numbers in a
          // second place that could drift from the code.
          sendResponse({ ok: true, result: await autoSend.reconcile(),
            defaults: t058Defaults() });
        } else if (msg.type === 't058-arm') {
          // T048: `deliveryMode` comes from the popup and is checked against the
          // phrase inside `arm` -- an absent value stays foreground, so a popup
          // that never learned about the mode cannot widen anything.
          sendResponse({ ok: true, result: await autoSend.armWith(
            { ttlMs: msg.ttlMs, maxSends: msg.maxSends,
              deliveryMode: msg.deliveryMode },
            msg.confirmation, msg.userGesture === true) });
        } else if (msg.type === 't058-arm-once') {
          // T122: the restricted grant. No ttl/maxSends are read from the message on purpose:
          // the bounds are constants in `armOnce`, so the popup cannot ask for more than one
          // message and a rewritten popup cannot either.
          const extra = Object.keys(msg).filter((key) => !['type', 'confirmation',
            'userGesture'].includes(key));
          if (extra.length) {
            sendResponse({ ok: false, error: 'unexpected_fields',
              fields: extra });
          } else {
            sendResponse({ ok: true, result: await autoSend.armOnce(
              msg.confirmation, msg.userGesture === true) });
          }
        } else if (msg.type === 't058-disarm') {
          sendResponse({ ok: true, result: await autoSend.stop('operator_disarmed') });
        } else if (msg.type === 't058-send') {
          // The candidate is explicit and comes from the operator surface. It is
          // never read out of the received store: those records are
          // `deliverable:false` and promoting one would be the silent upgrade
          // this design forbids.
          const allowed = new Set(['type', 'runId', 'status']);
          const extra = Object.keys(msg).filter((key) => !allowed.has(key));
          if (extra.length) {
            sendResponse({ ok: true, result: { sent: false,
              code: 'candidate_fields_not_allowed', detail: extra.join(',') } });
          } else {
            sendResponse({ ok: true, result: await autoSend.sendOnce({
              runId: msg.runId, status: msg.status }) });
          }
        } else {
          sendResponse({ ok: false, error: 'unknown_t058_request' });        }
      } else if (msg && typeof msg.type === 'string' && msg.type.startsWith('t059-')) {
        // Same popup-only boundary: an armed terminal trigger is a standing
        // permission to write, so a content script must not be able to set it.
        if (sender.id !== chrome.runtime.id ||
            sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) {
          sendResponse({ ok: false, error: 'extension_popup_required' });
        } else if (msg.type === 't059-trigger-state') {
          const stored = await chrome.storage.local.get({ terminalTrigger: null });
          const base = stored.terminalTrigger || terminalTrigger.createTriggerState();
          const reconciled = terminalTrigger.reconcileAfterRestart(base);
          if (reconciled.changed) {
            await chrome.storage.local.set({ terminalTrigger: reconciled.state });
          }
          // T137: a repair that disabled the arm must also drop its alarm, or the popup reads
          // `alarm: 1` next to a disabled arm and an ended authorization keeps a wake-up.
          if (reconciled.state.enabled !== true) {
            await syncTerminalAlarm();
          }
          const candidates = await chromeAutoSend.readCandidates();
          const preArmKeys = new Set(Array.isArray(reconciled.state.preArmCandidateKeys)
            ? reconciled.state.preArmCandidateKeys : []);
          const preArm = candidates.filter((item) => preArmKeys.has(
            terminalTrigger.key(item.runId, item.status))).length;
          // T095B75: report the alarm Chrome actually holds, separately from the period
          // the trigger would like. Conflating the two is what let "armed and ticking"
          // and "armed and asleep" render as the same sentence in the popup, so a
          // dormant trigger looked healthy for as long as nobody read a file mtime.
          //
          // `alarm` is the observation; `alarmExpected` is the intent. The popup now
          // says which one it has, and the answer "armed but not scheduled" is a state
          // it can name rather than a difference it cannot see.
          let alarm = null;
          let alarmError = null;
          try {
            const found = await chrome.alarms.get(TERMINAL_ALARM);
            alarm = found && Number.isFinite(found.periodInMinutes)
              ? found.periodInMinutes : null;
          } catch (err) {
            // An unreadable alarm table is not the same fact as an empty one, and the
            // popup must not silently render it as "missing".
            alarm = null;
            alarmError = String(err && err.message ? err.message : err);
          }
          sendResponse({ ok: true, result: reconciled.state,
            candidates: candidates.length, preArm,
            defaults: t059Defaults(),
            alarm,
            alarmError,
            alarmExpected: reconciled.state.enabled === true
              ? terminalAlarmPeriod(reconciled.state) : null });
        } else if (msg.type === 't059-trigger-arm') {
          const binding = await chromeAutoSend.readBinding();
          const stored = await chrome.storage.local.get({ terminalTrigger: null });
          const base = stored.terminalTrigger || terminalTrigger.createTriggerState();
          const done = terminalTrigger.configure(base, {
            binding, minIntervalMs: msg.minIntervalMs, maxPerHour: msg.maxPerHour,
          }, msg.confirmation, msg.userGesture === true);
          if (done.result.ok) {
            // T091: take the boundary from the host *before* enabling anything.
            //
            // The order matters. Enabling first and asking afterwards would leave
            // a window whose completions belong to neither side: too late to be in
            // a snapshot, too early to be covered by an arm the operator has made.
            // Snapshot first, and if the host will not answer, do not enable.
            //
            // The epoch names this arm round. The host stores it with the snapshot
            // and echoes it in every later sample; a mismatch on either side means
            // the two are talking about different rounds, and nothing is provable.
            const epoch = newArmEpoch();
            const snap = await requestArmSnapshot(epoch);
            if (snap.ok !== true) {
              // Nothing is persisted: `done.state` is discarded and the stored
              // trigger is left exactly as it was found (possibly still armed from
              // an earlier round, with its own epoch).
              sendResponse({ ok: true, result: {
                ok: false,
                // Named after the host's own code, prefixed so a refusal here is
                // never mistaken for a refusal from the trigger gate itself.
                code: 'arm_' + String(snap.code || 'failed'),
                snapshot: snap,
              } });
              return true;
            }
            // Snapshot what is already queued. Enabling a standing permission is
            // not consent to deliver the backlog: those candidates are kept and
            // shown, but never written. Only work produced *after* this moment
            // can be sent, and `runTerminalTrigger` is what enforces it.
            const queued = await chromeAutoSend.readCandidates();
            done.state.preArmCandidateKeys = queued.map((item) =>
              terminalTrigger.key(item.runId, item.status));
            done.state.armEpoch = epoch;
            done.state.armSnapshotAt = snap.takenAt;
            done.state.armSnapshotCount = snap.count;
            await chrome.storage.local.set({ terminalTrigger: done.state });
            await syncTerminalAlarm();
          }
          sendResponse({ ok: true, result: done.result,
            preArm: Array.isArray(done.state.preArmCandidateKeys)
              ? done.state.preArmCandidateKeys.length : 0 });
        } else if (msg.type === 't059-trigger-arm-once') {
          // T123: the restricted trigger. Only the typed phrase and the gesture travel: the
          // cap, the window and the "one candidate" rule are decided inside the module, so
          // there is no message field that could turn this back into the standing arm.
          const extra = Object.keys(msg).filter((key) => !['type', 'confirmation',
            'userGesture'].includes(key));
          if (extra.length) {
            sendResponse({ ok: false, error: 'unexpected_fields', fields: extra });
            return true;
          }
          const binding = await chromeAutoSend.readBinding();
          const storedOnce = await chrome.storage.local.get({ terminalTrigger: null });
          const baseOnce = storedOnce.terminalTrigger
            || terminalTrigger.createTriggerState();
          const once = terminalTrigger.configureOnce(baseOnce, { binding },
            msg.confirmation, msg.userGesture === true);
          if (!once.result.ok) {
            sendResponse({ ok: true, result: once.result });
            return true;
          }
          const epochOnce = newArmEpoch();
          const snapOnce = await requestArmSnapshot(epochOnce);
          if (snapOnce.ok !== true) {
            sendResponse({ ok: true, result: {
              ok: false, code: 'arm_' + String(snapOnce.code || 'failed'),
              snapshot: snapOnce } });
            return true;
          }
          // The same backlog rule as the standing arm: enabling is not consent to deliver what
          // is already queued. For a restricted arm this matters twice over -- the one trigger
          // must not be spent on a task that finished before it was armed.
          const queuedOnce = await chromeAutoSend.readCandidates();
          once.state.preArmCandidateKeys = queuedOnce.map((item) =>
            terminalTrigger.key(item.runId, item.status));
          once.state.armEpoch = epochOnce;
          once.state.armSnapshotAt = snapOnce.takenAt;
          once.state.armSnapshotCount = snapOnce.count;
          await chrome.storage.local.set({ terminalTrigger: once.state });
          await syncTerminalAlarm();
          sendResponse({ ok: true, result: once.result,
            preArm: Array.isArray(once.state.preArmCandidateKeys)
              ? once.state.preArmCandidateKeys.length : 0 });
        } else if (msg.type === 't059-trigger-disable') {
          const stored = await chrome.storage.local.get({ terminalTrigger: null });
          const base = stored.terminalTrigger || terminalTrigger.createTriggerState();
          const done = terminalTrigger.disable(base, 'operator_disabled');
          await chrome.storage.local.set({ terminalTrigger: done.state });
          await syncTerminalAlarm();
          sendResponse({ ok: true, result: done.result });
        } else if (msg.type === 't059-trigger-arm-alarm') {
          // Exposed so the arming path and the alarm can be reconciled without
          // a popup: after a browser restart the alarm is gone but the state
          // may still say armed.
          sendResponse({ ok: true, result: await syncTerminalAlarm() });
        } else if (msg.type === 't059-trigger-run') {
          sendResponse({ ok: true, result: await runTerminalTrigger({
            limit: msg.limit }) });
        } else {
          sendResponse({ ok: false, error: 'unknown_t059_request' });
        }
      } else if (msg && typeof msg.type === 'string' && msg.type.startsWith('t067-')) {
        // T067: per-task opt-in for runs a person started in DSH Desktop. Popup
        // only, same boundary as T053/T058/T059 -- this widens what may be written
        // to the page, so a content script or a web page must not reach it.
        if (sender.id !== chrome.runtime.id ||
            sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) {
          sendResponse({ ok: false, error: 'extension_popup_required' });
        } else if (msg.type === 't067-direct-state') {
          sendResponse({ ok: true, result: await readDirectOptInState() });
        } else if (msg.type === 't067-direct-optin') {
          // The click is the consent, so it must be a real one. Without the flag
          // this would be a message any script in the extension context could
          // send, and an opt-in nobody made is not an opt-in.
          if (msg.userGesture !== true) {
            sendResponse({ ok: true, result: { ok: false,
              code: 'operator_gesture_required' } });
          } else {
            sendResponse({ ok: true, result: await armDirectCandidate(
              msg.runId, msg.status) });
          }
        } else {
          sendResponse({ ok: false, error: 'unknown_t067_request' });
        }
      } else if (msg && typeof msg.type === 'string' && msg.type.startsWith('t068-')) {
        // T068: opting in to a task that is still running. Popup only, for the same
        // reason as T067 -- this is the widest form of consent the product has (it
        // authorises a write that will happen later, unattended), so a content script
        // or a page must not be able to reach it.
        if (sender.id !== chrome.runtime.id ||
            sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) {
          sendResponse({ ok: false, error: 'extension_popup_required' });
        } else if (msg.type === 't068-running-state') {
          sendResponse({ ok: true, result: await readRunningState() });
        } else if (msg.type === 't068-running-optin'
          || msg.type === 't068-running-optout') {
          // A click is the whole consent, so it has to be a real click. Arming and
          // revoking both require it: an opt-out sent by some other script would be
          // a way to silence a notice the operator did ask for.
          if (msg.userGesture !== true) {
            sendResponse({ ok: true, result: { ok: false,
              code: 'operator_gesture_required' } });
          } else if (msg.type === 't068-running-optin') {
            sendResponse({ ok: true, result: await armRunningOptIn(
              msg.sessionId, msg.turn, msg.seenEndedAt) });
          } else {
            sendResponse({ ok: true, result: await revokeRunningOptIn(
              msg.sessionId, msg.turn) });
          }
        } else {
          sendResponse({ ok: false, error: 'unknown_t068_request' });
        }
      } else if (msg && msg.type === 't065-chain-selfcheck') {
        // Popup-only, same boundary as T053/T058/T059: this reads the host and
        // the binding, so a page or content script must not be able to trigger
        // it even though it writes nothing.
        if (sender.id !== chrome.runtime.id ||
            sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) {
          sendResponse({ ok: false, error: 'extension_popup_required' });
        } else {
          sendResponse({ ok: true, result: await readChainSelfCheck() });
        }
      } else if (msg && msg.type === 't069-canary-readiness') {
        // Same popup-only boundary: read-only, but it names the binding and the
        // remaining grant, which are not things a page should be able to query.
        if (sender.id !== chrome.runtime.id ||
            sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) {
          sendResponse({ ok: false, error: 'extension_popup_required' });
        } else {
          sendResponse({ ok: true, result: await readCanaryReadiness() });
        }
      } else if (msg && msg.type === 't074-chain-evidence') {
        // Same boundary again: this reports where a specific completion got to,
        // which is operator-only information. Read-only -- no poll, no ACK.
        if (sender.id !== chrome.runtime.id ||
            sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) {
          sendResponse({ ok: false, error: 'extension_popup_required' });
        } else {
          sendResponse({ ok: true, result: await readChainEvidence(msg.runId) });
        }
      } else if (msg && msg.type === 'content-report') {
        // The content script reports what it saw. Stored, never acted on.
        await chrome.storage.local.set({
          lastContentReport: {
            at: new Date().toISOString(),
            tabUrl: sender.tab ? sender.tab.url : null,
            report: msg.report || null,
          },
        });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'unknown request' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true;                        // keep the channel open for the async reply
});

// T059: pull terminal candidates from the host, and store them durably.
//
// The host answers `terminal-list` read-only from Bridge's own runs ledger; its
// first answer only establishes a baseline, so the runs that finished before
// anyone authorized this do not all fire at once. Nothing here reads the
// notification queue, and nothing here writes an event: candidates land under
// their own storage key, and `deliverable:false` stays untouched.
//
// Merging is by `runId|status` and bounded, because the storage file is what
// survives a worker restart -- an unbounded append there is a slow leak.
const MAX_CANDIDATES_STORED = 50;

// T091: one arm round, named.
//
// A random id rather than a counter or a timestamp: two arm rounds in the same
// millisecond must not collide, and a value that could repeat after a reload would
// let the host's snapshot be read as this round's. It appears in storage, in the
// host's own arm file, and in every sample; if any two of those disagree nothing
// is provable and nothing is sent.
function newArmEpoch() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (_err) { /* fall through to the shape check below */ }
  // Deterministic fallback, still unique enough for "different arm rounds":
  // 96 random bits from Math.random plus the clock.
  const part = () => Math.floor(Math.random() * 0x100000000).toString(16)
    .padStart(8, '0');
  return 'arm-' + Date.now().toString(16) + '-' + part() + part() + part();
}

async function requestArmSnapshot(epoch) {
  try {
    const reply = await request('terminal-arm-snapshot', { epoch });
    if (!reply || typeof reply !== 'object') {
      return { ok: false, code: 'no_reply' };
    }
    if (reply.ok !== true) {
      return { ok: false, code: reply.code || 'host_refused',
        error: reply.error || null,
        count: Number.isSafeInteger(reply.count) ? reply.count : null,
        limit: Number.isSafeInteger(reply.limit) ? reply.limit : null };
    }
    if (reply.epoch !== epoch) {
      // The host answered about a different round. Treat it as a failure rather
      // than enabling on a boundary this extension never asked for.
      return { ok: false, code: 'epoch_echo_mismatch' };
    }
    if (!Number.isSafeInteger(reply.count) || reply.count < 0
        || !Number.isSafeInteger(reply.takenAt)) {
      return { ok: false, code: 'snapshot_malformed' };
    }
    return { ok: true, code: null, takenAt: reply.takenAt, count: reply.count };
  } catch (err) {
    return { ok: false, code: 'host_unavailable',
      error: String(err && err.message ? err.message : err) };
  }
}

// What the popup shows as "最近轮询/ACK" is a fact about a *real* poll, so only
// this function writes it. `readChainSelfCheck` used to write here too, which
// made a diagnostic click look like a poll that produced nothing
// (`added:null acked:null at:<now>`) and erased the last real numbers.
// A caller that has no measured counts must pass null, never a guessed number.
async function recordChainStatus(entry) {
  try {
    await chrome.storage.local.set({
      terminalChainStatus: Object.assign({ at: Date.now() }, entry),
    });
  } catch (_err) { /* storage gone: the poll result itself is still valid */ }
}

// T069: complete the host-owned provenance of a candidate we already hold.
//
// The intake used to skip a re-offered run outright (`if (seen.has(k)) continue`). That
// is fine for a run whose entry is complete, and wrong for one whose entry is not --
// and "not complete" is not hypothetical: a candidate stored by the release before
// T069 has only the floored `endedAt`, and the consent rule now refuses to decide from
// it. Skipping the re-offer left that gap permanent.
//
// Only fields the *host* owns are written. `origin`, `directArmedAt`, `postArm` and the
// journal are deliberately excluded: they encode a decision or an arm boundary, and a
// later sample must never be able to rewrite them into something more permissive.
function refreshProvenance(entry, candidate) {
  const next = Object.assign({}, entry);
  let changed = false;
  if (Number.isSafeInteger(candidate.endedAtMs) && candidate.endedAtMs > 0
      && next.endedAtMs !== candidate.endedAtMs) {
    next.endedAtMs = candidate.endedAtMs;
    changed = true;
  }
  if (Number.isSafeInteger(candidate.endedAt)
      && next.endedAt !== candidate.endedAt) {
    next.endedAt = candidate.endedAt;
    changed = true;
  }
  if (Number.isInteger(candidate.nativeTurn)
      && next.nativeTurn !== candidate.nativeTurn) {
    next.nativeTurn = candidate.nativeTurn;
    changed = true;
  }
  if (typeof candidate.nativeSession === 'string' && candidate.nativeSession
      && next.nativeSession !== candidate.nativeSession) {
    next.nativeSession = candidate.nativeSession;
    changed = true;
  }
  return changed ? next : null;
}

async function refreshTerminalCandidates() {
  let reply;
  try {
    reply = await request('terminal-list');
  } catch (err) {
    // A missing host, a dead pipe, a protocol error: all mean "no new
    // candidates", never "send anyway".
    await recordChainStatus({ ok: false, code: 'host_unavailable',
      added: null, acked: null });
    return { ok: false, code: 'host_unavailable',
      error: String(err && err.message ? err.message : err), added: 0 };
  }
  if (!reply || typeof reply !== 'object') {
    await recordChainStatus({ ok: false, code: 'host_error',
      added: null, acked: null });
    return { ok: false, code: 'host_error', added: 0 };
  }
  // NativeClient resolves the *result payload* on success (native_client.js
  // `_onMessage`: `entry.resolve(doc.result)`), so `reply` is already the
  // sample report. Unwrapping `reply.result` again would reject every good
  // answer, which is exactly the bug this line used to have.
  const report = reply;
  if (report.ok === false) {
    // The host could not read its source. Report the gap; do not invent work.
    const code = report.code || 'source_unavailable';
    await recordChainStatus({ ok: false, code, added: null, acked: null });
    return { ok: false, code, error: report.error || null, added: 0 };
  }
  if (report.ok !== true) {
    await recordChainStatus({ ok: false, code: 'host_error',
      added: null, acked: null });
    return { ok: false, code: 'host_error', added: 0 };
  }
  const incoming = Array.isArray(report.candidates) ? report.candidates : [];
  const stored = await chrome.storage.local.get({ terminalCandidates: [] });
  const existing = Array.isArray(stored.terminalCandidates)
    ? stored.terminalCandidates : [];
  const seen = new Set(existing.map((item) => terminalTrigger.key(item.runId,
    item.status)));
  let merged = existing.slice();
  let added = 0;
  // T069: entries whose provenance was completed from a re-offer. Counted separately
  // from `added` so the poll record still answers "how many new completions arrived".
  let refreshed = 0;
  // Take only what fits. The old code appended everything and then kept the newest
  // `MAX_CANDIDATES_STORED`, which silently dropped the *oldest unsent* candidates.
  // The host still had those in `pendingIds` and re-offered exactly them, while the
  // room left in each answer was consumed by `due`, so no new candidate could ever
  // arrive: delivery stalled for good at around 50 (measured: 55 written, then 0
  // forever). Nothing that can still be sent is discarded now; anything that does
  // not fit stays pending on the host and comes back when room frees up.
  //
  // T074: capacity counts *work*, not history. Candidates that were already queued
  // when the trigger was armed are protected from sending and kept only so the
  // operator can see them -- but they used to occupy the same 50 slots as real
  // work. Fifty leftovers therefore made `room === 0` permanently: the host kept
  // offering new completions, the intake kept refusing them, and the chain went
  // silent with no error to look at. Protected entries now give up their slot to
  // work (oldest first) instead of blocking it.
  const triggerStored = await chrome.storage.local.get({ terminalTrigger: null });
  const preArmKeys = new Set(
    triggerStored.terminalTrigger && Array.isArray(triggerStored.terminalTrigger
      .preArmCandidateKeys) ? triggerStored.terminalTrigger.preArmCandidateKeys : []);
  const isProtected = (item) => Boolean(item) && preArmKeys.has(
    terminalTrigger.key(item.runId, item.status));
  // T073: capacity reserves space for candidates that can still become a notice.
  //
  // `preArmKeys` alone is not that test. It is a snapshot taken when the trigger was
  // armed, and it goes stale: on a live install it held 49 keys, not one of which
  // matched any of the 50 stored candidates, so every entry counted as work, `room`
  // was permanently 0, and a finished task could not be *queued* at all -- let alone
  // delivered. A notice the operator had explicitly asked for died at intake, before
  // the tick ever saw it.
  //
  // A channel-B candidate nobody has opted into cannot produce a notice on its own; it
  // is display history the operator may still choose from. Reserving capacity for those
  // is what let a backlog of them become permanent. Channel A needs no consent, and
  // either consent -- recorded while the task was running, or clicked on the entry
  // afterwards -- makes the entry real work.
  const optInState = (await readOptIns()).state;
  const reservesCapacity = (item) => {
    if (!item) return false;
    if (isProtected(item)) return false;      // pre-arm history: shown, never sent
    if (item.origin === terminalTrigger.ORIGIN_BRIDGE) return true;
    if (Number.isFinite(item.directArmedAt)) return true;
    if (Number.isFinite(item.runningArmedAt)) return true;
    return terminalTrigger.optInFor(optInState, item) !== null;
  };
  const workCount = existing.filter(reservesCapacity).length;
  const room = Math.max(0, MAX_CANDIDATES_STORED - workCount);
  // T069: an entry we already hold is not skipped outright any more -- its host-owned
  // provenance is refreshed if the host re-offers the same run. Normally an entry is
  // acknowledged as soon as it is stored and never comes back, but there are two real
  // cases where it does: an ACK that failed, and a candidate stored by an older
  // release. In both, the entry is missing fields that the consent decision now reads,
  // and dropping the re-offer on the floor is what made "the field is missing" look
  // like a permanent property of that task rather than a gap to fill.
  const byKey = new Map(existing.map((item) => [
    terminalTrigger.key(item.runId, item.status), item]));
  for (const candidate of incoming) {
    if (!candidate || typeof candidate.runId !== 'string') continue;
    const k = terminalTrigger.key(candidate.runId, candidate.status);
    const already = byKey.get(k);
    if (already) {
      const patched = refreshProvenance(already, candidate);
      if (patched) {
        // Refreshing never consumes a slot and never counts as `added`: the entry is
        // already in `merged`, and the capacity bound is about work, not about fields.
        const at = merged.indexOf(already);
        if (at >= 0) merged[at] = patched;
        byKey.set(k, patched);
        refreshed += 1;
      }
      continue;
    }
    if (added >= room) break;
    seen.add(k);
    // T086: keep the creation time. The arm boundary is proved from it, so
    // dropping it here would leave every future candidate unprovable.
    const entry = { runId: candidate.runId, status: candidate.status };
    if (Number.isFinite(candidate.startedAt) && candidate.startedAt > 0) {
      entry.startedAt = candidate.startedAt;
    }
    // T091: the host's verdict against the arm snapshot travels with the entry.
    // Dropping it here (as the T086 shape did) would leave every future candidate
    // with only the weaker creation-time proof, and the long-task refusal this
    // release exists to remove would quietly come back.
    if (candidate.postArm === true || candidate.postArm === false) {
      entry.postArm = candidate.postArm;
    }
    // T067: the channel, decided by the host from the dispatch bindings. Recorded
    // once, at intake, and never rewritten: a re-offer of the same run must not be
    // able to change which consent rule applies to it, because that is how one run
    // would get two notices. `directArmedAt` -- an operator's per-task opt-in -- is
    // likewise never carried over from a fresh sample; it only ever comes from the
    // popup.
    if (terminalTrigger.ORIGINS.includes(candidate.origin)) {
      entry.origin = candidate.origin;
    }
    // T067R: a channel-B candidate's id is derived from its turn, so the id alone
    // tells the operator nothing. The turn number and session travel with the entry
    // and are shown only in the popup -- never in the notice, whose text is a fixed
    // template. Without them the operator is asked to opt in to an opaque uuid.
    if (Number.isInteger(candidate.nativeTurn)) {
      entry.nativeTurn = candidate.nativeTurn;
    }
    if (typeof candidate.nativeSession === 'string' && candidate.nativeSession) {
      entry.nativeSession = candidate.nativeSession;
    }
    if (Number.isSafeInteger(candidate.endedAt)) {
      entry.endedAt = candidate.endedAt;
    }
    // T069: the millisecond terminal instant. Dropping it here would leave the stored
    // entry with only the floored second, and the consent rule would refuse every
    // running opt-in with `terminal_time_unknown` -- the feature would look broken
    // rather than merely conservative. `Number.isSafeInteger` and not `isFinite`: the
    // host sends an integer or `null`, and a float would mean a shape we do not
    // understand.
    if (Number.isSafeInteger(candidate.endedAtMs) && candidate.endedAtMs > 0) {
      entry.endedAtMs = candidate.endedAtMs;
    }
    merged.push(entry);
    added += 1;
  }
  // Bounded again, but only at the expense of history -- never of work.
  if (merged.length > MAX_CANDIDATES_STORED) {
    let excess = merged.length - MAX_CANDIDATES_STORED;
    const kept = [];
    for (const item of merged) {          // oldest first
      // T073: protected history first, then anything else that cannot become a
      // notice. `isProtected` alone could not free a slot that an un-consented
      // channel-B entry was holding, so the display backlog could grow to the bound
      // and stay there for good.
      if (excess > 0 && !reservesCapacity(item)) { excess -= 1; continue; }
      kept.push(item);
    }
    merged = kept;
  }
  // T069: `refreshed` also has to be persisted, or a provenance repair would be lost
  // with the very `set` that was supposed to save it.
  if (added > 0 || refreshed > 0) {
    await chrome.storage.local.set({ terminalCandidates: merged });
  }
  // Remember the sampler's baseline state. A successful sample *proves* the
  // baseline exists, because `terminal_source.sample` reports
  // `baselineEstablished: true` only on the call that creates it and `false` on
  // every later successful call -- the baseline is there, it just was not made
  // this time. Writing that flag straight through cleared the persistent marker
  // on the second poll, and since this is the only place that polls (and it only
  // runs with the trigger enabled), the marker could never come back while the
  // self-check refuses to call `terminal-list` without it. The result was a
  // permanent `baseline_not_established` report on a perfectly healthy machine.
  //
  // So the persisted flag is monotonic on success and untouched on failure:
  //   * success  -> a baseline exists (true, regardless of which call made it)
  //   * failure  -> write nothing; an unreadable source must not invent state
  // `establishedNow` keeps the original per-call meaning for auditing.
  try {
    const prev = await chrome.storage.local.get({ terminalSourceBaseline: null });
    const before = prev.terminalSourceBaseline
      && typeof prev.terminalSourceBaseline === 'object'
      ? prev.terminalSourceBaseline : null;
    const sampledAt = Date.now();
    // T066: `at` is rewritten on **every** successful sample, so it answers "when
    // did we last hear from the source", not "when was the baseline created". Both
    // were shown under the single label `establishedAt=`, which made a 13m30s gap
    // between two self-checks read as a re-baseline. Two facts, two fields, one
    // written once and one rewritten -- so the pair is decidable at a glance.
    const establishedAt = before && Number.isFinite(before.establishedAt)
      ? before.establishedAt
      : (before && Number.isFinite(before.at) ? before.at : sampledAt);
    await chrome.storage.local.set({
      terminalSourceBaseline: {
        established: true,
        establishedNow: report.baselineEstablished === true,
        establishedAt,
        existingTerminalRuns: Number.isSafeInteger(report.existingTerminalRuns)
          ? report.existingTerminalRuns : null,
        droppedFromBaseline: Number.isSafeInteger(report.droppedFromBaseline)
          ? report.droppedFromBaseline : null,
        // T066 freshness: what the source last knew and how old its file is. Display
        // only -- no branch anywhere reads these, so an idle hour cannot make the
        // chain look worse; it just stops the panel from calling a frozen source ok.
        newestRunId: typeof report.newestRunId === 'string'
          ? report.newestRunId : null,
        newestStartedAt: Number.isSafeInteger(report.newestStartedAt)
          ? report.newestStartedAt : null,
        ledgerMtime: Number.isSafeInteger(report.ledgerMtime)
          ? report.ledgerMtime : null,
        // T067: which channel source decided the A/B split, and whether that answer
        // is a live read or a cache. `null` means the bridge database could not be
        // read at all, so every candidate is `unknown` -- shown, never auto-sent.
        originSource: typeof report.originSource === 'string'
          ? report.originSource : null,
        originStale: report.originStale === true,
        originBridgeIds: Number.isSafeInteger(report.originBridgeIds)
          ? report.originBridgeIds : null,
        at: sampledAt,
      },
    });
  } catch (_err) { /* storage unavailable: the poll itself already succeeded */ }
  // Verify against what is *actually stored* -- always, not only when this round
  // added something. Two cases need this:
  //   * `added > 0`: the write may not have landed (set resolving is not the
  //     same as the value being there);
  //   * `added === 0`: the candidate was persisted on an earlier round whose ACK
  //     then failed. The host re-offers it, we recognise it, and previously we
  //     never re-acknowledged -- so it stayed pending forever.
  // Gating the ACK on `added > 0` was the bug: a stored-and-unacked candidate
  // could never be settled by a later round.
  const check = await chrome.storage.local.get({ terminalCandidates: [] });
  const persisted = new Set((check.terminalCandidates || [])
    .map((item) => terminalTrigger.key(item.runId, item.status)));
  // Only what survived the write is acknowledgeable. That single test covers
  // capacity too: a candidate dropped by the bound is absent from `persisted`
  // and therefore stays pending on the host, to be offered again.
  const ackable = incoming.filter((candidate) => candidate &&
    typeof candidate.runId === 'string' &&
    persisted.has(terminalTrigger.key(candidate.runId, candidate.status)));
  let acked = 0;
  if (ackable.length > 0) {
    try {
      await request('terminal-ack', {
        acked: ackable.map((candidate) => candidate.runId),
      });
      acked = ackable.length;
    } catch (_err) {
      // Unacknowledged is the safe failure: the host keeps the candidate
      // pending and offers it again, and the candidate key stops a second
      // notice. Nothing is lost by retrying on the next tick.
      acked = 0;
    }
  }
  await recordChainStatus({ ok: true, code: null, added, acked, refreshed });
  return {
    ok: true,
    added,
    acked,
    // T069: how many already-held entries had their host-owned provenance completed.
    // Not part of `added` (nothing new arrived) and never counted as work.
    refreshed,
    queued: Math.min(merged.length, MAX_CANDIDATES_STORED),
    // Per-call meaning, kept as-is: "this sample is the one that created the
    // baseline". Readers that want "does a baseline exist" must use the persisted
    // `terminalSourceBaseline.established`, which is the monotonic answer.
    baselineEstablished: report.baselineEstablished === true,
    existingTerminalRuns: report.existingTerminalRuns,
    droppedFromBaseline: report.droppedFromBaseline,
    // T091: which arm round this sample was measured against, and how big that
    // snapshot was. `null` means the host has no snapshot, which the trigger must
    // treat as "unproven" rather than "everything is new".
    armEpoch: typeof report.armEpoch === 'string' && report.armEpoch
      ? report.armEpoch : null,
    armTakenAt: Number.isSafeInteger(report.armTakenAt) ? report.armTakenAt : null,
    armCount: Number.isSafeInteger(report.armCount) ? report.armCount : null,
    // T067: where the channel verdict came from. Reported so the self-check can
    // say "the A/B split is a live read / a cache / not available at all" instead
    // of every run silently looking like a direct one.
    originSource: typeof report.originSource === 'string'
      ? report.originSource : null,
    originStale: report.originStale === true,
    provenance: report.provenance || 'unverified',
  };
}

// T067: the per-task opt-in surface for runs a person started in DSH Desktop.
//
// Read-only. It answers "which stored candidates are waiting for a click, which
// are already armed, and which need no click at all because the Bridge asked for
// them". It deliberately does not poll the host, does not arm anything, and does
// not touch the send path -- opening the popup must never change what gets sent.
async function readDirectOptInState(now = Date.now()) {
  const stored = await chrome.storage.local.get({
    terminalCandidates: [], terminalTrigger: null, terminalSourceBaseline: null,
  });
  const list = Array.isArray(stored.terminalCandidates)
    ? stored.terminalCandidates : [];
  const trigger = terminalTrigger.normalizeTriggerState(
    stored.terminalTrigger || terminalTrigger.createTriggerState(), now).state;
  const preArmKeys = new Set(Array.isArray(trigger.preArmCandidateKeys)
    ? trigger.preArmCandidateKeys : []);
  const keyOf = (item) => terminalTrigger.key(item.runId, item.status);
  const describe = (item) => {
    const k = keyOf(item);
    const seen = trigger.seen && trigger.seen[k] ? trigger.seen[k] : null;
    const armedAt = Number.isFinite(item.directArmedAt) ? item.directArmedAt : null;
    return {
      runId: item.runId,
      status: item.status,
      origin: item.origin,
      startedAt: Number.isFinite(item.startedAt) ? item.startedAt : null,
      postArm: item.postArm === true ? true : (item.postArm === false ? false : null),
      preArm: preArmKeys.has(k),
      armedAt,
      // An opt-in past its window is shown as expired rather than as armed: the
      // gate will refuse it, and a popup that said "armed" would be lying.
      armedExpired: armedAt !== null
        && now - armedAt > terminalTrigger.DIRECT_OPTIN_TTL_MS,
      settledState: seen ? seen.state : null,
    };
  };
  const all = list.map(describe);
  const direct = all.filter((item) => item.origin !== terminalTrigger.ORIGIN_BRIDGE
    && item.settledState === null && item.preArm === false);
  const baseline = stored.terminalSourceBaseline;
  return {
    originSource: baseline && typeof baseline.originSource === 'string'
      ? baseline.originSource : null,
    originStale: Boolean(baseline && baseline.originStale === true),
    ttlMs: terminalTrigger.DIRECT_OPTIN_TTL_MS,
    counts: {
      total: all.length,
      bridge: all.filter((item) => item.origin === terminalTrigger.ORIGIN_BRIDGE).length,
      // "waiting" is the population the popup must list: a direct or unknown run
      // that is stored, not yet settled, not pre-arm history, and not armed.
      waiting: direct.filter((item) => item.armedAt === null).length,
      armed: direct.filter((item) => item.armedAt !== null
        && item.armedExpired === false).length,
      expired: direct.filter((item) => item.armedExpired === true).length,
      missingOrigin: all.filter((item) => !terminalTrigger.ORIGINS
        .includes(item.origin)).length,
    },
    direct,
  };
}

// One per-task opt-in. The flag is written onto the stored candidate, so an
// eviction takes it away with the run instead of leaving a live permission
// pointing at nothing.
async function armDirectCandidate(runId, status, now = Date.now()) {
  const stored = await chrome.storage.local.get({
    terminalCandidates: [], terminalTrigger: null,
  });
  const list = Array.isArray(stored.terminalCandidates)
    ? stored.terminalCandidates : [];
  const trigger = terminalTrigger.normalizeTriggerState(
    stored.terminalTrigger || terminalTrigger.createTriggerState(), now).state;
  const done = terminalTrigger.armDirect(list, runId, status, trigger, now);
  if (!done.ok) return done;
  await chrome.storage.local.set({ terminalCandidates: done.list });
  // Verify against what is actually stored: `set` resolving is not the same as the
  // value being there, and an opt-in the operator believes in but which is not on
  // disk would only surface as a silent "why was this not sent".
  const check = await chrome.storage.local.get({ terminalCandidates: [] });
  const key = terminalTrigger.key(runId, status);
  const persisted = (check.terminalCandidates || []).find((item) => item
    && terminalTrigger.key(item.runId, item.status) === key);
  if (!persisted || !Number.isFinite(persisted.directArmedAt)) {
    return { ok: false, code: 'opt_in_not_persisted', runId, status };
  }
  // Nothing is sent here. The opt-in only makes the candidate admissible on the
  // next scheduled tick, so every existing limit -- pacing, hourly ceiling, the
  // page gate and the operator's grant -- still stands between the click and the
  // page. Rushing a write because somebody clicked is the one thing this design
  // will not do.
  return { ok: true, code: null, runId, status, origin: persisted.origin,
    armedAt: persisted.directArmedAt, ttlMs: terminalTrigger.DIRECT_OPTIN_TTL_MS };
}

// ------------------------------------------------------------------ T068 running opt-ins
//
// The popup surface for "I want a notice when *that* task finishes", decided while it
// is still running. Three properties matter and each one is load-bearing:
//
//   * reading is read-only. Opening the popup must not consume a candidate, move the
//     sampler forward, or ACK anything -- so the running inventory comes from its own
//     host op, never from `terminal-list`.
//   * the decision is stored by (sessionId, turn), not by runId or list position. That
//     is what the host joins channel A on, and what keeps the choice alive across
//     candidate eviction, trigger re-arming and a browser restart.
//   * nothing is sent here. The opt-in only makes the task admissible once the host
//     reports it terminal; pacing, the hourly ceiling, the page gate and the T053/T058
//     grant all still stand between the click and the page.

async function readOptIns() {
  const stored = await chrome.storage.local.get({ terminalOptIns: null });
  const repaired = terminalTrigger.normalizeOptIns(stored.terminalOptIns);
  if (repaired.dropped.length > 0) {
    // Persist the repair so it is not recomputed on every popup open, and so the
    // dropped keys are visible in storage rather than only in this call.
    await chrome.storage.local.set({ terminalOptIns: repaired.state });
  }
  return repaired;
}

function ordinalLabel(item) {
  if (!item || !Number.isInteger(item.turn)) return '?';
  return '第 ' + item.turn + ' 轮';
}

async function readRunningState() {
  const now = Date.now();
  const optIns = await readOptIns();
  const stored = await chrome.storage.local.get({ terminalTrigger: null });
  const trigger = terminalTrigger.normalizeTriggerState(
    stored.terminalTrigger || terminalTrigger.createTriggerState(), now).state;
  let host = null;
  try {
    host = await request('terminal-running');
  } catch (err) {
    host = { ok: false, code: 'host_unreachable',
      error: err && err.message ? err.message : String(err) };
  }
  const sourceOk = Boolean(host && host.ok === true);
  const running = sourceOk && Array.isArray(host.running) ? host.running : [];
  const rows = running.map((item) => {
    const entry = terminalTrigger.optInFor(optIns.state, {
      nativeSession: item.sessionId, nativeTurn: item.turn });
    const usable = entry
      ? terminalTrigger.optInUsable(entry, { nativeSession: item.sessionId,
        nativeTurn: item.turn, endedAtMs: null }, now)
      : null;
    return {
      sessionId: item.sessionId,
      turn: item.turn,
      runId: item.runId,
      startedAt: Number.isFinite(item.startedAt) ? item.startedAt : null,
      observedSince: Number.isFinite(item.observedSince) ? item.observedSince : null,
      lastActivityAt: Number.isFinite(item.lastActivityAt)
        ? item.lastActivityAt : null,
      activityCount: Number.isInteger(item.activityCount) ? item.activityCount : 0,
      evidence: item.evidence || null,
      optedIn: Boolean(entry) && !entry.consumedAt,
      optedInAt: entry && Number.isFinite(entry.armedAt) ? entry.armedAt : null,
      consumedAt: entry && Number.isFinite(entry.consumedAt)
        ? entry.consumedAt : null,
      // What `optInUsable` says for a turn that has not ended. `terminal_time_unknown`
      // is the expected answer here and is not an error: it becomes usable the moment
      // the host reports the turn's end, which is checked again at admission.
      usableNow: usable ? usable.code : 'no_opt_in',
    };
  });
  return {
    ok: sourceOk,
    code: sourceOk ? null : (host && host.code) || 'running_unavailable',
    error: sourceOk ? null : (host && host.error) || null,
    // Deliberately separate from `code`: "the source could not be read" and "nothing
    // is running" must not look alike, or an operator would conclude their task is
    // gone when in fact nothing was looked at.
    nothingRunning: sourceOk && rows.length === 0,
    ledgerOk: Boolean(host && host.ledgerOk === true),
    nativeOk: Boolean(host && host.nativeOk === true),
    bridgeRunning: host && Number.isInteger(host.bridgeRunning)
      ? host.bridgeRunning : null,
    stale: host && Number.isInteger(host.stale) ? host.stale : null,
    triggerEnabled: trigger.enabled === true,
    rows,
    counts: {
      running: rows.length,
      optedIn: rows.filter((row) => row.optedIn).length,
    },
    bounds: {
      maxOptIns: terminalTrigger.MAX_OPTINS,
      maxAgeMs: terminalTrigger.OPTIN_MAX_AGE_MS,
    },
  };
}

// One running task, named exactly. `seenEndedAt` is what the popup displayed as the
// task's end time; if the host had already reported one, the click is a decision about
// a finished task and belongs to the T067 path instead, so it is refused here rather
// than recorded as something it is not.
async function armRunningOptIn(sessionId, turn, seenEndedAt, now = Date.now()) {
  if (typeof sessionId !== 'string' || !sessionId
    || !Number.isInteger(turn) || turn < 0) {
    return { ok: false, code: 'target_invalid' };
  }
  if (Number.isFinite(seenEndedAt)) {
    return { ok: false, code: 'task_already_ended', sessionId, turn };
  }
  const optIns = await readOptIns();
  const armed = terminalTrigger.armRunning(optIns.state, sessionId, turn, now);
  if (!armed.ok) {
    return { ok: false, code: armed.code, sessionId, turn };
  }
  await chrome.storage.local.set({ terminalOptIns: armed.state });
  // Verify against what is actually stored: `set` resolving is not the same as the
  // value being there, and an opt-in the operator believes in but which never reached
  // disk would only surface as a task that mysteriously did not notify.
  const check = await chrome.storage.local.get({ terminalOptIns: null });
  const key = terminalTrigger.optInKey(sessionId, turn);
  const persisted = check.terminalOptIns && check.terminalOptIns.entries
    ? check.terminalOptIns.entries[key] : null;
  if (!persisted || !Number.isFinite(persisted.armedAt)) {
    return { ok: false, code: 'opt_in_not_persisted', sessionId, turn };
  }
  return { ok: true, code: null, sessionId, turn, armedAt: persisted.armedAt,
    label: ordinalLabel({ turn }),
    // Said out loud because it is the one thing that would make the operator think
    // the feature is broken: the choice is recorded, but nothing will be sent until
    // the T059 trigger is armed.
    triggerEnabled: Boolean(await triggerIsEnabled()),
    note: '选择已记录。终态触发未启用时不会发送。' };
}

async function triggerIsEnabled() {
  const stored = await chrome.storage.local.get({ terminalTrigger: null });
  const state = stored && stored.terminalTrigger;
  return Boolean(state && state.enabled === true);
}

// Retire an opt-in once the notice it authorised has actually been written, or the
// attempt was stopped for good. Kept here rather than inside the send loop so the
// "did this consent still apply" rule stays in `terminal_trigger.js`, where it is
// unit-tested without a browser.
async function consumeOptIn(candidate, journalState, now = Date.now()) {
  if (!candidate) return { changed: false };
  if (!Number.isFinite(candidate.runningArmedAt) || candidate.runningArmedAt <= 0) {
    return { changed: false };
  }
  const optIns = await readOptIns();
  const done = terminalTrigger.settleOptIn(optIns.state, candidate, journalState, now);
  if (done.changed) await chrome.storage.local.set({ terminalOptIns: done.state });
  return { changed: done.changed, journalState };
}

async function revokeRunningOptIn(sessionId, turn) {
  if (typeof sessionId !== 'string' || !sessionId
    || !Number.isInteger(turn) || turn < 0) {
    return { ok: false, code: 'target_invalid' };
  }
  const optIns = await readOptIns();
  const done = terminalTrigger.revokeRunning(optIns.state, sessionId, turn);
  if (!done.ok) return { ok: false, code: done.code, sessionId, turn };
  await chrome.storage.local.set({ terminalOptIns: done.state });
  const check = await chrome.storage.local.get({ terminalOptIns: null });
  const key = terminalTrigger.optInKey(sessionId, turn);
  const still = check.terminalOptIns && check.terminalOptIns.entries
    ? check.terminalOptIns.entries[key] : null;
  if (still) return { ok: false, code: 'opt_out_not_persisted', sessionId, turn };
  return { ok: true, code: null, sessionId, turn };
}

// T059: drive the terminal trigger over its own candidate list.
//
// This runs only when something explicitly asked for it. There is no alarm and
// no interval: an unattended loop that writes into a conversation is exactly the
// thing that must be opted into deliberately, not inherited from a poll timer.
//
// Every iteration can only ever lower what is allowed: `admit` refusals skip,
// `sendOnce` refusals skip, a non-sent outcome disables the trigger, and any
// exception disables it and stops the loop.
// T142: keep the last verdict where the popup can read it. Deliberately a
// read-modify-write of one field: a tick that snapshotted the state earlier must never
// overwrite an arm the operator took in the meantime.
async function recordTickVerdict(guard, options = {}) {
  const patch = {
    at: Date.now(),
    guard: {
      ok: guard && guard.ok !== false,
      code: (guard && guard.code) || null,
      count: guard && Number.isSafeInteger(guard.count) ? guard.count : 0,
      chosen: guard && typeof guard.chosen === 'string' ? guard.chosen : null,
      waiting: guard && Number.isSafeInteger(guard.waiting) ? guard.waiting : 0,
    },
    sent: Number.isSafeInteger(options.sent) ? options.sent : 0,
  };
  try {
    const stored = await chrome.storage.local.get({ terminalTrigger: null });
    const base = stored.terminalTrigger || options.state || null;
    if (!base) return patch;
    await chrome.storage.local.set({
      terminalTrigger: Object.assign({}, base, { lastTick: patch }),
    });
  } catch (_err) {
    // A diagnostic must never be the reason a tick fails.
  }
  return patch;
}

async function runTerminalTrigger(options = {}) {
  const limit = Number.isSafeInteger(options.limit) ? options.limit : 3;
  // Test seam only: the offline suites replace the page writer so they can prove
  // *which* candidates reach it without any page existing. Production callers pass
  // no writer, so the real controller is used.
  const sendOnce = typeof options.sendOnce === 'function'
    ? options.sendOnce : (candidate) => autoSend.sendOnce(candidate);
  // Test seam only, same idea as `sendOnce`: the hourly window and the 30s pacing
  // are clock-driven, and no honest test can spend an hour of wall time. Production
  // callers pass no clock, so `Date.now` is used.
  const nowFn = typeof options.now === 'function' ? options.now : Date.now;
  const stored = await chrome.storage.local.get({ terminalTrigger: null });
  // T078: an armed record written by an older release may lack fields this one
  // reads. Normalize on load and persist the repair, so every later call in this
  // tick sees a complete schema and the repair is not repeated on every alarm.
  const migrated = terminalTrigger.normalizeTriggerState(
    stored.terminalTrigger || terminalTrigger.createTriggerState(), nowFn());
  let state = migrated.state;
  if (migrated.filled.length > 0) {
    await chrome.storage.local.set({ terminalTrigger: state });
  }
  const reconciled = terminalTrigger.reconcileAfterRestart(state, nowFn());
  if (reconciled.changed) {
    state = reconciled.state;
    await chrome.storage.local.set({ terminalTrigger: state });
  }
  // T137: the same rule on the tick path. The `disable()` paths further down clear the alarm
  // explicitly; this one used to leave it scheduled, so an arm that ended with its window kept
  // waking the worker every hour to be told `trigger_disabled`.
  if (state.enabled !== true) {
    await syncTerminalAlarm();
  }

  // Default off, and off means "do not even ask the host". Polling a source
  // whose answers cannot be acted on would be a standing read of the user's
  // task history for no benefit.
  if (state.enabled !== true) {
    return { state, results: [], fetched: { ok: false, code: 'trigger_disabled' } };
  }
  const fetched = await refreshTerminalCandidates();
  if (fetched.ok !== true) {
    // An unreadable source is not a reason to keep the previous candidates
    // moving: stop, and let a human decide.
    return { state, results: [], fetched };
  }

  const results = [];
  const rawCandidates = await chromeAutoSend.readCandidates();
  // T068: attach the running opt-in to each candidate, if one authorises it.
  //
  // This has to happen *before* the fail-closed partition below, because an opt-in
  // taken while the task was running is a decision made before the arm boundary --
  // and it is a decision, not history. Leaving the annotation until `admit()` would
  // mean the T086/T091 gates (which only ever look at `startedAt` and `postArm`)
  // refuse the very long task the operator made a point of asking about.
  //
  // `optInUsable` is the whole check: recorded before this turn's own `endedAt`, not
  // spent, not expired. A run with nothing in the store comes out of here unchanged.
  const optIns = await readOptIns();
  const candidates = rawCandidates.map((item) => {
    if (!item || (item.origin !== terminalTrigger.ORIGIN_DIRECT
      && item.origin !== terminalTrigger.ORIGIN_UNKNOWN)) {
      return item;
    }
    const entry = terminalTrigger.optInFor(optIns.state, item);
    if (!entry) return item;
    const usable = terminalTrigger.optInUsable(entry, item, nowFn());
    if (!usable.ok) return Object.assign({}, item, { optInRefusal: usable.code });
    return Object.assign({}, item, { runningArmedAt: usable.armedAt,
      consent: 'running_opt_in' });
  });

  // Fail-closed partition: only candidates produced *after* the trigger was armed
  // may be written. Anything already queued at arm time is history -- the operator
  // enabled "notify me about future completions", not "deliver my backlog".
  //
  // A state written before this field existed has no snapshot, so nothing stored
  // can be proven new; in that case the whole current list is treated as pre-arm
  // and the snapshot is taken now. Refusing to send is recoverable, sending is not.
  const keyOf = (item) => terminalTrigger.key(item.runId, item.status);
  let preArmKeys = Array.isArray(state.preArmCandidateKeys)
    ? state.preArmCandidateKeys : null;
  if (preArmKeys === null) {
    preArmKeys = candidates.map(keyOf);
    state = Object.assign({}, state, { preArmCandidateKeys: preArmKeys });
    await chrome.storage.local.set({ terminalTrigger: state });
  }
  // T086: the snapshot above is a fact about the *cache*, not about the tasks. It
  // only knows what the local queue happened to hold when the operator armed, so a
  // run that finished before arming but had not been pulled from the host yet slips
  // through it -- which is what a reload-and-re-arm produced. A second, independent
  // gate decides from the run's own creation time; see `completionAfterArm`.
  //
  // A record with no `armedAt` cannot prove anything, so one is recorded now. That
  // is not the same as grandfathering the backlog: everything already created is
  // earlier than this instant, so it stays refused on this and every later tick.
  if (!Number.isFinite(state.armedAt) || state.armedAt <= 0) {
    state = Object.assign({}, state, { armedAt: nowFn() });
    await chrome.storage.local.set({ terminalTrigger: state });
  }
  // T091: two proofs, and the stronger one wins where it is available.
  //
  //   snapshot  the host recorded which runs were already terminal when this arm
  //             round started. A run absent from that set was *not* terminal then,
  //             so it finished afterwards -- provable in both directions, which is
  //             what lets a long task created before the arm be delivered.
  //   created   `startedAt >= armedAt` (T086). Still correct, but it can only prove
  //             the positive case; a run created before the arm is refused however
  //             late it finished.
  //
  // A record armed by the previous release has no epoch. It keeps working on the
  // weaker proof rather than being shut off, because that proof never sends
  // anything that was already finished; re-arming is what upgrades it. An epoch
  // that *exists* but does not match the host is a different matter -- the two
  // sides disagree about which round this is, so nothing is provable at all.
  const stateEpoch = typeof state.armEpoch === 'string' && state.armEpoch
    ? state.armEpoch : null;
  const hostEpoch = typeof fetched.armEpoch === 'string' && fetched.armEpoch
    ? fetched.armEpoch : null;
  const epochProof = stateEpoch !== null && hostEpoch !== null
    && hostEpoch === stateEpoch;
  // Reasons that are a settled judgement about *that* candidate: they may be
  // folded into the pre-arm snapshot so they stop occupying work slots. A global
  // refusal must NOT be folded -- the next tick or the next arm may well make the
  // same candidate provable, and locking it as history would swallow real work.
  const SETTLED_REASONS = new Set(['queued_before_arm', 'in_arm_snapshot',
    'started_before_arm', 'candidate_time_missing']);

  const preArm = new Set(preArmKeys);
  const preArmKeysInitial = new Set(preArmKeys);
  const blocked = [];
  const fresh = [];
  for (const item of candidates) {
    const reason = (() => {
      // T068: a task the operator opted into *while it was running*. Both proofs
      // below are about "was this finished after the arm round started", and both
      // answer "no" for a task that was already in flight when somebody armed the
      // trigger -- which is exactly the long task this release exists for. The
      // operator's own click, recorded before the task ended, replaces those proofs
      // for this one run and no other.
      //
      // Still refused here: a bridge run (its `runningArmedAt` can never be set --
      // `readOptIns` is only consulted for direct/unknown), and an opt-in that
      // `optInUsable` rejected, which leaves `optInRefusal` instead.
      if (Number.isFinite(item.runningArmedAt) && item.runningArmedAt > 0) {
        return null;
      }
      if (preArm.has(keyOf(item))) return 'queued_before_arm';
      if (stateEpoch !== null) {
        if (hostEpoch === null) return 'arm_snapshot_missing';
        if (hostEpoch !== stateEpoch) return 'arm_epoch_mismatch';
        if (item.postArm === true) return null;
        if (item.postArm === false) return 'in_arm_snapshot';
        // Epoch matched but this entry was stored before `postArm` existed.
        const proof = terminalTrigger.completionAfterArm(state, item);
        return proof.proven ? null : proof.reason;
      }
      const proof = terminalTrigger.completionAfterArm(state, item);
      return proof.proven ? null : proof.reason;
    })();
    if (reason === null) fresh.push(item);
    else blocked.push({ item, reason });
  }
  const boundaryBlocked = blocked.filter((entry) =>
    SETTLED_REASONS.has(entry.reason));
  // Blocked candidates are folded into the pre-arm snapshot once, so every later
  // tick, the capacity bound and the popup all treat them as the history they are.
  // Without this they would keep occupying work slots and could starve real
  // completions, which is the failure T074 already had to fix once.
  if (boundaryBlocked.length > 0) {
    const grown = [...new Set([...preArmKeys,
      ...boundaryBlocked.map((entry) => keyOf(entry.item))])];
    preArmKeys = grown;
    state = Object.assign({}, state, { preArmCandidateKeys: grown });
    await chrome.storage.local.set({ terminalTrigger: state });
    for (const key of grown) preArm.add(key);
  }
  // Reported, never drained: these stay in storage so the operator can see what
  // is waiting, and they are not acknowledged to the host on this path. The
  // boundary reason travels with each one so "why was this not sent" has an answer
  // that is not a guess, and a transient reason is reported as transient.
  const boundaryReason = new Map(blocked.map((entry) =>
    [keyOf(entry.item), entry.reason]));
  for (const entry of blocked) {
    const settled = SETTLED_REASONS.has(entry.reason);
    results.push({
      candidate: entry.item,
      code: settled ? 'pre_arm_candidate' : 'boundary_unproven',
      sent: false,
      reason: entry.reason,
      proof: settled ? (epochProof ? 'arm_snapshot' : 'started_at')
        : 'none',
      // A refused-but-provisional candidate must not look like history.
      settled,
      note: preArmKeysInitial.has(keyOf(entry.item)) && settled
        ? 'queued_before_arm' : undefined,
    });
  }

  // The limit applies to work this tick may actually do. Counting skipped history
  // against it would let a handful of stale entries starve every new completion.
  //
  // T073: and so does counting *refusals*. `limit` used to slice `fresh` before any
  // decision was taken, so the three oldest entries were inspected and then discarded
  // whether or not they could ever be admitted. A channel-B candidate nobody has opted
  // into is refused with `direct_not_opted_in`, which by design neither journals it nor
  // drains it -- so it stayed at the front and was re-refused on every tick for ever,
  // and everything behind it was never looked at. A live install at 50 such entries
  // silently stopped delivering while the popup said the opt-in had been recorded.
  //
  // Inspection is pure and cheap; the bound is there to cap page writes, so the budget
  // is spent on candidates that get past `admit`, and a refusal costs nothing. The loop
  // still terminates on the candidate list, and every refusal is still reported.
  let budget = Math.max(0, limit);
  // T122: a one-shot arm promises "the next terminal message", and the only honest way to keep
  // that promise is to refuse when two runs could claim it. Checked once, before the loop, so the
  // refusal is a fact about the candidate set rather than a race between iterations.
  // T142: a restricted arm releases exactly one candidate, chosen by the module (the
  // earliest completion after the arm; a genuine tie is still refused). T122 refused the
  // whole set instead, which on a live install with a backlog meant the arm could never
  // fire at all: 43 completions, zero page writes, `single_shot_multiple_candidates` for ever.
  const guard = terminalTrigger.guardSingleCandidate(state, fresh, nowFn());
  if (!guard.ok) {
    for (const candidate of fresh) results.push({ candidate, code: guard.code });
    await recordTickVerdict(guard, { state, sent: 0 });
    // Same shape as the normal exit: an early return that changed the return type would make
    // every caller read `results` off an array and silently see nothing.
    return { state, results, fetched };
  }
  if (typeof guard.chosen === 'string' && guard.chosen) {
    // Everything else stays queued: reported, never sent, never acknowledged, and never
    // allowed to hold this arm -- or the next one -- hostage.
    const chosenList = fresh.filter((candidate) => candidate.runId === guard.chosen);
    for (const candidate of fresh) {
      if (candidate.runId === guard.chosen) continue;
      results.push({ candidate, code: 'single_shot_queued', sent: false,
        chosen: guard.chosen, note: 'held_for_a_later_arm' });
    }
    fresh.length = 0;
    for (const candidate of chosenList) fresh.push(candidate);
  }
  for (const candidate of fresh) {
    if (budget <= 0) break;
    if (state.enabled !== true) {
      results.push({ candidate, code: 'trigger_disabled' });
      break;
    }
    const admitted = terminalTrigger.admit(state, candidate, nowFn());
    if (!admitted.admit) {
      results.push({ candidate, code: admitted.code });
      // T123: an expired restricted arm is dead, not sleepy. Persist that and clear the alarm,
      // so it cannot sit in storage waiting for a future candidate to revive it.
      if (admitted.code === 'trigger_expired') {
        const expired = terminalTrigger.disable(state, 'single_shot_trigger_expired',
          nowFn());
        state = expired.state;
        await chrome.storage.local.set({ terminalTrigger: state });
        await syncTerminalAlarm();
      }
      // Compute the key here rather than reading `admitted.key`: `admit()` only
      // returns a key on the success path, so the old branch compared against
      // `undefined` and never removed anything -- the local candidate list
      // accumulated entries that could never be cleared.
      if (admitted.code === 'duplicate_event' ||
          admitted.code === 'duplicate_run') {
        const staleKey = terminalTrigger.key(candidate.runId, candidate.status);
        await chromeAutoSend.consumeCandidate((item) =>
          terminalTrigger.key(item.runId, item.status) === staleKey);
      }
      continue;
    }
    // Past `admit`: this one is going to touch the page, so it is what the bound is
    // for. Spending the budget here is what keeps a burst of completions from turning
    // into a burst of writes while still letting a consented candidate through a
    // backlog it cannot be blamed for.
    budget -= 1;
    const marked = terminalTrigger.markAttempt(state, candidate, nowFn());
    state = marked.state;
    await chrome.storage.local.set({ terminalTrigger: state });

    let outcome;
    try {
      outcome = await sendOnce(candidate);
    } catch (err) {
      // Anything thrown here stops the trigger; it is never retried.
      state = terminalTrigger.disable(state,
        'send_threw:' + String(err && err.message ? err.message : err)).state;
      await chrome.storage.local.set({ terminalTrigger: state });
      results.push({ candidate, code: 'stopped', reason: 'send_threw' });
      break;
    }

    const settled = terminalTrigger.settle(state, marked.key, outcome, nowFn());
    // T149: check the journal bound after every outcome. Below the bound this is a no-op; above
    // it the arm stops, and nothing is trimmed (see `compactJournal`).
    state = terminalTrigger.compactJournal(settled.state).state;
    await chrome.storage.local.set({ terminalTrigger: state });
    // T068: spend the running opt-in, but only on a conclusive outcome. A deferral or
    // a rate-limit refusal leaves it alone on purpose -- the task still owes a notice,
    // and consuming the consent there would turn "wait your turn" into "never".
    //
    // The journal's own `state` is the authority, not `result.status`: `settle` writes
    // `sent`/`stopped` there and nothing else can, so reading it directly cannot drift
    // from what actually happened.
    const journal = state.seen && state.seen[marked.key];
    await consumeOptIn(candidate, journal ? journal.state : null, nowFn());
    // T076: a pre-write refusal is a deferral, not an event. The trigger stays
    // armed, no quota moves, and the candidate stays queued for the scheduled
    // re-check -- so the tick continues instead of breaking out.
    const status = settled.result && settled.result.status;
    if (status === 'deferred') {
      results.push({ candidate, code: 'deferred:' + settled.result.reason,
        deferred: true, sent: false, retryAt: settled.result.retryAt });
      continue;
    }
    // T066: `stored` is the object returned by `chrome.storage.local.get` above,
    // so `stored === null` was never true and this ternary always yielded
    // `outcome.code`. Keep the plain read; the dead guard is gone.
    results.push({ candidate, code: outcome.code, sent: outcome.sent === true });
    if (outcome.sent === true) {
      await chromeAutoSend.consumeCandidate((item) =>
        terminalTrigger.key(item.runId, item.status) === marked.key);
    }
    // T123: a restricted trigger is spent by the first send, or by the first attempt that may
    // have written. Stopping here -- and clearing the alarm with it -- is what keeps one test
    // message from being followed by an hourly trigger that keeps proposing new tasks.
    {
      const after = await chrome.storage.local.get({ terminalTrigger: null });
      const spent = terminalTrigger.disarmAfterSendOnce(after.terminalTrigger,
        { sent: outcome.sent === true,
          pageWriteAttempted: outcome.pageWriteAttempted === true }, nowFn());
      if (spent.disarmed === true) {
        state = spent.state;
        await chrome.storage.local.set({ terminalTrigger: state });
        await syncTerminalAlarm();
      }
    }
    if (state.enabled !== true) break;      // doubt disabled the trigger: stop
  }
  await recordTickVerdict(guard, { state,
    sent: results.filter((row) => row.sent === true).length });
  return { state, results, fetched };
}

// T065: read-only chain self-check.
//
// This is the one place the operator can ask "how far along is this really?".
// It answers by *reading*: two host queries that only report, plus local state.
// It must never become a button that does work, so:
//   - no `poll` (that would move the delivery cursor),
//   - no `simulate` (that would create events),
//   - no `terminal-ack` (that would consume a candidate),
//   - no page writes, no tab activation, no candidate creation.
// The counter it does move is its own `lastPoll` record, which is a note about
// what it saw, not state anything else depends on.
async function readChainSelfCheck() {
  const now = Date.now();
  const facts = {};

  // Layer 1: does the host answer at all?
  try {
    facts.hello = await request('hello');
  } catch (err) {
    facts.hello = { ok: false, code: 'host_unreachable',
      error: err && err.message ? err.message : String(err) };
  }

  // Layer 2: is the terminal source readable, and is it primed?
  //
  // `terminal-list` is what the sampler answers with; it is read-only on the
  // host side *except* that the first call establishes the baseline. That is why
  // this is guarded: running the self-check must not silently swallow every
  // pending completion into a fresh baseline. If a baseline already exists the
  // call is a pure read and is safe; if it does not, the self-check says so
  // instead of establishing one behind the operator's back.
  const stored = await chrome.storage.local.get({
    terminalCandidates: [], terminalTrigger: null, terminalChainStatus: null,
    terminalSourceBaseline: null, autosend: null,
  });
  // The baseline marker is written by the real poll, so this reads the truth
  // rather than inventing its own flag.
  const sourceNote = stored.terminalSourceBaseline;
  if (facts.hello && facts.hello.ok === false) {
    facts.terminalList = null;
  } else if (sourceNote && sourceNote.established === true) {
    try {
      facts.terminalList = await request('terminal-list');
    } catch (err) {
      facts.terminalList = { ok: false, code: 'host_unreachable',
        error: err && err.message ? err.message : String(err) };
    }
  } else {
    // Not yet primed: report it honestly rather than creating the baseline,
    // because the first `terminal-list` absorbs every existing terminal run.
    facts.terminalList = { ok: false, code: 'baseline_not_established' };
  }

  // Binding health: one probe of the *bound* tab only. `health()` is read-only.
  try {
    facts.bindingHealth = await targetBinding.health();
  } catch (err) {
    facts.bindingHealth = { ok: false, status: 'binding_health_failed',
      reason: err && err.message ? err.message : String(err) };
  }

  facts.autoSendState = stored.autosend || null;
  facts.triggerState = stored.terminalTrigger || null;
  facts.candidates = { candidates: stored.terminalCandidates,
    lastPoll: stored.terminalChainStatus,
    preArmCandidateKeys: facts.triggerState
      && Array.isArray(facts.triggerState.preArmCandidateKeys)
      ? facts.triggerState.preArmCandidateKeys : null };

  const report = summariseChain(facts, now);
  report.headline = describeStage(report);
  report.note = '只读自检：不轮询、不 ACK、不产生候选、不写页面、不激活标签。';

  // Record the *diagnostic* reading under its own key. It deliberately does not
  // touch `terminalChainStatus`: that key is the record of a real poll, and a
  // self-check measures no `added`/`acked` at all. Writing it here made a click
  // look like a poll that found nothing and destroyed the last real numbers.
  try {
    await chrome.storage.local.set({
      terminalSelfCheckStatus: {
        at: now,
        ok: report.layers.hostOnline.value === true,
        stage: report.stage,
        code: report.stage === 'ready' ? null : report.stage,
      },
    });
  } catch (_err) { /* storage gone: the report is still valid */ }

  return report;
}

// T057: one line an operator can act on, for the binding item in the checklist.
//
// The health verdict nests its facts: `{ok, status, reason, binding}` where
// `binding` is the *record*. The previous one-liner read `binding.conversationId`
// off the outer object, which is always undefined, so every case printed the same
// `无绑定`: a healthy binding, an invalidated one and "never bound" were
// indistinguishable in the one line someone reads right after refreshing the page
// -- and "healthy / 无绑定" contradicted itself. Cheap to fix here because
// `assessBindingHealth` already put everything needed in the result.
function describeBindingHealth(health) {
  const record = health && health.binding && typeof health.binding === 'object'
    ? health.binding : null;
  const status = health && typeof health.status === 'string'
    ? health.status : 'binding_unavailable';
  if (!record) {
    return status === 'not_bound'
      ? '未绑定（需要人工绑定一次）'
      : '无绑定记录: ' + status;
  }
  const where = 'tab=' + record.tabId + ' window=' + record.windowId +
    ' conversation=' + record.conversationId;
  if (typeof record.invalidatedReason === 'string' && record.invalidatedReason) {
    // Sticky invalidation: the record still exists, which is exactly why "无绑定"
    // was the wrong word for it. It says what the binding *was* and what broke.
    return status + ' / ' + record.invalidatedReason + ' / ' + where +
      '（需人工重新绑定）';
  }
  const reason = health && typeof health.reason === 'string' ? health.reason : null;
  return status + (reason ? ' / ' + reason : '') + ' / ' + where;
}

// T059: does the standing grant still describe the binding it was armed against?
//
// The grant is a snapshot (`autosend.arm` copies revision/conversationId/
// documentInstanceId at `autosend.js:209-211`), and `decide()` refuses when the
// snapshot no longer matches the live record: `binding_changed` (revision),
// `conversation_changed`, `document_instance_changed`. Both of those codes are in
// `PRE_WRITE_BLOCKED`, so a mismatch is not a wait -- `settle` disarms the trigger
// and a human has to re-arm.
//
// Nothing in this panel used to compare them, so the one sequence the operator is
// told to perform (bind, then arm, or re-bind after a refresh) could leave every row
// green while the next notice was already doomed. This row is that comparison.
//
// Rules, all read-only:
//   * no grant, or no binding record -> no row at all. The existing
//     `t058_authorized` / `binding_healthy` rows already say which side is missing;
//     inventing a second verdict here would double-report one fact.
//   * the three comparisons are made exactly as `decide()` makes them, in its order,
//     so this row can never disagree with the gate it is predicting:
//       autosend.js:277  binding.revision !== s.bindingRevision     -> binding_changed
//       autosend.js:280  binding.conversationId !== s.conversationId -> conversation_changed
//       autosend.js:296  probe doc !== (grant doc || binding doc)   -> document_instance_changed
//     An unreadable value is therefore NOT special-cased into a pass: a corrupt or
//     missing revision compares unequal to a real one and is reported as the refusal
//     `decide()` would produce. That is stronger than `unknown`, and it is what the
//     send path actually does.
//   * an older release may have armed without a document id (`autosend.js:211`
//     stores `null`); `decide()` then falls back to the binding's own value, so
//     there is nothing to disagree about and that comparison is skipped.
function addBindingGrantMatch(add, health, grant) {
  const record = health && health.binding && typeof health.binding === 'object'
    ? health.binding : null;
  if (!record || !grant) return;
  const id = 'grant_binding_match';
  const where = 'tab=' + record.tabId + ' window=' + record.windowId;
  const grantRevision = grant.bindingRevision;
  const bindingRevision = record.revision;
  if (bindingRevision !== grantRevision) {
    // The one that actually bites: arm first, bind afterwards -- or re-bind after a
    // page refresh, which is exactly the instruction the operator is given.
    add(id, 'bad', 'binding_changed',
      '授权绑定版本 ' + JSON.stringify(grantRevision) + ' ≠ 当前绑定版本 ' +
      JSON.stringify(bindingRevision) +
      '；发送会被拒 binding_changed，请先重新授权（' + where + '）');
    return;
  }
  const grantConversation = grant.conversationId;
  const boundConversation = record.conversationId;
  if (boundConversation !== grantConversation) {
    add(id, 'bad', 'conversation_changed',
      '授权会话 ' + JSON.stringify(grantConversation) + ' ≠ 当前绑定会话 ' +
      JSON.stringify(boundConversation) +
      '；发送会被拒 conversation_changed，请先重新授权');
    return;
  }
  const grantDoc = typeof grant.documentInstanceId === 'string' && grant.documentInstanceId
    ? grant.documentInstanceId : null;
  const boundDoc = typeof record.documentInstanceId === 'string' && record.documentInstanceId
    ? record.documentInstanceId : null;
  if (grantDoc !== null && boundDoc !== grantDoc) {
    add(id, 'bad', 'document_instance_changed',
      '授权文档实例 ' + (boundDoc ? grantDoc.slice(0, 12) + '… vs ' + boundDoc.slice(0, 12) + '…'
        : '已固定但绑定记录没有文档实例 ID') +
      '；发送会被拒 document_instance_changed，请先重新授权');
    return;
  }
  add(id, 'ok', null,
    'revision=' + String(bindingRevision) + ' / conversation=' + String(boundConversation) +
    ' / document=' + (grantDoc === null ? '未固定（按绑定记录判定）'
      : grantDoc.slice(0, 12) + '…') + ' / ' + where);
}

// T069: a read-only checklist for the first real send.
//
// It answers "would the next completion be delivered, and if not, what is missing"
// without polling, without ACKing, without touching the page, and without writing
// any state. The only live call is the read-only `hello` -- explicitly authorized
// for this purpose because it neither reads a page nor touches the baseline or the
// delivery queue -- plus the existing read-only binding health probe.
//
// T071 correction: this used to report `host_online: true` unconditionally, which
// was not an observation at all, and it judged the send grant on `enabled` alone,
// so an expired or used-up grant still read as ready. Both were false greens in the
// one diagnostic an operator consults before trusting a send. Every item now
// carries `state` of `ok' / 'bad' / 'unknown'` built from the same layer functions
// the chain summary uses, and `unknown` is never counted as ready.
async function readCanaryReadiness(now = Date.now(), options = {}) {
  const stored = await chrome.storage.local.get({
    terminalTrigger: null, autosend: null, terminalCandidates: [],
    terminalSourceBaseline: null, t053TargetBindingState: null,
  });
  // T078: report the schema on a *copy*, so the panel can show what a legacy
  // record would need even before the next alarm tick repairs it. Nothing here is
  // written back -- a diagnostic must not change the thing it is measuring.
  const storedTrigger = stored.terminalTrigger;
  const trigger = storedTrigger === null || storedTrigger === undefined
    ? null : terminalTrigger.normalizeTriggerState(storedTrigger, now).state;
  const grant = stored.autosend;
  const candidates = Array.isArray(stored.terminalCandidates)
    ? stored.terminalCandidates : [];
  const preArmKeys = new Set(trigger && Array.isArray(trigger.preArmCandidateKeys)
    ? trigger.preArmCandidateKeys : []);
  const keyOf = (item) => terminalTrigger.key(item.runId, item.status);
  const freshCount = candidates.filter((item) => !preArmKeys.has(keyOf(item))).length;
  const baseline = stored.terminalSourceBaseline;
  let alarm = null;
  try {
    const found = await chrome.alarms.get(TERMINAL_ALARM);
    alarm = found && Number.isFinite(found.periodInMinutes)
      ? found.periodInMinutes : null;
  } catch (_err) { alarm = null; }

  const items = [];
  // `ok` stays for the callers that only ask "is anything in the way"; `state`
  // is the honest three-way answer. An unknown item is NOT ok.
  const add = (id, state, code, detail) => items.push({
    id, state, ok: state === 'ok', unknown: state === 'unknown', code, detail,
  });
  const fromLayer = (id, entry, fallbackCode, detail) => {
    if (!entry || entry.known !== true) {
      add(id, 'unknown', (entry && entry.reason) || fallbackCode, detail);
    } else {
      // The layers put their own code on the entry (e.g. `host_unreachable`), so
      // prefer it over the generic fallback.
      add(id, entry.value === true ? 'ok' : 'bad', entry.value === true
        ? null : (entry.code || fallbackCode), detail);
    }
  };

  // Two injected seams, same style as the trigger tick's `sendOnce`/`now`: the
  // probes stay real by default, and a test can answer them without a host, a tab
  // or a page. Neither seam can write anything -- they only stand in for reads.
  const callHost = typeof options.request === 'function' ? options.request : request;
  const callHealth = typeof options.bindingHealth === 'function'
    ? options.bindingHealth : () => targetBinding.health();

  // Layer 1: did the host actually answer? `hello` is read-only; it does not read
  // a page, does not poll and does not acknowledge. Asking is the only way to get
  // an `ok` here, so when probing is skipped the answer is `unknown`, not `true`.
  let hello = null;
  if (options.probeHost === false) {
    hello = null;                    // deliberately not asked -> hostLayer: unknown
  } else {
    try {
      hello = await callHost('hello');
    } catch (err) {
      hello = { ok: false, code: 'host_unreachable',
        error: err && err.message ? err.message : String(err) };
    }
  }
  const hostFacts = hostLayer(hello, null);
  fromLayer('host_online', hostFacts.hostOnline,
    options.probeHost === false ? 'host_not_probed' : 'host_unreachable',
    hello && hello.ok !== false && hello.capabilities
      ? 'hello ok; capabilities=' + Object.keys(hello.capabilities).sort().join(',')
      : (options.probeHost === false
        ? '本次未探测（未发起 Host 调用）'
        : 'hello 未成功: ' + JSON.stringify(hello && hello.code || null)));

  // T066/T067: two timestamps plus the source's own newest run, because "the chain
  // is green" and "the source has not recorded anything for 90 minutes" used to
  // look identical here. `establishedAt` is written once; `lastSample` moves every
  // poll; the source line names the newest terminal run the ledger knows and its age.
  const sourceAgeMin = baseline && Number.isSafeInteger(baseline.ledgerMtime)
    ? Math.max(0, Math.round((now - baseline.ledgerMtime * 1000) / 60000)) : null;
  const newestLabel = baseline && typeof baseline.newestRunId === 'string'
    ? baseline.newestRunId.slice(0, 8) : 'none';
  // T067: the channel split is a separate layer, and it is shown as its own fact
  // rather than folded into the baseline line. A live read makes Bridge-dispatched
  // runs automatic; a cache makes only the ids it already knew automatic; no read
  // at all makes every run manual. All three are legitimate states -- silently
  // reporting them as "ok" is not.
  //
  // Three states, not two, because "never sampled since the upgrade" and "sampled
  // and the bridge database was unreadable" are different facts and only the second
  // one is a problem. The key's *presence* is the discriminator: an older marker has
  // no `originSource` at all, while a failed classification writes an explicit null.
  const hasOriginKey = Boolean(baseline)
    && Object.prototype.hasOwnProperty.call(baseline, 'originSource');
  const originMissing = baseline && baseline.originSource === null
    || baseline && baseline.originSource === undefined;
  const originDetail = !hasOriginKey
    ? '尚未采样：升级后的第一次采样才会判定（届时自动生效）'
    : (originMissing
      ? '来源未知（bridge 库读不到）→ 全部按直发处理，需逐条选择'
      : (baseline.originSource === 'bridge-sqlite'
        ? '实时读取 bridge 派发绑定'
        : (baseline.originSource === 'bridge-cache'
          ? '使用缓存，新 run 需逐条选择'
          : String(baseline.originSource)))
        + (Number.isSafeInteger(baseline.originBridgeIds)
          ? '（' + baseline.originBridgeIds + ' 条绑定）' : ''));
  add('baseline_established', baseline && baseline.established === true
    ? 'ok' : 'bad',
    baseline && baseline.established === true ? null : 'baseline_not_established',
    baseline
      ? ('establishedAt=' + (baseline.establishedAt || 'unknown')
        + ' lastSample=' + (baseline.at || 'unknown')
        + ' source=newest ' + newestLabel
        + (sourceAgeMin === null ? '' : ' (' + sourceAgeMin + ' min old)'))
      : 'no marker');
  add('run_origin', !hasOriginKey ? 'ok' : (originMissing ? 'unknown' : 'ok'),
    !hasOriginKey ? null : (originMissing ? 'origin_source_unavailable' : null),
    originDetail);

  // Layer 2/3: the trigger switch and the standing authorization, both judged by
  // the shared layers so an expired or exhausted grant cannot read as active.
  // An *absent* state is knowable (nothing is armed, nothing is authorized) and is
  // reported as bad; only a state that exists but cannot be interpreted is
  // unknown. Conflating the two made "never configured" look like "cannot tell".
  const triggerFacts = triggerLayer(trigger, now);
  if (!trigger) {
    add('t059_enabled', 'bad', 'trigger_disabled', '未启用');
  } else {
    fromLayer('t059_enabled', triggerFacts.trigger, 'trigger_disabled',
      'interval=' + trigger.minIntervalMs + 'ms max=' + trigger.maxPerHour);
  }
  add('t059_alarm_scheduled', alarm !== null ? 'ok' : 'bad',
    alarm === null ? 'alarm_missing' : null,
    alarm === null ? '无定时器' : ('periodInMinutes=' + alarm));

  const authFacts = authorizationLayer(grant, now);
  const authDetail = grant
    ? ('sent=' + grant.sentCount + '/' + grant.maxSends
      + ' expiresAt=' + (Number.isFinite(grant.expiresAt) ? grant.expiresAt : 'none'))
    : '未授权';
  if (!grant) {
    add('t058_authorized', 'bad', 'authorization_inactive', '未授权');
  } else {
    fromLayer('t058_authorized', authFacts.authorized, 'authorization_inactive',
      authDetail);
  }
  // The specific reason an otherwise-enabled grant is unusable, spelled out rather
  // than folded into the generic code above. The shared layer flattens these onto
  // the entry itself (`known()` spreads them), so there is no `.detail` to read.
  const grantInfo = authFacts.authorized && authFacts.authorized.known === true
    ? authFacts.authorized : {};
  if (grant && grant.enabled === true && grantInfo.expired === true) {
    add('t058_grant_usable', 'bad', 'authorization_expired',
      'expiresAt 已过: ' + authDetail);
  } else if (grant && grant.enabled === true && grantInfo.exhausted === true) {
    add('t058_grant_usable', 'bad', 'authorization_exhausted',
      '配额已用完: ' + authDetail);
  } else if (grant && grant.enabled === true) {
    add('t058_grant_usable', 'ok', null,
      '剩余 ' + String(grantInfo.remainingSends) + ' 条');
  } else {
    add('t058_grant_usable', 'bad', 'authorization_inactive', authDetail);
  }

  const doubtful = Boolean(trigger && typeof trigger.lastError === 'string'
    && (trigger.lastError.startsWith('stopped:')
      || trigger.lastError.startsWith('blocked:')));
  add('no_doubtful_attempt', doubtful ? 'bad' : 'ok',
    trigger && typeof trigger.lastError === 'string' ? trigger.lastError : null,
    trigger && trigger.lastError ? trigger.lastError : 'clean');
  // T076: a deferral is a legitimate waiting state, not a failure and not a ready
  // signal either. `unknown` is exactly the honest answer: nothing is wrong, but
  // nothing can be sent right now.
  const deferredCount = trigger && trigger.deferred
    && typeof trigger.deferred === 'object'
    ? Object.keys(trigger.deferred).length : 0;
  if (deferredCount > 0) {
    const first = Object.values(trigger.deferred)
      .sort((a, b) => (a.retryAt || 0) - (b.retryAt || 0))[0];
    add('no_pending_deferral', 'unknown', 'deferred_waiting',
      deferredCount + ' 条写前被拒、等待重检（' + String(first && first.reason)
      + '），最近重检 ' + (Number.isFinite(first && first.retryAt)
        ? new Date(first.retryAt).toISOString() : 'unknown'));
  } else {
    add('no_pending_deferral', 'ok', null, '无等待中的延后');
  }
  // T078: report the read-only result of the schema repair. Filled fields are a
  // note, not a problem; a quarantine means this trigger will refuse to send until
  // a human re-arms it, so it must block by name.
  const suspectFields = trigger && Array.isArray(trigger.schemaSuspect)
    ? trigger.schemaSuspect.filter((f) => typeof f === 'string') : [];
  const filledFields = trigger && Array.isArray(trigger.schemaFilled)
    ? trigger.schemaFilled.filter((f) => typeof f === 'string') : [];
  if (suspectFields.length > 0) {
    add('trigger_schema', 'bad', 'trigger_schema_suspect',
      '状态中有无法信任的字段：' + suspectFields.join(', ')
      + '；已停止发送，需人工重新启用');
  } else if (filledFields.length > 0) {
    add('trigger_schema', 'ok', null,
      '兼容已补全：' + filledFields.join(', ') + '（历史记录未改动）');
  } else {
    add('trigger_schema', 'ok', null, '字段完整，无需兼容补全');
  }
  // T086: the arming boundary. Shown so "why was that old completion not sent" has
  // an answer in the panel instead of being an invisible rule.
  //
  // T091: which proof is in force matters, so it is named. A record with a snapshot
  // round delivers tasks that were still running at the arm however old they are; a
  // record without one (armed by the previous release) still refuses them. Those two
  // states look identical from the send history, so the panel has to tell them apart.
  const armBoundary = trigger && Number.isFinite(trigger.armedAt) ? trigger.armedAt : null;
  const blockedCount = trigger && Array.isArray(trigger.preArmCandidateKeys)
    ? trigger.preArmCandidateKeys.length : 0;
  const armEpoch = trigger && typeof trigger.armEpoch === 'string' && trigger.armEpoch
    ? trigger.armEpoch : null;
  if (armBoundary === null) {
    add('arm_boundary', 'unknown', 'arm_boundary_missing',
      '没有记录启用时刻；在重新启用前不会发送任何候选');
  } else if (armEpoch === null) {
    add('arm_boundary', 'unknown', 'arm_snapshot_missing',
      '启用时刻 ' + new Date(armBoundary).toISOString()
      + '；本轮没有 Host 快照，只按创建时间判定，启用前创建的旧任务会被拒绝。'
      + '重新启用可升级到快照判定；写前历史 ' + blockedCount + ' 条');
  } else {
    add('arm_boundary', 'ok', null,
      '启用时刻 ' + new Date(armBoundary).toISOString()
      + '；Host 快照 ' + (Number.isSafeInteger(trigger.armSnapshotCount)
        ? trigger.armSnapshotCount : '?') + ' 条（轮次 ' + armEpoch.slice(0, 8)
      + '）；启用后完成的任务一律发送，含启用前创建的长任务；写前历史 '
      + blockedCount + ' 条');
  }
  // T079: which of the three facts the last stop actually is. Informational only --
  // it never blocks on its own, because the stop that produced it is already
  // reported above; but "the page was never written" and "the notice is sitting in
  // the composer" must not read the same in the panel.
  const lastReason = trigger && typeof trigger.lastError === 'string'
    ? trigger.lastError : null;
  const outcomeClass = classifySendReason(lastReason);
  const CLASS_TEXT = {
    never_written: '页面未被写入：草稿、绑定、额度都未改变（写前拒绝）',
    written_not_clicked: '已写入 composer 但未点击：草稿可能残留，需人工确认后再启用',
    clicked_unknown: '已点击但回执不确定：这一条算不出送达，也不会重试',
  };
  if (outcomeClass) {
    add('last_send_class', 'ok', 'last_send_' + outcomeClass,
      CLASS_TEXT[outcomeClass] + '（原因：' + String(lastReason) + '）');
  } else {
    add('last_send_class', 'ok', null,
      lastReason ? '无法归类的原因：' + lastReason : '尚无发送尝试');
  }
  add('fresh_candidate_pending', 'ok', null,
    '新候选 ' + freshCount + ' 条 / 历史（不会发送）' + (candidates.length - freshCount) + ' 条');

  // Binding health is the other live read, and it stays read-only.
  let binding = null;
  try {
    binding = await callHealth();
  } catch (err) {
    binding = { ok: false, status: 'binding_health_failed' };
  }
  const bindingFacts = bindingLayer(binding);
  fromLayer('binding_healthy', bindingFacts.binding,
    (binding && binding.status) || 'binding_unavailable',
    describeBindingHealth(binding));
  // T059: `t058_authorized` asks whether the grant is *active*; `binding_healthy`
  // asks whether the bound page is still that document. Neither compares the two
  // records, and `decide()` compares three things on every send
  // (`autosend.js:274-298`): revision, conversationId and documentInstanceId. So
  // "bind again after arming" -- the exact sequence the operator was told to follow
  // before a canary -- produced a panel with every row ok while the next notice was
  // already certain to be refused `binding_changed`, and `settle` would then disarm
  // the trigger. This row is the missing comparison. It only reads: no rebind, no
  // re-arm, no state written.
  addBindingGrantMatch(add, binding, grant);

  const bad = items.filter((item) => item.state === 'bad');
  const unsure = items.filter((item) => item.state === 'unknown');
  const codes = (list) => [...new Set(list.map((item) => item.code || item.id))];
  return {
    ok: bad.length === 0 && unsure.length === 0,
    at: now,
    blockedBy: codes(bad),
    // Kept separate on purpose: "not asked" is not a failure, and it is not
    // permission either.
    unknownBy: codes(unsure),
    items,
    // This diagnostic observes *readiness*, never delivery. Nothing here can
    // prove a page write happened, so it must never be read as "canary passed".
    realWriteConfirmed: false,
    note: '只读诊断：不轮询、不 ACK、不写页面、不激活标签、不改绑定。'
      + '全部为 ok 也只表示"具备尝试条件"，真实写入仍未经确认。',
  };
}

// T074: staged evidence for one completion, read straight out of stored state.
//
// Read-only in the strict sense: no `terminal-list` (that would move the delivery
// cursor), no `terminal-ack`, no page, no tab, no `hello` even -- every fact here
// is already on disk, so asking the host would only add a way for this diagnostic
// to change something.
//
// `downstream` is pinned to null on purpose. Nothing in this extension can see
// whether ChatGPT acted on the notice, so the sixth stage stays `unknown` and the
// report can never claim the loop closed.
async function readChainEvidence(runId, options = {}) {
  const stored = await chrome.storage.local.get({
    terminalCandidates: [], terminalTrigger: null, autosend: null,
    terminalChainStatus: null, terminalSourceBaseline: null,
    terminalSelfCheckStatus: null,
  });
  const report = describeChainEvidence({
    runId: typeof runId === 'string' && runId ? runId : undefined,
    terminalChainStatus: stored.terminalChainStatus,
    terminalSourceBaseline: stored.terminalSourceBaseline,
    candidates: stored.terminalCandidates,
    triggerState: stored.terminalTrigger,
    autoSendState: stored.autosend,
    // An injectable seam, for the same reason as the other seams: a test can prove
    // how an independent observation *would* read without one existing. Production
    // never passes anything, so this stays absent.
    downstream: options.downstream || null,
  }, { now: typeof options.now === 'number' ? options.now : undefined });
  report.headline = describeEvidenceLine(report);
  report.selfCheck = stored.terminalSelfCheckStatus || null;
  report.note = report.note + ' 只读：不轮询、不 ACK、不写页面、不激活标签。';
  return report;
}

export {
  pollOnce,
  request,
  storeEvents,
  inspectTabs,
  probeChatGPTTabs,
  queueDelivery,
  runTerminalTrigger,
  refreshTerminalCandidates,
  runTerminalOnAlarm,
  syncTerminalAlarm,
  readChainSelfCheck,
  readCanaryReadiness,
  readChainEvidence,
  readDirectOptInState,
  armDirectCandidate,
  // T068: the running-task surfaces. Exported for the same reason as the rest of this
  // list -- the end-to-end suites drive the real functions rather than a copy of them.
  readRunningState,
  armRunningOptIn,
  revokeRunningOptIn,
};
