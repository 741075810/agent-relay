# Optional offline bound handoff receipt contract

`offline_bound_receipt.mjs` is independent of legacy fake transport and coordinator. No production
caller is installed. `createOfflineBoundReceiptAdapter({enabled:false,transport,maxKeys:128})` is
disabled unless enabled is exactly true. The caller must supply a trusted `transport.request`.
There is no network implementation, retry, lease release, task completion or persistent storage here.

Request fields: sessionId, taskId, key, epoch (nonempty UTF-8 strings <=512 bytes), attempt
(positive safe integer), title (string <=32768 UTF-8 bytes). The adapter snapshots/freeze-copies the
request before calling the transport, and checks receipt binding to that exact snapshot.

Explicit transport response:

```json
{
  "outcome": "ack",
  "receipt": {
    "version": 1,
    "receiptId": "synthetic-receipt-1",
    "sessionId": "synthetic-session",
    "taskId": "synthetic-task",
    "key": "synthetic-key",
    "epoch": "synthetic-epoch",
    "attempt": 1
  }
}
```

All five binding fields must match exactly; missing fields are never copied from the request.
`assessBoundReceipt(request,reply)` is a stateless validator returning ack or unknown plus reason.
The adapter also latches each key before awaiting transport. Repeated/concurrent requests, changed
attempt/task for a used key, and reuse of an accepted receiptId return unknown. There is no reset or
cached-ACK replay API. Max distinct keys defaults128, allowed1–1024; capacity returns unknown rather
than evicting evidence. Duplicate receiptId across different keys is detected only after that second
request returns; it does not retroactively prevent that distinct request's first outbound call.

A valid reply returns `{outcome:'ack'}` solely for accepted-handoff bookkeeping. Exceptions, unsupported
failed responses, malformed/missing/mismatched identity and conflicts return `{outcome:'unknown',code}`.
The existing coordinator retains its in-flight lease and escalates unknown acceptance rather than retrying.
The legacy `{outcome,code?}` fake transport remains unchanged and is intentionally insufficient for
this separately opted-in contract. No legacy behavior is implicitly upgraded.

## Trust and persistence limits

Field equality and receiptId uniqueness are correlation/integrity checks, NOT cryptographic provenance,
authenticated upstream acceptance, executed-task completion or exactly-once execution. An untrusted
transport can echo the request and manufacture a matching receipt. Caller must establish transport
provenance and a real receipt protocol independently; tests deliberately use synthetic in-memory receipts.
No production endpoint, schema or receipt signature is invented here.

Latches are per instance and in memory only. New adapter instances/processes lose them. Durable restart
control requires a separately validated checkpoint/intent contract and a trusted single owner; this
module supplies neither filesystem durability nor fencing. It accepts trusted small plain objects, not
arbitrary hostile getters/proxies or unbounded payloads. Never infer permission to restart unknown work
from an empty new adapter. Existing runtime consent remains separate and untouched.

Tests:

```powershell
node --test --test-isolation=none --test-concurrency=1 --test-timeout=10000 test_t095b152_continuation_coordinator.mjs
```
