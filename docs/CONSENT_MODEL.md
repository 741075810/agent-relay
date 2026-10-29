# Consent model

Two channels, one gate. This document says exactly what each one requires and which
refusals exist, so a refusal can be read without re-deriving the code.

## Channels

| Origin | How it is decided | What it needs before a notice may be written |
|---|---|---|
| `bridge` | the run appears in the Bridge ledger's `(sessionID, turn)` index | nothing further from the operator — it is automatic by construction |
| `direct` | DSH ran the turn, and the ledger does not account for it | a per-task opt-in recorded **strictly before** that turn's end |
| `unknown` | the channel could not be proven | treated exactly as `direct` |

`unknown` exists because a failed origin read must not become an unattended send. It
degrades channel A to the manual path; it never promotes channel B to automatic.

## The consent rule

```
usable(entry, candidate) =
      entry exists                      else  no_opt_in
  and not entry.consumedAt              else  already_settled
  and entry.armedAt is a positive ms     else  opt_in_unreadable
  and entry.armedAt <= now + 5 min slack else  opt_in_from_the_future
  and now - entry.armedAt <= 7 days      else  opt_in_expired
  and candidate.endedAtMs is a positive int
                                         else  terminal_time_unknown
  and entry.armedAt <  candidate.endedAtMs
                                         else  opt_in_after_terminal
```

Notes that are easy to get wrong:

* **Strict.** `armedAt === endedAtMs` is refused. There is no ordering to prove at one
  instant, and treating that case as "probably before" is precisely the defect that made
  a click after a task finished authorise a notice for it.
* **`endedAtMs`, not `endedAt`.** The latter is whole seconds, kept only so older builds
  can still read a candidate. Reconstructing milliseconds from it is a guess.
* **Unknown is refused, not defaulted.** `terminal_time_unknown` is a real answer.
* There is **no 30-minute TTL on a running opt-in.** That TTL belongs to a click on a
  candidate that had *already ended* (`directArmedAt`). A six-hour task must keep a
  decision made in its second minute; the bounds that replace the TTL are: it names one
  `(session, turn)`, it must predate that turn's end, it expires after 7 days, and the
  store holds at most 100 entries — evicting settled ones before live ones.

## Two kinds of opt-in

| Field | Recorded when | TTL | Used by |
|---|---|---|---|
| `runningArmedAt` | the task was **running**; the popup lists it before it ends | none (bounded as above) | the running panel |
| `directArmedAt` | the task had already **ended** and the operator picked it from the list | 30 min | the T067 candidate path |

`admit()` accepts either. It is one gate with one journal, so whichever consent applied,
a run can only be written once.

## Refusal codes and what they mean to a person

| Code | Meaning | What to do |
|---|---|---|
| `direct_not_opted_in` | nobody asked for this one | click 结束后通知这一条 on it |
| `opt_in_after_terminal` | a click exists, but it came at or after the end | expected; the task was already finished when you clicked |
| `terminal_time_unknown` | no trustworthy end instant for this run | wait for the host to re-offer it, or let it end again naturally |
| `opt_in_expired` | the click is more than 7 days old | click again |
| `already_settled` | this consent already produced (or definitively failed to produce) a notice | nothing; that is single-delivery working |
| `direct_optin_expired` | a **candidate** click older than 30 minutes | click again |
| `origin_unproven` | the channel could not be proven, and no click exists | same as `direct_not_opted_in` |

`opt_in_after_terminal` and `direct_not_opted_in` must never be conflated. The first says
"you clicked, too late"; the second says "you never clicked". Rendering the first as the
second sends someone looking for a button they already pressed.

## The race that is neutralised rather than denied

The host reads the last 2 MiB of an append-only log. If the window cuts between a turn's
final record and its `turn/end`, a just-finished turn looks running for one poll.

That cannot produce a wrong notice: an opt-in taken in that window is recorded **after**
the real end, and once `turn/end` becomes visible `optInUsable` refuses it with
`opt_in_after_terminal`. The window can cost a legitimate consent only if the person
clicks during the one poll in which the task had just died — and then the honest answer
is "too late", which is what they get.

## What never counts as consent

* a prompt or message mentioning the task;
* the task's own text, status, or any file timestamp;
* a previous opt-in for a different turn, or the same turn in a different session;
* a click recorded by a content script (the message handler requires
  `extension_popup_required`);
* a message without a real user gesture;
* an entry written to storage by hand — `armedAt` is the proof, and a hand-written value
  can only ever claim a time, not establish one.

## A refusal may not starve a consent

`direct_not_opted_in` is a correct answer, but it is not an *event*: it writes no journal
entry and removes nothing from the candidate list. That is deliberate — journaling it
would mark a channel-B task as handled for good, so a click on it later could never
produce a notice.

