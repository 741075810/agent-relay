// Optional offline contract only. No built-in transport, persistence or runtime wiring.
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= 512 && !value.includes('\0');
const fields = ['sessionId', 'taskId', 'key', 'epoch', 'attempt'];
const unknown = code => ({ outcome: 'unknown', code });
function validBinding(value) {
  return isObject(value) && fields.every(field => Object.hasOwn(value, field))
    && ['sessionId', 'taskId', 'key', 'epoch'].every(field => id(value[field]))
    && Number.isSafeInteger(value.attempt) && value.attempt > 0;
}

/** Integrity/correlation validation, NOT authenticity or upstream execution proof. */
export function assessBoundReceipt(request, reply) {
  try {
    if (!validBinding(request)) return unknown('request_invalid');
    if (!isObject(reply) || reply.outcome !== 'ack' || !Object.hasOwn(reply, 'receipt')) {
      return unknown('receipt_missing');
    }
    const receipt = reply.receipt;
    if (!validBinding(receipt) || receipt.version !== 1 || !id(receipt.receiptId)) {
      return unknown('receipt_invalid');
    }
    if (fields.some(field => receipt[field] !== request[field])) return unknown('receipt_binding_mismatch');
    return { outcome: 'ack' }; // accepted handoff only; never a task-completion result
  } catch { return unknown('receipt_invalid'); }
}

/** Caller attests transport provenance; enabled must be exactly true. No retries/reset API.
 * In-memory latches are deliberately conservative and do NOT survive process restart.
 */
export function createOfflineBoundReceiptAdapter({ enabled = false, transport, maxKeys = 128 } = {}) {
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 1024) throw new Error('max_keys_invalid');
  const pending = new Set();
  const receiptIds = new Set();
  return {
    async request(input) {
      if (enabled !== true) return unknown('adapter_disabled');
      let request;
      try {
        if (!validBinding(input) || typeof input.title !== 'string'
          || Buffer.byteLength(input.title, 'utf8') > 32768) return unknown('request_invalid');
        request = Object.freeze(Object.fromEntries([...fields, 'title'].map(field => [field, input[field]])));
      } catch { return unknown('request_invalid'); }
      if (pending.has(request.key)) return unknown('duplicate_or_conflicting_request');
      if (pending.size >= maxKeys) return unknown('adapter_capacity');
      if (!transport || typeof transport.request !== 'function') return unknown('transport_missing');
      pending.add(request.key); // before await: concurrent/repeated/changed-attempt calls never resend
      try {
        const reply = await transport.request(request);
        // Snapshot before validation so getters cannot change the receipt between checks and use.
        const saved = structuredClone(reply);
        const result = assessBoundReceipt(request, saved);
        if (result.outcome !== 'ack') return result;
        if (receiptIds.has(saved.receipt.receiptId)) return unknown('duplicate_receipt');
        receiptIds.add(saved.receipt.receiptId);
        return result;
      } catch { return unknown('transport_or_receipt_error'); }
    },
  };
}
