// T174: the worker's own write path records what the adapter returned -- without changing what it returns.
//
// Driven through `createChromeAutoSend` with a fake `chrome` whose `tabs.sendMessage` answers exactly like
// the content script does. Nothing is stubbed inside the module under test.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'extension', 'lib');
const WIRE = await import(pathToFileURL(path.join(LIB, 'autosend_chrome_wiring.js')).href
  + '?r=t174' + Math.random().toString(36).slice(2));
const STORE = await import(pathToFileURL(path.join(LIB, 'diagnostic_store.js')).href
  + '?r=t174b' + Math.random().toString(36).slice(2));

const NOTICE = 'DSH task t-174 completed. See the panel for details.';
const CONV = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

function fakeChrome(replyFactory) {
  const data = {};
  const sent = [];
  return {
    data, sent,
    chrome: {
      storage: {
        local: {
          get(defaults, cb) {
            const out = {};
            for (const [k, fallback] of Object.entries(defaults || {})) {
              out[k] = Object.prototype.hasOwnProperty.call(data, k) ? data[k] : fallback;
            }
            const p = Promise.resolve(out);
            if (cb) { p.then(cb); return undefined; }
            return p;
          },
          set(patch, cb) {
            Object.assign(data, patch);
            const p = Promise.resolve();
            if (cb) { p.then(cb); return undefined; }
            return p;
          },
        },
      },
      tabs: {
        sendMessage(tabId, message) {
          sent.push({ tabId, message });
          return Promise.resolve(replyFactory(message));
        },
      },
    },
  };
}

const okReply = (result) => ({ ok: true, result });
const adapterResult = (over = {}) => ({
  status: 'unconfirmed', reason: 'send_button_not_ready',
  composerTouched: true, composerWritten: true, clickPerformed: false,
  evidence: { observedAt: 1793900000000, deliveryMode: 'foreground', readyWaitedMs: 1500,
    visibilityState: 'hidden', conversationId: CONV, expectedConversationId: CONV, text: NOTICE },
  ...over,
});

test('T174: the store module resolves from the shipped lib directory', async () => {
  const readout = await STORE.readLatest({ get: (d, cb) => cb({}) });
  assert.equal(readout.present, false);
  assert.equal(readout.code, 'no_diagnostic_recorded');
});

test('T174: a refused write is recorded, and the refusal shape is unchanged', async () => {
  const env = fakeChrome(() => ({ ok: false, error: 'content_script_gone' }));
  const controller = WIRE.createChromeAutoSend(env.chrome, {
    probeSpecificTab: async () => ({ ok: true }),
    getBindingState: async () => ({ tabId: 7, conversationId: CONV, documentInstanceId: 'doc-1' }),
    now: () => 1000,
  });
  const write = controller.__writeForTest;
  // The controller keeps `write` private on purpose; drive it through the same fake chrome it was built
  // with, by asking the public surface for a send and inspecting what actually went over the wire.
  assert.equal(typeof controller.write, 'function', 'the wiring must expose its write for the host to call');
  const out = await controller.write({ runId: 'run-1', status: 'completed' },
    { tabId: 7, conversationId: CONV, documentInstanceId: 'doc-1' }, 'foreground');
  assert.deepEqual(out, { status: 'unconfirmed', reason: 'content_refused:content_script_gone' });
  assert.equal(env.sent.length, 1, 'exactly one message goes to the tab');
  await new Promise((r) => setTimeout(r, 10));
  const record = env.data.lastDeliveryDiagnostic;
  assert.ok(record, 'the refusal must leave a record behind');
  assert.equal(record.delivered, false);
  assert.equal(record.classification, 'unknown');
});

test('T174: a written-not-clicked outcome is stored redacted and reported as not delivered', async () => {
  const env = fakeChrome(() => okReply(adapterResult()));
  const controller = WIRE.createChromeAutoSend(env.chrome, {
    probeSpecificTab: async () => ({ ok: true }),
    getBindingState: async () => ({ tabId: 7, conversationId: CONV, documentInstanceId: 'doc-1' }),
    now: () => 1000,
  });
  const out = await controller.write({ runId: 'run-2', status: 'completed' },
    { tabId: 7, conversationId: CONV, documentInstanceId: 'doc-1' }, 'foreground');
  assert.equal(out.status, 'unconfirmed');
  assert.equal(out.clickPerformed, false);
  assert.equal(env.sent.length, 1, 'one send, not two');
  await new Promise((r) => setTimeout(r, 10));
  const record = env.data.lastDeliveryDiagnostic;
  assert.equal(record.classification, 'written_not_clicked');
  assert.equal(record.delivered, false);
  assert.equal(record.fields.reason, 'send_button_not_ready');
  assert.equal(record.fields.clickPerformed, false);
  const serialised = JSON.stringify(record);
  assert.equal(serialised.includes(NOTICE), false, 'the notice text must not be stored');
});

test('T174: a submitted notice is still not "delivered" without an acknowledgement', async () => {
  const env = fakeChrome(() => okReply(adapterResult({ status: 'submitted', reason: null,
    clickPerformed: true,
    evidence: { observedAt: 1793900001000, composerEmpty: true, exactTemplateMatched: true,
      appeared: 1, waitedMs: 80, visibilityState: 'visible', hasFocus: true } })));
  const controller = WIRE.createChromeAutoSend(env.chrome, {
    probeSpecificTab: async () => ({ ok: true }),
    getBindingState: async () => ({ tabId: 7, conversationId: CONV, documentInstanceId: 'doc-1' }),
    now: () => 1000,
  });
  await controller.write({ runId: 'run-3', status: 'completed' },
    { tabId: 7, conversationId: CONV, documentInstanceId: 'doc-1' }, 'foreground');
  await new Promise((r) => setTimeout(r, 10));
  const record = env.data.lastDeliveryDiagnostic;
  assert.equal(record.classification, 'submitted');
  assert.equal(record.delivered, false, 'submitted is not consumption, and not an ack');
  assert.match(record.deliveredWhy, /not delivered/);
});

test('T174: a diagnostics failure cannot break the send result or the response shape', async () => {
  const env = fakeChrome(() => okReply(adapterResult()));
  // A storage that throws on write: the notice path must still return the adapter result untouched.
  env.chrome.storage.local.set = () => { throw new Error('quota'); };
  const controller = WIRE.createChromeAutoSend(env.chrome, {
    probeSpecificTab: async () => ({ ok: true }),
    getBindingState: async () => ({ tabId: 7, conversationId: CONV, documentInstanceId: 'doc-1' }),
    now: () => 1000,
  });
  const out = await controller.write({ runId: 'run-4', status: 'completed' },
    { tabId: 7, conversationId: CONV, documentInstanceId: 'doc-1' }, 'foreground');
  assert.equal(out.status, 'unconfirmed');
  assert.equal(out.reason, 'send_button_not_ready');
});
