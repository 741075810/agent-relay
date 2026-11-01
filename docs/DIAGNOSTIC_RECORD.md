# When a notice is written but not sent: getting one reviewable record

The adapter fails closed by design. When the composer holds the notice and no click happened, it returns
`status: 'unconfirmed'` with `clickPerformed: false` and a reason. That is the right behaviour and a bad
handover: the reason lives in a transient message, and the one thing you must not do is re-trigger —
the draft is intact, so a second attempt is either refused or duplicates.

This document is the read-only path from that page to a record a reviewer can act on.

## 1. Build the record (no page access, no sending)

`extension/lib/diagnostic_record.js` is a pure formatter. It takes the result object the adapter already
produced and returns `{ schema, classification, delivered, fields, unknownFields }`, plus
`renderDiagnosticText(record)` for a copy-pasteable block.

```js
import { buildDiagnosticRecord, renderDiagnosticText } from './extension/lib/diagnostic_record.js';

const record = buildDiagnosticRecord({
  result,                       // exactly what deliverInto returned, or the stored copy of it
  request: { runId, deliveryMode, expectedConversationId },
  observation: { visibilityState: document.visibilityState, hasFocus: document.hasFocus() },
});
console.log(renderDiagnosticText(record));
```

From the console, when a stored result is reachable, the same thing without a bundler:

```js
const m = await import('./extension/lib/diagnostic_record.js');
console.log(m.renderDiagnosticText(m.buildDiagnosticRecord({ result: <stored result> })));
```

## 2. What the record contains, and what it never contains

Fields: `status`, `reason`, `classification`, `deliveryMode`, `controlMode`, `clickPerformed`,
`composerWritten`, `composerTouched`, `composerOccupancy`, `composerEmptyAtReceipt`, `readyWaitedMs`,
`waitedMs`, `visibilityState`, `hasFocus`, `documentInstanceMatched`, `conversationMatched`, `receiptPath`,
`exactTemplateMatched`, `appeared`, `buttonPath`, `observedAt`.

Rules the tests enforce:

* a field the run did not produce is the literal string `unknown`, never a default that reads like an
  observation, and it is listed again in `unknownFields` with the note that nothing was inferred;
* `delivered` is true only for `submitted` **with** `clickPerformed`, an empty composer and an exact
  template match — `written_not_clicked` and `clicked_unknown` are both explicitly not delivered;
* no notice text, no message body, no other composer's contents, no `receiptRaw`, no cookie, token or key.
  The formatter copies named fields only, so a result that happens to carry `text` cannot leak it.

## 3. Reading the five states

| State | `classification` | `clickPerformed` | What to do |
|---|---|---|---|
| written, button never became usable | `written_not_clicked` | false | nothing was sent; the draft is intact. Report `reason` + `readyWaitedMs` |
| clicked, no receipt appeared | `clicked_unknown` | true | unproven either way. Report `waitedMs`, `receiptPath`, `appeared`; do **not** click again |
| composer already held foreign text | `never_written` | false | someone was typing. `composerOccupancy` says `composer_holds_foreign_text` |
| wrong conversation / route changed | `never_written` | false | page moved. Report `reason` and whether the ids matched |
| tab hidden or locked, state unobserved | whatever the reason was | — | `visibilityState: unknown` means **unknown**, not "works while locked" |

## 4. Why `visibilityState` is often `unknown`

The adapter records visibility only where it checks it: the background precondition, and refusals that
carry page facts. A foreground refusal for lost focus does not record it. The record says `unknown` in
that case on purpose — a late `observation` may fill the field in, and the record then reflects an
observation made after the fact rather than a fact the run saw.

Nothing here claims that a hidden or locked tab can be sent from. That question has no evidence in this
repository, and the code neither asserts nor assumes it.
