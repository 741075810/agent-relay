// T173: keep the last delivery outcome where the popup can read it, and nowhere else.
//
// `diagnostic_record.js` (T166) builds the record; until now it was called only from Node tests. This is
// the runtime half: a `deliverInto`-shaped result goes in, the record is built, only the whitelisted
// fields are kept, and one entry is stored under a single key. The popup reads that key with a plain
// `chrome.storage.local.get` -- no page access, no message to the page.
//
// It must never copy notice text or page text, never treat a write or a click as delivery, and never
// invent a value the run did not observe. `test_t095b173_diagnostic_store.mjs` asserts all three.

import { buildDiagnosticRecord, DIAGNOSTIC_SCHEMA } from './diagnostic_record.js';

export const LAST_DIAGNOSTIC_KEY = 'lastDeliveryDiagnostic';

const KEEP = Object.freeze(['status', 'reason', 'classification', 'deliveryMode', 'controlMode',
  'clickPerformed', 'composerWritten', 'composerTouched', 'composerOccupancy',
  'composerEmptyAtReceipt', 'readyWaitedMs', 'waitedMs', 'visibilityState', 'hasFocus',
  'documentInstanceMatched', 'conversationMatched', 'receiptPath', 'exactTemplateMatched',
  'appeared', 'buttonPath', 'observedAt']);

function storageGet(storage, key) {
  return new Promise((resolve) => {
    try {
      storage.get({ [key]: null }, (value) => resolve(value || {}));
    } catch (err) {
      resolve({});
    }
  });
}

function storageSet(storage, patch) {
  return new Promise((resolve) => {
    try {
      storage.set(patch, () => resolve(true));
    } catch (err) {
      resolve(false);
    }
  });
}

// T176: two overlapping events must not end with the older one stored. `noteDelivery` in the worker is
// fire-and-forget, so two completions can interleave; without ordering the last write to land wins, which
// may be the older outcome. Writes are therefore serialised through one chain and guarded by timestamp.
// Best-effort, not a durable guarantee: a service-worker restart between read and write can still lose the
// newest record, and nothing here survives a storage quota failure.
let writeChain = Promise.resolve();

function serialised(task) {
  const next = writeChain.then(task, task);
  writeChain = next.catch(() => {});
  return next;
}

/** Store one outcome and hand back exactly what was stored. */
export async function recordDelivery(storage, input = {}, now = Date.now()) {
  const record = buildDiagnosticRecord(input);
  const fields = {};
  for (const key of KEEP) fields[key] = record.fields[key];
  // T173: `submitted` is the page accepting the message, not ChatGPT consuming it. Until something
  // acks the notice (the host ledger's `acked` state, which this worker cannot observe), the record says
  // not delivered. Claiming otherwise would repeat the exact confusion this panel exists to remove.
  const acknowledged = input.acked === true;
  const delivered = acknowledged && record.delivered === true;
  const stored = {
    schema: DIAGNOSTIC_SCHEMA,
    at: now,
    classification: record.classification,
    delivered,
    deliveredWhy: delivered
      ? 'acknowledged after a verified receipt'
      : (acknowledged ? 'acknowledged flag set, but the receipt facts are incomplete'
        : 'not delivered: no acknowledgement observed (a write or a click is not delivery)'),
    unknownFields: record.unknownFields.slice(),
    fields,
  };
  return serialised(async () => {
    const current = (await storageGet(storage, LAST_DIAGNOSTIC_KEY))[LAST_DIAGNOSTIC_KEY];
    // An older outcome that arrives late must not replace a newer one already on disk.
    if (current && typeof current === 'object' && Number.isFinite(current.at) && current.at >= now) {
      return current;
    }
    await storageSet(storage, { [LAST_DIAGNOSTIC_KEY]: stored });
    return stored;
  });
}

/** The last stored outcome, or a shape that says plainly that nothing was recorded. */
export async function readLatest(storage) {
  const got = await storageGet(storage, LAST_DIAGNOSTIC_KEY);
  const stored = got[LAST_DIAGNOSTIC_KEY];
  if (!stored || typeof stored !== 'object') {
    return { present: false, code: 'no_diagnostic_recorded',
      note: 'no delivery outcome has been recorded since this build was loaded' };
  }
  return { present: true, code: null, stored };
}
