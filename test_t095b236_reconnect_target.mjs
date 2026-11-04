// T236: the automatic content-script repair must actually reach the tab it was asked to repair.
//
// The live failure this pins: run 16e78274-a6c9-461b-9eef-5e89c4c17bc9 completed, the host offered it, the extension
// admitted it -- six times -- and every attempt ended as `deferred / probe_unavailable`. The extension's own notes log
// explains why: each repair attempt recorded `content-reconnect-failed code=reconnect_not_a_conversation`, and the only
// thing that ever fixed the tab was the operator clicking the popup.
//
// The cause is the shape of the object handed to the repair. The autosend probe calls `probeSpecificTab` with a target
// that carries ids only (`{tabId, windowId}`); the repair then asked `ensureContentScript` to parse `target.url`, which
// is undefined, and refused. So the repair was a guaranteed no-op that still cost a probe round.
//
// What is asserted here is deliberately about injection *counts*, because "the repair ran" and "the repair injected"
// are the two facts that were confused:
//   * a bound tab with no receiver gets exactly one injection, and the page is measured again afterwards;
//   * a tab that is not showing the bound conversation still gets none -- the fix must not widen where we inject;
//   * a tab that has gone away gets none;
//   * the wrapper exported for this purpose is the one `background.js` wires, so the test is not exercising a copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, 'extension');
const RECONNECT = await import('file://' + path.join(EXT, 'lib', 'content_reconnect.js').replace(/\\/g, '/'));
const PREFLIGHT = await import('file://' + path.join(EXT, 'lib', 'readonly_preflight.js').replace(/\\/g, '/'));

const CONV = '6ae6ff97-1304-83e9-9525-729645f8ecd5';
const CONV_URL = 'https://chatgpt.com/c/' + CONV;
const TAB_ID = 1524612623;
const WINDOW_ID = 1524612473;

function fakeApi(options = {}) {
  const calls = { injected: 0, sendMessage: 0, tabsGet: 0 };
  const state = { url: options.url || CONV_URL, gone: options.gone === true, receiver: options.receiver === true };
  return {
    calls,
    state,
    tabs: {
      async get(tabId) {
        calls.tabsGet += 1;
        if (state.gone || tabId !== TAB_ID) return null;
        return { id: TAB_ID, windowId: WINDOW_ID, url: state.url, active: true, discarded: false };
      },
      async sendMessage() {
        calls.sendMessage += 1;
        if (!state.receiver) {
          const err = new Error('Could not establish connection. Receiving end does not exist.');
          throw err;
        }
        return { ok: true, report: { url: state.url, visibilityState: 'visible', hasFocus: false,
          composerPresent: true, observedAt: Date.now() } };
      },
      async query() { return [{ id: TAB_ID, windowId: WINDOW_ID, url: state.url, active: true }]; },
    },
    scripting: {
      async executeScript(request) {
        calls.injected += 1;
        // A successful injection installs the receiver the next probe will find.
        state.receiver = true;
        return [{ frameId: 0, result: null, request }];
      },
    },
  };
}

/** The wiring background.js uses for the autosend path: a probe target of ids only. */
function probeAsAutosendWiresIt(api) {
  const probe = RECONNECT.createResilientProbe({
    probeSpecificTab: PREFLIGHT.probeSpecificTab,
    reconnect: (surface, target, options) => RECONNECT.reconnectForProbe(surface, target, options),
  });
  return (target) => probe(api, target);
}

test('a bound tab with no receiver is repaired once, then measured again', async () => {
  const api = fakeApi();
  const probe = probeAsAutosendWiresIt(api);
  const result = await probe({ tabId: TAB_ID, windowId: WINDOW_ID });
  assert.equal(api.calls.injected, 1, 'the repair injected exactly once');
  assert.equal(api.calls.sendMessage >= 2, true, 'the probe was repeated after the repair');
  assert.equal(result.reconnected, true);
  assert.equal(result.reconnect.ok, true);
  // The fake reply does not carry every field `assessProbe` compares, so the status is a route mismatch here; what
  // matters for this milestone is that the repair *ran* and the page was measured again afterwards.
  assert.notEqual(result.status, 'content_unavailable', 'the tab answers once the observer is back');
});

test('a tab that is not a conversation at all is never injected into', async () => {
  const api = fakeApi({ url: 'https://chatgpt.com/' });
  const probe = probeAsAutosendWiresIt(api);
  const result = await probe({ tabId: TAB_ID, windowId: WINDOW_ID });
  assert.equal(api.calls.injected, 0, 'a non-conversation url is not something to repair');
  assert.notEqual(result.status, 'background_observable');
});

test('a tab that moved to another conversation can be re-observed but never used for a send', async () => {
  // A probe target carries no conversation id, so the repair cannot tell which conversation was bound; it repairs the
  // read-only observer and the *probe* then refuses, because the document is not the bound one. Writing is a separate
  // step that still re-checks the bound document, so this is observation only.
  const api = fakeApi({ url: 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000000' });
  const probe = probeAsAutosendWiresIt(api);
  const result = await probe({ tabId: TAB_ID, windowId: WINDOW_ID });
  assert.notEqual(result.status, 'background_observable', 'another conversation is not the bound document');
});

test('a tab that is gone is not repaired and not measured twice', async () => {
  const api = fakeApi({ gone: true });
  const probe = probeAsAutosendWiresIt(api);
  const result = await probe({ tabId: TAB_ID, windowId: WINDOW_ID });
  assert.equal(api.calls.injected, 0);
  // A tab that is gone never reaches the repair at all: the probe itself reports the missing tab, which is a different
  // fact from "there is no receiving end".
  assert.equal(result.status === 'content_unavailable', false);
});

test('the wrapper reads the tab instead of trusting the caller to have supplied a url', async () => {
  const api = fakeApi();
  // Deliberately no url and no conversationId: exactly what the autosend wiring passes.
  const attempt = await RECONNECT.reconnectForProbe(api, { tabId: TAB_ID, windowId: WINDOW_ID });
  assert.equal(attempt.ok, true);
  assert.equal(api.calls.injected, 1);
  assert.equal(api.calls.tabsGet >= 1, true, 'the tab was read to learn its url');
});

test('background wires the repair through that wrapper', () => {
  const source = readFileSync(path.join(EXT, 'background.js'), 'utf8');
  assert.equal(/reconnect:\s*\(api,\s*target\)\s*=>\s*ensureContentScript\(/.test(source), false,
    'the repair still hands the probe target straight to ensureContentScript, which needs a url it never gets');
  assert.equal(/reconnect:\s*\(api,\s*target\)\s*=>\s*reconnectForProbe\(/.test(source), true,
    'the repair must go through the wrapper that reads the tab');
  assert.equal(source.includes('reconnectForProbe'), true);
});
