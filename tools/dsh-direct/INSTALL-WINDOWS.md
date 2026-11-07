# Installing dsh-direct into DSH Desktop on Windows

> **Status (T276).** Steps 1–4 were executed on this machine against the live Desktop and are recorded in the task
> report: the token file, the plugin directory, the profile manifest dependency and the profile patch row all exist, and
> a real Host process loaded the plugin and served `/health` — that last measurement was taken with an isolated
> `DSH_HOME` and the *fixed* code, because the already-running Desktop had cached the module generation that failed to
> load (see step 5). One restart of the Desktop is still owed before level B can be claimed for the live instance, and
> level C needs the session that the restart re-creates.

Target build: `@deepseek-ai/dsh-desktop 0.2.0-rc.2`, `dshBuildCommit 04f392c9ddd144fa426da2045178797da6db6c11`.
That build ships `@deepseek-ai/cordis@4.0.4`, which satisfies this plugin's `peerDependencies.cordis: ">=4.0.0-rc <5"`.

## 0. Path convention used in this document

One placeholder per thing, used identically everywhere. Do not translate them by hand — set them once in PowerShell and
read every path from the variable.

| placeholder | meaning | how to get it |
|---|---|---|
| `<HOME>` | your Windows profile directory | `$HOME_DIR = $env:USERPROFILE` |
| `<REPO>` | this repository on disk | `$REPO = (Resolve-Path '<REPO>').Path` |
| `<DSH_INSTALL>` | the Desktop install directory | `$DSH = '<DSH_INSTALL>'` |
| `<NODE_EXE>` | the Node the MCP client will launch | `(Get-Command node).Source` |
| `<WORKSPACE>` | the cwd of the session you bind to | shown in the Desktop session header |

Everything this plugin writes lives under **one** directory: `<HOME>/.dsh/dsh-direct/`. The token file is
`<HOME>/.dsh/dsh-direct/host.token` in every step below — if two steps in an install guide disagree on that path, one of
them is wrong, and `preflight` now fails on exactly that.

## 0b. How a Desktop profile actually loads a plugin

A Desktop install does **not** read `<HOME>/.dsh/cordis.patch.yml`; that root layer belongs to the CLI-era layout and does
not exist on a Desktop machine. The Desktop keeps one profile per surface under `<HOME>/.dsh/profiles/<name>` — `desktop`
for the app itself — and the app declares that profile *managed exclusively by the Electron application*: `dsh --profile
desktop --dump-config` refuses with `profile "desktop" is managed exclusively by the Electron application`. Everything
below therefore happens inside `<HOME>/.dsh/profiles/desktop`:

| file | what it decides | who writes it |
|---|---|---|
| `package.json` `dependencies` | whether the package name `dsh-direct` resolves at all | `pnpm` via the profile's own plugin manager, or a hand-written `file:` entry |
| `package.json` `dsh.profile.bundles` | which bundles are composed, in order | the profile's plugin manager (Plugins page in the app, or the `plugin_manager` tool) |
| `cordis.patch.yml` | the user layer: per-row `config`, `disabled`, `insert` | you, or the plugin manager when it flips a switch |
| `node_modules/<name>` | the resolved package (a symlink or junction for `file:` specs) | `pnpm`, or `New-Item -ItemType Junction` |

What hot-applies and what does not, measured on `0.2.0-rc.2`: the base bundle composes `@deepseek-ai/dsh-hmr`
(`include:hmr`) with `root: []`, so **Include refreshes and profile config changes apply to the running Host** — enabling
a bundle answered `application: "applied"` and the plugin was imported immediately — while **JavaScript module
generations do not change**: a plugin whose source was fixed on disk kept being executed from the old module
(`at new apply (file:///…/lib/index.js:162:26)`), and re-pointing both the junction and the manifest dependency at a
second copy still resolved to the cached URL. A new package, or a fixed one, needs a **Desktop restart**. The plugin
manager says so itself: *"Package replacements require restarting the process to load a fresh JavaScript module
generation."*

