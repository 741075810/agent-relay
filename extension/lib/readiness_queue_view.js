// T171: one read-only line for the readiness panel -- blocked layer plus what is waiting.
//
// popup.js is a classic script (`popup.html` loads build_stamp / queue_error_view / single_shot_view /
// popup.js, and no modules), so this follows the same pattern as `single_shot_view.js`: a global, no
// imports, no side effects. It formats only.
//
// Three states must not collapse:
//   * blocked, and the queue count is known      -> "blocked: <layers> -- N waiting"
//   * blocked, and the queue count is NOT known  -> "blocked: <layers> -- waiting: unknown"
//     (unknown is not zero: printing 0 here is how "nothing was lost" gets claimed without a read)
//   * not blocked                                -> a plain "ok" line, still without sending anything
//
// Nothing here sends, retries, clears the queue, or touches the ack list. The two uncertain delivery
// states are named only to say they are never retried automatically.
(function expose() {
  'use strict';
  const UNCERTAIN = ['written_not_clicked', 'clicked_unknown'];

  function list(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : [];
  }

  function readinessQueueLine(readiness, waiting) {
    const blocked = list(readiness && readiness.blockedBy);
    const unsure = list(readiness && readiness.unknownBy);
    const count = Number.isSafeInteger(waiting) && waiting >= 0 ? waiting : null;
    const waitingText = count === null ? 'waiting: unknown' : count + ' waiting';
    const uncertainty = 'uncertain states are never retried automatically: ' + UNCERTAIN.join(', ');

    if (blocked.length === 0 && unsure.length === 0) {
      return 'notifications: ready -- ' + waitingText
        + (count !== null && count > 0 ? '; ' + uncertainty : '');
    }
    const parts = [];
    if (blocked.length > 0) parts.push('blocked: ' + blocked.join(', '));
    if (unsure.length > 0) parts.push('unknown: ' + unsure.join(', '));
    return 'notifications: ' + parts.join(' | ') + ' -- ' + waitingText
      + (count !== null && count > 0 ? '; ' + uncertainty : '');
  }

  window.readinessQueueLine = readinessQueueLine;
  window.READINESS_UNCERTAIN_STATES = UNCERTAIN.slice();
}());
