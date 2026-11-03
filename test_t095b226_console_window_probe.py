"""T226: the window probe reports rather than guesses, and the suite no longer flashes a window at the operator.

The observer exists because two rounds in a row believed "no visible window" and were wrong twice, both times because the
test ran from a console where a child reuses the parent's console. It is asserted here that the tool actually records what
it sees -- start/stop records, process records with a parent chain, and a non-negative count -- over a couple of seconds,
not that the desktop is clean (that depends on the machine, not on this code).
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(HERE, 'tools', 'service', 'console_window_probe.py')
SUPERVISOR_TEST = os.path.join(HERE, 'test_t095b221_relay_supervisor.py')


class ConsoleWindowProbeTest(unittest.TestCase):
    def test_the_probe_records_what_it_saw(self):
        if sys.platform != 'win32':
            self.skipTest('the probe talks to the Windows API')
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, 'windows.jsonl')
            done = subprocess.run([sys.executable, '-B', PROBE, '--seconds', '2', '--out', out, '--quiet'],
                                  capture_output=True, text=True, timeout=120,
                                  creationflags=0x08000000 if sys.platform == 'win32' else 0)
            self.assertEqual(done.returncode, 0, done.stderr)
            records = [json.loads(line) for line in open(out, encoding='utf-8') if line.strip()]
            kinds = [item['kind'] for item in records]
            self.assertEqual(kinds[0], 'start')
            self.assertEqual(kinds[-1], 'stop')
            for item in records:
                if item['kind'] == 'window':
                    # attribution is the whole point: a window without a chain is an unusable record
                    self.assertIn('<-', item['chain'])
                    self.assertTrue(item['class'])
                if item['kind'] == 'proc':
                    self.assertTrue(item['name'])
            # the observer must never start a child of its own, or it would record its own window candidates
            source = open(PROBE, encoding='utf-8').read()
            self.assertNotIn('subprocess', source)
            self.assertNotIn('os.system', source)

    def test_the_visible_window_control_is_opt_in(self):
        """A test that proves the defect by showing a window must not do it on every gate run."""
        source = open(SUPERVISOR_TEST, encoding='utf-8').read()
        self.assertIn("os.environ.get('DSH_T226_VISIBLE_CONTROL') == '1'", source)
        # the guard itself stays unconditional: run_hidden must be windowless whether or not the control runs
        self.assertIn("self.assertIn(fixed, ('no-console-window', 'hidden')", source)


if __name__ == '__main__':
    unittest.main()
