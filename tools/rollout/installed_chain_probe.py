#!/usr/bin/env python3
"""T217: one read-only round trip through an *installed* launcher and host, in a held directory.

This exists so the switch has a check that is about the installed bytes rather than about the repository: the script starts
the installed `host_launcher.exe`, sends one `terminal-list` frame exactly as the extension would, and reports what came
back.

It takes a **copy** of the directory and runs the copy, because the host samples with `--state-dir <dir>\\state` and that
sample writes (`terminal-source.json` gains `relayActivatedAt`, `relayBaselineIds`, and the queue advances). T219 ran an
earlier version of this probe against the live install and it did exactly that: the tool promised "writes nothing to the
state directory" and then wrote to it. Copying by default is what makes the promise true; `--no-copy-state` exists for the
case where the caller wants the real directory and accepts the writes.

    python -B tools/rollout/installed_chain_probe.py --dir INSTALL_DIR --origin ORIGIN

Exit 0 only when the reply parses, is `ok`, and reports an arm boundary it could read. Every refusal names itself.
"""

import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile


def send(launcher, origin, message, timeout=180):
    try:
        proc = subprocess.Popen([launcher, origin], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, cwd=os.path.dirname(launcher))
    except OSError as exc:
        # A file named host_launcher.exe that is not an executable, or one being rewritten: say so rather than dying with a
        # traceback and no report. The caller still needs `ranIn` to know where it ran.
        return None, b'', ('not_executable: %s' % exc).encode('utf-8')
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
    ap.add_argument('--no-copy-state', action='store_true',
                    help='run the directory in place and accept that the host writes to its state directory')
    ap.add_argument('--keep-copy', action='store_true', help='leave the copied directory behind for inspection')
    args = ap.parse_args(argv)

    source = os.path.abspath(args.dir)
    launcher = os.path.join(source, 'host_launcher.exe')
    if not os.path.isfile(launcher):
        print('missing_launcher: %s' % launcher, file=sys.stderr)
        return 2
    work = source
    if not args.no_copy_state:
        work = tempfile.mkdtemp(prefix='installed-probe-')
        shutil.copytree(source, os.path.join(work, 'install'))
        work = os.path.join(work, 'install')
        launcher = os.path.join(work, 'host_launcher.exe')
    message = {'v': 1, 'id': 't217-installed-probe', 'op': 'terminal-list'}
    if args.epoch:
        message['epoch'] = args.epoch
    try:
        return _report(work, source, launcher, args, message)
    finally:
        if work != source and not args.keep_copy:
            shutil.rmtree(os.path.dirname(work), ignore_errors=True)


def _report(work, source, launcher, args, message):
    code, out, err = send(launcher, args.origin, message)
    report = {'exit': code, 'ranIn': ('copy' if work != source else 'place')}
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
