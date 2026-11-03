#!/usr/bin/env python3
"""T210: the migration entry for enabling the relay beside an already-running native host.

Arming today writes `terminal-arm.json` from the Bridge ledger alone. A relay candidate that the ledger never saw is then
*absent* from the snapshot, and absence used to be read as "finished after consent" -- a notice about work the operator
had already watched finish. This tool is the minimal, explicit entry that avoids that:

    python -B tools/service/arm_with_relay.py \
        --state-dir STATE_DIR --ledger-root LEDGER_ROOT \
        --relay-url http://127.0.0.1:PORT --relay-token-file TOKEN_FILE \
        --epoch <operator-chosen-epoch>

It builds one snapshot that covers both sources and records which ones it covered (`sources`, `relayCovered`). It writes
nothing else, contacts nothing else, and starts nothing. Refusals are named:

  * `relay_source_unavailable_for_arm` -- the relay could not be read; a snapshot without it would silently omit runs;
  * `source_unavailable`              -- the Bridge ledger could not be read;
  * `snapshot_truncated`              -- the terminal set exceeds the snapshot bound; a partial snapshot would make the
                                         dropped ids look new.

An operator running this against a live host changes only the arm file: the host picks it up on its next sample, and
every candidate it does not contain must still prove its own completion time before it can be announced.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import terminal_source                                    # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description='Write an arm snapshot that covers the relay source too.')
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--ledger-root', required=True)
    parser.add_argument('--relay-url', required=True)
    parser.add_argument('--relay-token-file', required=True)
    parser.add_argument('--epoch', required=True)
    parser.add_argument('--json', action='store_true', help='machine-readable output')
    args = parser.parse_args(argv)

    report = terminal_source.arm_snapshot(
        args.state_dir, args.ledger_root, args.epoch,
        relay_source={'url': args.relay_url, 'token_file': args.relay_token_file})
    if args.json:
        print(json.dumps(report, sort_keys=True))
    elif report.get('ok'):
        print('armed epoch %s: %d ids (%s)' % (report['epoch'], report['count'], ', '.join(report['sources'])))
    else:
        print('refused: %s (%s)' % (report['code'], report.get('error')), file=sys.stderr)
    return 0 if report.get('ok') else 1


if __name__ == '__main__':
    raise SystemExit(main())