The consequence is that a refused candidate stays queued and will be examined again on
the next tick. The per-tick budget therefore has to bound **work**, not **inspection**:
`runTerminalTrigger` spends it only once `admit()` has returned true, i.e. when a notice
is actually going to be written.

Spending it on inspection instead is what T073 fixed. With the budget applied to the
first N entries of the list, the N oldest channel-B completions — none of them opted
into — were refused on every tick for ever, so nothing behind them was ever looked at.
A live install reached 50 such entries, and a task the operator had explicitly opted into
while it was running finished and was never delivered. The popup had confirmed the click;
the chain had gone quiet; no error was recorded anywhere, because a refusal is not an
error.

The same rule governs capacity. `MAX_CANDIDATES_STORED` reserves room for entries that
can still become a notice — channel A, or channel B with either consent — and treats the
rest as display history that gives up its slot first. A backlog of un-consented
candidates must never be able to make `room` zero, or a fresh completion cannot even be
queued, and the tick never sees it.

Two invariants follow, and `test_t073_candidate_starvation.mjs` asserts both:

* a consented candidate is reached however many un-consented ones precede it, at any
  budget of one or more;
* a tick writes at most `limit` notices, and a second tick does not repeat one.

## A stored authorization is not a running timer

Consent lives in `chrome.storage.local` and survives everything. The alarm that consumes
it lives in Chrome's alarm table and survives nothing — not a browser restart, and, as it
turned out, not an extension reload either.

The two lifecycle hooks are not interchangeable. `onStartup` fires when the *browser*
starts. `onInstalled` fires on install, on update, and on the reload button in
`chrome://extensions`. Reloading an unpacked extension — the normal way to pick up a code
change — fires only the second one. For a while only `onStartup` restored the terminal
alarm, so a reload left the trigger with `enabled: true` in storage and no alarm to wake
it: it never ticked, never sent, and recorded no error, because nothing had run to fail.

What made it expensive to find is that every surface kept reporting health. `lastError`
was null. `terminalChainStatus` was `ok: true` — correctly, since it describes the last
tick, which had succeeded. The popup printed `调度周期：每 0.5 分钟检查一次`, which was not
an observation at all but `terminalAlarmPeriod(state)`, arithmetic on the configured
interval. The extension looked armed and scheduled while doing nothing whatsoever.

Both hooks now call `restoreTerminalAlarm()`, and `t059-trigger-state` reports the alarm
Chrome actually holds (`alarm`) separately from the period the trigger would use
(`alarmExpected`). Three states are now distinguishable, and the popup names them apart:

| `alarm` | `alarmExpected` | meaning |
|---|---|---|
| a number | a number | armed and scheduled at that period |
| `null` | a number | armed but **not** scheduled — the dormant state |
| `null` | `null` | not armed, so there is no period to expect |

The restore itself has to stay narrow, and `test_t095b75_reload_alarm.mjs` asserts each
half of that:

* it creates or clears exactly one alarm and writes nothing else — the trigger record,
  the candidates, the consent store, the T058/T059 grant and the T053 binding all come
  out byte-identical;
* a trigger with `enabled: false` is **never** re-enabled. Restoring a timer is not
  re-authorising anything;
* a second, third or fourth wake-up does not re-create an alarm that already matches.
  Re-creating resets the timer, and a timer reset more often than its own period never
  fires — the same starvation as T073, reached from the other end;
* it never connects to the native host and never messages a tab. Scheduling is a local
  operation, and a restore that needs the host would fail exactly when the host is down.

Failing is allowed; failing silently is not. If the alarm cannot be restored — no
`alarms` permission, a storage read that throws — the install hook still completes, the
queue poller is still scheduled, and a `terminal-alarm-restore-failed` note is recorded,
so the next person reading storage sees the fact that went missing here.

## Reconnecting is not re-authorising

The same reload that clears the alarm table also clears `chrome.storage.session`, and
that is where T053 keeps the operator's confirmed target. It also orphans every content
script already injected into an open page: the page keeps running, the tab keeps its id,
and nothing puts a script back, because declarative content scripts are injected at
document idle and a document that never navigates never reaches document idle again.

So a reload used to cost two things, and only one of them was obvious:

* the binding was gone, so the standing T058/T059 grant had nothing to point at and every
  tick refused `target_not_bound`;
* the probe had no receiver, so there was nothing to measure even if the binding had
  survived.

Refreshing the page fixes the second and *worsens* the first: a refresh is a new document,
a new document is a different target, and the binding is correctly invalidated. That is
why the refresh never helped — it moved the work from "reload the page" to "bind again",
turn after turn.

The fix is two narrow repairs, and the phrase "narrow" is doing real work in both:

