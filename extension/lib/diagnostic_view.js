// T173: render one stored delivery record in the popup, read-only.
//
// Classic script on purpose: popup.html loads build_stamp / queue_error_view / single_shot_view /
// readiness_queue_view / diagnostic_view / popup.js and calls them as globals, so a `type="module"`
// import could not be reached from popup.js. `unknown` is spelled out; no text field exists to leak.
(function expose() {
  'use strict';
  const ORDER = ['status', 'reason', 'classification', 'clickPerformed', 'composerWritten',
    'composerOccupancy', 'composerEmptyAtReceipt', 'deliveryMode', 'controlMode', 'readyWaitedMs',
    'waitedMs', 'visibilityState', 'hasFocus', 'conversationMatched', 'documentInstanceMatched',
    'receiptPath', 'exactTemplateMatched', 'appeared', 'buttonPath', 'observedAt'];

  function diagnosticLines(readout) {
    if (!readout || readout.present !== true || !readout.stored) {
      return ['last notice: ' + ((readout && readout.note) || 'no record') + ' (unknown, not zero)'];
    }
    const record = readout.stored;
    const fields = record.fields || {};
    const lines = ['last notice: ' + (record.classification || 'unknown')
      + ' -- delivered: ' + (record.delivered === true ? 'yes' : 'no')];
    for (const key of ORDER) {
      const value = fields[key];
      lines.push('  ' + key + ': '
        + (value === undefined || value === null ? 'unknown' : String(value)));
    }
    if (Array.isArray(record.unknownFields) && record.unknownFields.length > 0) {
      lines.push('  unknown fields: ' + record.unknownFields.join(', ') + ' (not inferred)');
    }
    lines.push('  delivered means a verified receipt; a write or a click alone is not delivery');
    return lines;
  }

  window.diagnosticLines = diagnosticLines;
}());
