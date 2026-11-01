// T176: overlapping delivery outcomes must not leave the older one stored.
//
// `noteDelivery` is fire-and-forget, so two completions can interleave. These tests reproduce that with a
// storage whose writes resolve out of order, and pin the two protections: one serialised chain, and a
// timestamp guard that refuses an older record over a newer one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'extension', 'lib');
const load = async (name) => import(pathToFileURL(path.join(LIB, name)).href
  + '?r=t176' + Math.random().toString(36).slice(2));
const STORE = await load('diagnostic_store.js');

// chrome.storage.local.get echoes the requested defaults for absent keys; a stub that returns {} would
// make every read look empty and hide the guard under test.
function memGet() {
  return (defaults, cb) => {
    const out = {};
    for (const [k, d] of Object.entries(defaults || {})) {
      out[k] = Object.prototype.hasOwnProperty.call(memGet.data || {}, k) ? memGet.data[k] : d;
    }
    cb(out);
  };
}

function memStorage() {
  const data = {};
  return {
    data,
    get(defaults, cb) {
      const out = {};
      for (const [k, d] of Object.entries(defaults || {})) {
        out[k] = Object.prototype.hasOwnProperty.call(data, k) ? data[k] : d;
      }
      cb(out);
    },
    set(patch, cb) { Object.assign(data, patch); if (cb) cb(); },
  };
}

function slowStorage(delays) {
  const data = {};
  let n = 0;
  return {
    data,
    get(defaults, cb) {
      const out = {};
      for (const [k, d] of Object.entries(defaults || {})) {
        out[k] = Object.prototype.hasOwnProperty.call(data, k) ? data[k] : d;
      }
      cb(out);
    },
    set(patch, cb) {
      const wait = delays[Math.min(n, delays.length - 1)];
      n += 1;
      setTimeout(() => { Object.assign(data, patch); if (cb) cb(); }, wait);
    },
  };
}

const outcome = (reason, extra = {}) => ({ result: { status: 'unconfirmed', reason, ...extra } });

test('T176: a late-arriving older outcome does not replace a newer one', async () => {
  const storage = memStorage();
  await STORE.recordDelivery(storage, outcome('send_button_not_ready'), 2000);
  await STORE.recordDelivery(storage, outcome('adapter_error'), 1000);
  assert.equal(storage.data.lastDeliveryDiagnostic.at, 2000, 'newer record survives');
  assert.equal(storage.data.lastDeliveryDiagnostic.fields.reason, 'send_button_not_ready');
});

test('T176: two overlapping writes settle on the newest, not on whichever landed last', async () => {
  // The first write takes 40ms, the second 0ms: without serialisation the older record would land last.
  const storage = slowStorage([40, 0]);
  const first = STORE.recordDelivery(storage, outcome('send_button_not_ready'), 5000);
  const second = STORE.recordDelivery(storage, outcome('adapter_error'), 6000);
  await Promise.all([first, second]);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(storage.data.lastDeliveryDiagnostic.at, 6000);
  assert.equal(storage.data.lastDeliveryDiagnostic.fields.reason, 'adapter_error');
});

test('T176: an equal timestamp keeps the record already stored, deterministically', async () => {
  const storage = memStorage();
  await STORE.recordDelivery(storage, outcome('send_button_not_ready'), 7000);
  const after = await STORE.recordDelivery(storage, outcome('adapter_error'), 7000);
  assert.equal(after.fields.reason, 'send_button_not_ready', 'a tie must not flip the panel back and forth');
});

test('T176: a failing write does not poison the chain', async () => {
  let calls = 0;
  const storage = {
    data: {},
    get: memGet(),
    set(patch, cb) { calls += 1; if (calls === 1) throw new Error('quota'); Object.assign(storage.data, patch); if (cb) cb(); },
  };
  await STORE.recordDelivery(storage, outcome('adapter_error'), 8000);
  await STORE.recordDelivery(storage, outcome('send_button_not_ready'), 9000);
  assert.equal(calls, 2, 'the second write must still be attempted');
  assert.equal(storage.data.lastDeliveryDiagnostic.at, 9000);
});

test('T176: the record is explicitly best-effort, and the docs say so', async () => {
  const source = readFileSync(path.join(LIB, 'diagnostic_store.js'), 'utf8');
  assert.match(source, /Best-effort, not a durable guarantee/);
  const doc = readFileSync(path.join(HERE, 'docs', 'DIAGNOSTIC_RECORD.md'), 'utf8');
  assert.match(doc, /best-effort/i, 'the doc must not promise reliable persistence');
});
