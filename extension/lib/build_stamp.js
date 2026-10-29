// Shown in the popup so a stale build is visible instead of being guessed at.
// Chrome gives an extension no API to report its own load directory, so this
// literal is the only honest signal: if the popup prints a different value than
// the source tree holds, the loaded copy is not this one (or was not reloaded).
export const BUILD_STAMP = 'T069-terminal-ms';
