// T233: turn the stored delivery diagnostic into one JSON document the operator can hand to `notify_doctor.py`.
//
// Constraints this file is built around, all of them enforced here rather than in the caller:
//
//   * whitelist, never blacklist. Every field that leaves is named below; a field added to the record later does not
//     travel until someone adds it here on purpose. The record's own `receiptRaw`, the notice text, conversation and
//     document ids, tab ids, URLs and any token stay behind.
//   * bounded. At most MAX_RECORDS entries and MAX_BYTES of JSON; the oldest are dropped and the count of dropped
//     entries is reported, because a silently truncated export is a lie about coverage.
//   * attribution stated in the document. `page_visible` is always `unknown`: this export proves what the page
//     accepted, never that a person read it.
//   * nothing runs on its own. This module has no chrome.* access and no timers; the popup calls it from a click.
(function () {
  'use strict';

  var SCHEMA = 't233-diagnostic-export/1';
  var MAX_RECORDS = 20;
  var MAX_BYTES = 32768;
  var STATUSES = ['submitted', 'unconfirmed', 'refused'];

  // The page-side facts worth keeping: what was clicked, what was written, whether one exact message appeared, and
  // whether the two identities matched. `receiptPath` is deliberately absent -- it is a DOM path, and the reviewer
  // does not need page structure to read this.
  var FIELD_KEYS = ['status', 'clickPerformed', 'composerWritten', 'composerTouched',
    'appeared', 'exactTemplateMatched', 'documentInstanceMatched', 'conversationMatched',
    'visibilityState', 'hasFocus'];

  function pickFields(fields) {
    var out = {};
    var source = (fields && typeof fields === 'object') ? fields : {};
    for (var i = 0; i < FIELD_KEYS.length; i += 1) {
      var key = FIELD_KEYS[i];
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      var value = source[key];
      if (typeof value === 'boolean' || typeof value === 'string' || value === null) out[key] = value;
    }
    return out;
  }

  function one(record) {
    if (!record || typeof record !== 'object') return null;
    var fields = pickFields(record.fields);
    var status = STATUSES.indexOf(fields.status) >= 0 ? fields.status : 'unknown';
    return {
      runId: typeof record.runId === 'string' && record.runId ? record.runId : null,
      at: Number.isFinite(record.at) ? record.at : null,
      status: status,
      delivered: record.delivered === true,
      deliveredWhy: typeof record.deliveredWhy === 'string' ? record.deliveredWhy : null,
      fields: fields,
    };
  }

  function collect(last, history) {
    var rows = [];
    if (Array.isArray(history)) {
      for (var i = 0; i < history.length; i += 1) {
        // `deliveryDiagnosticHistory` entries are per-run summaries of observed stages, not records; only an entry
        // that carries a record-shaped `fields` object is exported, and anything else is skipped rather than guessed.
        var candidate = history[i];
        if (candidate && typeof candidate === 'object' && candidate.fields && typeof candidate.fields === 'object') {
          rows.push(candidate);
        }
      }
    }
    if (last && typeof last === 'object') rows.push(last);
    var seen = {};
    var unique = [];
    for (var j = 0; j < rows.length; j += 1) {
      var item = one(rows[j]);
      if (!item) continue;
      var key = (item.runId || '') + '|' + item.at + '|' + item.status;
      if (seen[key]) continue;
      seen[key] = true;
      unique.push(item);
    }
    unique.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    return unique;
  }

  function buildDiagnosticExport(last, history, options) {
    var opts = options || {};
    var now = Number.isFinite(opts.now) ? opts.now : Date.now();
    var all = collect(last, history);
    var kept = all.slice(0, MAX_RECORDS);
    var counts = { submitted: 0, unconfirmed: 0, refused: 0, unknown: 0 };
    for (var i = 0; i < kept.length; i += 1) counts[kept[i].status] += 1;

    var document = {
      schema: SCHEMA,
      exportedAt: new Date(now).toISOString(),
      exportedBy: 'popup-button',            // never a timer, never a background worker
      scope: {
        source: 'chrome.storage.local',
        keys: ['lastDeliveryDiagnostic', 'deliveryDiagnosticHistory'],
        fields: 'whitelist:t233',
        attribution: ['submit_confirmed'],
        pageVisible: 'unknown',
        upload: 'never; this document only goes where the operator puts it',
      },
      counts: { records: kept.length, dropped: all.length - kept.length,
        submitted: counts.submitted, unconfirmed: counts.unconfirmed,
        refused: counts.refused, unknown: counts.unknown },
      records: kept,
    };

    // Byte cap: drop from the tail (the oldest, since the list is newest-first) until it fits. `dropped` keeps
    // counting so the document never overstates its own coverage.
    var text = JSON.stringify(document, null, 2);
    while (text.length > MAX_BYTES && document.records.length > 0) {
      document.records.pop();
      document.counts.records = document.records.length;
      document.counts.dropped = all.length - document.records.length;
      text = JSON.stringify(document, null, 2);
    }
    if (document.records.length === 0) {
      document.counts.submitted = 0;
      document.counts.unconfirmed = 0;
      document.counts.refused = 0;
      document.counts.unknown = 0;
    }
    return { document: document, text: text, bytes: new TextEncoder().encode(text).length };
  }

  window.buildDiagnosticExport = buildDiagnosticExport;
  window.DIAGNOSTIC_EXPORT = { schema: SCHEMA, maxRecords: MAX_RECORDS, maxBytes: MAX_BYTES,
    fields: FIELD_KEYS.slice(), statuses: STATUSES.slice() };
})();
