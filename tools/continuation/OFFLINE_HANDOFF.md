# Explicit one-shot offline handoff boundary

`offline_handoff.mjs` is a direct-import-only utility; no production entrypoint imports it. It neither
creates a coordinator nor enables its grant. Legacy coordinator and fake transport source are unchanged.

Small API:

```js
const boundary = createOfflineHandoff({
  enabled: false, // explicit true only in isolated offline fixtures
  identity: { sessionId, goalId, goalRevision },
  planDigest, // caller's independently bound approved-plan digest
  store,     // caller-owned trusted single-owner isolated store: async read/write
  transport, // caller-supplied synthetic/trusted transport with explicit bound-receipt contract
});
// Give boundary.bridge to an OFFLINE coordinator at construction/restore time.
// No live coordinator bridge is replaced by this utility.
const result = await boundary.step(existingOfflineCoordinator, { tailText, goal, plan, at });
```

`step` requires the coordinator to already reference this exact bridge. It rejects absent inputs,
identity/plan mismatch and any non-resume_ok raw-ledger assessment before invoking coordinator.step.
Filtered records are not an input. Existing store errors block; a stored envelope must match expected
identity and the coordinator's current checkpoint exactly. Missing store is allowed ONLY for a caller's
known fresh fixture: this is not authority to reconstruct lost history after an unexplained restart.

At the transport seam, the boundary verifies the actual checkpoint version/session and leased
job session/task/epoch/attempt against the captured request. It writes the original assessment inputs,
decision and leased checkpoint as one envelope, requires exact envelope readback, and rechecks checkpoint
stability before calling the optional bound-receipt adapter. Storage errors return unknown to retain the
coordinator's in-flight lease. Direct bridge calls outside active preflight return unknown without sending.

One step attempt per boundary instance, including rejected evidence. No reset/retry/loop, receipt replay,
lease release, ACK-to-done conversion or auto-rearm API. Bound ACK is only handoff bookkeeping. Post-ACK
settlement persistence is deliberately caller-owned and is NOT performed here; restart from the pre-send
lease remains unknown. T316/T317 tests exercise a separately persisted clean ACK checkpoint and lost settlement.

## Caller obligations and non-guarantees

- Real offline coordinator and store are trusted injected objects. Byte comparison is not semantic
  validation of every store/job/grant field or authenticated identity provenance.
- Caller must bind the goal/session/plan to its fixture, own the directory exclusively, and not mutate
  coordinator state or invoke step/enable/poll/recover concurrently. The one-shot latch is not fencing.
- No schema proving plan tasks correspond to transport tasks, no upstream execution-completion proof,
  no real endpoint/receipt authentication and no production integration are provided.
- A lying store returning fabricated exact bytes defeats readback. A matching receipt from an untrusted
  transport is likewise not proof of remote acceptance. Trusted implementations remain prerequisites.
- File flush/rename/readback is not unconditional Windows power-loss durability. Intent-loss and stale
  generation limitations in OFFLINE_CHECKPOINT.md still apply. Empty storage does not justify replay.
- Returned ack may precede durable ACK settlement. Do not interpret success as release permission or
  invent terminal history to make a later recovery green. Never bypass the guard by calling another bridge.

The existing T316 fixture was refactored to use this module, not duplicated. It covers default-off,
malformed/missing raw input, interior corruption, write throw/loss, post-submit missing/mismatched receipt,
transport throw/unknown, lost settlement, clean handoff and restart with a fresh boundary/adapter.
