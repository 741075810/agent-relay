// T188: per-run delivery history, driven through the real `createChromeAutoSend().write()`.
//
// Two rules this file exists to enforce on itself, both learned from T186:
//   * one fake per test -- assertions read `env.data` and `env.chrome.storage.local`, the same objects the
//     worker wrote through, never a second `fakeChrome()` created for the assertion;
//   * the completion signal is registered *before* the send: `env.nextWrite()` resolves from inside the fake
//     `set()`, so nothing sleeps, polls, or guesses how many microtasks a fire-and-forget write needs.
// The signal is a property of the fake only. The production send path is unchanged: it still does not await
// any diagnostic.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'extension', 'lib');
const WIRE = await import(pathToFileURL(path.join(LIB, 'autosend_chrome_wiring.js')).href);
const STORE = await import(pathToFileURL(path.join(LIB, 'diagnostic_store.js')).href);

const NOTICE = 'DSH task t-188 completed. See the panel for details.';
const CONV = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const RUN_A = '876f78c3-2bd6-42c0-bf6e-c8fc7723f858';
const RUN_B = 'b4c54db8-1d6a-48a6-bc71-9f63f2216f77';
const BINDING = { tabId: 7, conversationId: CONV, documentInstanceId: 'doc-1' };

/**
 * One fake, both conventions, plus a completion signal registered before the send.
 * `set` throws only when `env.failSet` is set, which is how the "storage.set throws" case is driven.
 */
function fakeEnv(replyFactory) {
  const data = {};
  const sent = [];
  const waiters = [];
  const env = { data, sent, failSet: false };
  const settle = () => {
    const pending = waiters.splice(0);
    for (const resolve of pending) resolve(true);
  };
  env.chrome = {
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
          if (env.failSet) throw new Error('storage_failure_injected');
          Object.assign(data, patch);
          const p = Promise.resolve();
          if (cb) { p.then(cb).then(settle); return undefined; }
          return p.then(() => { settle(); });
        },
      },
    },
    tabs: {
      sendMessage(tabId, message) {
        sent.push({ tabId, message });
        return Promise.resolve(replyFactory(message));
      },
    },
  };
  /** Register the completion signal *now*; the next landed write resolves it. Bounded, never polls. */
  env.nextWrite = (ms = 800) => new Promise((resolve) => {
    waiters.push(resolve);
    setTimeout(() => resolve(false), ms);
  });
  env.controller = WIRE.createChromeAutoSend(env.chrome, {
    probeSpecificTab: async () => ({ ok: true }),
    getBindingState: async () => BINDING,
    now: () => 1000,
  });
  return env;
}

const submitted = {
  status: 'submitted', reason: null, clickPerformed: true, composerWritten: true, composerTouched: true,
  evidence: { composerEmpty: true, exactTemplateMatched: true, appeared: 1, waitedMs: 70,
    visibilityState: 'visible', hasFocus: true, text: NOTICE },
};
const refused = {
  status: 'unconfirmed', reason: 'composer_not_empty', clickPerformed: false, composerWritten: false,
  composerTouched: true,
  evidence: { composerEmpty: false, waitedMs: 4000, appeared: 0, visibilityState: 'hidden',
    hasFocus: false, text: NOTICE },
};

const stage = (entry, name) => entry.stages.find((item) => item.stage === name);

test('T188: one run records both stages, readable through the same storage it wrote', async () => {
  const env = fakeEnv(() => ({ ok: true, result: submitted }));
  const signal = env.nextWrite();                       // registered before the send
  const out = await env.controller.write({ runId: RUN_A, status: 'completed' }, BINDING, 'foreground');
  assert.equal(out.status, 'submitted', 'the caller still gets the adapter result unchanged');
  assert.equal(await signal, true, 'a write landed within the bound');

  for (let i = 0; i < 3; i += 1) await env.nextWrite();  // the two diagnostic writes follow in order
  const rows = await STORE.readRunHistory(env.chrome.storage.local);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, RUN_A);
  assert.equal(stage(rows[0], 'send_attempted').fields.deliveryMode, 'foreground');
  assert.equal(stage(rows[0], 'adapter_result').fields.status, 'submitted');
  assert.equal(stage(rows[0], 'adapter_result').fields.clickPerformed, true);
  assert.equal(rows[0].delivered, false, 'a submitted write is not a delivery');
});

