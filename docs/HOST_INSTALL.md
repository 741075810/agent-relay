# Installing the host and finding its real directory

An install document that names a directory the registration does not point at is worse
than no document: files get copied, behaviour does not change, and the symptom looks
like a broken release.

## Derive the path, never assume it

The chain has three links and every one is readable:

```
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dsh.notify
  └─ (default) → absolute path to a manifest .json
       └─ "path" → absolute path to host_launcher.exe
            └─ its directory = where the host modules are imported from
```

`t045_diagnose.py` prints all three plus the launcher's SHA256 and any live host process,
and writes nothing:

```powershell
python -B t045_diagnose.py
```

Its output is the authority. If a document says the host lives somewhere else, the
document is wrong — including an earlier version of this one, which named
`%LOCALAPPDATA%\DSH\host`. That directory does not exist on a normal install and nothing
reads it.

## Install

```powershell
$here = (Get-Location).Path

# 1. build the launcher (source is in launcher/, binary is not tracked)
powershell -ExecutionPolicy Bypass -File launcher\build_launcher.ps1

# 2. create the manifest from the template and fill in two values
Copy-Item host_manifest.example.json host_manifest.json
#   "path"            → $here\host_launcher.exe   (must be absolute, escaped backslashes)
#   "allowed_origins" → chrome-extension://<your extension id>/

# 3. register it per-user (no admin needed)
$m = Join-Path $here 'host_manifest.json'
$k = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.dsh.notify'
New-Item -Path $k -Force | Out-Null
Set-ItemProperty -Path $k -Name '(default)' -Value $m

# 4. verify
python -B t045_diagnose.py
```

Chrome accepts the manifest path as the key's default value; it does **not** need the
file to be inside the extension directory.

## The extension id

An unpacked extension's id is derived from its load path, so it differs per machine.
Read it from `chrome://extensions` (Developer mode on) and put it in
`allowed_origins`. It must be the exact 32-character id followed by a trailing `/`.

`test_t045_host_launcher.py` and `test_t046_live_launcher.py` read the id from
`host_manifest.json`, or from `DSH_EXTENSION_ID`:

```powershell
$env:DSH_EXTENSION_ID = '<your id>'
```

They skip (rather than fail) when neither is available, because a clone with no manifest
has no confirmed id — and asserting a made-up one would assert the wrong thing.

## Restarting after an edit

A Python process keeps the modules it imported at launch. Editing `terminal_source.py`
on disk does **not** change the behaviour of a host that is already running, and the
difference is invisible except as "my fix did nothing".

```powershell
# who is running, and since when?
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like '*host.py*' } |
  Select-Object ProcessId, CreationDate, CommandLine | Format-List
```

Compare `CreationDate` against the mtime of the files you edited. If the process started
before the edit, it is running old code. Chrome kills the host when the browser closes
and respawns it on the next `nativeMessaging` call, so quitting Chrome is the clean way
to pick up changes; reload the extension in `chrome://extensions` as well, and check the
popup's `代码版本:` line to confirm which build is loaded.

## Uninstall

```powershell
Remove-Item 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.dsh.notify' -Recurse
```

Then remove the extension in `chrome://extensions`. Nothing outside the user profile is
touched, and no service is installed.
