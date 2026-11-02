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

// T188: `lastDeliveryDiagnostic` answers "what happened last". A missing notice asks a different question --
// "what happened to *that* run" -- so the same whitelisted facts are also kept per runId, bounded, and only
// for the two stages the worker can actually observe. A stage with no entry is unknown, and the reader says
// so instead of filling it in.
export const HISTORY_KEY = 'deliveryDiagnosticHistory';
export const HISTORY_LIMIT = 20;
export const STAGES = Object.freeze(['send_attempted', 'adapter_result']);

// T189: a whitelist of *names* is not enough -- the values arrive from a page-facing reply, so each one is
// constrained here. Anything unrecognised becomes `unknown`; raw exception text is never persisted.
const HISTORY_FIELDS = Object.freeze(['status', 'reason', 'classification', 'deliveryMode',
  'clickPerformed', 'composerWritten', 'composerTouched', 'visibilityState', 'hasFocus',
  'receiptPath', 'conversationMatched', 'documentInstanceMatched']);

const ENUMS = Object.freeze({
  status: Object.freeze(['attempted', 'submitted', 'unconfirmed', 'refused', 'queued', 'blocked']),
  classification: Object.freeze(['delivered', 'submitted', 'written_not_clicked', 'clicked_unknown',
    'failed', 'blocked']),
  deliveryMode: Object.freeze(['foreground', 'background']),
  visibilityState: Object.freeze(['visible', 'hidden']),
  receiptPath: Object.freeze(['click', 'keyboard', 'enter']),
});
const BOOLEANS = Object.freeze(['clickPerformed', 'composerWritten', 'composerTouched', 'hasFocus',
  'conversationMatched', 'documentInstanceMatched']);
//: A run id is an opaque identifier from the host (`uuid`, `tsk-…`, `evt_…`, hex). It is deliberately not a
//: UUID-only rule -- and it can never carry a URL, a path, a token or notice text, because none of those
//: survive the character set.
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const REASON = /^[a-z][a-z0-9_]{0,47}$/;
const REASON_WITH_CATEGORY = /^([a-z][a-z0-9_]{0,31}):/;

export function normaliseRunId(value) {
  if (typeof value !== 'string' || !RUN_ID.test(value)) return null;
  return value;
}

/**
 * A reason is a code, not a message. `adapter_error:<Chrome text>` and `content_refused:<text>` keep their
 * category and drop everything after it, which is where tab ids, extension URLs and page text live.
 */
export function normaliseReason(value) {
  if (typeof value !== 'string' || value.length > 200) return 'unknown';
  const category = REASON_WITH_CATEGORY.exec(value);
  if (category) return REASON.test(category[1]) ? category[1] : 'unknown';
  return REASON.test(value) ? value : 'unknown';
}

function normaliseField(key, value) {
  if (BOOLEANS.includes(key)) return typeof value === 'boolean' ? value : null;
  if (key === 'reason') return normaliseReason(value);
  const allowed = ENUMS[key];
  if (allowed) return (typeof value === 'string' && allowed.includes(value)) ? value : 'unknown';
  return null;
}

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

// Ordering: every write gets a sequence number taken from the stored data, so two runs recorded in the same
// millisecond still have a defined order, and a restart continues the numbering instead of restarting it.
// Honest limit: this is monotonic *as long as the stored history survives*. If the storage is cleared, or an
// older entry was pruned, the counter is derived from what is left -- ties are then only as reliable as that.
let historySeq = 0;
const MAX_SEQ = 1e9;

function nextSeq(list) {
  let max = historySeq;
  for (const item of list) {
    if (item && Number.isFinite(item.seq) && item.seq > max) max = item.seq;
  }
  historySeq = Math.min(max + 1, MAX_SEQ);
  return historySeq;
}

function historyEntry(list, runId, at) {
  const found = list.find((item) => item && item.runId === runId);
  if (found) return found;
  const entry = { runId, firstAt: at, lastAt: at, seq: 0, stages: {} };
  list.push(entry);
  return entry;
}

