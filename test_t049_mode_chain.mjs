// T049 acceptance: does the *authorised* background mode actually travel the
// production path, or only the unit-test path?
//
// Everything below runs the shipped worker: `extension/background.js` is imported
// against a fake `chrome`, its own `t058-arm` / `t058-send` handlers are dispatched
// through its own `onMessage` listener, and the message it emits is handed to the
// real `send_adapter.deliverInto` against a fake page. No seam is injected into the
// controller, so the grant -> decide -> wiring -> content -> adapter chain is the
// one a reloaded extension would run.
import { readFileSync } from 'node:fs';
import {
  A, NOTICE, CONV, RUN, URL_OK, DOC, FG_PHRASE, BG_PHRASE,
  createPage, deps, drive,
} from './test_t048_fakes.mjs';

let passed = 0;
const failures = [];
function check(ok, label) {
  if (ok) { passed += 1; console.log('  PASS  ' + label); return; }
  failures.push(label);
  console.log('  FAIL  ' + label);
}

const REV = 8;
const BINDING = {
  version: 1, tabId: 7, windowId: 2, url: URL_OK, conversationId: CONV,
  documentInstanceId: DOC, manuallyConfirmed: true, revision: REV,
};

// ---------------------------------------------------------------------------
// A fake `chrome` that is *also* the page. `tabs.sendMessage` routes each message
// the way the real split does: the probe is answered from live page state, and the
// write notice is handed to the shipped adapter. Anything that would move, raise
// or open a window is absent, so a caller that tried would throw.
// ---------------------------------------------------------------------------
function createWorkerChrome(page, options = {}) {
  const local = new Map();
  const session = new Map();
  const messages = [];
  const listeners = [];
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const event = () => ({ addListener(fn) { this.fn = fn; },
    removeListener() {}, hasListener() { return false; }, fn: null });
  const area = (map) => ({
    async get(defaults) {
      const out = {};
      if (defaults && typeof defaults === 'object') {
        for (const [k, v] of Object.entries(defaults)) {
          out[k] = map.has(k) ? clone(map.get(k)) : v;
        }
      }
      return out;
    },
    async set(items) { for (const [k, v] of Object.entries(items || {})) map.set(k, clone(v)); },
    async remove(key) { map.delete(key); },
  });

  const tabs = {
    async get(id) {
      return { id, windowId: BINDING.windowId, url: URL_OK,
        active: options.active === true,
        discarded: options.discarded === true, frozen: options.frozen === true };
    },
    async sendMessage(id, msg) {
      messages.push(clone(msg));
      if (msg && msg.type === 'readonly-probe') {
        const response = {
          type: 'readonly-probe-response', requestId: msg.requestId,
          documentInstanceId: DOC, routeStable: true, observedAt: Date.now(),
          url: URL_OK, conversationId: CONV,
          visibilityState: page.doc.visibilityState,
          hasFocus: page.doc.hasFocus(),
          composerPresent: true,
          pageLoaded: true,
        };
        if (options.probe === 'discarded') return { status: 'discarded' };
        return response;
      }
      if (msg && msg.type === 't058-write-notice') {
        // Exactly what content.js does with the message: no re-implementation.
        const result = await A.deliverInto(page.doc, msg, page.clock.now, deps(page));
        return { ok: true, result };
      }
      throw new Error('unexpected message type: ' + (msg && msg.type));
    },
    // Present only so a call shows up as a failure rather than a TypeError.
    async update() { throw new Error('tabs.update must never be called'); },
    async highlight() { throw new Error('tabs.highlight must never be called'); },
    async create() { throw new Error('tabs.create must never be called'); },
    async query() { return []; },
    // background.js subscribes to these at module load; every one is a listener
    // registry, none of them is an activation surface.
    onActivated: event(), onUpdated: event(), onRemoved: event(),
    onReplaced: event(), onAttached: event(), onDetached: event(),
  };

  const api = {
    runtime: {
      id: 'test-extension',
      getURL: (p) => 'chrome-extension://test-extension/' + p,
      connectNative: () => { throw new Error('no host in this suite'); },
      onMessage: { addListener(fn) { listeners.push(fn); },
        removeListener() {}, hasListener() { return false; } },
      onInstalled: event(), onStartup: event(), onSuspend: event(),
      lastError: undefined,
    },
    storage: { local: area(local), session: area(session) },
    alarms: {
      async get() { return undefined; },
      async create() {},
      async clear() { return true; },
      onAlarm: event(),
    },
    tabs,
    // No `update`, no `create`: an activation attempt would be a TypeError.
    windows: { onFocusChanged: event() },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    permissions: { async contains() { return false; } },
  };

  return {
    api, local, session, messages,
    read: (key) => clone(local.get(key)),
    async dispatch(msg) {
      const listener = listeners[0];
      if (!listener) throw new Error('background.js registered no onMessage listener');
      let reply = null;
      const ret = listener(clone(msg), {
        id: 'test-extension',
        url: 'chrome-extension://test-extension/popup.html',
      }, (r) => { reply = r; });
      if (ret !== true) return reply;
      const started = Date.now();
      while (reply === null && Date.now() - started < 20000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return reply;
    },
  };
}

async function open(page, options) {
  const env = createWorkerChrome(page, options);
  globalThis.chrome = env.api;
  env.session.set('t053TargetBindingState', {
    version: 1, revision: REV, binding: BINDING, candidates: [],
    candidateScannedAt: null,
  });
  const bg = await import(new URL('./extension/background.js?t049='
    + Date.now() + Math.random().toString(16).slice(2), import.meta.url).href);
  env.bg = bg;
  env.send = (runId, status) =>
    env.dispatch({ type: 't058-send', runId, status });
  env.arm = (mode, phrase) => env.dispatch({ type: 't058-arm',
    confirmation: phrase, deliveryMode: mode, userGesture: true });
  env.cleanup = () => { delete globalThis.chrome; };
  return env;
}

async function main() {
  // =====================================================================
  // 1. The grant itself: background needs the other phrase, and is recorded
  // =====================================================================
  console.log('== T049: the worker refuses to widen a grant by itself ==');
  {
    const page = createPage({ focused: false, visibilityState: 'hidden' });
    const env = await open(page);
    try {
      const wrongPhrase = await env.arm('background', FG_PHRASE);
      check(wrongPhrase && wrongPhrase.result && wrongPhrase.result.ok === false,
        'the foreground phrase cannot arm background');
      check(wrongPhrase.result.code === 'arm_background_confirmation_mismatch',
        'and says why (' + wrongPhrase.result.code + ')');
      check(env.read('autosend') === undefined,
        'and nothing was stored on a refused arm');

      const armed = await env.arm('background', BG_PHRASE);
      check(armed.result.ok === true, 'the background phrase arms it');
      check(armed.result.deliveryMode === 'background',
        'the reply names the mode (' + armed.result.deliveryMode + ')');
      const stored = env.read('autosend');
      check(stored && stored.deliveryMode === 'background',
        'and the stored grant carries it (' + (stored && stored.deliveryMode) + ')');
      check(stored.bindingRevision === REV && stored.conversationId === CONV,
        'with the same binding revision and conversation as before');

      const fgWrong = await env.arm('foreground', BG_PHRASE);
      check(fgWrong.result.ok === false
        && fgWrong.result.code === 'arm_confirmation_mismatch',
        'and the background phrase cannot arm foreground either ('
        + fgWrong.result.code + ')');
    } finally { env.cleanup(); }
  }

  // =====================================================================
  // 2. A stored background grant delivers to a hidden, unfocused tab
  // =====================================================================
  console.log('== T049: the stored background grant reaches the page ==');
  {
    const page = createPage({ focused: false, visibilityState: 'hidden' });
    const env = await open(page);
    try {
      const armed = await env.arm('background', BG_PHRASE);
      check(armed.result.ok === true, 'armed background');
      check(page.doc.hasFocus() === false && page.doc.visibilityState === 'hidden',
        'the page really is hidden and unfocused while this runs');

      const reply = await drive(page, env.send(RUN, 'completed'), 20000);
      const result = reply && reply.result;
      check(result && result.sent === true,
        'the notice is sent from a background tab (' + (result && result.code) + ')');
      const writes = env.messages.filter((m) => m.type === 't058-write-notice');
      check(writes.length === 1, 'exactly one write message left the worker ('
        + writes.length + ')');
      check(writes[0].deliveryMode === 'background',
        'and it carries the mode from the grant (' + writes[0].deliveryMode + ')');
      check(writes[0].expectedConversationId === CONV,
        'along with the bound conversation id it must re-check');
      check(page.clicks.length === 1, 'the page was clicked once (' + page.clicks.length + ')');
      check(page.messages.length === 1 && page.messages[0] === NOTICE,
        'and proved by one exact-template bubble ("' + page.messages[0] + '")');
      check(page.focusCalls() === 0,
        'the background write never focused the composer (' + page.focusCalls() + ')');
      const stored = env.read('autosend');
      check(stored.sentCount === 1, 'the quota moved by one (' + stored.sentCount + ')');
      check(env.read('terminalCandidates') === undefined,
        'no candidate cache was invented by the manual send');
    } finally { env.cleanup(); }
  }

  // =====================================================================
  // 3. The same facts in foreground mode are still refused, unchanged
  // =====================================================================
  console.log('== T049: foreground behaviour is exactly what it was ==');
  {
    const page = createPage({ focused: false, visibilityState: 'hidden' });
    const env = await open(page);
    try {
      const armed = await env.dispatch({ type: 't058-arm',
        confirmation: FG_PHRASE, userGesture: true });
      check(armed.result.ok === true, 'a foreground grant arms with no mode field');
      check(armed.result.deliveryMode === 'foreground',
        'and reports foreground (' + armed.result.deliveryMode + ')');
      const reply = await drive(page, env.send(RUN, 'completed'), 8000);
      check(reply.result.sent === false, 'a background tab is not written to');
      check(reply.result.code === 'target_not_visible_and_focused',
        'for the original reason (' + reply.result.code + ')');
      check(reply.result.pageWriteAttempted === false,
        'with proof the page was not touched');
      const writes = env.messages.filter((m) => m.type === 't058-write-notice');
      check(writes.length === 0, 'and no write message was sent (' + writes.length + ')');
      check(page.text === '' && page.clicks.length === 0,
        'the composer is empty and nothing was clicked');
    } finally { env.cleanup(); }
  }

  // =====================================================================
  // 4. Re-arming foreground after background takes effect (no stale mode)
  // =====================================================================
  console.log('== T049: re-arming changes the mode, it does not accumulate ==');
  {
    const page = createPage({ focused: false, visibilityState: 'hidden' });
    const env = await open(page);
    try {
      await env.arm('background', BG_PHRASE);
      const back = await env.dispatch({ type: 't058-arm',
        confirmation: FG_PHRASE, userGesture: true });
      check(back.result.ok === true && back.result.deliveryMode === 'foreground',
        're-arming foreground succeeds (' + back.result.deliveryMode + ')');
      check(env.read('autosend').deliveryMode === 'foreground',
        'and the stored grant is foreground again');
      const reply = await drive(page, env.send(RUN, 'completed'), 8000);
      check(reply.result.sent === false
        && reply.result.code === 'target_not_visible_and_focused',
        'so the background tab is refused again (' + reply.result.code + ')');
      check(env.messages.filter((m) => m.type === 't058-write-notice').length === 0,
        'and nothing was written');
    } finally { env.cleanup(); }
  }

  // =====================================================================
  // 5. Dedup, restart and freeze survive the whole chain
  // =====================================================================
  console.log('== T049: the chain still refuses a second notice ==');
  {
    const page = createPage({ focused: false, visibilityState: 'hidden' });
    const env = await open(page);
    try {
      await env.arm('background', BG_PHRASE);
      const first = await drive(page, env.send(RUN, 'completed'), 20000);
      check(first.result.sent === true, 'the first one is sent');
      const again = await drive(page, env.send(RUN, 'completed'), 8000);
      check(again.result.sent === false && again.result.code === 'duplicate_event',
        'the second is a duplicate (' + again.result.code + ')');
      const failed = await drive(page, env.send(RUN, 'failed'), 8000);
      check(failed.result.sent === false && failed.result.code === 'duplicate_run',
        'and a different status for the same run is refused too (' + failed.result.code + ')');
      check(env.messages.filter((m) => m.type === 't058-write-notice').length === 1,
        'the page was written exactly once in total');
      check(page.clicks.length === 1 && page.messages.length === 1,
        'and clicked exactly once');
    } finally { env.cleanup(); }
  }

  // =====================================================================
  // 6. A discarded tab is refused with a cause, not written to
  // =====================================================================
  console.log('== T049: a discarded tab is reported, never written ==');
  {
    const page = createPage({ focused: false, visibilityState: 'hidden' });
    const env = await open(page, { discarded: true });
    try {
      await env.arm('background', BG_PHRASE);
      const reply = await drive(page, env.send(RUN, 'completed'), 8000);
      check(reply.result.sent === false, 'nothing is sent to a discarded tab');
      check(reply.result.pageWriteAttempted === false, 'and the page was not touched');
      check(env.messages.filter((m) => m.type === 't058-write-notice').length === 0,
        'no write message was sent');
      check(['target_background_unobservable', 'probe_unavailable']
        .includes(reply.result.code),
        'the refusal names an unobservable tab (' + reply.result.code + ')');
      console.log('  note  code=' + reply.result.code
        + ' detail=' + JSON.stringify(reply.result.detail || null));
    } finally { env.cleanup(); }
  }

  // =====================================================================
  // 7. Nothing anywhere raised, focused or opened a window
  // =====================================================================
  console.log('== T049: no window or tab was ever activated ==');
  {
    const page = createPage({ focused: false, visibilityState: 'hidden' });
    const env = await open(page);
    try {
      await env.arm('background', BG_PHRASE);
      await drive(page, env.send(RUN, 'completed'), 20000);
      check(typeof env.api.windows.update === 'undefined'
        && typeof env.api.windows.create === 'undefined',
        'the fake offers no window activation at all');
      check(typeof env.api.tabs.move === 'undefined'
        && typeof env.api.tabs.reload === 'undefined',
        'and no tab move/reload either');
      check(page.clicks.length === 1 && page.focusCalls() === 0,
        'the only page interaction was the one click');
    } finally { env.cleanup(); }
  }

  // =====================================================================
  // 8. The popup's contract with the worker, read from both sides
  // =====================================================================
  console.log('== T049: what the popup is told, and what it sends back ==');
  {
    const page = createPage({ focused: false, visibilityState: 'hidden' });
    const env = await open(page);
    try {
      const state = await env.dispatch({ type: 't058-state' });
      check(state.ok === true, 'the state request answers');
      check(state.defaults && state.defaults.deliveryModes
        && state.defaults.deliveryModes.join(',') === 'foreground,background',
        'and advertises exactly two modes ('
        + (state.defaults && state.defaults.deliveryModes) + ')');
      check(state.defaults.defaultDeliveryMode === 'foreground',
        'with foreground as the default');
      check(state.defaults.confirmationPrefix === 'AUTOSEND '
        && state.defaults.backgroundConfirmationPrefix === 'AUTOSEND-BACKGROUND ',
        'and both phrases, so the popup never restates them itself');
      check(state.result && state.result.deliveryMode === 'foreground',
        'an unarmed record still reports a mode ('
        + (state.result && state.result.deliveryMode) + ')');
    } finally { env.cleanup(); }

    const popup = readFileSync(new URL('./extension/popup.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('./extension/popup.html', import.meta.url), 'utf8');
    check(/type: 't058-arm'[\s\S]{0,200}deliveryMode/.test(popup),
      'popup.js sends the chosen mode with the arm request');
    check(popup.includes('AUTOSEND-BACKGROUND'),
      'and shows the background phrase to copy');
    check(/id="notifyAuthMode"/.test(html)
      && /<option value="foreground" selected>/.test(html),
      'popup.html defaults the selector to foreground');
    check(/投递模式：/.test(popup),
      'and the state block prints the mode before the counters');
  }

  // =====================================================================
  // 9. The automatic (terminal-trigger) path shares that same controller
  // =====================================================================
  console.log('== T049: the automatic path is the same writer, not a second one ==');
  {
    const background = readFileSync(
      new URL('./extension/background.js', import.meta.url), 'utf8');
    check(/const autoSend = chromeAutoSend\.controller;/.test(background),
      'background.js keeps exactly one controller');
    check(/options\.sendOnce\s*:\s*\(candidate\) => autoSend\.sendOnce\(candidate\)/
      .test(background),
      'the terminal trigger defaults to that controller when no seam is injected');
    check(/const chromeAutoSend = createChromeAutoSend\(chrome, \{/.test(background),
      'and the controller is the Chrome wiring, not a stub');
    // The one place a mode could be supplied out of band is `autoSend.armWith`.
    // It is called with the message's own field and nothing else.
    const armCall = /autoSend\.armWith\(\s*\{([^}]*)\}/.exec(background);
    check(Boolean(armCall) && /deliveryMode: msg\.deliveryMode/.test(armCall[1]),
      'and the only arm call takes the mode straight from the popup message');

    // Same static rule T048 applies to the libs, now over the two files that run
    // in the worker and the page.
    for (const name of ['background.js', 'content.js']) {
      const source = readFileSync(new URL('./extension/' + name, import.meta.url), 'utf8')
        .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      check(!/tabs\.(update|highlight|create|move|reload)|windows\.(update|create)/
        .test(source), name + ' has no tab/window activation call outside comments');
    }
  }

  console.log('\nRESULT: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.log('UNCAUGHT: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