One Cordis 4 rule that bites a first-time plugin: a property may not be assigned on `ctx` unless it was declared
(`cannot set property "dshDirect" without provide`). That error is thrown *inside* `apply`, so the whole row fails to
activate — it does not degrade, it just shows up as `1 entry did not activate`. Keep state on the value `apply` returns.

## 1. Run the preflight first (read-only)

```powershell
$REPO = 'E:\ApkTest\agent-relay'   # adapt; nothing is written
node "$REPO\tools\dsh-direct\preflight.mjs" --package "$REPO\tools\dsh-direct\plugin" --port 42731
```

Expected: `package.manifest`, `package.imports`, `package.patch`, `cordis.compat`, `docs.consistency` all `ok`, and
`port.availability` reporting `port 42731 is free on 127.0.0.1`. `config.schema` is `not-checked` until you pass
`--config`; do that in step 6. `install.state` reports the plugin as absent, which is the truth before step 3.

The preflight never binds a port, never restarts the Desktop, never writes anywhere, and never prints the token: it
measures the file and reports the length.

## 2. Create the token file

```powershell
$HOME_DIR = $env:USERPROFILE
$base = Join-Path $HOME_DIR '.dsh\dsh-direct'
New-Item -ItemType Directory -Path $base -Force | Out-Null
$tokenFile = Join-Path $base 'host.token'
if (-not (Test-Path -LiteralPath $tokenFile)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  (($bytes | ForEach-Object { $_.ToString('x2') }) -join '') |
    Set-Content -LiteralPath $tokenFile -NoNewline -Encoding ascii
}
icacls $tokenFile /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null
(Get-Content -LiteralPath $tokenFile -Raw).Length     # expect 64
```

32 random bytes rendered as 64 hex characters. The plugin refuses anything shorter than 32 characters, and the MCP
server refuses an empty or unreadable file. `icacls` matters because Node cannot set a Windows ACL: `0600` is honoured on
POSIX only.

## 3. Copy the plugin package

Copy **exactly what `package.json` `files[]` declares**, plus `package.json` itself. Copying the whole `plugin/`
directory also works, but it drags `sync.mjs` into the plugin home — a build script has no business there, and the
preflight checks the shipped set rather than the directory contents.

```powershell
$REPO = 'E:\ApkTest\agent-relay'
$src  = Join-Path $REPO 'tools\dsh-direct\plugin'
$dst  = Join-Path $HOME_DIR '.dsh\plugins\dsh-direct'
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Copy-Item -Path (Join-Path $src 'lib') -Destination $dst -Recurse -Force
Copy-Item -Path (Join-Path $src 'cordis.patch.yml'),(Join-Path $src 'package.json'),(Join-Path $src 'README.md') -Destination $dst -Force
Get-ChildItem -Recurse $dst -File | Select-Object FullName, Length
```

