# One-shot Host exit metadata

`host_exit_snapshot.ps1` is an external-operator diagnostic for Windows PowerShell 5.1 or PowerShell 7 on Windows. It writes one compact JSON object to stdout, never a file. Running without parameters returns `not_requested` and performs **zero OS queries**. No scheduled task, service, background watcher, process launch/termination, browser access or runtime configuration change.

Use from an already available PowerShell outside the Host. Supply the previously recorded target PID **and exact UTC creation timestamp**, plus an explicit UTC event window of at most 300 seconds. Example values below are synthetic:

```powershell
.\tools\diagnostics\host_exit_snapshot.ps1 `
  -TargetProcessId 4242 `
  -ExpectedCreatedUtc '2026-01-01T00:00:00.0000000Z' `
  -StartUtc '2026-01-01T00:01:00Z' `
  -EndUtc '2026-01-01T00:05:00Z'
```

Do not guess creation time from a task timestamp. If the old process is gone, `absent_both_samples` is evidence of absence at those samples, not its exit reason. If a PID is reused, `mismatch_or_pid_reused` forbids attributing the returned memory to the old Host. Matching before/after samples proves only sampled identity, not continuous liveness. `query_error`, `metadata_missing`, `absent` and `no_matching_events` remain distinct.

## Hard bounds and redaction

- Two exact-PID CIM calls, requesting only PID, creation time, private bytes and working set; each has `OperationTimeoutSec=2`.
- One Application query: event IDs 1000, 1001, 1002, 1026. Only with `-IncludeServiceEvents`, one additional System query: 7031, 7034. SCM events concern services; a desktop Host is not automatically a service.
- Each event query requests at most 9 records, emits 8, and uses the ninth as a truncation sentinel. Events are selected by time/ID, **not attributed to the target process**. Every event has `targetAttribution=UNKNOWN`; unrelated applications can consume the cap. No backfill/second page.
- Event output contains only numeric ID/record ID, UTC time and an allowlisted provider name. No Message formatting, XML, Properties, exception strings, file paths, command lines, environments, cookies, tokens or dumps. This intentionally gives correlation handles, not exception codes or proof of OOM. A separately authorized future provider-specific extraction can inspect a selected event externally; this script does not do it.
- JSON ceiling: 16,384 UTF-8 bytes (plus the shell output newline). Overflow emits only `output_limit`. Invalid/partial inputs return `invalid_request` before any query. Consume the JSON state, not just shell exit status.
- `Get-WinEvent` has no hard wall-clock deadline here: narrow filters and record limits bound returned data, not Windows event-service latency or internal memory. An external execution runner may impose a **15-second timeout** on this one-shot process. Do not launch it through a memory-stressed Host, and do not implement an in-Host retry loop.
- `cause=UNKNOWN` always. OS private bytes and working set are not V8 heap used/limit; absent events and high memory do not prove OOM. Persistent/sensitive event payloads and historical session/ledger content are never read by this script.

No same-Host guard is claimed: external execution is an operating precondition, not a process-tree discovery feature. No installation is required.

## Offline test

```powershell
powershell.exe -NoProfile -File .\tools\diagnostics\test_host_exit_snapshot.ps1
```

All CIM and Event Log calls are function mocks; no production collection. Tests cover no-argument/invalid-input zero-query behavior, UTC/window limits, exact PID/property/query caps, identity continuity/reuse/absence, memory fields, event truncation, optional SCM selection, errors vs absence, redaction and JSON size. Run in a fresh short-lived shell (the mock test uses namespaced global counters). No Pester dependency. Additional boundaries explicitly cover unknown-provider redaction, exactly eight records without truncation, a successful empty event result (distinct from an event-query error), and a stable PID whose creation timestamp differs from the expected identity.

## Windows Actions

The dedicated `diagnostics.yml` workflow runs this same mock script using Windows PowerShell on `windows-latest`, with a three-minute job timeout and read-only repository permissions. Push/PR path filters include only `tools/diagnostics/**` and that workflow. No OS production collection or external Host deployment occurs. Diagnostics-only changes skip the broad gate; mixed changes and edits to the broad gate itself still run it. Manual workflow dispatch remains available; no Python/Node dependencies or live Host are required.
