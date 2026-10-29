// T059: integration tests against a mock Chrome API.
//
// These drive the *real* wiring module (`autosend_chrome_wiring.js`) with a fake
// `chrome`, so the code under test is the code that ships -- not a copy of it.
//
// The two properties worth having a mock for:
//   * nothing here may switch, activate or focus a tab. The fake records every
//     tabs/windows call, and the test asserts `update`/`highlight`/`create`
//     were never touched. "Occupied" can only end in a stop.
//   * the page write goes to the bound tab id and nowhere else, exactly once.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

let passed = 0;
const failures = [];
function check(ok, label) {
  if (ok) { passed += 1; return; }
  failures.push(label);
  console.log('  FAILED: ' + label);
}

const dir = mkdtempSync(join(tmpdir(), 't059-chrome-'));
const files = ['autosend', 'autosend_controller', 'autosend_chrome_wiring'];
for (const name of files) {
  const source = readFileSync(new URL(`./extension/lib/${name}.js`, import.meta.url), 'utf8')
    .replace(/from '\.\/([a-z_]+)\.js'/g, "from './$1.mjs'");
  writeFileSync(join(dir, name + '.mjs'), source);
}
const { createChromeAutoSend } =
  await import(pathToFileURL(join(dir, 'autosend_chrome_wiring.mjs')).href);

const CONV = '22222222-2222-4222-8222-222222222222';
const RUN = '11111111-1111-4111-8111-111111111111';
const RUN2 = '33333333-3333-4333-8333-333333333333';
const URL_OK = 'https://chatgpt.com/c/' + CONV;
const DOC = 'doc-instance-0001';

function makeChrome(options = {}) {
  const opts = Object.assign({
    tabUrl: URL_OK, active: true, composerPresent: true, composerEmpty: true,
    sendReply: { ok: true, result: { status: 'submitted', reason: null,
      evidence: { composerEmpty: true, conversationId: CONV } } },
    navigateDuringProbe: false,
  }, options);
  const calls = [];
  const store = { local: {}, session: {} };
  const tab = () => ({ id: 7, windowId: 2, url: opts.tabUrl, active: opts.active });

  const chrome = {
    tabs: {
      get: async (id) => { calls.push(['tabs.get', id]); return Object.assign(tab(), { id }); },
      sendMessage: async (id, msg) => {
        calls.push(['tabs.sendMessage', id, msg.type]);
        return opts.sendReply;
      },
      update: async () => { calls.push(['tabs.update']); throw new Error('must not activate'); },
      highlight: async () => { calls.push(['tabs.highlight']); throw new Error('must not switch'); },
    },
    windows: {
      update: async () => { calls.push(['windows.update']); throw new Error('must not focus'); },
    },
    storage: {
      local: {
        get: async (defaults) => {
          const out = {};
          for (const [k, v] of Object.entries(defaults || {})) {
            out[k] = Object.prototype.hasOwnProperty.call(store.local, k)
              ? store.local[k] : v;
          }
          return out;
        },
        set: async (patch) => { Object.assign(store.local, patch); },
      },
    },
  };

  // The real `probeSpecificTab(api, target)` takes `{tabId, windowId}`. This
  // fake mirrors that contract on purpose: an earlier wiring passed a whole tab
  // object instead, and a fake that accepted both is what let the bug through.
  const probeSpecificTab = async (api, target) => {
    if (!Number.isSafeInteger(target && target.tabId)) {
      throw new Error('probe target must carry tabId: ' + JSON.stringify(target));
    }
    calls.push(['probe', target.tabId]);
    if (opts.navigateDuringProbe) {
      // The tab moved while we were measuring it.
      api.tabs.get = async (id) => Object.assign(tab(), { id, url: URL_OK + '?moved=1' });
    }
    return {
      status: 'background_observable',
      tabId: target.tabId, windowId: target.windowId, url: URL_OK,
      conversationId: CONV, documentInstanceId: DOC, observedAt: 5000,
      visibilityState: 'visible', hasFocus: true,
      composerPresent: opts.composerPresent, composerEmpty: opts.composerEmpty,
    };
  };

  const binding = {
    version: 1, revision: 3, boundAt: 1, tabId: 7, windowId: 2, url: URL_OK,
    conversationId: CONV, documentInstanceId: DOC, accountIdentity: 'unverified',
    accountVerified: false, manuallyConfirmed: true, invalidatedReason: null,
  };

  return { chrome, store, calls, probeSpecificTab, binding,
    getBindingState: async () => ({ ok: true, binding: opts.noBinding ? null : binding }) };
}

const now = () => 5000;

function build(options) {
  const env = makeChrome(options);
  const wiring = createChromeAutoSend(env.chrome, {
    probeSpecificTab: env.probeSpecificTab,
    getBindingState: env.getBindingState,
    now,
  });
  return { env, wiring };
}

