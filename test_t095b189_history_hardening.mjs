// T189: the history must not become a place where page text, URLs or tokens land, and a host acknowledgement
// must not become "delivered".
//
// The injection cases drive the real `createChromeAutoSend().write()` with an adapter reply that carries hostile
// values; the store must refuse to persist them. The ack case drives `recordStage` through the same module the
// worker's message handler uses.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'extension', 'lib');
const WIRE = await import(pathToFileURL(path.join(LIB, 'autosend_chrome_wiring.js')).href);
const STORE = await import(pathToFileURL(path.join(LIB, 'diagnostic_store.js')).href);

const CONV = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const RUN = '876f78c3-2bd6-42c0-bf6e-c8fc7723f858';
const BINDING = { tabId: 7, conversationId: CONV, documentInstanceId: 'doc-1' };
const NOTICE = 'DSH task t-189 completed. https://chatgpt.com/c/' + CONV;
const TOKEN = 'sk-live-9f8e7d6c5b4a';

function fakeEnv(replyFactory) {
  const data = {};
  const sent = [];
  const waiters = [];
  const env = { data, sent };
  const settle = () => { for (const resolve of waiters.splice(0)) resolve(true); };
  env.chrome = {
    storage: { local: {
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
        if (cb) { p.then(cb).then(settle); return undefined; }
        return p.then(() => { settle(); });
      },
    } },
    tabs: { sendMessage(tabId, message) { sent.push({ tabId, message });
      return Promise.resolve(replyFactory(message)); } },
  };
  env.nextWrite = (ms = 800) => new Promise((resolve) => {
    waiters.push(resolve); setTimeout(() => resolve(false), ms);
  });
  env.controller = WIRE.createChromeAutoSend(env.chrome, {
    probeSpecificTab: async () => ({ ok: true }),
    getBindingState: async () => BINDING,
    now: () => 1000,
  });
  return env;
}

async function drain(env, rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    const landed = await env.nextWrite(120);
    if (!landed) return;
  }
}

test('T189: a hostile adapter reply cannot put text, a URL or a token into the history', async () => {
  const env = fakeEnv(() => ({ ok: true, result: {
    status: NOTICE, reason: 'content_refused:' + NOTICE + ' ' + TOKEN,
    clickPerformed: 'yes', composerWritten: 1,
    receiptPath: 'https://chatgpt.com/c/' + CONV,
    evidence: { visibilityState: 'visible; text=' + NOTICE, hasFocus: 'true' },
  } }));
  const signal = env.nextWrite();
  await env.controller.write({ runId: RUN, status: 'completed' }, BINDING, 'foreground');
  await signal;
  await drain(env);
  const raw = JSON.stringify(env.data.deliveryDiagnosticHistory);
  for (const secret of [NOTICE, TOKEN, 'chatgpt.com', CONV, 'sk-live']) {
    assert.equal(raw.includes(secret), false, secret + ' must not be persisted');
  }
  const rows = await STORE.readRunHistory(env.chrome.storage.local, { runId: RUN });
  const result = rows[0].stages.find((s) => s.stage === 'adapter_result').fields;
  assert.equal(result.status, 'unknown', 'an unrecognised status is unknown, not copied');
  assert.equal(result.reason, 'content_refused', 'the category survives, the text does not');
  assert.equal(result.clickPerformed, undefined, 'a non-boolean is dropped');
  assert.equal(result.visibilityState, 'unknown');
});

test('T189: a run id that is not an identifier is refused outright', async () => {
  const env = fakeEnv(() => ({ ok: true, result: { status: 'submitted', clickPerformed: true } }));
  const before = env.nextWrite();
  await env.controller.write({ runId: 'https://chatgpt.com/c/' + CONV, status: 'completed' }, BINDING,
    'foreground');
  await before;
  await drain(env);
  const rows = await STORE.readRunHistory(env.chrome.storage.local);
  assert.deepEqual(rows, [], 'nothing was recorded under a URL-shaped run id');
  assert.equal(JSON.stringify(env.data).includes('chatgpt.com'), false);
});

test('T189: the run id rules accept the real shapes and reject the useful attacks', () => {
  for (const ok of [RUN, 'tsk-c953fb0c-5711-45f8-9bc5-598016623877', 'evt_sim_run0001_task_completed',
    '994303f27383f7300f2eaedd3f415c7b1f9e644a4a4d0452bc93fbd0580e6992', 'run-000123']) {
    assert.equal(STORE.normaliseRunId(ok), ok, ok + ' is accepted');
  }
  for (const bad of ['https://x/y', 'a b', '../../etc', 'x'.repeat(81), '', 'a/b', 'a\u0000b',
    '<script>alert(1)</script>', 'sk-live-' + 'x'.repeat(20) + ' sk']) {
    assert.equal(STORE.normaliseRunId(bad), null, JSON.stringify(bad) + ' is refused');
  }
});