test('T188: a refused run and a submitted run are distinguishable, by full runId', async () => {
  const env = fakeEnv((message) => ({ ok: true,
    result: message.runId === RUN_B ? refused : submitted }));
  const signal = env.nextWrite();
  await env.controller.write({ runId: RUN_A, status: 'completed' }, BINDING, 'foreground');
  await signal;
  const signal2 = env.nextWrite();
  await env.controller.write({ runId: RUN_B, status: 'completed' }, BINDING, 'foreground');
  await signal2;
  for (let i = 0; i < 4; i += 1) await env.nextWrite();

  const rows = await STORE.readRunHistory(env.chrome.storage.local);
  assert.equal(rows.length, 2, 'one row per run');
  assert.deepEqual(rows.map((r) => r.runId).sort(), [RUN_A, RUN_B].sort());
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i - 1].lastAt >= rows[i].lastAt, 'ordered by the last write that landed');
  }
  const a = rows.find((r) => r.runId === RUN_A);
  const b = rows.find((r) => r.runId === RUN_B);
  assert.equal(stage(a, 'adapter_result').fields.status, 'submitted');
  assert.equal(stage(b, 'adapter_result').fields.reason, 'composer_not_empty');
  assert.equal(stage(b, 'adapter_result').fields.clickPerformed, false);
  assert.equal(stage(b, 'adapter_result').fields.visibilityState, 'hidden');
  const onlyB = await STORE.readRunHistory(env.chrome.storage.local, { runId: RUN_B });
  assert.equal(onlyB.length, 1, 'lookup by the full runId works');
  assert.equal(onlyB[0].runId, RUN_B);
});

test('T188: a re-sent run replaces its own stage instead of inventing history', async () => {
  const env = fakeEnv(() => ({ ok: true, result: submitted }));
  const s1 = env.nextWrite();
  await env.controller.write({ runId: RUN_A, status: 'completed' }, BINDING, 'foreground');
  await s1;
  const s2 = env.nextWrite();
  await env.controller.write({ runId: RUN_A, status: 'completed' }, BINDING, 'foreground');
  await s2;
  for (let i = 0; i < 4; i += 1) await env.nextWrite();
  const rows = await STORE.readRunHistory(env.chrome.storage.local);
  assert.equal(rows.length, 1, 'one row per run, not one per attempt');
  assert.equal(stage(rows[0], 'adapter_result').known, true);
});

test('T188: storage.set throwing changes neither the send result nor the number of sends', async () => {
  const env = fakeEnv(() => ({ ok: true, result: submitted }));
  env.failSet = true;
  const out = await env.controller.write({ runId: RUN_A, status: 'completed' }, BINDING, 'foreground');
  assert.equal(out.status, 'submitted', 'the send path is unaffected');
  assert.equal(env.sent.length, 1, 'no retry was triggered by the diagnostic failure');
  const rows = await STORE.readRunHistory(env.chrome.storage.local);
  assert.deepEqual(rows, [], 'nothing was recorded, which reads as unknown');
});

test('T188: the history is bounded and keeps the newest entries', async () => {
  const env = fakeEnv(() => ({ ok: true, result: submitted }));
  for (let i = 0; i < 24; i += 1) {
    const signal = env.nextWrite();
    await env.controller.write({ runId: 'run-' + i, status: 'completed' }, BINDING, 'foreground');
    await signal;
  }
  // Let every queued diagnostic write land: each `set()` resolves the signal, and the empty-handed ones are
  // bounded by the timeout. This is a drain, not a poll -- there is no sleep and no retry of the send.
  for (let i = 0; i < 80; i += 1) {
    const landed = await env.nextWrite(120);
    if (!landed) break;
  }
  const rows = await STORE.readRunHistory(env.chrome.storage.local);
  assert.ok(rows.length <= STORE.HISTORY_LIMIT, 'bounded to HISTORY_LIMIT');
  assert.equal(rows.some((r) => r.runId === 'run-23'), true, 'the newest run is kept');
  assert.equal(rows.some((r) => r.runId === 'run-0'), false, 'the oldest were pruned');
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i - 1].lastAt >= rows[i].lastAt, 'ordered by the last write that landed');
  }
});

