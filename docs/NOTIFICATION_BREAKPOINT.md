# "DSH finished and nothing was sent": where the chain breaks first

Written for T167, against the code in this repository and the host's own scanner modules. No runtime
access was used, so every claim below is either measured in source or marked **unknown**.

## 1. The six links, and what this repository can prove about each

| Link | Where it lives | Evidence | Verdict |
|---|---|---|---|
| 1. Is the turn over? | `terminal_source.py`, `native_turns.py` | both build candidates from ledger / `run` records; `idle` appears **zero** times in either file (`grep -c idle` = 0/0) | **break, provable**: a turn that ends without a task record — DSH stopping itself, an unexpected stop, a cancellation — produces no candidate at all |
| 2. Is the event unique and stable? | none: candidates carry run ids from the ledger, nothing normalises `completed/failed/cancelled/unexpected_stop/idle_with_unfinished_work` into one shape | `TERMINAL = {` in `terminal_source.py:46` enumerates ledger statuses only | **gap, provable**: no single identity for "this ending", so dedupe depends on whichever source produced it |
| 3. Does consent authorise it? | `extension/lib/terminal_trigger.js` `optInUsable` | strict `armedAt < endedAtMs`, `terminal_time_unknown` refusal, run-id binding (T161/T165) | sound; this is the one rule that must not regress |
| 4. Was it written into the page? | `extension/lib/send_adapter.js` `deliverInto` | preflight → write → readiness wait → single click → receipt | sound and fail-closed |
| 5. Did the page accept it? | same, `waitForReceipt` / `readReceipt` | `submitted` only when `composerEmpty && exactTemplateMatched` | sound |
| 6. Did ChatGPT actually consume it? | none in this repository | no receipt of that kind exists here | **unknown**: `submitted` is the strongest claim the code can make |

Links 1 and 2 are the answer to "DSH finished, no notification": the notice machinery never got an event
to carry. The user's screenshot showed a later link (4) failing for a *different* run — text stranded in
the composer — so the two reports are consistent with two distinct break points, not one.

## 2. What T167 adds (offline half of the fix)

`extension/lib/terminal_events.js`:

* **state normalisation** — `normalizeTerminalEvent` accepts `completed`, `failed`, `cancelled`,
  `unexpected_stop`, `idle_with_unfinished_work`, and refuses `awaiting_user_input`, `permission_wait`,
  `idle_clean`, `running` with their own codes, because "the operator must type something" is not "the
  task finished";
* **no momentary idle** — `idle_with_unfinished_work` requires `unfinished >= 1` **and** an idle held for
  `IDLE_STABLE_MS` (60 s), otherwise `idle_unstable`;
* **stable identity** — `terminalEventId` = `source:sessionId:taskId:turn:kind`. Identifiers only, so
  re-reading the same log cannot mint a second id;
* **never a guessed time** — `endedAtMs` must be a positive safe integer, else `ended_at_unknown`;
* **delivery ledger** — `queued → attempted → submitted → acked`, with `written_not_clicked` and
  `clicked_unknown` as absorbing states. `acked` requires `receiptVerified`. **`submitted` is not
  delivered**; only `acked` is, and `delivered` is not a state anyone can set;
* **no retry that could duplicate** — `transition` refuses to leave `written_not_clicked` (the draft is
  intact) or `clicked_unknown` (a second click could duplicate), with a `why` that says which;
* **bounded backoff** — `nextAttemptDelayMs`: none for the absorbing states, `0` while queued,
  `min(30 s × attempts, 15 min)` while retryable;
* **T166 reuse** — `entryDiagnostic(entry, observation)` builds the same redacted record from a ledger
  entry, so a kept event is reviewable without touching the page.

## 3. Message delivery semantics (exact)

| state | meaning | may retry | counts as delivered |
|---|---|---|---|
| `queued` | event recorded, nothing attempted | yes | no |
| `attempted` | a write/click attempt started | yes (transient reasons only) | no |
| `written_not_clicked` | the notice is in the composer, no click | **no** | no |
| `clicked_unknown` | a click happened, no receipt | **no** | no |
| `submitted` | page accepted: empty composer + exact template match | no | **no** |
| `acked` | receipt verified, consumed downstream | no | **yes** |

Two consequences worth stating plainly: an event in `written_not_clicked` must stay visible to the
operator as pending work, not silently expire; and no code path may render `submitted` as "sent".

## 4. Upgrading a production extension: prerequisites and rollback (not performed)

This repository's extension is source, not the installed copy. Before any real update:

1. record the currently loaded version and its stamp (`tools/extension_stamp.py --check --root <deploy dir>`);
2. confirm the loaded copy lacks these files (`diagnostic_record.js`, `terminal_events.js` absent, or
   stamp older than the commit you are installing) — that is the offline test for "is the old build the
   one that had the bug";
3. disable the old unpacked copy before loading the new one, so two content scripts never share a tab;
4. keep the previous directory untouched as the rollback: re-enable it, reload the tab, re-check the stamp.

None of that was executed in this round, and none of it should be executed without the operator present.

## 5. Capability gap, stated as a gap

This repository has no supported channel that wakes ChatGPT while the screen is locked or the tab is
hidden, and nothing here demonstrates that a click works in that state. When the page cannot send, the
honest behaviour — and the one this code now encodes — is: keep the event, show it as pending, and say
which state it is in. `visibilityState: unknown` in a diagnostic record means unknown.