Expected files: `package.json`, `cordis.patch.yml`, `README.md`, and `lib\` with `index.js`, `protocol.mjs`,
`session_api.mjs`, `endpoint.mjs`, `adapters.mjs`, `host_bridge.mjs`.

## 4. Wire the package into the `desktop` profile, enable it, then give it real values

Three edits, in this order. Do them against `$PROFILE = <HOME>\.dsh\profiles\desktop`; back up first, because the app
rewrites these files itself:

```powershell
$PROFILE = Join-Path $HOME_DIR '.dsh\profiles\desktop'
Copy-Item (Join-Path $PROFILE 'package.json')        (Join-Path $PROFILE 'package.json.bak-before-dsh-direct')
Copy-Item (Join-Path $PROFILE 'cordis.patch.yml')    (Join-Path $PROFILE 'cordis.patch.yml.bak-before-dsh-direct')
```

**4a — make the name resolvable.** Add the dependency (relative to the profile, like every other local plugin there):

```json
"dependencies": {
  "dsh-direct": "file:../../plugins/dsh-direct"
}
```

and make `node_modules` agree with it, without running `pnpm` (a `file:` spec needs no download; the app's own
package operations would otherwise prune a hand-made link later — run them if you install anything else):

```powershell
$link = Join-Path $PROFILE 'node_modules\dsh-direct'
if (-not (Test-Path $link)) { New-Item -ItemType Junction -Path $link -Target (Join-Path $HOME_DIR '.dsh\plugins\dsh-direct') | Out-Null }
node -e "const {createRequire}=require('node:module');console.log(createRequire(String.raw`$PROFILE\noop.js`).resolve('dsh-direct/package.json'))"
```

**4b — enable the bundle.** Either the app's **Settings → Plugins** page, or the `plugin_manager` tool from any session:

```
plugin_manager {"action":"set_bundle","target":"dsh-direct","enabled":true}
```

The answer matters: `"application":"applied"` means the running Host recomposed and imported the package;
`"application":"failed"` carries the loader diagnostic for that one entry (see step 5 for the two failures seen in
practice); `"restart-required"` means this build does not recompose at all and the next step must be a restart anyway.

**4c — the values.** The bundle patch (`cordis.patch.yml` inside the package) already inserts the row with an empty
config, so the profile layer carries an **override**, not a second `insert:`. Append to
`<HOME>\.dsh\profiles\desktop\cordis.patch.yml`:

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

Use `<HOME>` expanded, e.g. under `C:\Users\alice` the token line becomes
`tokenFile: 'C:/Users/alice/.dsh/dsh-direct/host.token'`. Forward slashes avoid YAML escaping; single quotes keep a
backslash path literal. Parse the file before trusting it — the app hot-reloads this layer and a YAML error takes every
patch row with it:

```powershell
node -e "const {createRequire}=require('node:module');const Y=createRequire(String.raw`$PROFILE\noop.js`)('yaml');const t=Y.parse(require('node:fs').readFileSync(String.raw`$PROFILE\cordis.patch.yml`,'utf8'),{customTags:[{tag:'!!js',resolve:v=>v}]});console.log('rows',t.length, 'dsh-direct', t.filter(r=>r&&r.id==='dsh-direct').length)"
```

`port` is optional next to `endpointFile`; leave it out to let the OS choose. If you omit `port` **and** `endpointFile`,
the plugin refuses to start — that configuration cannot be reached after a restart, and pretending otherwise is what T272
shipped.

Alternative — a pinned port and no descriptor (then the MCP side uses `hostUrl`):

```yaml
        tokenFile: '<HOME>/.dsh/dsh-direct/host.token'
        port: 42731
