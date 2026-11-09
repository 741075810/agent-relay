// Offline only. No coordinator import, transport, automatic activation or directory creation.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

export const MAX_CHECKPOINT_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const textId = value => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= 512 && !value.includes('\0');
const fail = code => { throw Object.assign(new Error(code), { storeCode: code }); };

function validate(envelope, identity) {
  if (!object(envelope) || envelope.version !== 1) fail('envelope_invalid');
  if (envelope.sessionId !== identity.sessionId || envelope.goalId !== identity.goalId
    || envelope.goalRevision !== identity.goalRevision) fail('identity_mismatch');
  if (typeof envelope.checkpoint !== 'string'
    || Buffer.byteLength(envelope.checkpoint, 'utf8') > MAX_CHECKPOINT_BYTES) fail('checkpoint_size');
  let cp;
  try { cp = JSON.parse(envelope.checkpoint); } catch { fail('checkpoint_invalid'); }
  if (!object(cp) || cp.version !== 1 || cp.sessionId !== identity.sessionId
    || !object(cp.state) || !object(cp.store)) fail('checkpoint_invalid');
  // Structural validation only: does not certify grant, lease or dispatch semantics.
  return envelope;
}

/** Trusted existing directory, caller-enforced single owner. Disabled unless explicitly true.
 * fault(stage) is a test seam; a thrown error after intent creation leaves evidence in place.
 */
export function createOfflineCheckpointStore({ directory, identity, enabled = false, fault } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('directory_invalid');
  if (!object(identity) || !textId(identity.sessionId) || !textId(identity.goalId)
    || !Number.isSafeInteger(identity.goalRevision) || identity.goalRevision < 1) fail('identity_invalid');
  const expected = Object.freeze({ ...identity });
  const target = path.join(directory, 'checkpoint.json');
  const intent = path.join(directory, 'checkpoint.intent');
  const pending = path.join(directory, 'checkpoint.pending');
  let poisoned = false;
  let busy = false;
  const inject = async stage => { if (fault) await fault(stage); };
  const exists = async file => {
    try { await fs.lstat(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  async function readBytes(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('file_invalid');
    const handle = await fs.open(file, 'r');
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.size > MAX_FILE_BYTES) fail('file_size');
      // Fixed allocation, including a sentinel byte; never read an unbounded file.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_FILE_BYTES) fail('file_size');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } finally { await handle.close(); }
  }
  function decode(bytes) {
    let stored;
    try { stored = JSON.parse(bytes); } catch { fail('stored_json_invalid'); }
    if (!object(stored) || stored.version !== 1 || typeof stored.payload !== 'string'
      || stored.sha256 !== hash(stored.payload)) fail('integrity_mismatch');
    let envelope;
    try { envelope = JSON.parse(stored.payload); } catch { fail('envelope_invalid'); }
    return validate(envelope, expected);
  }
  const resultError = error => ({ code: error.storeCode || 'storage_error' });
  return {
    async read() {
      if (enabled !== true) return { code: 'disabled' };
      if (busy || poisoned) return { code: 'unsettled_write' };
      busy = true;
      try {
        if (await exists(intent) || await exists(pending)) return { code: 'unsettled_write' };
        const envelope = decode(await readBytes(target));
        return { code: null, envelope };
      } catch (error) {
        return error.code === 'ENOENT' ? { code: 'missing' } : resultError(error);
      } finally { busy = false; }
    },
    async write(envelope) {
      if (enabled !== true) return { code: 'disabled' };
      if (busy || poisoned) return { code: 'unsettled_write' };
      busy = true;
      let handle;
      try {
        if (await exists(intent) || await exists(pending)) fail('unsettled_write');
        // Intent precedes validation/new bytes, so even rejected replacement input
        // prevents later readers from silently treating old bytes as the new state.
        handle = await fs.open(intent, 'wx', 0o600);
        await handle.writeFile('offline-checkpoint-write-v1\n');
        await handle.sync();
        await handle.close(); handle = null;
        await inject('after_intent');
        if (await exists(target)) decode(await readBytes(target)); // preserve corrupt old evidence
        validate(envelope, expected);
        const payload = JSON.stringify(envelope);
        const bytes = JSON.stringify({ version: 1, payload, sha256: hash(payload) });
        if (Buffer.byteLength(bytes, 'utf8') > MAX_FILE_BYTES) fail('file_size');
        // Copy and validate serialized values before any externally injected await.
        decode(bytes);
        handle = await fs.open(pending, 'wx', 0o600);
        await handle.writeFile(bytes, 'utf8');
        await inject('after_write');
        await handle.sync();
        await handle.close(); handle = null;
        await inject('before_rename');
        await fs.rename(pending, target); // same directory; no delete-and-retry fallback
        await inject('after_rename');
        if (await readBytes(target) !== bytes) fail('readback_mismatch');
        decode(bytes);
        await fs.unlink(intent); // commit marker removed only after successful readback
        return { code: null, sha256: hash(payload) };
      } catch (error) {
        poisoned = true; // including failure to establish an intent marker
        return resultError(error);
      } finally {
        if (handle) { try { await handle.close(); } catch { poisoned = true; } }
        busy = false;
      }
    },
  };
}
