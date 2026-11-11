# T337 supported Direct writer boundary — mandatory, scoped, not Host-wide

## Implemented source guarantee

Every updated `TaskStore.accept`, `stage` and `transition` uses `.direct-writer.lock` acquired with
exclusive `openSync(..., 'wx')` in the canonical state directory. Updated `DirectServer.submitTask`,
`reconcileTask` and collecting `getResult` hold that same reservation across asynchronous Host work;
`assertWriterHeld` runs immediately before `HostClient.prompt`. Both MCP transports share these
methods. A legacy-shaped request through the UPDATED server needs no new optional flag: contention
returns `direct_writer_held` before Host access. Injecting an unrelated/uncoordinated store is rejected.

Ownership is a random per-acquisition token, checked before mutation/commit and before release. It
is not a monotonic distributed fencing epoch. There is **no expiry, takeover, PID-based reclaim or
automatic crash cleanup**; thus a paused/dead owner never loses its reservation to a successor through
this implementation. Same-process async contexts retain that token; a late callback after release is
rejected rather than silently reacquiring. A returned promise must cover the entire operation.

T352 adds a per-lease `generation` to the lock record (`version: 2`) and to the ledger it writes
(`doc.writer = { generation, pid, at }`). The generation names the writer that produced the current
bytes; it is **evidence, not a fence**, because a legitimate takeover inherits a document that names
its predecessor. Ownership is still decided by exact lock-body equality. The `writer` record is
additive: the ledger stays a version 1 document and older readers ignore it.

T352 also changed release. It used to check the body and then unlink by name; between those two
statements the file could be replaced by an external delete plus another writer's acquire, and the
unlink would then delete that newer owner's record. Release now renames the file aside atomically,
compares what it actually took, and when the record is not ours it restores those bytes under the
lock name (`flag: 'wx'`, so it never clobbers a third record) and refuses with `direct_writer_lost`
plus `restored`. Residual window, stated exactly: if another writer creates the lock between our
park and our restore, the restore is skipped and the parked copy is left as `<lock>.release-<owner>`
evidence. No portable compare-and-delete exists, so this narrows and repairs the damage instead of
eliminating the race.

A loaded ledger's original bytes must still match before each write. A stale instance returns
`direct_writer_stale`, preserves the reservation and does not merge or overwrite another snapshot.
The writer creates an exclusive random temporary file, writes all bytes, fsyncs, rechecks ownership
and snapshot, then renames. Failed writes retain their temp/reservation; in-memory mutation rolls back.
Validation/serialization errors before disk writing leave the disk unchanged. There is no claim of
full multi-step rollback: accepted task records and admission stages already committed remain evidence.
No unconditional power-loss/directory-fsync durability is claimed.

Codes: `direct_writer_held`, `direct_writer_unavailable`, `direct_writer_lost`, `direct_writer_stale`,
`direct_writer_preserved`, `direct_writer_required`, `direct_writer_reentrant`. These are structured
DirectError codes at the server boundary, not Host error statuses. There is no retry/steal override.

Read-only getTask and already-terminal getResult keep their existing snapshot semantics and do not
acquire a write reservation. They do not certify that the snapshot is the newest disk state. Open a
fresh reader for current evidence; do not overwrite production state to refresh it.

## What this does NOT enforce

- Old installed binaries / copied old TaskStore code do not know this reservation. Their direct disk
  writes are not denied by the OS. The byte check detects observed drift, not an atomic defense against
  an old writer changing the file between comparison and rename.
- Raw bearer-authenticated POST `/prompt`, another HostClient, and the installed Bridge connector's
  `ctx.sessionController.prompt` are outside this Direct boundary. The running Host checks no owner
  token. All paths require enforcement at the common native admission service before Host-wide claims.
- Same-account hostile code can unlink/edit files or override JavaScript methods. This is cooperative
  process correctness enforced in the updated API, not an ACL/security boundary against that account.
- The reservation is per Direct operation/ledger, NOT a productive campaign ownership lease. It does
  not prevent an unrelated compliant client acting between successive owner operations. The T336
  `lease.assertHeld` contract is still unsatisfied; the productive CLI remains fail-closed.

No migration, configuration/ACL change or installed Host patch is included. Existing canary journals
and `.completion-owner` are independent and remain untouched. Existing long-lived old clients need a
coordinated deployment, not a source-only assumption. Do not use the live ledger to test this change.

## Focused tests and failure evidence

```powershell
node --test --test-isolation=none --test-concurrency=1 --test-timeout=15000 test_t337_writer_boundary.mjs test_t336_productive_owner.mjs test_t276_task_lifecycle.mjs test_t285_restart_recovery.mjs
node test_t352_writer_generation.mjs
```

The six T337 cases use temporary state, real Node processes and one known task:

- one updated DirectServer holds an admission while another process attempts submit/reconcile/result
  collection and direct accept/stage/transition; all six reject with zero contender Host calls;
- killing an owner after a persisted task checkpoint leaves the reservation; no subsequent writer
  reclaims it or changes that task;
- validation/serialization failure rolls memory back and leaves disk unchanged;
- a real Windows read handle WITHOUT delete sharing causes rename denial; prior ledger survives,
  temp/lock remain, and the next writer is rejected after that handle closes;
- stale snapshots and replaced lock tokens never overwrite/unlink the newer evidence;
- an unfenced injected store and a late async writer are rejected.

The eight T352 cases add the replaced-owner path in detail: a lock swapped under a live lease is
restored byte for byte instead of deleted; legacy (`version: 1`) and malformed bodies are preserved
verbatim; a stale owner's `stage` is refused with the ledger unchanged and the newer record intact; the
generation in `doc.writer` changes per lease while the document still validates as version 1; a
preserved lease neither writes nor releases; and the reservation is present inside the rename and gone
afterwards.

Host behavior in contention tests is a counting fixture, not a real model request. No canary/productive
prompt is issued. Existing T336 tests use real temp Git/PowerShell artifact checks, not live acceptance.

## Deployment gate and recovery

First designate one authoritative ledger writer OR upgrade every permitted ledger-writing client to a
shared boundary. Put campaign ownership at the common native prompt-admission service, covering Direct,
Bridge and other callers; reject absent/stale owner generations atomically with admission. Verify both
legacy rejection and non-owner rejection without mutating real task history. Installed API inspection
currently exposes no supported method for activating such a policy without changing running services.
This work does not invent or hot-patch one; no productive registration is armed.

A preserved writer reservation requires exact owner termination/quiescence and ledger/Host outcome
inspection before any separately authorized recovery. A PID or elapsed time alone is not proof. No
recovery/delete command is shipped: existing unknown receipts, temp data and historical journals stay
intact. This stricter failure behavior intentionally prefers blocked progress over duplicate admission.
