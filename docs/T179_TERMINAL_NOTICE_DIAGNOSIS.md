# T179: why T178's completion produced no notice -- what can be shown, and what cannot

Written from this machine on 2026-11-01, read-only. No production file was written, no message was sent, no
extension, host, bridge, page, grant, queue or ACK was touched.

## 1. What this session can and cannot see

| Link | Status | Evidence |
|---|---|---|
| DSH run for T178 ended | **observed** | the Bridge task `tsk-2cb9681d-...` is `completed` at 2026-11-01T11:04:54Z, commit `07dc45c`, both CI jobs green |
| Bridge `task.completed` is the same fact as the native DSH run ending | **unknown** | they are separate records (`native_turns.py` vs the Bridge ledger). The repository never joins them by time; it joins by `(sessionID, turn)`. No join was performed here. |
| A terminal event was created | **unknown** | `state/` does not exist inside this repository -- the running Host uses its own `--native-root`, which this session does not know and must not search for |
| Consent recorded before the run ended (`armedAt < endedAtMs`) | **unknown, and decisive** | if the grant was armed at or after this run's end, refusal is *correct* behaviour, not a bug: `terminal_trigger.js` refuses `armedAt >= endedAtMs` and refuses `endedAtMs === null` |
| A notice was queued, sent, clicked, receipted | **unknown** | all of it lives in the production extension's `chrome.storage.local` and the Host state directory |
| ChatGPT consumed a notice for this run | **unknown, and unobservable** | no mechanism in this repository watches the page's reply |

The honest summary: **the first break cannot be located from here.** What was observed is the user-facing
symptom (a completed task, no notice), which is compatible with at least three different causes: a refusal
that is working as designed, a missing terminal event, and a write that failed at the page.

## 2. The read-only reads that would answer it

Run by the operator, nothing is sent, nothing is modified:

```powershell
# 1. is the grant armed, and was it armed before this run ended?
#    popup console (not the page console): the extension's own storage
chrome.storage.local.get(['autosend','terminalTrigger','terminalCandidates'], (v) => console.log(JSON.stringify(v).slice(0, 4000)))

# 2. what does the host's queue hold? (point it at the real --native-root)
python -B -c "import terminal_source,sys; s=terminal_source.load_state(sys.argv[1]); print({k:(len(v) if isinstance(v,list) else v) for k,v in s.items()})" "<native-root>/state"

# 3. did the last delivery outcome reach the panel?
python -B -c "import notice_queue,sys; print(notice_queue.diagnose(sys.argv[1]))" "<native-root>/state"
```

Decision table for the answer:

* `armedAt >= endedAtMs` for this run → **correct refusal**, not a defect. The fix is to arm before the next
  round is dispatched, not to relax the gate (AGENTS.md: the one rule that must not regress).
* `endedAtMs === null` → `terminal_time_unknown` refusal; the run record is incomplete, which is a Bridge
  writer question, not a trigger question.
* consent fine and no candidate for this run → the terminal event was never produced: that is the break this
  round was looking for, and `docs/NOTIFICATION_BREAKPOINT.md` already names the gap (`native_turns.py` and
  `terminal_source.py` emit nothing for idle and for unexpected stops).
* candidate present, `pendingIds` holds it, `ackedIds` empty → transport/consumer side: read the panel's
  `last notice` line (T173-T176) for the adapter's own verdict before changing anything.

## 3. The invariant this project must hold

A terminal event exists for every real end of a Bridge/DSH task -- `completed`, `failed`, `cancelled`,
`interrupted`, unexpected stop, and an idle that has been stable long enough to be a stop -- with
`eventId / taskId / sessionId / terminalStatus / timestamp`. It is persisted and deduplicated by that id, its
failures are observable, and it retries under the states that are safe to retry (`queued`, `attempted`) while
`written_not_clicked` and `clicked_unknown` are never retried automatically. Delivery to ChatGPT requires
consent recorded strictly before the end of *that* run; without it the event stays diagnosably pending and
blocked. An instruction inside the task ("stop when done") must never suppress the system-level signal, and a
host ACK is evidence that the host's ledger moved, never that ChatGPT read anything.

Where that invariant is already implemented, in this repository:

| Piece | Where | What it holds |
|---|---|---|
| stable terminal id | `extension/lib/terminal_events.js` (`terminalEventId`) | `source:sessionId:taskId:turn:kind` |
| ledger, dedupe, retry policy | same file (`createDeliveryLedger`, `transition`, `nextAttemptDelayMs`) | absorbing states for the two uncertain ones |
| host-side queue persistence | `terminal_source.py` (`candidates_from`, `save_state`, `acknowledge`) | `pendingIds` written, ACK moved once |
| queue ordering / no duplicates | `notice_queue.py` (`queue_key`, `mark`) | scanner-seeded pending rows are not duplicated |
| delivery outcome visible | `lib/diagnostic_store.js` + popup panel | reflects the adapter's own verdict, best-effort |
| consent rule | `terminal_trigger.js`, `test_t069_terminal_precision.{mjs,py}` | `armedAt < endedAtMs`, same millisecond refused |

No code was changed in this round: nothing was proven broken, and editing a gate on a hypothesis is how the
one rule that must not regress gets regressed.

## 4. Do not install the T178 candidate yet

`extensions`-side rollback risks found by review of `tools/build_extension_rc.py` are recorded here as **not
safe for production install**, and were deliberately not expanded into this round:

1. after `out.rename(retired)`, if `staged.rename(out)` raises, the `finally` removes the staging directory --
   and the retired backup inside it -- so the previous candidate is lost;
2. `candidate_identity()` proves only that the files the manifest lists still exist; a foreign file inside that
   directory would be deleted with it.

Both need fixing and a test each before any operator loads `dist/rc-t178`.

## 5. What this round did not claim

It does not claim a notice was lost, and it does not claim the notification path works. A real completion with
no notice is a symptom; the section 2 reads turn it into a fact. Until they are run, the first break is
**unknown** -- and the instruction-level "stop and wait" wording in an earlier prompt is not a root cause:
message transport is a separate pipeline from what the model is told to do at the end of its turn.
