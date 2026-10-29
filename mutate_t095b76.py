"""T095B76 mutation check: revert each part of the fix, confirm the suite goes red.

A test that passes both with and without the fix proves nothing. Each case below
patches one shipped file, runs the T095B76 suite against the patched tree, restores
the file byte-for-byte, and reports how many assertions failed. A case that fails to
turn the suite red is a hole in the suite, not a success.

Run from the module directory:  python -B mutate_t095b76.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
SUITE = 'test_t095b76_reload_binding.mjs'

CASES = [
    ('revert-1  per-instance document id (the whole enabler)',
     'extension/content.js',
     b'const DOCUMENT_INSTANCE_ID = stableDocumentId();',
     b'const DOCUMENT_INSTANCE_ID = crypto.randomUUID();'),
    ('revert-2  no write latch',
     'extension/content.js',
     b'if (globalThis.__dshWriteInFlight === true) {',
     b'if (false) {'),
    ('revert-3  controller back on the raw session area',
     'extension/background.js',
     b'session: bindingSession,',
     b'session: chrome.storage.session,'),
    ('revert-4  health back on the plain probe',
     'extension/background.js',
     b'probeHealth: resilientProbe,',
     b'probeHealth: probeSpecificTab,'),
    ('revert-5  no retry after a proven lost script',
     'extension/lib/content_reconnect.js',
     b'if (!first || first.status !== NO_RECEIVER_STATUS) return first;',
     b'if (true) return first;'),
    ('revert-6  inject even when the tab has moved',
     'extension/lib/content_reconnect.js',
     b'if (tab.url !== target.url) {',
     b'if (false) {'),
    ('revert-7  restore a mirror that does not validate',
     'extension/lib/binding_mirror.js',
     b'if (!isMirrorableState(mirror)) {',
     b'if (false) {'),
]


def run_suite():
    proc = subprocess.run(
        ['node', SUITE], cwd=str(ROOT), capture_output=True, text=True,
        encoding='utf-8', errors='replace')
    lines = (proc.stdout or '').splitlines()
    failures = [ln.strip() for ln in lines if ln.strip().startswith('FAIL')]
    result = ''
    for ln in lines:
        if ln.startswith('RESULT:'):
            result = ln.strip()
    return proc.returncode, failures, result


def main():
    baseline_code, baseline_failures, baseline = run_suite()
    print('baseline: exit=%d  %s' % (baseline_code, baseline))
    if baseline_code != 0:
        print('BASELINE IS RED -- fix that before trusting any mutation result')
        return 1

    holes = []
    for label, rel, old, new in CASES:
        path = ROOT / rel
        original = path.read_bytes()
        if original.count(old) != 1:
            print('%-56s SKIP (pattern appears %d times)'
                  % (label, original.count(old)))
            holes.append(label + ' [pattern not found]')
            continue
        path.write_bytes(original.replace(old, new))
        try:
            code, failures, result = run_suite()
        finally:
            path.write_bytes(original)
        restored = path.read_bytes() == original
        turned_red = code != 0 and len(failures) > 0
        print('%-56s %s  %s  restored=%s'
              % (label, 'RED' if turned_red else 'STILL GREEN',
                 result or ('exit %d' % code), 'yes' if restored else 'NO'))
        for item in failures[:4]:
            print('       %s' % item)
        if not turned_red:
            holes.append(label)

    code, failures, result = run_suite()
    print('after all restores: exit=%d  %s' % (code, result))
    if holes:
        print('')
        print('HOLES (%d): the suite does not notice these' % len(holes))
        for item in holes:
            print('  - %s' % item)
        return 1
    print('')
    print('all %d mutations turned the suite red' % len(CASES))
    return 0


if __name__ == '__main__':
    sys.exit(main())
