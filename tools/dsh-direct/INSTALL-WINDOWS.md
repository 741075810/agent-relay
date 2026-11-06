# Installing dsh-direct into DSH Desktop on Windows

> **Not performed in this round.** These are the exact steps for the operator. Nothing below was applied to the
> installed Desktop: no plugin install, no profile edit, no Desktop restart, no Chrome change. Until they run, acceptance
> stays at level **A** — see the table at the end.

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

## 4. Add the profile row, with a listener the MCP side can find

The bundle patch (`cordis.patch.yml`) inserts the row with an empty config. Real values go in the profile's own patch
file, `%USERPROFILE%\.dsh\cordis.patch.yml`. Append one row; leave the existing rows untouched.

Preferred — an endpoint descriptor, which survives a Desktop restart because the plugin rewrites it every bind:

```yaml
- insert:
    - id: dsh-direct
      name: 'dsh-direct'
      config:
        tokenFile: '<HOME>/.dsh/dsh-direct/host.token'
        endpointFile: '<HOME>/.dsh/dsh-direct/endpoint.json'
        port: 42731
        boundSessionIds:
          - 'session-XXXXXXXX-XXXX-4XXX-8XXX-XXXXXXXXXXXX'
```

Use `<HOME>` expanded, e.g. under `C:\Users\alice` the token line becomes
`tokenFile: 'C:/Users/alice/.dsh/dsh-direct/host.token'`. Forward slashes are fine on Windows and avoid YAML escaping.

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

## 5. Restart the Desktop and read the log

Close every Desktop window, start it again, then check the log line the plugin writes at `info`:

```powershell
$log = Join-Path $HOME_DIR '.dsh\dsh-direct\plugin.log'   # wherever the profile writes plugin logs
Select-String -Path (Join-Path $HOME_DIR '.dsh\*.log') -Pattern 'dsh-direct' -ErrorAction SilentlyContinue |
  Select-Object -Last 5
```

Expected: `serving http://127.0.0.1:<port> for 1 bound session(s), protocol dsh-api-session-controller@0.2.0-rc.2` and,
when `endpointFile` is configured, `endpoint <path>`. On a refusal you get `refusing to start: <reason>` instead — fix
that reason before going on. If the log says `bind_failed`, another process owns the port:

```powershell
Get-NetTCPConnection -LocalPort 42731 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess
```

Pick a different port in step 4 (any free port in 1024..65535) and restart the Desktop again.

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
# 1. remove the dsh-direct row from <HOME>/.dsh/cordis.patch.yml  (row first, directory second)
Remove-Item -Recurse -Force (Join-Path $HOME_DIR '.dsh\plugins\dsh-direct')
Remove-Item -Recurse -Force (Join-Path $HOME_DIR '.dsh\dsh-direct')
# 2. restart the Desktop, then prove the listener is gone:
node "$REPO\tools\dsh-direct\preflight.mjs" --port 42731
```

After the restart `port 42731 is free on 127.0.0.1` must come back `ok`. The plugin closes its listener on both the return
value of `apply` and the Cordis `dispose` event, and `close()` resolves on the server's `close` event with a 250 ms
socket sweep — a test asserts that a second instance can bind the same port immediately after dispose.

## What this proves, and what it does not

| level | requirement | status |
|---|---|---|
| **A** | plugin and MCP server verified in isolation against a fake Host and a fake Cordis context, plus this preflight | met by the repo's tests |
| **B** | the real Desktop loads the plugin and the bridge answers on loopback | requires steps 1–6 by hand |
| **C** | an existing session received a real prompt without the Bridge | requires step 7 |

`mcp_server.mjs` is a working MCP stdio server, but nothing in this repository registers it with ChatGPT's custom-MCP
settings: that registration is a Web-side action in the ChatGPT UI, and it needs a transport that reaches this machine.
Stdio means the client launches the process locally, which works for a desktop MCP client; a Web client needs an
HTTPS endpoint, and this bridge deliberately binds loopback only. That gap is stated rather than papered over.