function pruneHistory(list) {
  list.sort((a, b) => (b.lastAt - a.lastAt) || ((b.seq || 0) - (a.seq || 0)));
  return list.slice(0, HISTORY_LIMIT);
}

/**
 * Record one observed stage of one run. Deduplicated by `runId` + `stage`, so a retry loop replaces rather
 * than appends. Never throws: a diagnostic that cannot be written must cost nothing else.
 */
export async function recordStage(storage, input = {}, now = Date.now()) {
  const runId = normaliseRunId(input && input.runId);
  const stage = input && STAGES.includes(input.stage) ? input.stage : null;
  if (!runId || !stage) return null;
  const fields = {};
  for (const key of HISTORY_FIELDS) {
    if (input[key] === undefined) continue;
    const value = normaliseField(key, input[key]);
    if (value !== null) fields[key] = value;
  }
  try {
    return await serialised(async () => {
      const got = await storageGet(storage, HISTORY_KEY);
      const list = Array.isArray(got[HISTORY_KEY]) ? got[HISTORY_KEY].slice() : [];
      const entry = historyEntry(list, runId, now);
      entry.lastAt = Math.max(entry.lastAt, now);
      entry.seq = nextSeq(list);
      entry.stages[stage] = { at: now, fields };
      // T189: an acknowledgement here means "the host says it persisted the notice" (the `acked` input to
      // `t173-record-delivery`). It is *not* page delivery and *not* ChatGPT consuming anything, so it is
      // recorded under its own name and never turns anything into `delivered`.
      if (input.acked === true) {
        entry.hostAckedAt = now;
        entry.ackSource = 'host_ack_input';
        entry.delivered = false;
        entry.deliveredWhy = 'a host acknowledgement is not page delivery';
      }
      const pruned = pruneHistory(list);
      await storageSet(storage, { [HISTORY_KEY]: pruned });
      return pruned.find((item) => item.runId === runId) || null;
    });
  } catch (err) {
    return null;
  }
}

/** Read the bounded history: newest first; a stage the run never reached stays `known: false`. */
export async function readRunHistory(storage, options = {}) {
  const got = await storageGet(storage, HISTORY_KEY);
  const list = Array.isArray(got[HISTORY_KEY]) ? got[HISTORY_KEY].slice() : [];
  const sorted = pruneHistory(list);
  const runId = options && typeof options.runId === 'string' && options.runId ? options.runId : null;
  const wanted = runId ? sorted.filter((item) => item.runId === runId) : sorted;
  return wanted.map((entry) => ({
    runId: entry.runId,
    firstAt: entry.firstAt,
    lastAt: entry.lastAt,
    // Three separate facts, never collapsed: what the host said, what the page adapter said, and what was
    // actually observed about delivery. Only the last one may ever be `true`, and nothing here observes it.
    hostAcked: typeof entry.hostAckedAt === 'number',
    hostAckedAt: typeof entry.hostAckedAt === 'number' ? entry.hostAckedAt : null,
    ackSource: typeof entry.ackSource === 'string' ? entry.ackSource : null,
    pageSubmitted: Boolean(entry.stages && entry.stages.adapter_result &&
      entry.stages.adapter_result.fields && entry.stages.adapter_result.fields.status === 'submitted'),
    delivered: false,
    deliveredWhy: entry.deliveredWhy
      || 'no observation of page display exists in this record',
    stages: STAGES.map((stage) => ({
      stage,
      known: Boolean(entry.stages && entry.stages[stage]),
      at: entry.stages && entry.stages[stage] ? entry.stages[stage].at : null,
      fields: entry.stages && entry.stages[stage] ? entry.stages[stage].fields : {},
    })),
  }));
}

/** The last stored outcome, or a shape that says plainly that nothing was recorded. */export async function readLatest(storage) {
  const got = await storageGet(storage, LAST_DIAGNOSTIC_KEY);
  const stored = got[LAST_DIAGNOSTIC_KEY];
  if (!stored || typeof stored !== 'object') {
    return { present: false, code: 'no_diagnostic_recorded',
      note: 'no delivery outcome has been recorded since this build was loaded' };
  }
  return { present: true, code: null, stored };
}
