"""T095B87: T086's generation check is not a CAS, and the lock evicts the living.

Two claims got made last round and neither was tested:

  * "the queue has a compare-and-swap now" -- it is a **read the version, then rename**
    pair, with a window in between. Another writer that got in during that window has its
    work published over. That is the same lost update T086 was supposed to close, one
    level further in.
  * "`_Lock` breaks a stale lock so a dead host cannot wedge delivery" -- it breaks **any**
    lock after five seconds, including one held by a writer that is alive, working, and
    about to publish.

Both come from the same missing thing: the lock has no idea whether the process that holds
it still exists. A lease with an owner and a liveness check gives delivery the property it
actually needs -- a dead host is recycled, a slow live one is waited for.

The test below is deterministic: the slow writer's save is held open at a known point while
a second writer tries to enter, so nothing depends on which thread the scheduler favours.
"""
import threading
import time
import unittest

import host

from test_t095b86_queue_concurrency import QueueScene, event


class LiveHolderTest(QueueScene):
    @unittest.expectedFailure
    def test_a_live_slow_writer_is_waited_for_not_evicted(self):
        """KNOWN GAP, not fixed yet. `_Lock` breaks *any* lock after five seconds, so a
        writer that is alive and working inside the critical section is evicted and its
        publish lands over its peer's. The fix is a lease with an owner and a liveness
        check (`os.kill(pid, 0)` / `OpenProcess`), waiting while the owner lives and
        recycling only when it does not. Written as a failing test so the gap is visible
        in CI rather than remembered."""
        real_replace = host.os.replace
        reached = threading.Event()
        release = threading.Event()

        def gated_replace(src, dst, *args, **kwargs):
            if 'queue.json' in str(dst) and not reached.is_set():
                reached.set()
                release.wait(30)
            return real_replace(src, dst, *args, **kwargs)

        host.os.replace = gated_replace
        box = {}
        try:
            holder = threading.Thread(
                target=lambda: box.update(slow=host.append_events(
                    self.state, [event('slow')])))
            holder.start()
            self.assertTrue(reached.wait(10), 'the slow writer never reached its rename')

            intruder = threading.Thread(
                target=lambda: box.update(fast=host.append_events(
                    self.state, [event('fast')])))
            intruder.start()
            # Longer than `_Lock`'s five second patience: the old code breaks the lock here.
            time.sleep(5.5)
            during = {e['eventId'] for e in self.queue_document()['events']}
            self.assertNotIn('fast', during,
                             'a second writer entered while the first was alive and inside '
                             'the critical section')
            release.set()
            holder.join(40)
            intruder.join(40)
        finally:
            host.os.replace = real_replace
            release.set()

        present = {e['eventId'] for e in self.queue_document()['events']}
        self.assertEqual(present, {'slow', 'fast'},
                         'the queue lost a write (holds %r)' % (sorted(present),))
        self.assertEqual((box.get('slow'), box.get('fast')), (1, 1))

    def test_a_dead_holder_is_still_recycled(self):
        """The lease must not turn a killed host into a permanent wedge."""
        lock = host.os.path.join(self.state, host.LOCK_FILE)
        with open(lock, 'w', encoding='utf-8') as handle:
            handle.write('999999')                     # a pid that is not running
        started = time.time()
        added = host.append_events(self.state, [event('after-death')])
        self.assertEqual(added, 1)
        self.assertLess(time.time() - started, 12.0,
                        'a dead holder held delivery for too long')
        self.assertFalse(host.os.path.exists(lock))


class GenerationWindowTest(QueueScene):
    def test_the_version_check_and_the_rename_are_not_a_cas(self):
        """Whatever the version says, the bytes between the check and the rename are a
        window. If the lock is what closes it, the lock must be airtight while a writer is
        alive -- which is what the lease above gives it."""
        real_replace = host.os.replace
        inserted = {}

        def racing_replace(src, dst, *args, **kwargs):
            if 'queue.json' in str(dst) and not inserted.get('busy'):
                inserted['busy'] = True          # the peer's own save must not re-enter
                # A *different* writer's name, so it cannot collide with our temporary.
                peer = host.os.path.join(self.state, 'peer.json.tmp-1')
                with open(peer, 'w', encoding='utf-8') as handle:
                    host.json.dump(host.load_queue(self.state), handle)
                real_replace(peer, dst)
                inserted['done'] = True
            return real_replace(src, dst, *args, **kwargs)

        host.os.replace = racing_replace
        try:
            host.append_events(self.state, [event('mine')])
        finally:
            host.os.replace = real_replace
        self.assertTrue(inserted.get('done'), 'the race was never injected')
        present = {e['eventId'] for e in self.queue_document()['events']}
        self.assertIn('mine', present, 'the writer lost its own event to the race')

    def test_an_old_queue_without_a_generation_still_works(self):
        """A queue written before the counter existed must not need a migration."""
        document = {'version': 1, 'next_seq': 1,
                    'events': [dict(event('legacy'), seq=1, enqueuedAt=1,
                                    deliveredAt=None, deliveries=0)],
                    'acked': []}
        with open(host.os.path.join(self.state, host.QUEUE_FILE), 'w',
                  encoding='utf-8') as handle:
            host.json.dump(document, handle)
        added = host.append_events(self.state, [event('new')])
        self.assertEqual(added, 1)
        present = {e['eventId'] for e in self.queue_document()['events']}
        self.assertEqual(present, {'legacy', 'new'})
        self.assertIsInstance(self.queue_document().get('generation'), int)


if __name__ == '__main__':
    unittest.main()
