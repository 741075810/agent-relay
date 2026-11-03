# Extension pre-reload state (T218)

The unpacked extension Chrome is loading has been upgraded **on disk, in the directory Chrome already loads**. This
document records what is in place, what is still running, and the single UI step that remains. It is written before the
operator acts, so that "reloaded" and "not reloaded yet" cannot be confused later.

## What Chrome loads (its own record, not a guess)

Read from `Default\Secure Preferences`, the file Chrome itself persists:

| field | value |
|---|---|
| load path | `<HOST_INSTALL>\extension` (the same directory since T044) |
| location | `4` (`LOAD_UNPACKED`) |
| granted APIs | `alarms`, `nativeMessaging`, `storage`, `tabs`, `scripting` |
| host permissions | `https://chatgpt.com/*`, `https://chat.openai.com/*` |
| manifest version | `0.1.1` — **unchanged by this round** |

The id is not stored in the manifest (no `key`), so Chrome derives it from the load path: sha256 of the **UTF-16LE**
path string, first 32 hex digits, each mapped onto `a`..`p`. `tools/rollout/extension_identity.py` recomputes it and
compares it against Chrome's own record:

```
path            : <HOST_INSTALL>\extension
derived id      : <EXT_ID>
chrome record   : Default, agrees=True
```

That is why the upgrade was written **into that directory** rather than into a new one: copying the tree elsewhere would
have minted a different id, and the manifest's `allowed_origins`, the native host's allow-list and Chrome's stored
permissions would all have been pointing at an extension that no longer exists.

## What was written

Fifteen files, all inside the loaded directory. `manifest.json` was **not** touched — it is byte-identical
(`89FF5835…`), which is what makes "no permission change, no identity change" a fact rather than an intention.

| file | before | after |
|---|---|---|
| `background.js` | 127,189 B | 133,519 B |
| `popup.js` | 68,579 B | 71,013 B |
| `popup.html` | 15,033 B | 15,248 B |
| `lib/terminal_trigger.js` | 55,524 B | 59,772 B (`postArmUsable` present) |
| `lib/autosend.js` | 21,843 B | 22,580 B |
| `lib/autosend_chrome_wiring.js` | 6,639 B | 12,114 B |
| `lib/send_adapter.js` | 47,701 B | 50,313 B |
| `lib/build_stamp.js` | differs | 979 B |
| `lib/terminal_events.js`, `lib/diagnostic_record.js`, `lib/diagnostic_store.js`, `lib/diagnostic_view.js`, `lib/notice_runtime_view.js`, `lib/readiness_queue_view.js`, `lib/run_history_view.js` | absent | new |

Nothing was deleted. Every overwritten file's previous bytes are in the T217 backup (`…\217-backup-20261103-153213`,
43 entries, re-verified this round: 0 problems).

## Verification, against the loaded directory

| check | result |
|---|---|
| epoch suite, `T150_EXT_ROOT=<loaded dir>` | **pass 6 / fail 0** |
| epoch suite, the previous build from the backup | **pass 3 / fail 3** (the same three that failed in T217) |
| import graph from `background.js` (`extension_imports.py`) | 21 modules reached, none missing |
| manifest byte-identical to the repository | yes (`89FF5835…`) |
| id derivation vs Chrome's record | agrees |
| Chrome processes | untouched — no restart, no kill, no reload |
| old `host_launcher.exe` | still held by the running host, unchanged (`34CFE482…`) |
| Relay service / arm snapshot / sidecar | **not** started, **not** written |

## Still running, still the old code

Chrome loaded the previous files into memory. Until it reloads, the running service worker keeps executing the build it
started with, and the native host keeps serving it. Nothing in this round changed that, and nothing in this round claims
the new code is live: it is **on disk and verified**, not loaded.

## The one action left to the operator

1. Open `chrome://extensions`.
2. Find **DSH Notify Bridge (prototype)** and press its **Reload** button (⟳). Do not remove it, do not "Load unpacked"
   again, and do not change its path — either of those would mint a new id and lose the binding.
3. Confirm the entry still shows the same id (`<EXT_ID>`, shown in the card's details) and that no error badge appears.

After that, and only after that, `readiness_audit.py` can report `launcher_passes_relay` (the reload releases the
launcher's file lock), and T219 can replace the launcher, start the relay service and write the single arm snapshot.

## Rollback, if the reload shows an error

Every file in the table above comes back with one copy from the backup; `manifest.json` needs nothing. The extension then
matches the build that is running right now, and a second Reload returns Chrome to it:

```powershell
$backup = "$env:USERPROFILE\..\chatgpt_handoff\217-backup-20261103-153213"
$inst   = '<HOST_INSTALL>\extension'
Copy-Item "$backup\extension\*" $inst -Recurse -Force      # restores the seven replaced files
Remove-Item "$inst\lib\terminal_events.js", "$inst\lib\diagnostic_record.js", "$inst\lib\diagnostic_store.js",
            "$inst\lib\diagnostic_view.js", "$inst\lib\notice_runtime_view.js", "$inst\lib\readiness_queue_view.js",
            "$inst\lib\run_history_view.js" -Force          # the seven files that did not exist before
```

Then `T150_EXT_ROOT=$inst node test_t095b150_postarm_epoch.mjs` reports the old 3/6 again, which is the expected state of
the pre-T217 build, not a new fault.
