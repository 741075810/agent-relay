# dsh-direct (Cordis plugin)

The Host half of `tools/dsh-direct`: a plugin row that starts a loopback session bridge inside the **existing** DSH
Desktop Host, using `ctx.sessionController` — the same object the Desktop UI uses.

It never creates a session, never prompts outside `config.boundSessionIds`, never opens a public port, and refuses to
start at all when the Host cannot do the job (see the table in `../INSTALL-WINDOWS.md` §4).

## Layout

```
package.json        Cordis plugin manifest (type: module, main: ./lib/index.js, dsh.bundle.patch)
cordis.patch.yml    the bundle row: inserts id `dsh-direct` with an empty config
lib/index.js        apply(ctx, config) / inspectHost(ctx, config)
lib/protocol.mjs    \  copies of the runtime modules, synced byte-for-byte
lib/session_api.mjs  | from ../ by `node sync.mjs`; test_t272_plugin.mjs fails if any copy drifts,
lib/adapters.mjs     | because a Cordis plugin cannot import outside its own directory
lib/host_bridge.mjs /
sync.mjs            the copy step (idempotent; `--dry-run` reports only)
```

## Lifecycle

`apply` returns a disposer and also registers the same teardown on the Cordis `dispose` event, so a host that ignores
the return value still gets the socket closed. `dispose` returns a promise that resolves only after the listener is
gone — a plugin that unloads must not leave a bound port behind.

```js
export const name = 'dsh-direct';
export const inject = ['sessionController'];
export function apply(ctx, config) { /* ... */ }
```

`inspectHost(ctx, config)` reports `capabilities`, `boundSessionIds` and `tokenFile` without binding anything, for a
dry check before installing.
