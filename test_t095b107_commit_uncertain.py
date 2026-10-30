"""T095B107: after a successful `os.replace` the write is published; a failing directory sync
does not un-publish it, so saying "it failed" invites a retry of something that already landed.

T106 fsynced the state directory after the rename and swallowed any error, so the reply said
"queued" for a write that may not survive a power cut and nobody ever learned the disk was in
trouble. Neither direction is honest. The three states a caller needs to tell apart:

  * the temp file never reached the queue  -> nothing was written      (retry is correct)
  * the queue was replaced but not synced  -> readers see the new content,
                                              durability is unknown     (verify first)
  * replaced and synced                    -> done

`CommitUncertain` is the second state. It subclasses `HostError` so existing callers still
refuse, and `append_events` must not retry through it: its `eventId` de-duplication would turn
"uncertain" into a quiet "0 added" and the signal would vanish.

The directory sync is a no-op on Windows (a directory cannot be fsynced there), so the
platform-independent cases inject the failure at `_sync_directory`, and the POSIX case proves a
real directory handle reaches `fsync`. That one skips on Windows and runs on the ubuntu job.
"""
import errno
import os
import shutil
import tempfile
import unittest

import host

EVENT = {'eventId': 'evt-a', 'runId': 'run-a', 'text': 'x'}


class UncertainCommitTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t107-state-')
        host.append_events(self.state, [{'eventId': 'evt-base', 'runId': 'run-base',
                                         'text': 'b'}])
        self.original = host._sync_directory

    def tearDown(self):
        host._sync_directory = self.original
        shutil.rmtree(self.state, ignore_errors=True)

    def break_directory_sync(self, number=errno.EIO):
        def failing(_state_dir):
            raise OSError(number, os.strerror(number))
        host._sync_directory = failing

    def known(self):
        return host.known_event_ids(host.load_queue(self.state))

    def test_a_failed_directory_sync_is_reported_as_uncertain(self):
        self.break_directory_sync()
        with self.assertRaises(host.CommitUncertain) as caught:
            host.append_events(self.state, [dict(EVENT)])
        host._sync_directory = self.original
        message = str(caught.exception).lower()
        self.assertIn('committed', message, str(caught.exception))
        self.assertIn('replaced', message, str(caught.exception))
        self.assertNotIn('was not written', message, str(caught.exception))
        self.assertIn('evt-a', self.known(),
                      'the reply says the outcome is unknown but the event is not in the '
                      'queue: %s' % sorted(self.known()))

    def test_a_direct_save_reports_the_same_way(self):
        self.break_directory_sync(errno.ENOSPC)
        document = host.load_queue(self.state)
        with self.assertRaises(host.CommitUncertain) as caught:
            host.save_queue(self.state, document, expect=document.get('generation'))
        host._sync_directory = self.original
        self.assertIn('no space left', str(caught.exception).lower())
        self.assertIn('evt-base', self.known())

    def test_an_append_does_not_retry_into_a_second_write(self):
        self.break_directory_sync()
        with self.assertRaises(host.CommitUncertain):
            host.append_events(self.state, [dict(EVENT)])
        host._sync_directory = self.original
        document = host.load_queue(self.state)
        occurrences = [event for event in document['events']
                       if isinstance(event, dict) and event.get('eventId') == 'evt-a']
        self.assertEqual(len(occurrences), 1,
                         'the retry wrote the event again instead of trusting the first write')
        self.assertEqual(host.append_events(self.state, [dict(EVENT)]), 0,
                         'a later append of the same id must be a no-op')

    def test_a_failure_before_the_rename_is_a_plain_failure(self):
        """The other direction: nothing was published, so the queue must be untouched."""
        original_dump = host.json.dump

        def half(document, handle, **kwargs):
            handle.write('{"events": [')
            handle.flush()
            raise OSError(errno.ENOSPC, os.strerror(errno.ENOSPC))

        host.json.dump = half
        try:
            with self.assertRaises(OSError) as caught:
                host.append_events(self.state, [dict(EVENT)])
        finally:
            host.json.dump = original_dump
        self.assertNotIsInstance(caught.exception, host.CommitUncertain)
        self.assertEqual(self.known(), {'evt-base'})
        leftovers = [name for name in os.listdir(self.state) if '.tmp-' in name]
        self.assertEqual(leftovers, [])

    @unittest.skipIf(os.name == 'nt', 'Windows cannot fsync a directory handle')
    def test_a_real_directory_handle_reaches_fsync_on_posix(self):
        modes = []
        original = host.os.fsync

        def counting(fd):
            try:
                modes.append(os.fstat(fd).st_mode)
            except OSError:
                modes.append(0)
            return original(fd)

        host.os.fsync = counting
        try:
            host.append_events(self.state, [dict(EVENT)])
        finally:
            host.os.fsync = original
        self.assertTrue(any((mode & 0o170000) == 0o040000 for mode in modes),
                        'no directory handle was fsynced: %s' % modes)

    @unittest.skipIf(os.name != 'nt', 'asserts the Windows side of the difference')
    def test_windows_syncs_no_directory_and_raises_no_uncertainty(self):
        self.assertEqual(host.append_events(self.state, [dict(EVENT)]), 1)
        self.assertIn('evt-a', self.known())


if __name__ == '__main__':
    unittest.main()
