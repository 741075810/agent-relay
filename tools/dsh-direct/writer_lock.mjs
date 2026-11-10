// Mandatory for updated Direct writers. No expiry, stealing, PID cleanup or live-state migration.
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DirectError } from './protocol.mjs';

export function acquireWriter(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const root = realpathSync(stateDir), file = join(root, '.direct-writer.lock');
  const body = JSON.stringify({ version: 1, owner: randomUUID(), pid: process.pid }) + '\n';
  let fd;
  try { fd = openSync(file, 'wx', 0o600); }
  catch (e) {
    throw new DirectError(e.code === 'EEXIST' ? 'direct_writer_held' : 'direct_writer_unavailable',
      'Direct writer reservation not acquired; no takeover attempted');
  }
  // A partial/failed lock write is deliberately retained, never interpreted as an unlocked ledger.
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  let released = false, preserved = false;
  return Object.freeze({
    assertHeld() {
      if (preserved) throw new DirectError('direct_writer_preserved', 'Direct writer is quarantined after an uncertain write');
      let matches = false;
      try { matches = !released && readFileSync(file, 'utf8') === body; } catch {}
      if (!matches) throw new DirectError('direct_writer_lost', 'Direct writer reservation changed or disappeared');
    },
    preserve() { preserved = true; },
    release() {
      if (preserved) return;
      this.assertHeld();
      unlinkSync(file); released = true;
    },
  });
}
