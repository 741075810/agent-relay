# Installing dsh-direct into DSH Desktop on Windows

A passing suite or isolated Host proves neither that the running Desktop loaded the current module nor that the
original session received a prompt. Record A/B/C independently (last section). When installing from inside that
Desktop, finish and save the task first; defer any required process restart until the task ends. Reopen the **existing**
session after restart, never a replacement.

Target: `@deepseek-ai/dsh-desktop 0.2.0-rc.2`, build `04f392c9ddd144fa426da2045178797da6db6c11`,
`@deepseek-ai/cordis@4.0.4`. Node 22 or 24 supplies the MCP process and `AbortSignal.timeout`.

## 0. Paths and profile loading

| placeholder | meaning / PowerShell variable |
|---|---|
| `<HOME>` | Windows profile: `$HOME_DIR = $env:USERPROFILE` |
| `<REPO>` | repository root: `$REPO = (Resolve-Path '<REPO>').Path` |
| `<DSH_INSTALL>` | Desktop installation: `$env:DSH_INSTALL = '<DSH_INSTALL>'` |
| `<NODE_EXE>` | Node executable: `$NODE = (Get-Command node).Source` |
| `<WORKSPACE>` | the existing session's working directory |

Runtime state is isolated under `<HOME>/.dsh/dsh-direct/`. The Host token is always
`<HOME>/.dsh/dsh-direct/host.token`. Package files live separately under `<HOME>/.dsh/plugins/dsh-direct/`.

On the tested Desktop, the active profile is `<HOME>/.dsh/profiles/desktop`, not the legacy
`<HOME>/.dsh/cordis.patch.yml` layout. `preflight` inspects both layouts. The CLI rejects composing the Electron-owned
profile with `profile "desktop" is managed exclusively by the Electron application`.

| profile file | purpose |
|---|---|
| `package.json` → `dependencies` | resolves the local `dsh-direct` package |
| `package.json` → `dsh.profile.bundles` | lists enabled bundles |
| `cordis.patch.yml` | user override for the bundle's existing `dsh-direct` row |
| `node_modules/dsh-direct` | package-manager link or local directory junction |

Official `plugin_manager`/Plugins settings can hot-apply Include/configuration changes. On this build `include:hmr`
has `root: []`: changing an **already imported** JavaScript file does not replace its cached module generation. A first
import may hot-load; a failed import followed by source repair may require a process restart. Do not promise that
bundle disable/enable reloads source. The manager documents: "Package replacements require restarting the process to
load a fresh JavaScript module generation."

## 1. Preflight and backups (before editing profile files)

```powershell
$HOME_DIR = $env:USERPROFILE
$REPO = (Resolve-Path '<REPO>').Path
$NODE = (Get-Command node).Source
$env:DSH_INSTALL = '<DSH_INSTALL>'
$PROFILE_DIR = Join-Path $HOME_DIR '.dsh\profiles\desktop'
& $NODE "$REPO\tools\dsh-direct\preflight.mjs" --package "$REPO\tools\dsh-direct\plugin" --port 42731
if ($LASTEXITCODE -ne 0) { throw 'Resolve the preflight failures before installing.' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($name in 'package.json','cordis.patch.yml','pnpm-lock.yaml') {
  $file = Join-Path $PROFILE_DIR $name
  if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination "$file.bak-dsh-direct-$stamp" }
}
```

Expect package/import/patch/compatibility/document checks `ok`; a new install needs port 42731 free.
`config.schema` remains `not-checked` until step 4 creates the MCP config. Preflight never writes or restarts anything.
For an upgrade, preserve existing plugin files and runtime config too; keep the token and task ledger.

## 2. Generate the local Host token

