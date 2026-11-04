"""T232: the layer between "the host acknowledged an event" and "a person saw a message".

The extension already records that layer properly -- `submitted` means the click landed *and* exactly one
exact-template message appeared in the rendered DOM; `unconfirmed` means it was clicked and the page never proved it;
`refused` means nothing was written -- together with `delivered` which requires both an acknowledgement and complete
receipt facts. It lives in `chrome.storage.local`, so the only way a read-only tool can see it is an exported copy.

What these tests pin:

  * with no export, the answer is `unknown` and that is stated as a limitation, not as a finding that displaces the
    headline;
  * with an export, `submit_confirmed` reports what the page accepted -- and `page_visible` stays `unknown`, because
    "the page accepted the message" is not "a person read it";
  * a record claiming delivery with incomplete receipt facts is discarded, its facts kept;
  * a broken export is a finding; the tool still writes nothing.
"""
import hashlib
import io
import json
import os
import shutil
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, 'tools', 'notify_doctor.py')
NOW_MS = 1_800_000_000_000
NOW_SECONDS = NOW_MS // 1000


def load_tool():
    import importlib.util
    spec = importlib.util.spec_from_file_location('notify_doctor_t232', TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ident(n):
    return '%08d-0000-4000-8000-000000000000' % n


def record(run, status, appeared, exact, delivered=False, clicked=True):
    return {'schema': 't166-diagnostic/1', 'at': NOW_MS - 60_000, 'runId': run,
            'classification': 'submitted' if status == 'submitted' else 'not_delivered',
            'delivered': delivered,
            'deliveredWhy': 'acknowledged after a verified receipt' if delivered else
                            'not delivered: no acknowledgement observed',
            'fields': {'status': status, 'clickPerformed': clicked,
                       'composerWritten': clicked, 'appeared': appeared,
                       'exactTemplateMatched': exact, 'receiptPath': 'fixture-path',
                       'conversationMatched': True, 'documentInstanceMatched': True,
                       'visibilityState': 'visible', 'hasFocus': True}}


class DoctorCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tool = load_tool()

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='doctor-t232-')
        self.addCleanup(shutil.rmtree, self.root, True)

    def write(self, name, document):
        with io.open(os.path.join(self.root, name), 'w', encoding='utf-8') as handle:
            json.dump(document, handle)

    def write_state(self):
        self.write('terminal-origin.json', {'version': 1, 'ids': [ident(1)],
                                            'readAt': NOW_SECONDS - 30, 'source': 'bridge-sqlite'})
        self.write('terminal-source.json', {'version': 1, 'pendingIds': [], 'ackedIds': [ident(1)],
                                            'baselineIds': [], 'baselineCount': 0, 'baselineDropped': 0})
        self.write('terminal-arm.json', {'version': 1, 'ids': [], 'takenAt': NOW_SECONDS - 120,
                                         'epoch': ident(999), 'truncated': False})
        self.write('queue.json', {'version': 1, 'events': [], 'next_seq': 5, 'acked': [],
                                  'acked_at': {}, 'consumers': {}, 'consumer_acks': {}})

    def digest(self):
        rows = []
        for name in sorted(os.listdir(self.root)):
            with open(os.path.join(self.root, name), 'rb') as handle:
                rows.append(name + ':' + hashlib.sha256(handle.read()).hexdigest())
        return rows

    def diagnose(self):
        before = self.digest()
        report = self.tool.diagnose(self.root, now_ms=NOW_MS)
        self.assertEqual(before, self.digest(), 'the doctor must not write to the state directory')
        return report

    def codes(self, report):
        return [f['code'] for f in report['findings']]


class NoExportTest(DoctorCase):
    def test_without_an_export_the_submit_layer_is_unknown_and_says_so(self):
        self.write_state()
        report = self.diagnose()
        self.assertEqual(report['attribution']['submit_confirmed'], 'unknown')
        self.assertFalse(report['stages']['diagnostic']['exported'])
        self.assertIn('delivery_diagnostic_not_exported', report['limitations'])
        self.assertNotIn('delivery_diagnostic_not_exported', self.codes(report),
                         'a limit of the tool is not a finding about the chain')
        self.assertEqual(report['attribution']['page_visible'], 'unknown')

    def test_the_headline_survives_the_missing_export(self):
        """The regression that made this a limitation: an unknown finding displaced `consumer_polled`."""
        self.write_state()
        report = self.diagnose()
        self.assertIn(report['primary'], ('expected_silence', 'no_reason_found', 'consumer_polled'))
        self.assertNotEqual(report['primary'], 'delivery_diagnostic_not_exported')


