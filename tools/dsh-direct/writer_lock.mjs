// Mandatory for updated Direct writers. No expiry, stealing, PID cleanup or live-state migration.
//
// Ownership is still decided by exact body equality: a lock file that does not contain this
// owner's record is not this owner's lock, and nothing here reclaims, reinterprets or ages it
// out. What changed in T352 is the *release* path, which used to check the body and then
// unlink by name. Between those two statements the file could be replaced (an external delete
// plus another writer's acquire), and the unlink would then destroy the newer owner's record:
// the newer writer would keep failing closed, but its lock was gone and only its own
// assertHeld would notice. Release now moves the file aside with an atomic rename, inspects
// what it actually took, and restores it byte-for-byte when it is not ours. The window is
// narrower and the damage is reversible, not zero: no portable compare-and-delete exists.
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DirectError } from './protocol.mjs';

const LOCK_VERSION = 2;

export function acquireWriter(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const root = realpathSync(stateDir), file = join(root, '.direct-writer.lock');
  const owner = randomUUID(), generation = randomUUID();
  // `generation` is this lease's identity in the ledger's `writer` record. It is not an
  // expiry and not a fence over other processes: it only names the writer that produced the
  // bytes currently on disk.
  const body = JSON.stringify({ version: LOCK_VERSION, owner, generation, pid: process.pid }) + '\n';
  let fd;
  try { fd = openSync(file, 'wx', 0o600); }
  catch (e) {
    throw new DirectError(e.code === 'EEXIST' ? 'direct_writer_held' : 'direct_writer_unavailable',
      'Direct writer reservation not acquired; no takeover attempted');
  }
  // A partial/failed lock write is deliberately retained, never interpreted as an unlocked ledger.
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  let released = false, preserved = false;

  function ours(bytes) { return bytes !== null && bytes.toString('utf8') === body; }

  function readOrNull() {
    try { return readFileSync(file); } catch { return null; }
  }

  return Object.freeze({
    owner,
    generation,
    assertHeld() {
      if (preserved) throw new DirectError('direct_writer_preserved', 'Direct writer is quarantined after an uncertain write');
      if (released || !ours(readOrNull())) {
        throw new DirectError('direct_writer_lost', 'Direct writer reservation changed or disappeared');
      }
    },
    preserve() { preserved = true; },
    release() {
      if (preserved || released) return;
      const parked = file + '.release-' + owner;
      try { renameSync(file, parked); }
      catch (e) {
        // Nothing was moved: either the lock was already gone or it could not be touched.
        throw new DirectError('direct_writer_lost',
          'Direct writer reservation changed or disappeared', { reason: String((e && e.code) ?? null) });
      }
      const taken = (() => { try { return readFileSync(parked); } catch { return null; } })();
      if (ours(taken)) { unlinkSync(parked); released = true; return; }
      // We moved a record that was not ours. Put the other writer's bytes back under the lock
      // name, and if the name is already taken again, keep the parked copy as evidence.
      let restored = false;
      if (taken !== null) {
        try { writeFileSync(file, taken, { flag: 'wx', mode: 0o600 }); restored = true; } catch { restored = false; }
      }
      if (restored) { try { unlinkSync(parked); } catch { /* parked copy already gone */ } }
      throw new DirectError('direct_writer_lost',
        'Direct writer reservation was replaced; the other writer\'s record was restored instead of deleted',
        { restored, observedChars: taken === null ? null : taken.toString('utf8').length });
    },
  });
}
