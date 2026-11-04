# Finite passive production observation

These three tools fill the missing finite observer, **not** the notification path:
`passive_sources.py` reads metadata, `passive_observer.py` writes independent atomic
samples, and `passive_launcher.py` owns/witnesses only that observer child.
No host invocation, sample/ACK protocol request, service call, browser operation,
notification/replay, grant/binding edit or queue/database write is implemented.

## Inputs and evidence

Explicit private configuration, never committed:

```json
{
  "bridge_db": "BRIDGE_SQLITE",
  "native_state": "NATIVE_STATE_DIR",
  "extension_reader": "AUDITED_EXISTING_PARSER_SCRIPT",
  "extension_reader_sha256": "EXPECTED_CODE_SHA256",
  "block_reader": "AUDITED_EXISTING_BLOCK_PARSER_SCRIPT",
  "block_reader_sha256": "EXPECTED_BLOCK_CODE_SHA256",
  "observer_sha256": "EXPECTED_OBSERVER_CODE_SHA256",
  "sources_sha256": "EXPECTED_SOURCES_CODE_SHA256"
}
```

The optional adapter is for an already-audited local module exposing `L` (pure
`read_varint/read_block/block_entries`, `MAGIC`, `ROOT` and `__file__`),
`wal_batches`, `doc` and `BLOCK`. Both files are byte-pinned before import.
Neither copying `read_store` nor `read_db` wrapper is called. SST/WAL data lives
only in worker memory; no raw Chrome data, page content, URLs, target bindings,
credentials, messages or full Native records are written. Import this adapter
only for audited code; hashes establish bytes, not arbitrary plugin safety.
Hermetic tests use `extension_json` instead, containing synthetic source-shaped
metadata, and never import/read production sources.

- SQLite is `mode=ro`, `query_only=1`, zero busy wait, 100ms SQL progress deadline.
  SELECT projections omit payload/title/text. No backup/DDL/write probe is run live.
- Source task/run/binding joins are exact; binding fan-out refuses the source.
- T0 is after the initial snapshot read interval. T0 terminal set is distinct from
  later status observations. Pre-T0 event timestamps and repeated same-status
  completed events remain historical/duplicate, never new-transition evidence.
- Raw new `task.completed` count and trusted unique task/run count are separate.
  Same-run/different-task conflict quarantines the run. Missing exact event is an
  observability gap, not a reconstructed completion time.
- Native `ackedIds` PRESENT proves persisted consumption. `native_offered`
  remains UNKNOWN; `pendingIds` is not proof a frame was received. Actual ACK time
  is absent; read brackets and observation time are separate.
- Extension values are **observed retained values**, not certified latest state:
  active MANIFEST and checksums are unverified. Per-run `latest_state_evidence`
  and settlement-delay evidence stay UNKNOWN, even when observed state is sent.
- T058 stores no source epoch; its observed armedAt is separate, epoch UNKNOWN.
  T059 observed armEpoch is distinct from per-run postArmEpoch. No historical
  epoch transplantation or consent-qualified SLO assertion occurs.
- Page visibility, model consumption, relay-only and duplicate actual submission
  remain UNKNOWN. Multiple completed events are not duplicate-notice proof.

## Bounds and durability

Python 3.12, standard library. 30s cadence; gaps >45s declared. Duration <=86400s,
256 new run records, 5000 retained task identities, 512 events per cycle, Native
JSON/value/block 4MiB, extension data 16MiB/16files; child read timeout 2s.
The existing Snappy decoder uses bounded output allocation. SQL read locks are
short; schema/limits/source errors are explicit, not zero-completion claims.

All metadata stays in a new dedicated directory. Immutable cycle JSONs rotate by
120 records into numbered directories without overwriting/deleting old evidence.
Each publication is fsync + unique temporary file + atomic replace; same-name
same-bytes is idempotent, different bytes refuse. Reduction uses a candidate copy;
only a published cycle + checkpoint advance committed cursor. Partial publication
sets commit_uncertain and stops, with no restart/replay. Output including temp
checkpoints is capped at 32MiB with final-write reserve; hitting a bound stops.
Code change or >5s wall/monotonic discrepancy stops; a prior directory/lock refuses
startup rather than resetting T0/deadline. Final sample captures the last window
slice [T0,T1). A successful deadline means elapsed observation, not product PASS.

## Startup, inspect, stop

```powershell
# Current-user Interactive/Limited Scheduler action; no elevation, no retry:
pythonw.exe -B tools/passive_launcher.py --config PRIVATE_CONFIG --out NEW_OBSERVATION_DIR --seconds 86400 --interval 30
# Bounded inspection, no production state mutation:
python.exe -B tools/passive_observer.py --status --out NEW_OBSERVATION_DIR
# Graceful stop request touches only this independent output directory:
python.exe -B tools/passive_observer.py --stop --out NEW_OBSERVATION_DIR
# Force-stop/revoke only an exact dedicated Scheduler name if required:
Stop-ScheduledTask -TaskName DEDICATED_OBSERVER_TASK
Unregister-ScheduledTask -TaskName DEDICATED_OBSERVER_TASK -Confirm:$false
```

A direct current-user pythonw Scheduler action is not a DSH background job.
Use one dedicated unique name, `RunLevel Limited`, execution limit 86580s,
trigger EndBoundary, `RestartCount=0`, `MultipleInstances=IgnoreNew`; do not edit
existing tasks. Verify registration **and** actual process identity/creation,
T0/cursor/status plus a later heartbeat from a fresh caller before saying STARTED.
A return code alone is insufficient. A failed T0 is ONLY_PREPARED. Do not wait 24h
in the initiating DSH task; hand off clock/deadline/check/stop commands and end.

`stopped.json` contains finalization, not invented process exit time.
`exit-witness.json` uses an owned child process handle: Windows GetProcessTimes
exit FILETIME gives `exit_actual_at_utc`; other platforms keep exact exit UNKNOWN
and record `exit_observed_at_utc`. Scheduler force-killing the launcher may leave
no witness: report that concrete gap, not a fabricated stop time.

## Verification before publication

```powershell
python -B -m unittest -v test_t095b245_passive_observer
python -B tools/release_gate.py --clean-clone
```

The portable suite is included explicitly in Ubuntu CI; Windows discovery includes
it too. Publish by normal fast-forward only; require both jobs on the exact HEAD.
Private config/real run IDs/reports/live samples remain outside Git. An install
PASS proves configured extension disk bytes, not Chrome loaded runtime. These
tools change no product extension/host bytes and require no deployment or Reload.
