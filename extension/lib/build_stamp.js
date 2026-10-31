// What the popup prints so a stale load is visible instead of being guessed at.
//
// Chrome gives an extension no API to report its own load directory, so the only honest signal is
// a value that comes from the source tree and is compared by eye against what the popup shows.
// That value is derived, not asserted: `T112-<8 hex>` is the first 8 hex digits of a digest over
// every shipped file except this one (`python tools/extension_stamp.py --write`). A hand-edited
// stamp rots -- this literal sat at `T069-terminal-ms` for more than forty changes -- and a
// freshly hardcoded one says nothing about the files beside it. `--check` refuses when they
// disagree, which is what turns "the popup shows an old stamp" into a fact.
//
// Loaded as a plain script before popup.js (the popup is a classic script and cannot import), so
// this file is the single definition: popup.js reads the global and declares no stamp of its own.
globalThis.BUILD_STAMP = 'T112-d6817e4d';