test('T188: a restarted worker reads the same history from storage', async () => {
  const env = fakeEnv(() => ({ ok: true, result: submitted }));
  const signal = env.nextWrite();
  await env.controller.write({ runId: RUN_A, status: 'completed' }, BINDING, 'foreground');
  await signal;
  for (let i = 0; i < 2; i += 1) await env.nextWrite();
  // A duplicate module import stands in for a restarted service worker: only storage survives it.
  const STORE2 = await import(pathToFileURL(path.join(LIB, 'diagnostic_store.js')).href + '?restart=t188');
  const rows = await STORE2.readRunHistory(env.chrome.storage.local);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, RUN_A);
  assert.equal(stage(rows[0], 'send_attempted').known, true);
});

test('T188: no notice text, URL or token can reach the stored history', async () => {
  const env = fakeEnv(() => ({ ok: true, result: refused }));
  const signal = env.nextWrite();
  await env.controller.write({ runId: RUN_A, status: 'completed' }, BINDING, 'foreground');
  await signal;
  for (let i = 0; i < 2; i += 1) await env.nextWrite();
  const raw = JSON.stringify(env.data.deliveryDiagnosticHistory);
  for (const secret of [NOTICE, 'chatgpt.com', CONV, 'sk-live-123']) {
    assert.equal(raw.includes(secret), false, secret + ' must not be stored');
  }
});

test('T188: lastDeliveryDiagnostic still works and the popup reads both through read-only messages', async () => {
  const env = fakeEnv(() => ({ ok: true, result: submitted }));
  const signal = env.nextWrite();
  await env.controller.write({ runId: RUN_A, status: 'completed' }, BINDING, 'foreground');
  await signal;
  for (let i = 0; i < 2; i += 1) await env.nextWrite();
  const latest = await STORE.readLatest(env.chrome.storage.local);
  assert.equal(latest.present, true, 'the T173 key is untouched');

  const bg = readFileSync(path.join(HERE, 'extension', 'background.js'), 'utf8');
  const idx = bg.indexOf("msg.type === 't188-run-history'");
  assert.ok(idx > 0, 'the worker answers the history message');
  assert.match(bg.slice(idx, idx + 700), /extension_popup_required/);
  assert.match(bg.slice(idx, idx + 700), /readRunHistory/);
  const popup = readFileSync(path.join(HERE, 'extension', 'popup.js'), 'utf8');
  const at = popup.indexOf("'t188-run-history'");
  assert.ok(at > 0);
  assert.doesNotMatch(popup.slice(at - 300, at + 300), /setInterval|t058-write-notice|t059-/);
  const html = readFileSync(path.join(HERE, 'extension', 'popup.html'), 'utf8');
  assert.ok(html.indexOf('lib/run_history_view.js') < html.indexOf('src="popup.js"'));
});

test('T188: the renderer shows five runs at most, marks absent stages unknown, and never claims delivery', async () => {
  const source = readFileSync(path.join(LIB, 'run_history_view.js'), 'utf8');
  const window = {};
  vm.runInContext(source, vm.createContext({ window }), { filename: 'run_history_view.js' });
  const entry = (runId, delivered) => ({
    runId, delivered, stages: [
      { stage: 'send_attempted', known: true, fields: { status: 'attempted', deliveryMode: 'foreground' } },
      { stage: 'adapter_result', known: false, fields: {} },
    ],
  });
  const lines = window.runHistoryLines([1, 2, 3, 4, 5, 6, 7].map((n) => entry('run-' + n, false)));
  const text = lines.join('\n');
  assert.equal(lines.filter((l) => l.trim().startsWith('run-')).length, 5, 'at most five runs');
  assert.match(text, /adapter_result: unknown/);
  assert.match(text, /no host ack/);
  assert.match(text, /adapter not submitted/);
  assert.match(text, /submitted is not ChatGPT consumption/);
  assert.match(window.runHistoryLines([])[0], /none recorded/);
  const acked = Object.assign(entry('r', false), { hostAcked: true });
  assert.match(window.runHistoryLines([acked]).join('\n'), /host ack; adapter not submitted/);
});