```powershell
$base = Join-Path $HOME_DIR '.dsh\dsh-direct'
New-Item -ItemType Directory -Path $base -Force | Out-Null
$tokenFile = Join-Path $base 'host.token'
if (-not (Test-Path -LiteralPath $tokenFile)) {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  (($bytes | ForEach-Object { $_.ToString('x2') }) -join '') |
    Set-Content -LiteralPath $tokenFile -NoNewline -Encoding ascii
}
icacls $tokenFile /inheritance:r /grant:r "$($env:USERNAME):(R)"
if ($LASTEXITCODE -ne 0) { throw 'Token ACL update failed.' }
```

The token contains 32 random bytes as 64 hex characters; preflight reports length, never the value. Verify the ACL with
`icacls $tokenFile`. A Windows mode `0600` alone does not establish a private ACL. Never replace an existing token
while its Host is running: that Host reads its token at initialization.

## 3. Copy the declared package and resolve it in the profile

```powershell
$src = Join-Path $REPO 'tools\dsh-direct\plugin'
$dst = Join-Path $HOME_DIR '.dsh\plugins\dsh-direct'
New-Item -ItemType Directory -Path (Join-Path $dst 'lib') -Force | Out-Null
Copy-Item -Path (Join-Path $src 'lib\*') -Destination (Join-Path $dst 'lib') -Force
Copy-Item -Path (Join-Path $src 'package.json'),(Join-Path $src 'cordis.patch.yml'),(Join-Path $src 'README.md') -Destination $dst -Force
Get-ChildItem -LiteralPath $dst -Recurse -File | Select-Object FullName,Length
```

Nine files: `package.json`, `cordis.patch.yml`, `README.md`, and `lib/{index.js,protocol.mjs,session_api.mjs,endpoint.mjs,
adapters.mjs,host_bridge.mjs}`. `sync.mjs` is a development script, not a runtime dependency.

Merge this **one property** into the existing profile manifest's `dependencies`, preserving every other dependency
and setting. This fragment is not a replacement for the manifest:

```json
"dsh-direct": "file:../../plugins/dsh-direct"
```

For the local package, create a junction without replacing the profile's dependency tree or invoking a profile-wide
package upgrade. The manifest entry and junction must agree:

```powershell
$link = Join-Path $PROFILE_DIR 'node_modules\dsh-direct'
if (-not (Test-Path -LiteralPath $link)) {
  New-Item -ItemType Junction -Path $link -Target $dst | Out-Null
}
Get-Item -LiteralPath $link | Select-Object FullName,LinkType,Target
```

If the link exists, check that its target is `$dst`; do not delete an unknown directory. The manifest records the local
dependency, but this manual junction does not refresh `pnpm-lock.yaml`. Use the profile's official package manager for
future package operations and recheck package resolution afterwards; do not claim a frozen-lockfile install was run.

## 4. Configure one existing session, then enable the bundle

The package's patch already inserts `id: dsh-direct`. Add or update **one plain override**, not another `insert:` in
`<HOME>/.dsh/profiles/desktop/cordis.patch.yml`. Expand `<HOME>` and replace the synthetic session id with the existing
session id before saving. Preserve other rows and the file's custom YAML tags.

```yaml
- id: dsh-direct
  disabled: false
  config:
    tokenFile: '<HOME>/.dsh/dsh-direct/host.token'
    endpointFile: '<HOME>/.dsh/dsh-direct/endpoint.json'
    port: 42731
    boundSessionIds:
      - 'session-XXXXXXXX-XXXX-4XXX-8XXX-XXXXXXXXXXXX'
```

Single-quoted YAML keeps backslashes literal; forward slashes work too. The listener is fixed to `127.0.0.1` in the
plugin: no public-host configuration is exposed. Keep both endpoint descriptor and pinned port for this deployment.
Omitting `port` is supported only when `endpointFile` is present; that configuration chooses a dynamic port.

Create `<HOME>/.dsh/dsh-direct/config.json` for the external MCP, using expanded paths and the **same** session id:

