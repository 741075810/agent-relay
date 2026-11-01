// T166: a redacted, field-by-field diagnostic record of one delivery request.
//
// The live problem is not that a notice can end up stranded in the composer -- the adapter fails closed
// there by design. The problem is that the operator, standing at that page, has nothing to hand to a
// reviewer: the reason code lives in a message that scrolled away, and re-triggering is exactly what the
// design says not to do (the draft is intact, a second write would either be refused or duplicate).
//
// This module turns whatever was actually recorded into one record that can be copied out and reviewed:
//
//   * every field is either a value the run really produced, or the literal string `unknown` -- never a
//     guess, never a default that looks like an observation;
//   * no notice text, no message body, no other composer's contents, no cookie, token or key: the record
//     carries shapes and booleans, never payloads (`receiptRaw` and `text` are excluded by construction);
//   * the outcome vocabulary is the three classes the adapter already uses, so `unconfirmed` can never
//     render as delivered;
//   * nothing here sends, clicks, writes, clears a draft or reads the DOM. It is a formatter.

import { CLICKED_UNKNOWN, WRITTEN_NOT_CLICKED, NEVER_WRITTEN, classifySendReason }
  from './send_adapter.js';

export const DIAGNOSTIC_SCHEMA = 't166-diagnostic/1';
export const UNKNOWN = 'unknown';

// Fields the reviewer asked to see, in the order they read best. `from` names where a value comes from:
// the adapter's `evidence` object, the result itself, or the request that started it.
const FIELDS = [
  ['status', (result) => result && result.status],
  ['reason', (result) => result && result.reason],
  ['classification', null],
  ['deliveryMode', (result, request, evidence) => evidence.deliveryMode ?? request.deliveryMode],
  ['controlMode', (result, request, evidence) => evidence.controlMode],
  ['clickPerformed', (result) => result && result.clickPerformed],
  ['composerWritten', (result) => result && result.composerWritten],
  ['composerTouched', (result) => result && result.composerTouched],
  ['composerOccupancy', (result, request, evidence) => evidence.composerOccupancy],
  ['composerEmptyAtReceipt', (result, request, evidence) => evidence.composerEmpty],
  ['readyWaitedMs', (result, request, evidence) => evidence.readyWaitedMs],
  ['waitedMs', (result, request, evidence) => evidence.waitedMs],
  ['visibilityState', (result, request, evidence) => evidence.visibilityState],
  ['hasFocus', (result, request, evidence) => evidence.hasFocus],
  ['documentInstanceMatched', (result, request, evidence) => evidence.documentInstanceMatched],
  ['conversationMatched', (result, request, evidence) => evidence.conversationMatched],
  ['receiptPath', (result, request, evidence) => evidence.receiptPath],
  ['exactTemplateMatched', (result, request, evidence) => evidence.exactTemplateMatched],
  ['appeared', (result, request, evidence) => evidence.appeared],
  ['buttonPath', (result, request, evidence) => evidence.buttonPath],
  ['observedAt', (result, request, evidence) => evidence.observedAt],
];

function evidenceOf(result) {
  return result && typeof result.evidence === 'object' && result.evidence !== null
    ? result.evidence : {};
}

/** Derived facts that the adapter records under other names, or not at all. */
function derived(result, request, evidence) {
  const out = {};
  // The adapter records the two ids rather than a verdict; the verdict is what a reviewer needs.
  if (typeof evidence.conversationId === 'string' && typeof evidence.expectedConversationId === 'string') {
    out.conversationMatched = evidence.conversationId === evidence.expectedConversationId;
  }
  // Identity is only ever reported as matched when the adapter actually compared something.
  if (typeof evidence.document === 'object' && evidence.document !== null) {
    out.documentInstanceMatched = evidence.document.matched === undefined
      ? UNKNOWN : evidence.document.matched === true;
  }
  return out;
}

function valueOf(entry, result, request, evidence) {
  const [name, read] = entry;
  if (typeof read !== 'function') return undefined;
  const raw = read(result, request, evidence);
  return raw === undefined ? undefined : raw;
}

/**
 * @param {object} input
 * @param {object|null} input.result   the value `deliverInto` returned, or a record of it
 * @param {object} [input.request]     runId/status/deliveryMode/expectedConversationId (ids only)
 * @param {object} [input.observation] page facts observed later, e.g. `{visibilityState, hasFocus}`
 */
export function buildDiagnosticRecord({ result, request = {}, observation } = {}) {
  const evidence = Object.assign({}, evidenceOf(result), observation || {});
  const extras = derived(result, request || {}, evidence);
  const merged = Object.assign({}, evidence, extras);

  const fields = {};
  for (const entry of FIELDS) {
    const name = entry[0];
    if (name === 'classification') continue;
    const value = valueOf(entry, result, request, merged);
    fields[name] = value === undefined || value === null ? UNKNOWN : value;
  }
  // Never let a boolean-looking field carry a string `false`.
  for (const key of ['clickPerformed', 'composerWritten', 'composerTouched', 'composerEmptyAtReceipt',
    'hasFocus', 'exactTemplateMatched', 'documentInstanceMatched', 'conversationMatched']) {
    if (typeof fields[key] === 'string' && fields[key] !== UNKNOWN) {
      fields[key] = fields[key] === 'true' ? true : fields[key] === 'false' ? false : UNKNOWN;
    }
  }

  const classification = (result && result.status === 'submitted')
    ? 'submitted'
    : (classifySendReason(result && result.reason) || UNKNOWN);
  const ordered = { status: fields.status, reason: fields.reason, classification };
  for (const key of Object.keys(fields)) {
    if (key !== 'status' && key !== 'reason') ordered[key] = fields[key];
  }

  // A record may not claim more than the run proved. `submitted` requires the click and the receipt;
  // `written_not_clicked` and `clicked_unknown` are both explicitly not delivered.
  const delivered = classification === 'submitted'
    && ordered.clickPerformed === true && ordered.composerEmptyAtReceipt === true
    && ordered.exactTemplateMatched === true;

  return {
    schema: DIAGNOSTIC_SCHEMA,
    classification,
    delivered,
    deliveredWhy: delivered ? 'click plus empty composer plus exact template match'
      : 'not delivered: ' + (classification === UNKNOWN
        ? 'classification unknown (no reason code recorded)' : classification),
    fields: ordered,
    unknownFields: Object.keys(ordered).filter((key) => ordered[key] === UNKNOWN).sort(),
  };
}

/** The copy-pasteable form: one `key: value` line per field, unknown spelled out. */
export function renderDiagnosticText(record) {
  const lines = ['DSH delivery diagnostic (' + DIAGNOSTIC_SCHEMA + ')',
    'classification: ' + record.classification,
    'delivered: ' + (record.delivered ? 'yes' : 'no') + ' -- ' + record.deliveredWhy];
  for (const [key, value] of Object.entries(record.fields)) {
    lines.push(key + ': ' + (value === UNKNOWN ? 'unknown' : String(value)));
  }
  if (record.unknownFields.length > 0) {
    lines.push('unknown fields: ' + record.unknownFields.join(', ')
      + ' (not recorded by this run; not inferred)');
  }
  return lines.join('\n');
}

export { CLICKED_UNKNOWN, WRITTEN_NOT_CLICKED, NEVER_WRITTEN };