```

Rules enforced at start; each refusal is logged at `error` and nothing is bound:

| condition | result |
|---|---|
| `ctx.sessionController` lacks `list` / `prompt` / `page` | refuse, naming the missing methods and any T271-guessed names present |
| `config.tokenFile` missing, unreadable, or shorter than 32 characters | refuse |
| `config.boundSessionIds` empty | refuse |
| neither `port` nor `endpointFile` | refuse |
| `port` outside 1024..65535, or not an integer | refuse |
| the port is already taken (`EADDRINUSE`) | `bind_failed` — logged, no crash, no half-open bridge |

The last row is a T273 fix: before it, `EADDRINUSE` was an unhandled `error` event and took the Host process down.

## 5. Restart the Desktop once, then read what it says

A **new or changed module** needs a fresh process (step 0b). Restart the Desktop now — that is the one unavoidable
restart, and it is why an install must not be attempted from inside the very session it would kill: prepare everything,
then restart when the work that needs the session is finished and recorded.

The plugin's own `info` line is the confirmation:

```
serving http://127.0.0.1:<port> for 1 bound session(s), protocol dsh-api-session-controller@0.2.0-rc.2
```

with `, endpoint <path>` appended when `endpointFile` is configured. Where that line lands depends on the host surface;
the two independent witnesses that do not depend on logs at all are the descriptor and the port:

```powershell
node "$REPO\tools\dsh-direct\preflight.mjs" --config (Join-Path $HOME_DIR '.dsh\dsh-direct\config.json')
Get-Content (Join-Path $HOME_DIR '.dsh\dsh-direct\endpoint.json')     # base, kind, protocol, endpointId, pid
```

`refusing to start: <reason>` in the log, or no descriptor and a dead port, means fix that reason before going on. If the
log says `bind_failed`, another process owns the port:

```powershell
Get-NetTCPConnection -LocalPort 42731 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess
```

Pick a different port in step 4c (any free port in 1024..65535) and restart the Desktop again.

## 6. Point the MCP server at the bridge, then re-run the preflight

Write `<HOME>/.dsh/dsh-direct/config.json` from `tools/dsh-direct/config.example.json`, filling in:

```json
{
  "endpointFile": "<HOME>/.dsh/dsh-direct/endpoint.json",
  "tokenFile": "<HOME>/.dsh/dsh-direct/host.token",
  "stateDir": "<HOME>/.dsh/dsh-direct/state",
  "boundSessionIds": ["session-XXXXXXXX-XXXX-4XXX-8XXX-XXXXXXXXXXXX"],
  "boundCwds": ["<WORKSPACE>/project"],
  "maxPolls": 3
}
```

`endpointFile` and `hostUrl` are mutually exclusive: the endpoint file is read on every call, so a restarted Desktop is
followed automatically. Use `"hostUrl": "http://127.0.0.1:42731"` only when step 4 pinned the same port.

Then, with the Desktop running:

```powershell
node "$REPO\tools\dsh-direct\preflight.mjs" --config (Join-Path $HOME_DIR '.dsh\dsh-direct\config.json')
```

Expected: `config.schema ok`, `config.token ok` (64 characters), `endpoint.locate ok`, `endpoint.identity ok` naming
`cordis_session_controller` and `dsh-api-session-controller@0.2.0-rc.2`. `endpoint.identity` is the check that the port
actually belongs to this plugin: `/health` is unauthenticated, so without it a stale descriptor pointing at somebody
else's local server would look fine right up until a prompt was sent.

Register the MCP server with your MCP client as a stdio server:

```json
{
  "mcpServers": {
    "dsh-direct": {
      "command": "<NODE_EXE>",
      "args": ["<REPO>/tools/dsh-direct/mcp_server.mjs",
               "--config", "<HOME>/.dsh/dsh-direct/config.json"]
    }
  }
}
```

## 6b. Optional: serve MCP over Streamable HTTP instead of stdio

Only needed when the MCP client speaks HTTP rather than launching a process. It is off by default and it uses a separate
token: the HTTP listener is another credential surface, so it never reuses the Host token.

```powershell
$httpToken = Join-Path $HOME_DIR '.dsh\dsh-direct\http.token'
if (-not (Test-Path -LiteralPath $httpToken)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  (($bytes | ForEach-Object { $_.ToString('x2') }) -join '') |
    Set-Content -LiteralPath $httpToken -NoNewline -Encoding ascii
}
icacls $httpToken /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null
(Get-Content -LiteralPath $httpToken -Raw).Length     # expect 64
```

Add the `http` block to `<HOME>/.dsh/dsh-direct/config.json` (the example ships it disabled):

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

`enabled` must be the JSON boolean `true`; the string `"true"` is refused by name. The listener is always `127.0.0.1` —
`host` is not a knob. `allowedOrigins` stays empty for a CLI client, which sends no `Origin` header; a browser-based
client must have its exact origin listed, otherwise every request from it is `403`.

Start it and smoke-test the handshake:

```powershell
Start-Process -FilePath '<NODE_EXE>' -ArgumentList @("$REPO\tools\dsh-direct\mcp_server.mjs", '--config',
  (Join-Path $HOME_DIR '.dsh\dsh-direct\config.json'))
# stderr banner: dsh-direct: MCP Streamable HTTP on http://127.0.0.1:42732/mcp (loopback only, 0 allowed origin(s), ...)

$body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}'
$token = Get-Content -LiteralPath $httpToken -Raw
Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:42732/mcp' -Body $body -ContentType 'application/json' `
  -Headers @{ Authorization = "Bearer $token"; Accept = 'application/json' }
