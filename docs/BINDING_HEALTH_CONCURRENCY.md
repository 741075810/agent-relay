# Binding health checks and concurrent manual rebinding

`createTargetBindingController().health()` observes a previously confirmed binding.
It does not authorise a send. A probe begun for an old binding must not persist
invalidation against a new manual confirmation merely because the tab is the same.

## Failure reproduced

The former epoch-change branch called `invalidate(tabId, reason)` before checking
binding revision. A delayed health response could therefore follow this sequence:

1. Start health for revision 1.
2. A loading event invalidates revision 1.
3. The operator explicitly confirms a new document in the same tab, revision 2.
4. A fresh health check reports revision 2 healthy.
5. The old response returns and incorrectly invalidates revision 2.

An additional read/check followed by an asynchronous, unconditional invalidation
leaves a second race: a legitimate bind may already own the mutation queue while
health reads the previous storage snapshot. Comparing revision alone also misses
clear/bind ABA because revision can be reused.

## Guard

Health finalization runs in the controller's existing `mutate` queue. In that
single decision it compares the initiating binding's revision, boundAt, tab,
window, URL, conversation and document identity against the latest stored binding.
A worker-local generation token changes on accepted manual bind/clear decisions;
health captures it before its initial asynchronous read. This detects even a
same-millisecond clear/bind with byte-identical persisted identity fields.

- A mismatch returns `binding_changed_during_health_check`, with no storage write,
  candidate deletion or epoch increment.
- A matching, already invalidated binding retains its first reason and time.
- A matching binding is assessed against the probe and current navigation epoch.
  Only that same serialized decision may persist a new invalidation.
- Healthy/transient results remain non-writing and `sendEligible:false`.
- Browser loading, URL, close, replace and window-move events retain their
  unconditional fail-closed handling.

The generation token is not persisted and changes before the attempted storage
write. A failed bind/clear write can conservatively reject an outstanding health
result; a new health check can observe the unchanged binding. It neither restores
an invalidated binding nor grants consent. The token is worker-local because a
worker restart has no surviving old health promise. The controller remains a
single-writer component, not a cross-worker storage transaction protocol.

## Regression suite

```sh
node --test --test-timeout=10000 test_t291_binding_health_race.mjs
```

The suite uses the real controller, policy and readonly probe with cloned in-memory
storage/tabs. Gates delay real probe responses and storage operations, not a mock
of `health()`. It covers stale epoch results, candidate/epoch preservation,
first-cause retention, revision reuse, same-millisecond ABA, a bind already owning
the write queue, concurrent health results, and navigation during finalization.
No browser, native host, production state, terminal event or send entry point is
used. The Windows gate discovers the suite; the Ubuntu job runs it explicitly.

This is a source-level concurrency regression. It does not establish the cause
of any particular historical notification. Current binding storage is not a
historical attempt snapshot. The change does not modify the storage schema,
strict `armedAt < endedAtMs` rule, historical-run deduplication or page-send gate.

Publishing source and updating the installed extension are separate operations.
The release gate reports configured disk drift; it does not copy files, reload
Chrome, recover consent or replay previously blocked notifications.