* the binding is mirrored into `chrome.storage.local` and rehydrated into the session copy
  on read. **A restore is a claim, not a proof.** Every send already re-probes the tab and
  compares tab, window, url, conversation and document instance before typing; restoring
  the record cannot get past that check, it only saves the operator from retyping
  something the probe can still prove. An invalidated binding comes back invalidated,
  because the mirror carries `invalidatedReason`; a mirror that fails its shape check is
  ignored rather than repaired; and a mirror is only ever written from a value the
  controller itself just wrote, so the two copies cannot disagree about what was
  confirmed.
* a lost content script is re-injected with `chrome.scripting.executeScript`, which is why
  the manifest now requests `scripting` — the one permission T044, T053 and T051 all
  asserted the extension did not need. It is used under conditions that make it an
  observation repair rather than a new capability: the target is the single tab the
  operator already bound, its URL must still equal the bound URL character for
  character, it runs `files: ['content.js']` and never a `func` or a string of code, it
  never touches the main world, and it fires only after a probe has *definitively*
  reported no receiver. A timeout is not that proof — a slow reply may mean a live
  script, and injecting then would run the file twice in one document.

That last hazard is why `content.js` now latches its write path. Two listeners would mean
two notices in one conversation, so the latch is taken synchronously before the first
`await` and released in a `finally`; the second caller is refused with
`concurrent_write_in_flight` instead of racing. One document gets one writer.

And the document id had to stop being an id for a *script* and become an id for a
*document*, or the whole reconnect would be pointless: a re-injected script that
announced a fresh random id would satisfy every gate except the one that matters, and the
operator would be asked to bind again — the exact step the reconnect exists to avoid. It
is now derived from `performance.timeOrigin`, which is fixed when the document is created
and unreadable from the page's own world. Two evaluations in one document reproduce it
exactly. A reload, a navigation or a refresh creates a new document and therefore a new
value, so **T052's rule is untouched**: a stale document is still refused with
`document_instance_changed`. Reconnecting to the document that was confirmed is not the
same act as adopting a new one, and only the first is done silently.

`test_t095b76_reload_binding.mjs` asserts all of it, and `mutate_t095b76.py` proves the
assertions are load-bearing by reverting each half of the fix in turn and requiring the
suite to go red — seven mutations, seven red runs. A test that passes with and without the
fix is a comment.

## Asking why no notice went out

```powershell
python -B tools/notify_doctor.py            # reads state/, writes nothing
python -B tools/notify_doctor.py --json
python -B tools/notify_doctor.py --now 2027-01-15T08:00:00Z
```

The chain has four stages visible on disk and one that is not:

| stage | file | what it answers |
|---|---|---|
| origin | `terminal-origin.json` | has the host read this turn at all |
| source | `terminal-source.json` | is it still pending, or acked, or dropped at the baseline cap |
| arm | `terminal-arm.json` | was the extension armed for it, and how long ago |
| queue | `queue.json` | was it enqueued, was it deliverable, did any consumer take it |
| — | the extension's LevelDB | **not read**; reported as `extension_store_not_read` |

Findings are graded, and the grade is the point. `blocker` means the chain broke: an armed
turn with no queue event (`armed_but_not_enqueued`), a deliverable event nobody took
(`waiting_for_consumer`), an armed window that has already passed over pending turns
(`arm_stale`), or a snapshot timestamped in the future (`clock_skew`). `expected` means
silence is correct here: pending turns that arrived after the snapshot
(`pending_not_armed`), a turn past the baseline cap (`baseline_truncated`), an event marked
undeliverable (`suppressed_by_gate`), nothing pending and nothing armed
(`nothing_to_send`). `chain_intact` is true when there is no blocker.

That distinction exists because the first version of the tool reported a just-ended turn —
pending, and therefore not yet inside any armed snapshot — as a fault. Three quarters of
its findings would have been normal operation, and a diagnostic that cries wolf at normal
operation is read once and then ignored, which leaves the operator exactly where they
started but with a tool they no longer trust.

**Time.** Every numeric timestamp in these artifacts is epoch **seconds**; the extension
side stores **milliseconds**, and `queue.json` events carry `createdAt` as a 20-character
ISO-8601 UTC string. `to_ms` normalises by magnitude in one place and records which unit it
read (`unit_read` in the output). Rendering is UTC+8 computed arithmetically rather than
from the machine's timezone, because a silent hour of skew and a stalled chain look
identical at night. `0` is not treated as an instant: "never delivered" is stored as 0, and
it is 1970 only if you insist.

`test_t095b77_notify_doctor.py` asserts all of it against fabricated fixtures, including
that the state directory is byte-identical before and after a run and that the output
contains no identifier.

