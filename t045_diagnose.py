"""Read-only registry/manifest inspection for the T044 Native Messaging host.

This script deliberately does NOT launch the host, browser, or extension. Earlier
T045 versions used subprocess.Popen and on timeout could kill only the direct
launcher while leaving python.exe alive; they also had an unbounded stderr read.
That process-level test is now exclusively in test_t046_live_launcher.py, which
starts the launcher suspended inside a kill-on-close Windows Job Object and has a
single monotonic deadline.

Run:
    E:\\program\\python312\\python.exe -B t045_diagnose.py
    E:\\program\\python312\\python.exe -B t045_diagnose.py --origin <32-char-id>
"""
import argparse
import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
HOST_NAME = 'com.dsh.notify'
DEFAULT_MANIFEST = os.path.join(HERE, 'host_manifest.json')
EXT_DIR = os.path.join(HERE, 'extension')
REG_KEY = r'Software\Google\Chrome\NativeMessagingHosts\%s' % HOST_NAME


def say(status, text):
    print('[%s] %s' % (status, text))


def read_registered_manifest():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_KEY) as key:
            return winreg.QueryValueEx(key, '')[0]
    except (ImportError, OSError):
        return None


def extension_id_from_path(path):
    digest = hashlib.sha256(path.encode('utf-16-le')).digest()[:16]
    alphabet = 'abcdefghijklmnop'
    return ''.join(alphabet[n] for byte in digest
                   for n in ((byte >> 4) & 15, byte & 15))


def inspect_manifest(path, supplied_id=None):
    if not path or not os.path.isfile(path):
        say('FAIL', 'manifest missing: %r' % path)
        return 1
    raw = open(path, 'rb').read()
    if raw.startswith(b'\xef\xbb\xbf'):
        say('FAIL', 'manifest has a UTF-8 BOM')
        return 1
    try:
        doc = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as exc:
        say('FAIL', 'manifest is not plain UTF-8 JSON: %s' % exc)
        return 1

    say('OK', 'manifest parses as plain UTF-8 JSON without BOM')
    say('OK' if doc.get('name') == HOST_NAME else 'FAIL',
        'name=%r' % doc.get('name'))
    say('OK' if doc.get('type') == 'stdio' else 'FAIL',
        'type=%r' % doc.get('type'))

    executable = doc.get('path') or ''
    path_ok = os.path.isabs(executable) and os.path.isfile(executable)
    say('OK' if path_ok else 'FAIL',
        'path=%r (absolute and exists=%s)' % (executable, path_ok))
    if path_ok and executable.lower().endswith('.exe'):
        with open(executable, 'rb') as handle:
            is_pe = handle.read(2) == b'MZ'
        say('OK' if is_pe else 'FAIL', 'launcher is a PE executable (MZ=%s)' % is_pe)
    elif path_ok and executable.lower().endswith('.cmd'):
        launcher = open(executable, 'rb').read()
        crlf_ok = b'\r\n' in launcher and b'\n' not in launcher.replace(b'\r\n', b'')
        say('OK' if crlf_ok else 'FAIL', 'cmd line endings are CRLF=%s' % crlf_ok)

    origins = doc.get('allowed_origins')
    if not isinstance(origins, list) or not origins:
        say('FAIL', 'allowed_origins is empty or not a list')
        origins = []
    for origin in origins:
        say('OK' if '*' not in origin else 'FAIL',
            'allowed origin=%r' % origin)

    derived = extension_id_from_path(EXT_DIR)
    expected = supplied_id or derived
    if supplied_id:
        say('INFO', 'using user-supplied extension id %s' % supplied_id)
    else:
        say('INFO', 'id derived from unpacked extension path: %s' % derived)
    expected_origin = 'chrome-extension://' + expected
    matches = expected_origin in [origin.rstrip('/') for origin in origins]
    say('OK' if matches else 'FAIL',
        'caller origin %r is in allowed_origins=%s' % (expected_origin, matches))
    return 0 if (path_ok and doc.get('name') == HOST_NAME
                  and doc.get('type') == 'stdio' and matches) else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', help='the 32-character extension id shown by chrome://extensions')
    args = parser.parse_args()

    registered = read_registered_manifest()
    if registered:
        say('OK', 'HKCU registration points to %s' % registered)
    else:
        say('FAIL', 'HKCU registration not found (this script did not modify it)')
        return 1
    if os.path.normcase(os.path.abspath(registered)) != os.path.normcase(
            os.path.abspath(DEFAULT_MANIFEST)):
        say('WARN', 'registered manifest differs from this project copy')
    print('')
    say('INFO', 'static inspection only; no process was launched')
    return inspect_manifest(registered, args.origin)


if __name__ == '__main__':
    raise SystemExit(main())
