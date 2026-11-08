"""T286: do not hold a Bridge ledger reader during CPU-heavy JSON parsing.

The writer replaces an immutable snapshot by name. Parsing bytes after close
preserves that snapshot while allowing the writer to publish its next one.
Fixtures only; no production ledger or notification state is read or written.
"""
import builtins
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import terminal_source as source


class LedgerReadLifetimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='t286-ledger-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'endpoint.json.runs.json'
        self.old = [{'requestID': 'fixture-request', 'createdAt': 1, 'status': 'running'}]
        self.new = [{'requestID': 'fixture-request', 'createdAt': 1, 'status': 'completed'}]
        self.path.write_text(json.dumps(self.old), encoding='utf-8')
        self.opened = []

    def opening(self, *args, **kwargs):
        handle = builtins.open(*args, **kwargs)
        self.opened.append(handle)
        return handle

    def test_parse_occurs_after_close_and_keeps_original_snapshot(self):
        parse = json.loads
        def at_parse(raw, *args, **kwargs):
            self.assertTrue(self.opened)
            self.assertTrue(all(h.closed for h in self.opened), 'ledger handle held during parse')
            temp = self.path.with_suffix('.tmp')
            temp.write_text(json.dumps(self.new), encoding='utf-8')
            os.replace(temp, self.path)
            return parse(raw, *args, **kwargs)
        with mock.patch.object(source, 'open', self.opening, create=True):
            with mock.patch.object(source.json, 'loads', at_parse):
                self.assertEqual(source.read_runs(str(self.path)), self.old)
            self.assertEqual(source.read_runs(str(self.path)), self.new)

    def test_real_node_rename_succeeds_at_parse_boundary(self):
        node = shutil.which('node')
        self.assertIsNotNone(node, 'release tests require Node')
        script = Path(self.temp.name) / 'writer.mjs'
        script.write_text("import {writeFile,rename} from 'node:fs/promises';"
                          "const p=process.argv[2]; await writeFile(p+'.tmp',process.argv[3]);"
                          "await rename(p+'.tmp',p);\n", encoding='utf-8')
        parse = json.loads
        def at_parse(raw, *args, **kwargs):
            result = subprocess.run([node, str(script), str(self.path), json.dumps(self.new)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            return parse(raw, *args, **kwargs)
        with mock.patch.object(source.json, 'loads', at_parse):
            self.assertEqual(source.read_runs(str(self.path)), self.old)
        self.assertEqual(source.read_runs(str(self.path)), self.new)

    def test_parse_failure_closes_reader_and_does_not_repair_data(self):
        self.path.write_text('{malformed', encoding='utf-8')
        with mock.patch.object(source, 'open', self.opening, create=True):
            with self.assertRaises(source.SourceError):
                source.read_runs(str(self.path))
        self.assertTrue(all(h.closed for h in self.opened))
        self.assertEqual(self.path.read_text(encoding='utf-8'), '{malformed')

    def test_missing_and_io_error_stay_distinct_from_empty_ledger(self):
        with self.assertRaises(source.SourceError):
            source.read_runs(str(self.path.with_name('missing')))
        with mock.patch.object(source, 'open', side_effect=PermissionError('denied'), create=True):
            with self.assertRaisesRegex(source.SourceError, 'denied'):
                source.read_runs(str(self.path))
        self.path.write_text('[]', encoding='utf-8')
        self.assertEqual(source.read_runs(str(self.path)), [])

    def test_malformed_identity_is_still_rejected(self):
        self.path.write_text('[{"createdAt":1}]', encoding='utf-8')
        with self.assertRaisesRegex(source.SourceError, 'requestID'):
            source.read_runs(str(self.path))

    def test_invalid_utf8_is_not_reinterpreted_and_handle_closes(self):
        invalid = b'["\xff"]'
        self.path.write_bytes(invalid)
        with mock.patch.object(source, 'open', self.opening, create=True):
            with self.assertRaises(source.SourceError):
                source.read_runs(str(self.path))
        self.assertTrue(all(h.closed for h in self.opened))
        self.assertEqual(self.path.read_bytes(), invalid)

    def test_close_failure_is_reported_without_parsing(self):
        handle = mock.MagicMock()
        handle.__enter__.return_value = handle
        handle.read.return_value = '[]'
        handle.__exit__.side_effect = OSError('close failed')
        with mock.patch.object(source, 'open', return_value=handle, create=True):
            with mock.patch.object(source.json, 'loads') as parse:
                with self.assertRaisesRegex(source.SourceError, 'close failed'):
                    source.read_runs(str(self.path))
        parse.assert_not_called()

    def test_read_failure_closes_reader_and_never_parses(self):
        handle = mock.MagicMock()
        handle.__enter__.return_value = handle
        handle.read.side_effect = OSError('read failed')
        with mock.patch.object(source, 'open', return_value=handle, create=True):
            with mock.patch.object(source.json, 'loads') as parse:
                with self.assertRaisesRegex(source.SourceError, 'read failed'):
                    source.read_runs(str(self.path))
        handle.__exit__.assert_called_once()
        parse.assert_not_called()


if __name__ == '__main__':
    unittest.main()