class ExportTest(DoctorCase):
    def test_a_submitted_record_reports_submit_not_visibility(self):
        self.write_state()
        self.write('delivery-diagnostic.json',
                   {'records': [record(ident(1), 'submitted', True, True, delivered=True)]})
        report = self.diagnose()
        self.assertTrue(report['stages']['diagnostic']['exported'])
        self.assertEqual(report['stages']['diagnostic']['submitted'], 1)
        self.assertEqual(report['attribution']['submit_confirmed'], 'submitted')
        self.assertEqual(report['attribution']['page_visible'], 'unknown',
                         'the page accepting a message is not a person reading it')
        self.assertNotIn(report.get('delivery'), ('delivered', 'user_visible'))
        self.assertNotIn('delivery_diagnostic_not_exported', report['limitations'])

    def test_an_unconfirmed_record_is_unconfirmed_and_nothing_more(self):
        self.write_state()
        self.write('delivery-diagnostic.json',
                   {'records': [record(ident(1), 'unconfirmed', False, False)]})
        report = self.diagnose()
        self.assertEqual(report['stages']['diagnostic']['unconfirmed'], 1)
        self.assertEqual(report['attribution']['submit_confirmed'], 'unconfirmed')
        self.assertEqual(report['attribution']['page_visible'], 'unknown')

    def test_a_refused_record_is_refused(self):
        self.write_state()
        self.write('delivery-diagnostic.json',
                   {'records': [record(ident(1), 'refused', False, False, clicked=False)]})
        report = self.diagnose()
        self.assertEqual(report['attribution']['submit_confirmed'], 'refused')

    def test_mixed_outcomes_are_not_summarised_into_the_happy_one(self):
        self.write_state()
        self.write('delivery-diagnostic.json', {'records': [
            record(ident(1), 'submitted', True, True, delivered=True),
            record(ident(2), 'unconfirmed', False, False)]})
        report = self.diagnose()
        self.assertEqual(report['attribution']['submit_confirmed'], 'mixed')
        self.assertEqual(report['stages']['diagnostic']['submitted'], 1)
        self.assertEqual(report['stages']['diagnostic']['unconfirmed'], 1)

    def test_a_single_record_document_is_accepted_too(self):
        self.write_state()
        self.write('delivery-diagnostic.json', record(ident(1), 'submitted', True, True, delivered=True))
        report = self.diagnose()
        self.assertEqual(report['stages']['diagnostic']['records'], 1)
        self.assertEqual(report['attribution']['submit_confirmed'], 'submitted')


class ClaimGuardTest(DoctorCase):
    def test_a_record_that_claims_delivery_without_receipt_facts_is_discarded(self):
        self.write_state()
        self.write('delivery-diagnostic.json', {'records': [
            record(ident(1), 'unconfirmed', False, False, delivered=True)]})
        report = self.diagnose()
        self.assertEqual(report['stages']['diagnostic']['inconsistent'], 1)
        self.assertIn('diagnostic_self_inconsistent', self.codes(report))
        self.assertEqual(report['attribution']['submit_confirmed'], 'unconfirmed',
                         'the status the page actually produced, not the claim')
        self.assertEqual(report['attribution']['page_visible'], 'unknown')

    def test_a_broken_export_is_a_finding(self):
        self.write_state()
        with io.open(os.path.join(self.root, 'delivery-diagnostic.json'), 'w', encoding='utf-8') as handle:
            handle.write('{ not json')
        report = self.diagnose()
        self.assertIn('artifact_unreadable', self.codes(report))
        self.assertEqual(report['attribution']['submit_confirmed'], 'unknown')
        self.assertEqual(report['attribution']['page_visible'], 'unknown')


if __name__ == '__main__':
    unittest.main()
