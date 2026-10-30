// T095B109: does the extension keep the host's "committed, durability unknown" signal?
//
// The host replies to a failed-but-published write with
//   { ok: false, error: { code: 'internal', message: '…this write is committed…',
//                         committed: true } }
// `native_client` turns that into a PortError built from `code` and `message` only, so the
// structured flag is dropped: the wording survives, the fact does not. `queue_delivery` then
// records `lastError` as free text, which means anything that wants to tell "written but not
// durable" from "not written" has to pattern-match English.
//
// This suite first records what actually happens (so the claim is measured, not assumed), then
// pins the two properties that must not change: no automatic replay of a committed operation,
// and identical behaviour against a host that does not send the flag at all.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 't109-committed-'));
for (const [from, to] of [['./extension/lib/native_client.js', 'native_client.mjs'],
                          ['./extension/lib/queue_delivery.js', 'queue_delivery.mjs']]) {
  writeFileSync(join(dir, to), readFileSync(new URL(from, import.meta.url)));
}
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: (await import('node:crypto')).webcrypto,
  });
}
const { NativeClient } = await import(pathToFileURL(join(dir, 'native_client.mjs')).href);
const { QueueDelivery } = await import(pathToFileURL(join(dir, 'queue_delivery.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let pass = 0;
let fail = 0;
function check(ok, label) {
  if (ok) {
    pass += 1;
    console.log('  PASS  ' + label);
  } else {
    fail += 1;
    console.log('  FAIL  ' + label);
  }
}

const COMMITTED_MESSAGE = 'the queue file was replaced and its content is what a reader now '
  + 'sees, but the directory entry could not be synced (EIO), so this write is committed and '
  + 'may not survive a power loss.';

// A port that answers the first request with `reply` and records what was sent.
function port(reply) {
  const listeners = { message: [], disconnect: [] };
  const sent = [];
  return {
    sent,
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    postMessage: (doc) => {
      sent.push(doc);
      if (sent.length === 1 && reply) {
        queueMicrotask(() => listeners.message.forEach((fn) => fn(reply(doc))));
      }
    },
  };
}

function event(id) {
  return { eventId: id, name: 'task.completed', runId: id, status: 'completed',
    createdAt: '2026-10-22T00:00:00Z', message: '[DSH preview] ' + id, replay: true,
    deliverable: false };
}

function harness(request) {
  const state = { cursor: 0, received: [], lastError: null, consumerId: 'c1' };
  const log = [];
  const delivery = new QueueDelivery({
    consumerId: 'c1',
    request: async (op, args) => { log.push(['request', op, args]); return request(op, args); },
    get: async (defaults) => Object.assign({}, defaults, state),
    set: async (values) => { log.push(['set', values]); Object.assign(state, values); },
    now: () => '2026-10-22T00:00:01.000Z',
  });
  return { state, log, delivery };
}

// 1. What the client does with the frame today.
{
  const p = port((doc) => ({ v: 1, id: doc.id, ok: false,
    error: { code: 'internal', message: COMMITTED_MESSAGE, committed: true } }));
  const client = new NativeClient({ connect: () => p, timeoutMs: 1000 });
  let caught = null;
  try {
    await client.request('ack', { acked: ['e1'] });
  } catch (err) {
    caught = err;
  }
  check(caught !== null, 'a committed failure rejects the request');
  check(String(caught.message).includes('committed'),
        'the host wording reaches the caller: ' + String(caught.message).slice(0, 60));
  check(caught.kind === 'host', 'the failure is attributed to the host, not the port');
  check(caught.committed === true,
        'the structured flag survives the client (measured, not assumed)');
  check(p.sent.length === 1,
        'the client does not resend a committed operation on its own');
}

// 2. A host that never sends the flag must behave exactly as before.
{
  const p = port((doc) => ({ v: 1, id: doc.id, ok: false,
    error: { code: 'internal', message: 'the queue did not keep event(s) e1' } }));
  const client = new NativeClient({ connect: () => p, timeoutMs: 1000 });
  let caught = null;
  try {
    await client.request('ack', { acked: ['e1'] });
  } catch (err) {
    caught = err;
  }
  check(caught !== null && caught.committed === false,
        'an older host reports "not committed" rather than undefined');
}

// 3. Delivery: a committed ACK failure must not re-show the event, and must record the flag.
{
  let ackFails = true;
  const h = harness(async (op, args) => {
    if (op === 'poll') return { events: [event('e1')], cursor: 4, more: false };
    if (op === 'ack' && ackFails) {
      ackFails = false;
      const err = new Error('internal: ' + COMMITTED_MESSAGE);
      err.committed = true;
      throw err;
    }
    return { newlyAcked: 0 };
  });
  const first = await h.delivery.poll();
  check(!first.ok && h.state.cursor === 0, 'a committed ack failure leaves the cursor uncommitted');
  check(h.state.received.length === 1, 'the event is not shown twice after the retry');
  check(String(h.state.lastError || '').includes('committed'),
        'the record keeps the host wording');
  check(h.state.lastErrorCommitted === true,
        'the record keeps the structured flag for anything that wants it');
  const second = await h.delivery.poll();
  check(second.ok && h.state.cursor === 4, 'the retry converges and commits the cursor');
  check(h.state.received.length === 1, 'still one display after the successful retry');
  check(h.state.lastError === null && h.state.lastErrorCommitted !== true,
        'a clean poll clears the committed marker');
}

console.log('');
console.log((fail === 0 ? 'OK ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
