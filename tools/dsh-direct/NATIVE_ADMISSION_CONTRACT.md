# Native admission contract

What a runtime build must implement before `admissionGate()` may report
`atomic-session-admission-lease` as satisfied, and why prose alone cannot satisfy it.

This document is a contract, not a claim. Nothing here is enabled: `admissionGate()` still
returns `writer_fencing_unavailable` and `DISPATCH_GATE` still blocks every dispatch. The
facts below were established against a staged copy of the shipped runtime at compatibility
baseline `0.2.0-rc.2`; the copies are not committed to this repository (see Publishing in
`AGENTS.md`), so each fact is stated with the operation that produced it rather than shipped
as code.

## 1. The decision belongs at the durable inbox commit

A local writer fence is not enough, and neither is a wrapper. The authoritative moment is the
session's own durable commit of pending input:

```
ReactLoopInbox.mutate(target, start, deleteCount, inserted, discardRemoved)
    -> session.append("agent/inbox/spliced", splice)
```

Every route converges there or bypasses wrappers entirely:

| route | reaches the commit as |
|---|---|
| `ReactLoopAgent.followup` (native prompt, Bridge queue) | `inbox.splice(target, Infinity, 0, [message])` |
| `ReactLoopAgent.steer` / `inject` | the same `send()` call with another target |
| public `Inbox.append` / `prepend` / `replace` / `splice` | `mutate` directly |
| the driver's own step drain (`claim`) | `mutate` with `inserted.length === 0` |
| the loop's tool-context insert | `mutate` from `executeToolCalls` |

Therefore the admission check must run **inside** `mutate`, after the splice is normalised and
**immediately before** `session.append`, with no `await` in between. A check placed before an
`await` is a different, weaker decision: content preparation (model capability lookup,
attachment admission, file-receipt binding) happens asynchronously in the controller, and a
generation handover can land inside that window.

Refusals are synchronous and typed. The message that fails admission must never reach
`session.append`, so the event log itself is the evidence that nothing was admitted.

## 2. What a request must carry

An owner generation envelope, immutable per delivery:

| field | meaning |
|---|---|
| `requestId` | immutable request identity; a repeat with a different payload is a conflict, not a duplicate |
| `sessionId` | the session the envelope was issued for |
| `owner` | the campaign/owner identity holding the generation |
| `generation` | the owner's generation counter |
| `epoch` | monotonic admission epoch for this session; the only value the fence compares |

Two rules that are easy to get wrong:

* **An undeclared field does not survive validation.** The generated request codec is a zod
  object and strips unknown keys even in its strict codec mode, so an envelope that is not
  declared in the codec is silently dropped before the controller ever sees it. Declaring the
  field is part of the contract, not a detail.
* **The route is not the authority.** A native prompt reaches the commit as `followup`, a
  Bridge delivery as `inject`, and a request envelope is issued for the owner generation, not
  for a route. Comparing the envelope's provenance against the committing route refuses every
  genuine native prompt.

## 3. Refusal codes

| code | raised when |
|---|---|
| `admission_required` | an inserted message carries no envelope |
| `admission_unknown_session` | the fence has no generation for this session |
| `admission_session_mismatch` | the envelope belongs to another session |
| `admission_owner_mismatch` | the envelope names an owner that does not hold the live generation |
| `admission_generation_stale` | the envelope's epoch is behind the session's live epoch |
| `admission_released` | the generation was released without a successor |
| `admission_epoch_unknown` | the envelope's epoch was never issued |

At the controller boundary the same refusal must stay distinguishable from a busy agent:
a delivery refused at the commit surfaces as `session/admission-refused` carrying the
boundary's own code, never as `session/agent-busy`. A legacy request that carries no envelope
is refused as `session/admission-required`, an envelope issued for another session as
`session/admission-mismatch`, and a repeated `requestId` bound to a different payload as
`session/request-id-conflict`.

## 4. Exemptions, by name and reason

* `claim` — the driver draining its own queue removes messages; requiring a lease there would
  make a session whose campaign ended unreadable.
