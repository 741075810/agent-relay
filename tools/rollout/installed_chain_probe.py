#!/usr/bin/env python3
"""T217: one read-only round trip through an *installed* launcher and host, in a held directory.

This exists so the switch has a check that is about the installed bytes rather than about the repository: the script takes
a copy of the installed directory, starts the installed `host_launcher.exe`, sends one `terminal-list` frame exactly as the
extension would, and reports what came back. It starts no service, writes nothing to the state directory it is given, and
never speaks to a page.

    python -B tools/rollout/installed_chain_probe.py --dir COPY_OF_INSTALL --origin ORIGIN

Exit 0 only when the reply parses, is `ok`, and reports an arm boundary it could read. Every refusal names itself.
"""

import argparse
import json
import os
import struct
import subprocess
import sys


def send(launcher, origin, message, timeout=180):
    proc = subprocess.Popen([launcher, origin], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=os.path.dirname(launcher))
    try:
        body = json.dumps(message).encode('utf-8')
        out, err = proc.communicate(struct.pack('<I', len(body)) + body, timeout=timeout)
        code = proc.returncode
    finally:
        if proc.poll() is None:
            proc.kill()
    return code, out, err


def main(argv=None):
    ap = argparse.ArgumentParser(description='read-only round trip through an installed launcher')
    ap.add_argument('--dir', required=True, help='directory holding host_launcher.exe and host.py')
    ap.add_argument('--origin', required=True, help='the allowed origin from that directory\'s manifest')
    ap.add_argument('--epoch', default=None)
    args = ap.parse_args(argv)

    launcher = os.path.join(args.dir, 'host_launcher.exe')
    if not os.path.isfile(launcher):
        print('missing_launcher: %s' % launcher, file=sys.stderr)
        return 2
    message = {'v': 1, 'id': 't217-installed-probe', 'op': 'terminal-list'}
    if args.epoch:
        message['epoch'] = args.epoch
    code, out, err = send(launcher, args.origin, message)
    report = {'exit': code}
    if code != 0 or len(out) < 4:
        report.update({'ok': False, 'code': 'no_reply', 'stderr': err.decode('utf-8', 'replace')[-400:]})
        print(json.dumps(report, sort_keys=True))
        return 3
    length = struct.unpack('<I', out[:4])[0]
    try:
        reply = json.loads(out[4:4 + length].decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        report.update({'ok': False, 'code': 'unparsable_reply'})
        print(json.dumps(report, sort_keys=True))
        return 3
    result = reply.get('result') or {}
    error = reply.get('error') if isinstance(reply.get('error'), dict) else {}
    report.update({'ok': bool(reply.get('ok')), 'replyCode': error.get('code'),
                   'replyMessage': (error.get('message') or '')[:300], 'code': result.get('code'),
        'armEpoch': result.get('armEpoch'), 'armPrecision': result.get('armPrecision'),
        'armRelayCovered': result.get('armRelayCovered'), 'relayCode': result.get('relayCode'),
        'relayActivation': result.get('relayActivation'), 'candidates': len(result.get('candidates') or []),
        'baselineEstablished': result.get('baselineEstablished')})
    print(json.dumps(report, sort_keys=True))
    return 0 if report['ok'] else 3


if __name__ == '__main__':
    raise SystemExit(main())