```

Expect `200`, a 32-hex `Mcp-Session-Id`, and `protocolVersion: "2025-11-25"` in the body. `GET` on the same URL answers
`405` with `Allow: POST, DELETE`: this server pushes nothing, so it never holds a stream open. A missing token answers
`401`, a foreign `Origin` answers `403`, and a body over `maxBodyBytes` answers `413`.

Re-run the preflight with the same `--config`: `http.config`, `http.origins` and `http.token` appear, and `http.token`
fails if the file is missing, short, or is the same file as the Host token.

**This is not a ChatGPT Web connection.** The listener is loopback-only and plain HTTP, so nothing outside this machine
can reach it by design. Registering a custom MCP connector in ChatGPT is a user action in the ChatGPT settings, and it
would need an HTTPS endpoint this repository does not create and does not authorise. Level C below stays unmet until
that is done deliberately, with a decision about exposure.

## 7. First live check (level C)

1. `list_sessions` → exactly the bound session, plus `protocol: dsh-api-session-controller@0.2.0-rc.2`.
2. `submit_task { "requestId": "manual-0001", "sessionId": "<bound>", "prompt": "Reply with the single word: ok" }` →
   the Desktop session itself must show that user message, and the tool result must carry the assistant text.
3. Restart the Desktop (not the MCP client), then `submit_task` again with a fresh requestId: with `endpointFile` the
   call must succeed on the new port. With a pinned `hostUrl` it must fail with `host_unreachable` — that is the
   difference the descriptor buys, and worth seeing once.
4. Kill the MCP client between send and answer, start it again: `get_task` → `unsettled`, `submit_task` → `session_busy`,
   `reconcile_task { taskId, prompt: "<same text>" }` → settles with no second message in the Desktop session.

## Uninstall, and the socket it must release

```powershell
$PROFILE = Join-Path $HOME_DIR '.dsh\profiles\desktop'
# 1. disable the bundle first (app Plugins page, or plugin_manager set_bundle target=dsh-direct enabled=false),
#    then remove the override row from the profile patch and the dependency from the profile manifest
#    ($PROFILE\cordis.patch.yml, $PROFILE\package.json), then the files:
Remove-Item -Recurse -Force (Join-Path $HOME_DIR '.dsh\plugins\dsh-direct')
Remove-Item -Recurse -Force (Join-Path $HOME_DIR '.dsh\dsh-direct')
Remove-Item -Force (Join-Path $PROFILE 'node_modules\dsh-direct')      # the junction, not its target
# 2. restart the Desktop, then prove the listener is gone:
node "$REPO\tools\dsh-direct\preflight.mjs" --port 42731
```

After the restart `port 42731 is free on 127.0.0.1` must come back `ok`. The plugin closes its listener on both the return
value of `apply` and the Cordis `dispose` event, and `close()` resolves on the server's `close` event with a 250 ms
socket sweep — a test asserts that a second instance can bind the same port immediately after dispose.

## What this proves, and what it does not

| level | requirement | status |
|---|---|---|
| **A** | plugin, MCP server (stdio and Streamable HTTP) and preflight verified in isolation against a fake Host; the HTTP layer driven over a real socket, including a full submit→result→duplicate run | met by the repo's tests |
| **B** | the real Desktop loads the plugin and the bridge answers on loopback | met for a **real Host process** built from the installed package and this document's patch row (`/health` answered `cordis_session_controller` / `dsh-api-session-controller@0.2.0-rc.2`, `list_sessions` answered over stdio MCP), measured in an isolated `DSH_HOME`; **not yet** for the already-running Desktop instance, which holds the pre-fix module generation until step 5's restart |
| **C** | an existing session received a real prompt without the Bridge | not yet: needs the restart from step 5, then step 7 against the bound session |

`mcp_server.mjs` is a working MCP server on both transports, but nothing in this repository registers it with ChatGPT's
custom-MCP settings: that registration is a Web-side action in the ChatGPT UI, and it needs a transport that reaches this
machine. Stdio means the client launches the process locally, which works for a desktop MCP client; the HTTP transport is
loopback-only, which works for a local HTTP MCP client. A Web client needs an HTTPS endpoint reachable from the internet,
and no part of this repository creates one or authorises one. That gap is stated rather than papered over.
