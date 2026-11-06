# Installing dsh-direct into DSH Desktop on Windows

> **Not performed in this round.** These are the exact steps for the operator to run by hand. Nothing here has been
> applied to the installed Desktop: the profile is untouched, no Desktop restart was done, and no existing
> notification / Bridge / Native path was modified. Until these steps run, acceptance stays at level A (isolated
> plugin + MCP server tested) — see `README.md`.

Target build: `@deepseek-ai/dsh-desktop 0.2.0-rc.2`, `dshBuildCommit 04f392c9ddd144fa426da2045178797da6db6c11`,
installed at `<DSH_INSTALL>\`. The plugin home is `%USERPROFILE%\.dsh`. Every path below is written with
`<USERPROFILE>` where your home directory goes: replace it with the value of `$env:USERPROFILE` (for example
`%USERPROFILE%`), and keep forward slashes inside JSON values.

## 0. What must already be true

- The Desktop is closed before step 4. Reloading a plugin row needs a restart; a running Desktop will not pick up a new
  `cordis.patch.yml`.
- You know the **existing** session id you want to bind to (`session-<uuid>`). This tool never creates one.
- Node 22.15+ or 24+ is the runtime the Desktop ships; the plugin declares `engines.node` accordingly.

## 1. Pick the session and its cwd

Open the Desktop, open the session you mean to use, and note two values from
`%USERPROFILE%\.dsh` (session metadata) — or read them from the Host once the plugin is running and `/sessions` answers:

```
sessionId: session-XXXXXXXX-XXXX-4XXX-8XXX-XXXXXXXXXXXX
cwd:       <WORKSPACE>/project
```

`cwd` is the bindable identity in 0.2.0-rc.2; `SessionSummary` has no `projectId`.

## 2. Create the bearer token file (only this account may read it)

```powershell
$tokenDir = Join-Path $env:USERPROFILE '.dsh\dsh-direct'
New-Item -ItemType Directory -Path $tokenDir -Force | Out-Null
$tokenFile = Join-Path $tokenDir 'host.token'
if (-not (Test-Path $tokenFile)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  # 64 hex characters; the bridge refuses anything shorter than 32 characters.
  ($bytes | ForEach-Object { $_.ToString('x2') }) -join '' | Set-Content -LiteralPath $tokenFile -NoNewline -Encoding ascii
}
icacls $tokenFile /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null
Get-Content -LiteralPath $tokenFile | Measure-Object -Character   # expect 64
```

## 3. Copy the plugin into the plugin home

The plugin is self-contained: `plugin/lib` carries its own copies of the four runtime modules, because a Cordis plugin
cannot import outside its own directory.

```powershell
$src = '<REPO>\tools\dsh-direct\plugin'
$dst = Join-Path $env:USERPROFILE '.dsh\plugins\dsh-direct'
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force
Get-ChildItem -Recurse $dst | Select-Object FullName, Length
```

Expected: `package.json`, `cordis.patch.yml`, `README.md`, `lib\index.js`, `lib\protocol.mjs`, `lib\session_api.mjs`,
`lib\adapters.mjs`, `lib\host_bridge.mjs`.

## 4. Add the profile row with your config

The bundle patch inserts the row with an **empty** config on purpose. The real values go in the profile's own patch
file, `%USERPROFILE%\.dsh\cordis.patch.yml`. Append one row; keep the existing rows untouched:

```yaml
- insert:
    - id: dsh-direct
      name: 'dsh-direct'
      config:
        tokenFile: '<USERPROFILE>/dsh-direct/host.token'
        port: 0
        boundSessionIds:
          - 'session-XXXXXXXX-XXXX-4XXX-8XXX-XXXXXXXXXXXX'
```

`port: 0` lets the OS choose; the plugin logs the chosen loopback URL at `info`. If you need a fixed port, pick
`42700`–`42799` and check with `Get-NetTCPConnection -LocalPort <port>` that it is free.

Rules the plugin enforces at start (each refusal is logged at `error` and nothing is bound):

| condition | result |
|---|---|
| `ctx.sessionController` lacks `list` / `prompt` / `page` | refuse, naming the missing methods and any T271-guessed names present |
| `config.tokenFile` missing | refuse |
| token file shorter than 32 characters | refuse |
| `config.boundSessionIds` empty | refuse |

## 5. Restart the Desktop and confirm it came up

Close all Desktop windows, start it again, then — while it runs — check the bridge from PowerShell:

```powershell
$url = Get-Content "$env:USERPROFILE\.dsh\logs\dsh.log" | Select-String 'dsh-direct.*serving' | Select-Object -Last 1
$url.Line
# then, with the port printed in that line:
Invoke-RestMethod 'http://127.0.0.1:<port>/health' | ConvertTo-Json -Depth 4
```

`/health` needs no token and reports `kind: cordis_session_controller`, `protocol:
dsh-api-session-controller@0.2.0-rc.2`, and `capabilities.missing: []`. If it reports `list, page` as missing, the
Desktop build is not rc.2-compatible — stop here instead of working around it.

## 6. Point the MCP server at it

Write `%USERPROFILE%\.dsh\dsh-direct\config.json`:

```json
{
  "hostUrl": "http://127.0.0.1:<port>",
  "tokenFile": "<USERPROFILE>/dsh-direct/host.token",
  "stateDir": "<USERPROFILE>/dsh-direct/state",
  "boundSessionIds": ["session-XXXXXXXX-XXXX-4XXX-8XXX-XXXXXXXXXXXX"],
  "boundCwds": ["<WORKSPACE>/project"],
  "maxPolls": 3
}
```

Then register it with whatever MCP client you use, as a stdio server:

```json
{
  "mcpServers": {
    "dsh-direct": {
      "command": "<NODE_EXE>",
      "args": ["<REPO>/tools/dsh-direct/mcp_server.mjs",
               "--config", "<USERPROFILE>/dsh-direct/config.json"]
    }
  }
}
```

## 7. First live check (level C)

In the MCP client:

1. `list_sessions` → must show exactly the bound session, and a `protocol` field.
2. `submit_task { requestId: "manual-0001", sessionId: "<bound>", prompt: "Reply with the single word: ok" }` → the
   Desktop session itself must show that user message, and the tool result must carry the assistant text.
3. Deliberately kill the MCP client between the send and the answer, then start it again:
   `get_task` → `unsettled`; `submit_task` again → `session_busy`; `reconcile_task { taskId, prompt: "<same text>" }` →
   settles without a second message appearing in the Desktop session. **That last observation is the whole point of
   this version.**

## Rollback

```powershell
# remove the row from %USERPROFILE%\.dsh\cordis.patch.yml, then
Remove-Item -Recurse -Force (Join-Path $env:USERPROFILE '.dsh\plugins\dsh-direct')
Remove-Item -Recurse -Force (Join-Path $env:USERPROFILE '.dsh\dsh-direct')
# restart the Desktop
```

Removing the row first matters: a plugin directory without its row never loads, while a row without its directory
makes the Desktop log a load error on every start.
