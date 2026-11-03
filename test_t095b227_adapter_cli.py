"""T227: the shipped CLI has to run, and has to say the honest thing when nothing is bound.

Found by running it: as a script its first statement failed, because `relay_merge` lives at the repository root and a
script's sys.path[0] is the file's own directory. Tests passed anyway because they inserted the path themselves -- which
is exactly the kind of gap that makes a tool look green and be broken for the operator.
"""

import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTER = os.path.join(HERE, 'tools', 'service', 'independent_terminal_source.py')


class ShippedCliTest(unittest.TestCase):
    def test_the_script_runs_and_reports_no_source_bound(self):
        done = subprocess.run([sys.executable, '-B', ADAPTER, '--state-dir', HERE],
                              capture_output=True, text=True, timeout=120,
                              creationflags=0x08000000 if sys.platform == 'win32' else 0)
        self.assertEqual(done.returncode, 0, done.stderr)
        payload = json.loads(done.stdout.strip())
        self.assertEqual(payload['code'], 'independent_source_unconfigured')
        self.assertIn('independent-terminal-source', payload['detail'])

    def test_it_imports_the_shared_consent_rules_rather_than_copying_them(self):
        source = open(ADAPTER, encoding='utf-8').read()
        self.assertIn('import relay_merge', source)
        # a copied rule is a second rule that will drift; the constants must come from relay_merge
        for name in ('CLOCK_SKEW_MS', 'EARLIEST_MS'):
            self.assertNotIn('%s =' % name, source, '%s is redefined here instead of imported' % name)


if __name__ == '__main__':
    unittest.main()