console.log('== chrome wiring: one send, to the bound tab, with nothing activated ==');
{
  const { env, wiring } = build();
  const armed = await wiring.controller.armWith({}, 'AUTOSEND ' + CONV, true);
  check(armed.ok === true, 'arm succeeds through the real wiring');

  const result = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
  check(result.sent === true, 'the send succeeds (' + result.code + ')');

  const sends = env.calls.filter((c) => c[0] === 'tabs.sendMessage');
  check(sends.length === 1, 'exactly one message to the page (' + sends.length + ')');
  check(sends[0][1] === 7, 'addressed to the bound tab id (' + sends[0][1] + ')');
  check(sends[0][2] === 't058-write-notice', 'and it is the notice message');

  const forbidden = env.calls.filter((c) =>
    ['tabs.update', 'tabs.highlight', 'windows.update'].includes(c[0]));
  check(forbidden.length === 0,
        'no activation, focus or switch was attempted (' + JSON.stringify(forbidden) + ')');

  // Contract lock: a tab object here silently produced `tab_unavailable` on
  // every real probe, so the shape is asserted rather than assumed.
  check(env.calls.some((c) => c[0] === 'probe' && c[1] === 7),
        'the probe was called with the bound tab id');
}

console.log('== chrome wiring: an occupied session stops instead of switching away ==');
{
  const { env, wiring } = build({ composerEmpty: false });
  await wiring.controller.armWith({}, 'AUTOSEND ' + CONV, true);
  const result = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
  check(result.sent === false, 'a session with a draft in the box is not sent');
  check(result.code === 'session_occupied', 'and the reason is session_occupied (' +
        result.code + ')');
  check(env.calls.filter((c) => c[0] === 'tabs.sendMessage').length === 0,
        'nothing was written to the page');
  check(env.calls.filter((c) => c[0] === 'tabs.update').length === 0,
        'and no tab switch was attempted');
}

console.log('== chrome wiring: a tab that moves during the probe is refused ==');
{
  const { env, wiring } = build({ navigateDuringProbe: true });
  await wiring.controller.armWith({}, 'AUTOSEND ' + CONV, true);
  const result = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
  check(result.sent === false && result.code === 'probe_unavailable',
        'a URL that changed mid-probe yields no probe (' + result.code + ')');
  check(env.calls.filter((c) => c[0] === 'tabs.sendMessage').length === 0,
        'and nothing was written to a tab that had moved');
}

console.log('== chrome wiring: a refused page write disarms everything ==');
{
  const { env, wiring } = build({ sendReply: { ok: false, error: 'no_receiver' } });
  await wiring.controller.armWith({}, 'AUTOSEND ' + CONV, true);
  const result = await wiring.controller.sendOnce({ runId: RUN, status: 'completed' });
  check(result.sent === false && result.code === 'ambiguous',
        'a content-side refusal is ambiguous (' + result.code + ')');
  check(env.store.local.autosend.enabled === false, 'and the authorization is disarmed');
  const again = await wiring.controller.sendOnce({ runId: RUN2, status: 'completed' });
  check(again.code === 'autosend_disabled', 'nothing further is attempted (' +
        again.code + ')');
}

console.log('== chrome wiring: candidates are drained only after an attempt ==');
{
  const { env, wiring } = build();
  await env.chrome.storage.local.set({
    terminalCandidates: [
      { runId: RUN, status: 'completed' },
      { runId: RUN2, status: 'failed' },
    ],
  });
  const before = await wiring.readCandidates();
  check(before.length === 2, 'two candidates are queued');
  const kept = await wiring.consumeCandidate((item) => item.runId === RUN);
  check(kept.length === 1 && kept[0].runId === RUN2,
        'draining removes exactly the attempted one');
  check((await wiring.readCandidates())[0].runId === RUN2,
        'and the store reflects that');
  check(await wiring.readCandidates().then((l) => l.length) === 1,
        'the untouched candidate is preserved');
}

console.log('== chrome wiring: the read-only notification store is never a source ==');
{
  const source = readFileSync(
    new URL('./extension/lib/autosend_chrome_wiring.js', import.meta.url), 'utf8');
  check(!source.includes('received'),
        'the wiring never reads the read-only received store');
  check(!source.includes('deliverable'),
        'and never treats an event flag as permission to send');
  check(!/tabs\.update|tabs\.highlight|windows\.update/.test(
    source.replace(/\/\/.*$/gm, '')),
        'and has no activation surface outside comments (comment-stripped check)');
}

console.log('== popup: the one-time authorization surface actually exists ==');
{
  const html = readFileSync(
    new URL('./extension/popup.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('./extension/popup.js', import.meta.url), 'utf8');
  for (const id of ['notifyAuthState', 'notifyAuthArm', 'notifyAuthDisarm',
    'notifyAuthConfirmation', 'terminalTriggerState', 'terminalTriggerArm',
    'terminalTriggerDisarm', 'terminalTriggerConfirmation']) {
    check(html.includes('id="' + id + '"'), 'popup.html declares id ' + id);
  }
  for (const type of ['t058-state', 't058-arm', 't058-disarm',
    't059-trigger-state', 't059-trigger-arm', 't059-trigger-disable']) {
    check(js.includes("'" + type + "'"), 'popup.js asks for ' + type);
  }
  check(js.includes('userGesture: true'),
        'the arm calls carry an explicit user gesture');
  check(!/AUTOSEND [0-9a-f-]{36}/.test(js),
        'the phrase is never hard-coded; it comes from the live binding');
}

console.log('\nRESULT: ' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
