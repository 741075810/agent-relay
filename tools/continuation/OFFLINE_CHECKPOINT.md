# Offline filesystem checkpoint store

`offline_checkpoint_store.mjs` exports `createOfflineCheckpointStore({directory, identity, enabled=false, fault})`.
No import connects it to the coordinator, transport, DSH, Bridge or Chrome. The caller must supply an
existing absolute path to an isolated directory. Disabled read/write return `disabled` without filesystem I/O.

Identity: `{sessionId, goalId, goalRevision}`; IDs1–512 UTF-8 bytes, revision a positive safe integer.
Envelope: `{version:1, sessionId, goalId, goalRevision, checkpoint:<JSON string>}`.
Checkpoint: object with `version:1`, matching sessionId, and object-valued state/store.
Extra envelope fields may carry raw ledger text, plan and recovery decision. Their semantic correctness
is NOT validated by this store. Validate recovery and full checkpoint semantics before considering any handoff.
The checksum detects accidental corruption, not hostile tampering or authentic authorization.

Limits: checkpoint string64KiB UTF-8; complete stored wrapper256KiB; reads allocate at most256KiB+1.
Stored wrapper is `{version:1,payload:<envelope JSON>,sha256:<payload hash>}` with strict UTF-8 decoding.
The input is a trusted, small plain object: constructing/serializing arbitrarily huge caller objects is
outside the bounded-file contract. Errors return codes, not filesystem paths or exception details.

Write protocol:

1. Refuse unresolved `checkpoint.intent` or `checkpoint.pending`.
2. Exclusively create intent, write marker, `FileHandle.sync()`, close.
3. Validate existing checkpoint (if any) and new envelope. Corrupt old bytes are not overwritten.
4. Exclusively create same-directory pending file, write, sync, close.
5. Rename pending to `checkpoint.json`. Never delete old target and retry on a rename failure.
6. Read back bounded bytes and require exact match plus checksum/validation.
7. Remove intent only after successful readback; return success.

Any error poisons this instance. Partial/ambiguous files remain for diagnosis. A new reader refuses any
intent/pending file, even when an old clean checkpoint remains. No automatic cleanup, retry, rollback,
old-generation fallback or dispatch occurs. There is deliberately no clear-poison/repair API.
`fault(stage)` is an optional isolated-test seam: after_intent, after_write, before_rename, after_rename.
It is not a production persistence callback.

## Guarantee boundaries (especially Windows)

This is not an unconditional power-loss transaction. FileHandle.sync requests a file flush (not merely
close); neither fsync/fdatasync nor same-directory rename guarantees persistence across every Windows
filesystem, controller cache, power cut, antivirus/share lock or network mount. Directory metadata is
not fsynced by this implementation. Power loss can affect intent creation/removal and rename ordering.
Rename replacement failure returns storage_error with evidence retained; successful Windows replacement
was exercised locally in temporary fixtures, not proven for every volume or sharing configuration.

If the intent itself cannot be created, the current instance refuses subsequent reads, but a fresh process
may have no durable evidence of that attempted write. An external authoritative generation/intent record
is required to rule out stale-state use across that boundary. **Do not automatically restore/retry after
an unexplained restart merely because a clean target is readable.** Total metadata loss is not solved here.

Trusted directory and caller-enforced single ownership are prerequisites, not guarantees provided here.
The in-instance busy flag and exclusive create do not provide cross-process coordination, fencing,
identity attestation or protection from directory symlink/reparse-point races. No multi-owner safety is
claimed. A caller must not connect this directly to a live dispatcher based on these tests.

Tests use only temporary directories and clean up their own synthetic data. Run:

```powershell
node --test --test-timeout=10000 test_t095b161b_round_recovery.mjs
```