```json
{
  "endpointFile": "<HOME>/.dsh/dsh-direct/endpoint.json",
  "tokenFile": "<HOME>/.dsh/dsh-direct/host.token",
  "stateDir": "<HOME>/.dsh/dsh-direct/state",
  "boundSessionIds": ["session-XXXXXXXX-XXXX-4XXX-8XXX-XXXXXXXXXXXX"],
  "boundCwds": [],
  "boundProjectIds": [],
  "maxPolls": 3
}
```

Leave `boundCwds` empty for an id-only binding: ids and cwd bindings are alternatives, not an intersection.
`endpointFile` and `hostUrl` are mutually exclusive. A fixed `hostUrl: http://127.0.0.1:42731` works only while that port
remains pinned; the descriptor additionally carries a per-bind `endpointId` checked against `/health`.

Use the official Plugins settings or the host tool (list bundles first to confirm the exact identifier):

```text
plugin_manager {"action":"list_bundles"}
plugin_manager {"action":"set_bundle","target":"dsh-direct","enabled":true}
```

`application: applied` reports a composition change; `application: failed` includes the entry's loader error. Neither
alone proves a current, functioning listener. Keep the bundle enabled as the requested installation; it is not a
temporary diagnostic switch.

## 5. Verify loading; defer a required restart until the current task ends

For a repaired module already cached in the live Desktop, record the old descriptor's `pid` and `endpointId`, save the
work and final recovery instructions, then have the operator exit/reopen Desktop **after this task ends**. Do not kill
Desktop, schedule an automatic restart, replace its core modules, or create another session to bypass this condition.

After restart, verify a fresh descriptor and a listener owned by the new Desktop Host process:

```powershell
& $NODE "$REPO\tools\dsh-direct\preflight.mjs" --package "$REPO\tools\dsh-direct\plugin" --config (Join-Path $base 'config.json')
Get-NetTCPConnection -LocalPort 42731 -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess
Invoke-RestMethod 'http://127.0.0.1:42731/health'
```

Expect `127.0.0.1`, `kind: cordis_session_controller`, `protocol: dsh-api-session-controller@0.2.0-rc.2`, required
capabilities `list,prompt,page,projections`, and matching endpointId. `/health` is intentionally unauthenticated;
`/sessions`, `/prompt`, `/events` and `/admission` require the private bearer token.

A health response is **not** a loaded-code fingerprint. A prior failed activation may have left an ownerless listener.
If the old pid/endpointId still serves, or the manager reports activation failure, do not grade B as passed. Check
`bind_failed` and port ownership; do not hide an old listener by choosing another port.

Implementation contracts verified against this build: Cordis rejects undeclared `ctx` assignments; plugin lifetime is
owned with `ctx.effect`, not an assumed `dispose` event. `prompt` and `page` require real AbortSignals. History `page`
needs a finite cursor from `projections().asOfSeq`; `throughSeq: -1` selects an empty prefix, not the latest history.

## 6. Register the self-built MCP locally

For a client launching a stdio server (substitute its absolute Node and repository paths):

```json
{
  "mcpServers": {
    "dsh-direct": {
      "command": "<NODE_EXE>",
      "args": ["<REPO>/tools/dsh-direct/mcp_server.mjs", "--config", "<HOME>/.dsh/dsh-direct/config.json"]
    }
  }
}
```

`preflight --config` should report config/token/endpoint identity checks `ok`. Registration here is for a local MCP
client, not a cloud web connector. No public port, tunnel, Chrome extension change, or notification change is needed.

### Optional Streamable HTTP transport

Stdio is the default. For a local HTTP MCP client only, generate another 32-random-byte token in
`<HOME>/.dsh/dsh-direct/http.token` using step 2's method and ACL, then add this block to the MCP config:

```json
"http": {
  "enabled": true,
  "port": 42732,
  "path": "/mcp",
  "authTokenFile": "<HOME>/.dsh/dsh-direct/http.token",
  "allowedOrigins": [],
  "maxBodyBytes": 1048576,
  "requestTimeoutMs": 120000,
  "maxSessions": 16,
  "maxConcurrentRequests": 8
}
```

