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
