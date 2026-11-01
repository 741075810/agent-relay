# T170: readiness blocked while notices wait -- audit, and the patch I did not ship

## 1. What was checked, in source

| Item | Evidence | Result |
|---|---|---|
| Readiness request boundary | `extension/background.js`, message `t069-canary-readiness`: `sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') || sender.tab` -> `extension_popup_required` | popup-only, read-only; a page or content script cannot trigger it |
| What readiness reads | `readCanaryReadiness()`: `chrome.storage.local.get({terminalTrigger, autosend, terminalCandidates, terminalSourceBaseline, t053TargetBindingState})`, normalised trigger state, grant, candidates, baseline | read-only; nothing written back |
| Waiting notices are already counted | same function computes `deferredCount = Object.keys(trigger.deferred).length` and reads `trigger.deferred` values for a soonest `retryAt` | the readiness payload already knows how many notices are waiting |
| Blocked reason is already shown | `extension/popup.js` (readiness render): `blocked = ready.result.blockedBy`, `unsure = ready.result.unknownBy`, markers `--` / `??`, one line per item | an operator does see which layers are blocked |
| Popup script model | `extension/popup.html` loads `lib/build_stamp.js`, `lib/queue_error_view.js`, `lib/single_shot_view.js`, `popup.js` -- all classic scripts; `readonly_preflight.js` is an ES module | module helpers are **not** in popup scope; a UI addition needs a module `<script type="module">` or a classic-script home |
| Host side | `host.py:837` `running_report`, `:859` `acknowledge`; `terminal_source.py:651` writes `pendingIds`, `:817` `save_state` | the queue and the ACK are the existing ones; nothing new is needed there |

## 2. Why no code was shipped this round

The tempting change was: pair `blockedBy` with the waiting count and print one more line. I wrote it,
then reverted it, because two facts make it unverifiable offline:

1. `readonly_preflight.js` is a module and `popup.html` does not load modules, so calling the helper
   from `popup.js` would have thrown at runtime -- a broken popup is worse than a missing line;
2. the readiness payload with `blockedBy` is assembled where I could not pin down within this round's
   read budget, so wiring "the same shape" into it would have been guesswork.

The audit result is that **the existing code already reports both facts separately**: which layers are
blocked, and how many notices are deferred. What it does not do is state the *consequence* in one place.

## 3. Minimal production patch, for a round that can read the payload builder

In `extension/background.js`, inside the readiness result (the object that already carries `blockedBy`,
`unknownBy`, `items`, and whose function already computes `deferredCount`):

```js
// one derived field, no new store, no new message type
queue: {
  waiting: deferredCount,
  // States that must never be retried automatically after a grant is restored. The extension ledger
  // (lib/terminal_events.js) already treats them as absorbing; this only reports that.
  noAutoRetry: ['written_not_clicked', 'clicked_unknown'],
  line: deferredCount > 0 && blocked.length > 0
    ? 'blocked: ' + blocked.join(', ') + ' -- ' + deferredCount
      + ' notice(s) waiting; not sent while blocked; written_not_clicked / clicked_unknown are never '
      + 'retried automatically after recovery'
    : null,
},
```

and in `extension/popup.js`, one line appended to the existing readiness block:

```js
if (ready.result.queue && ready.result.queue.line) {
  chainEls.detail.textContent += '\n' + ready.result.queue.line;
}
```

Properties this preserves: no send, no clearing of `pendingIds`, no ACK write, no change to grant
semantics, and no retry of the two uncertain states. `blocked` plus a non-empty queue is exactly the
T065 -> T168/T169 situation: the user had to act before two finished tasks could be announced.

## 4. Regressions that patch must carry (not written yet, deliberately)

1. T058 blocked -> ok transition: a blocked readiness with `deferredCount = 2` reports both the layer
   and the count; after the grant is restored the same call reports `ok` and the count is unchanged.
2. Host candidate still present: `pendingIds` in the state document is identical before and after the
   readiness call (readiness is read-only).
3. ACK not repeated: `terminal_source.acknowledge` called twice moves the id once.
4. Popup invisible / background: a readiness call with `jsdom`-less fake sender that is not the popup
   returns `extension_popup_required` and no payload.
5. Conservative input: `blockedBy` absent, `deferred` absent, `deferred` not an object -> count 0, no
   line, no throw.
6. No regression on the working path: a ready state with zero waiting notices prints no extra line.

## 5. Runtime evidence to collect (read-only, no messages sent)

```powershell
# what the extension believes right now (read-only; run from the popup console, not the page)
chrome.storage.local.get(['autosend','terminalTrigger'], (v) => console.log(JSON.stringify(v).slice(0, 2000)))

# what the host has queued, without touching it
python -B -c "import notice_queue,sys; print(notice_queue.diagnose(sys.argv[1]))" <state dir>
```

If `autosend` shows a spent or expired grant while `terminalTrigger.deferred` is non-empty, that is the
T065 situation with waiting work: `expired` versus `quota` cannot be distinguished from the screenshot,
and both must be read from the record itself -- **unknown** until that read happens.