* the loop's tool-context insert — formed by the loop mid-step, not delivered by a producer.

Everything else fails closed. An exemption added without a reason in this list is a hole.

## 5. Acceptance observations

A build that claims this contract is accepted only after all four are observed in a new
process generation:

1. a delivery whose envelope predates a handover is refused with `admission_generation_stale`
   and produces no `agent/inbox/spliced` event;
2. a native prompt and a Bridge `followup` under one generation both commit, once each;
3. a handover during content preparation leaves exactly one event, from the newer generation;
4. the step drain still drains a session with no live generation.

## 6. The journal is the commit every producer shares

A fence in the driver's inbox governs the driver. `Session.append()` governs **every** writer, because
it is the single durable commit for pending input: the inbox, a plugin, and a direct
`session.append("agent/inbox/spliced", ...)` all end there, and none of the latter two pass through
`ReactLoopInbox` at all. A decision taken only in the inbox is a decision any other writer can skip.

Three properties of the journal make it the right place, and all three are observable rather than
assumed:

* the payload is snapshotted before the event is built, so a policy sees exactly what would be
  stored, and a refusal throws before the log changes — "nothing committed" is provable from the log
  alone;
* the event is deep-frozen, so an admitted `{owner, generation, epoch}` must be recorded *in* the
  event at append time, not attached afterwards;
* a field the event schema does not know still survives into the log, so the recorded generation is
  readable back on replay without a schema change. (Persisting it as *evidence* across a restart is
  still the replay item in §7.)

The policy must be explicit about what it does not police. Two things are permitted without a lease:
any event type other than `agent/inbox/spliced` (it has its own contract), and a splice whose
`inserted` list is empty (a removal cannot introduce content, and blocking it would make a finished
campaign unreadable). Content insertion is decided by the same authority the inbox consults, over the
same envelopes, so the two gates cannot disagree — the inbox is only the earlier, cheaper refusal.

**Known conflict to resolve in a build, not by loosening the policy.** The loop inserts tool context
into its own inbox under a local `driver-context` exemption. That exemption lives only in the inbox;
at the journal the message is content without an envelope and is refused. An unmodified loop would
lose those inserts. The fix is an identity the authority can verify for internal producers (or a
separate event type for loop-formed context), which is a contract change.

**Internal producers present a capability, never a flag.** The session module mints an opaque,
frozen capability through `grantInternalProducer(session, label, generation)`; the registry is
module-private and keyed by the object itself, so the capability *is* its identity. Four rules make
the grant unforgeable from the wire rather than merely discouraged:

* it travels **out of band**, as `append(type, data, { internal })`; the options object is never
  snapshotted into the event, so a writer that only controls `data` — a controller, a Bridge, a
  plugin replaying JSON — cannot present one;
* it is bound to **one session**: a capability minted for another journal reads as absent and the
  ordinary `admission_required` refusal follows, which leaks nothing about the other session;
* it is bound to **one generation**: after a handover the old capability is refused with
  `admission_generation_stale`, so a loop abandoned by the previous owner cannot keep writing;
* a spread, a `structuredClone` or a JSON round-trip of a valid capability is a value the registry
  has never seen and is refused.

An admitted internal insert records `{owner, generation, epoch, internal: <label>}` in the event, so
a replay reads which internal producer wrote it and under which generation. The boundary defends
against an unprivileged *writer*: code that already runs in the same process and can call
`grantInternalProducer` with the session object is outside it — that is a module-trust question, not
a wire question, and a build should keep the grant in the session package for exactly that reason.

## 7. Still uncovered after the inbox commit is fenced

* raw `Session.append("agent/inbox/spliced", ...)` issued below the driver — either it
  participates in the same authority or it is excluded from the admitted producer set;
* durable replay: if an admitted generation must survive restart as evidence rather than be
  re-derived, the projection schema needs a version bump;
* cancellation (`remove`, `clear`, direct removal) — must be classified deliberately instead
  of inheriting the exemption above;
* every ledger writer (this engine, the Direct server, the Host bridge) must share one
  authority before `all-ledger-writers-coordinated` can be reported as satisfied.
