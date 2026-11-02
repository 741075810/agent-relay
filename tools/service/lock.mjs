// T197: exclusive writer lock with identity, shared by the MCP server and the service.
//
// T196 used `existsSync` then `writeFileSync`, which is a race two processes can both win, and the exit hook unlinked
// whatever was at the path -- so a second process that had already taken over could have its fresh lock deleted by the
// first one's cleanup. Now the lock is created atomically (`wx` -- fails if it exists), it carries a random token, and
// releasing only removes the file when the token is still ours.

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export function lockPath(dir) {
  return dir.replace(/[\\/]+$/, '') + (process.platform === 'win32' ? '\\' : '/') + 'writer.lock';
}

function readLock(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

/**
 * @returns {{ok: boolean, code: string|null, token: string|null, path: string, owner?: object|null}}
 */
export function acquireLock(dir) {
  const path = lockPath(dir);
  const token = randomBytes(12).toString('hex');
  const body = JSON.stringify({ pid: process.pid, token, at: Date.now() }) + '\n';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, 'wx'); // atomic create-or-fail: exactly one winner
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return { ok: true, code: null, token, path };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return { ok: false, code: 'lock_io_error', token: null, path };
    }
    const owner = readLock(path);
    if (owner && pidAlive(owner.pid)) return { ok: false, code: 'state_dir_busy', token: null, path, owner };
    // Stale (dead pid, or unreadable/partial file): remove it and retry the atomic create.
    try {
      unlinkSync(path);
    } catch { /* someone else removed it first; the retry decides */ }
  }
  return { ok: false, code: 'state_dir_busy', token: null, path, owner: readLock(path) };
}

/** Remove the lock only if it is still the one this process created. */
export function releaseLock(lock) {
  if (!lock || !lock.ok || !lock.path || !lock.token) return false;
  const owner = readLock(lock.path);
  if (!owner || owner.token !== lock.token || owner.pid !== process.pid) return false;
  try {
    unlinkSync(lock.path);
    return true;
  } catch {
    return false;
  }
}