Never reuse `host.token` for this surface. The HTTP listener remains `127.0.0.1`; an empty Origin allowlist is appropriate
for a local CLI. Start `node <REPO>/tools/dsh-direct/mcp_server.mjs --config <HOME>/.dsh/dsh-direct/config.json` from a
separate terminal. POST `initialize` with bearer auth, JSON content type and `Accept: application/json`; expect 200,
`Mcp-Session-Id` and negotiated protocol `2025-11-25`. GET returns 405; missing auth 401; foreign Origin 403; oversized
body 413. This local transport does not provide a remotely reachable ChatGPT Web connector, and one is not needed for C.

## 7. One live dispatch into the original session (C)

1. Run the verifier from a separate local terminal after the installation task ends. `list_sessions` must return exactly
   the bound original id with `running: false` and `agentAvailable: true`. Busy, missing or unknown means **stop**.
2. Send exactly one inert prompt with one recorded requestId, for example
   `submit_task {"requestId":"manual-check-0001","sessionId":"<bound>","prompt":"Reply only: DIRECT-OK"}`.
3. Preserve taskId, requestId and receipt. If state is running, poll `get_result {taskId}` every 5 seconds for at most
   180 seconds; `task_not_finished` means wait, not resend. A timeout is pending evidence, not permission for another
   requestId. `get_result` refreshes history without re-admitting the prompt.
4. Success requires the exact request's `user/message.data.source.rpcId`, the associated turn, a completed `turn/end`
   and the expected assistant reply. Old/intermediate assistant text is not proof. Record the direct endpointId/pid,
   MCP task ledger and `(sessionId, requestId, turnId)` join. This path is MCP → private loopback listener →
   `ctx.sessionController`; the separate Bridge connector is a consumer of that service, not a hop on this path.
5. If admission is unsettled, preserve its ledger. `reconcile_task {taskId}` first checks durable evidence; supplying
   the original `prompt` permits a same-requestId retry **only after idle is confirmed**. Never erase the ledger or
   invent a new requestId to bypass an unresolved task. Restarting with an in-flight task is not success evidence.

A dynamic-port restart check is a separate optional test. With pinned port 42731, `hostUrl` may still work after restart;
there is no requirement that it fail. Do not inject extra test prompts or kill MCP clients during the one-message check.

## Rollback and uninstall

First disable the bundle through `plugin_manager` (`set_bundle`, `target: dsh-direct`, `enabled: false`). Verify whether
the listener closes; a known old leaked generation needs a deferred Desktop process restart. Keep authentication and
ledger files until that listener has stopped. Do not terminate the Desktop hosting an active task.

To uninstall after exit, remove only the `dsh-direct` override, its dependency, and its bundle entry, preserving all
unrelated settings. Remove the junction itself (`cmd /c rmdir "<HOME>\.dsh\profiles\desktop\node_modules\dsh-direct"`,
no `/s`); then archive/remove the package and plugin runtime directory. Retain task evidence first.

For emergency restoration with Desktop closed, restore the timestamped package/patch/lock backups **only if no later
unrelated configuration edits occurred**. Otherwise remove only the plugin-specific additions. Reopen Desktop and run
`preflight --port 42731`: it should report that port free. This does not require uninstalling other plugins.

## Acceptance record

| level | required evidence |
|---|---|
| **A** | exact committed SHA; targeted suites; full clean-clone release gate; Windows and Ubuntu CI for that SHA |
| **B** | current real Desktop loads the installed module; fresh descriptor; correct loopback listener/process; authenticated session list |
| **C** | original session confirmed idle; one MCP dispatch; exact request/turn/result correlation; direct-path receipt |

An isolated real Host test is supporting integration evidence, not B for the user's Desktop. A healthy leaked listener
or an accepted-but-unfinished request is not C. Keep per-machine logs/status outside this source repository.
