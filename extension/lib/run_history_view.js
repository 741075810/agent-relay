// T188: render the per-run delivery history in the popup. Read-only: no timers, no sends, no storage writes.
(function expose() {
  'use strict';

  function stageOf(entry, name) {
    if (!entry || !Array.isArray(entry.stages)) return null;
    return entry.stages.find((item) => item && item.stage === name) || null;
  }

  function describe(stage) {
    if (!stage || !stage.known) return 'unknown';
    const f = stage.fields || {};
    const bits = [f.status || 'unknown'];
    if (f.reason) bits.push(f.reason);
    if (f.classification) bits.push(f.classification);
    if (f.clickPerformed !== undefined) bits.push('click=' + f.clickPerformed);
    if (f.composerWritten !== undefined) bits.push('written=' + f.composerWritten);
    return bits.join(' ');
  }

  function runHistoryLines(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return ['recent runs: none recorded (unknown, not "nothing was owed")'];
    }
    const lines = ['recent runs (' + entries.length + '):'];
    for (const entry of entries.slice(0, 5)) {
      // T189: `delivered` is always false here -- nothing in this record observes page display. What can be
      // said is whether the host acknowledged, and whether the adapter itself accepted the message.
      const state = (entry.hostAcked ? 'host ack' : 'no host ack')
        + (entry.pageSubmitted ? '; adapter submitted' : '; adapter not submitted');
      const attempted = stageOf(entry, 'send_attempted');
      lines.push('  ' + entry.runId + ' -- ' + state);
      lines.push('    send_attempted: ' + (attempted && attempted.known
        ? (attempted.fields.deliveryMode || 'attempted') : 'unknown'));
      lines.push('    adapter_result: ' + describe(stageOf(entry, 'adapter_result')));
    }
    lines.push('  a host acknowledgement is not page display; submitted is not ChatGPT consumption');
    return lines;
  }

  window.runHistoryLines = runHistoryLines;
}());
