"""Two independent Chrome-extension consumers against one host queue, offline."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON = sys.executable


def request(ident, op, args=None):
    return {'v': 1, 'id': ident, 'op': op, 'args': args or {}}


class MultiConsumerWireTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='t048-wire-')
        self.addCleanup(self.tmp.cleanup)
        self.state = os.path.join(self.tmp.name, 'state')
        self.manifest = os.path.join(self.tmp.name, 'manifest.json')
        with open(self.manifest, 'w', encoding='utf-8') as handle:
            json.dump({'name': 'com.dsh.notify', 'type': 'stdio',
                       'allowed_origins': ['chrome-extension://test/']}, handle)

    def call(self, messages):
        from test_t044_native_messaging import frame, unframe
        payload = b''.join(frame(message) for message in messages)
        proc = subprocess.run(
            [PYTHON, '-B', os.path.join(HERE, 'host.py'),
             '--state-dir', self.state, '--manifest', self.manifest,
             'chrome-extension://test/'],
            input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=HERE, timeout=10)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', 'replace'))
        return unframe(proc.stdout)

    def test_two_consumers_ack_independently_on_real_host_wire(self):
        first = self.call([
            request('sim', 'simulate', {'count': 1}),
            request('a-poll', 'poll', {'cursor': 0, 'consumer': 'profile-a'}),
            request('a-ack', 'ack', {'acked': [], 'consumer': 'profile-a'}),
        ])
        event = first[1]['result']['events'][0]
        self.call([request('a-ack-event', 'ack', {
            'acked': [event['eventId']], 'consumer': 'profile-a'})])
        second = self.call([request('b-poll', 'poll', {
            'cursor': 0, 'consumer': 'profile-b'})])
        self.assertEqual(second[0]['result']['events'][0]['eventId'],
                         event['eventId'])
        self.call([request('b-ack', 'ack', {
            'acked': [event['eventId']], 'consumer': 'profile-b'})])
        a_again = self.call([request('a-again', 'poll', {
            'cursor': 0, 'consumer': 'profile-a'})])
        b_again = self.call([request('b-again', 'poll', {
            'cursor': 0, 'consumer': 'profile-b'})])
        self.assertEqual(a_again[0]['result']['events'], [])
        self.assertEqual(b_again[0]['result']['events'], [])


if __name__ == '__main__':
    unittest.main()