test('T189: reasons are codes, never raw error text', () => {
  assert.equal(STORE.normaliseReason('adapter_error:Could not establish connection. Receiving end does not exist.'),
    'adapter_error');
  assert.equal(STORE.normaliseReason('content_refused:no_reply'), 'content_refused');
  assert.equal(STORE.normaliseReason('composer_not_empty'), 'composer_not_empty');
  assert.equal(STORE.normaliseReason('TypeError: x is undefined'), 'unknown');
  assert.equal(STORE.normaliseReason('x'.repeat(300)), 'unknown');
  assert.equal(STORE.normaliseReason(42), 'unknown');
  assert.equal(STORE.normaliseReason('not a code'), 'unknown');
});

test('T189: a host acknowledgement never becomes delivered', async () => {
  const env = fakeEnv(() => ({ ok: true, result: { status: 'submitted', clickPerformed: true } }));
  const signal = env.nextWrite();
  await env.controller.write({ runId: RUN, status: 'completed' }, BINDING, 'foreground');
  await signal;
  await drain(env);
  await STORE.recordStage(env.chrome.storage.local, { runId: RUN, stage: 'adapter_result',
    status: 'submitted', clickPerformed: true, acked: true }, 5000);
  const row = (await STORE.readRunHistory(env.chrome.storage.local, { runId: RUN }))[0];
  assert.equal(row.hostAcked, true, 'the host ack is recorded as itself');
  assert.equal(row.ackSource, 'host_ack_input', 'and it says where it came from');
  assert.equal(row.pageSubmitted, true, 'the adapter did accept the message');
  assert.equal(row.delivered, false, 'and none of that is page delivery');
  assert.match(row.deliveredWhy, /not page delivery|no observation/);
});

test('T189: the observation of a page match is only recorded when the adapter reports one', async () => {
  const env = fakeEnv(() => ({ ok: true, result: {
    status: 'unconfirmed', reason: 'conversation_mismatch', conversationMatched: false,
    evidence: { visibilityState: 'hidden', hasFocus: false },
  } }));
  const signal = env.nextWrite();
  await env.controller.write({ runId: RUN, status: 'completed' }, BINDING, 'foreground');
  await signal;
  await drain(env);
  const row = (await STORE.readRunHistory(env.chrome.storage.local, { runId: RUN }))[0];
  assert.equal(row.stages.find((s) => s.stage === 'send_attempted').fields.conversationMatched, undefined,
    'the attempt stage no longer claims a match it never observed');
  assert.equal(row.stages.find((s) => s.stage === 'adapter_result').fields.conversationMatched, undefined,
    'and the adapter stage only records what the reply contained');
});

test('T189: numbering continues after a restart instead of restarting at one', async () => {
  const env = fakeEnv(() => ({ ok: true, result: { status: 'submitted' } }));
  for (const runId of ['run-000001', 'run-000002']) {
    const signal = env.nextWrite();
    await env.controller.write({ runId, status: 'completed' }, BINDING, 'foreground');
    await signal;
  }
  await drain(env);
  const first = env.data.deliveryDiagnosticHistory.map((e) => e.seq);
  assert.ok(first.every((n) => Number.isFinite(n) && n > 0));
  // A fresh module instance is a restarted worker: the counter must be derived from what is stored.
  const STORE2 = await import(pathToFileURL(path.join(LIB, 'diagnostic_store.js')).href + '?restart=t189');
  await STORE2.recordStage(env.chrome.storage.local, { runId: 'run-000003', stage: 'send_attempted',
    status: 'attempted' }, 9000);
  const rows = await STORE2.readRunHistory(env.chrome.storage.local);
  const seqs = rows.map((r) => env.data.deliveryDiagnosticHistory
    .find((e) => e.runId === r.runId).seq);
  assert.equal(new Set(seqs).size, seqs.length, 'no two runs share a sequence number');
  const newest = env.data.deliveryDiagnosticHistory.find((e) => e.runId === 'run-000003');
  assert.ok(Math.max(...first) < newest.seq, 'the restarted worker continued the numbering');
});

test('T189: unknown stages stay unknown and the history stays bounded under hostile input', async () => {
  const env = fakeEnv(() => ({ ok: true, result: { status: 'submitted' } }));
  for (let i = 0; i < 22; i += 1) {
    const signal = env.nextWrite();
    await env.controller.write({ runId: 'run-1' + String(i).padStart(5, '0'), status: 'completed' },
      BINDING, 'foreground');
    await signal;
  }
  await drain(env, 60);
  const rows = await STORE.readRunHistory(env.chrome.storage.local);
  assert.ok(rows.length <= STORE.HISTORY_LIMIT);
  assert.equal(rows.every((r) => r.delivered === false), true);
  assert.equal(rows.every((r) => r.stages.every((s) => 'known' in s)), true);
});
