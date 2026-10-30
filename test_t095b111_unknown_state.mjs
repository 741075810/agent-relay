// T095B111: "the host never said" is its own state, and today it is flattened into "false".
//
// The chain is NativeClient -> QueueDelivery -> popup, and the middle of it throws a fact away:
//
//   native_client.js   failure.committed = detail.committed === true   -> an old host yields false
//   queue_delivery.js  lastErrorCommitted: Boolean(err && err.committed) -> false again
//   queue_error_view   `=== false` means "the host reports no commit evidence"; a host that
//                      cannot answer lands in that same branch
//
// So T110's third wording -- "旧版 Host 不会报告提交状态，无法判断是否落盘" -- can never appear,
// and the operator is told the host denied a commit it never spoke about. The deployed host is an
// old build with no `committed` field at all, which makes this the branch production would hit.
//
// Three states, end to end: true / false / null (unknown). Unknown must not become "not committed".
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 't111-tri-'));
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
await import('./extension/lib/queue_error_view.js');
const { describeQueueError } = globalThis;

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

const TEXT = 'internal: the queue file was replaced and its content is what a reader now sees';

function port(error) {
  const listeners = [];
  let sent = 0;
  return {
    get sent() { return sent; },
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: { addListener: () => {} },
    postMessage: (doc) => {
      sent += 1;
      if (sent === 1) {
        queueMicrotask(() => listeners.forEach((fn) => fn({ v: 1, id: doc.id, ok: false,
          error })));
      }
    },
  };
}

async function clientError(error) {
  const client = new NativeClient({ connect: () => port(error), timeoutMs: 1000 });
  try {
    await client.request('ack', { acked: ['e1'] });
  } catch (err) {
    return err;
  }
  throw new Error('the request unexpectedly succeeded');
}

function event(id) {
  return { eventId: id, name: 'task.completed', runId: id, status: 'completed',
    createdAt: '2026-10-22T00:00:00Z', message: '[DSH preview] ' + id, replay: true,
    deliverable: false };
}

function harness(request) {
  const state = { cursor: 0, received: [], lastError: null, consumerId: 'c1' };
  const delivery = new QueueDelivery({
    consumerId: 'c1',
    request: async (op, args) => request(op, args),
    get: async (defaults) => Object.assign({}, defaults, state),
    set: async (values) => { Object.assign(state, values); },
    now: () => '2026-10-22T00:00:01.000Z',
  });
  return { state, delivery };
}

// 1. "Unknown" survives the client.
{
  const err = await clientError({ code: 'internal', message: TEXT });
  check(err.committed === null,
        'a host that sends no field yields null (unknown), not false: '
        + String(err.committed));
  check(String(err.message).includes('internal'), 'the code prefix is untouched');
}

// 2. The two facts the host can actually state are still stated.
{
  const yes = await clientError({ code: 'internal', message: TEXT, committed: true });
  check(yes.committed === true, 'committed:true is preserved');
  const no = await clientError({ code: 'internal', message: TEXT, committed: false });
  check(no.committed === false, 'committed:false is preserved');
}

// 3. Delivery keeps the third state instead of collapsing it.
{
  let fails = true;
  const h = harness(async (op) => {
    if (op === 'poll') return { events: [event('e1')], cursor: 4, more: false };
    if (op === 'ack' && fails) {
      fails = false;
      const err = new Error('internal: ' + TEXT);
      throw err;                        // no `committed` at all: an old host
    }
    return { newlyAcked: 0 };
  });
  await h.delivery.poll();
  check(h.state.lastErrorCommitted === null,
        'the delivery record keeps "unknown" as null, not false: '
        + String(h.state.lastErrorCommitted));
  check(h.state.cursor === 0, 'the cursor is still not committed, so the retry still happens');
}

// 4. ...and the popup wording can finally tell the three apart.
{
  const unknown = describeQueueError({ lastError: TEXT, lastErrorCommitted: null });
  check(unknown.tone === 'bad', 'unknown is still shown as a failure');
  check(unknown.text.includes('旧版 Host'),
        'unknown points at the version mismatch: ' + unknown.text.slice(0, 24));
  check(!unknown.text.includes('没有已提交证据'),
        'unknown is not reported as the host denying a commit');

  const denied = describeQueueError({ lastError: TEXT, lastErrorCommitted: false });
  check(denied.text.includes('没有已提交证据'), 'an explicit false keeps the denial wording');
  check(denied.text !== unknown.text, 'the two failures do not read the same');

  const landed = describeQueueError({ lastError: TEXT, lastErrorCommitted: true });
  check(landed.text.includes('已写入'), 'committed:true still says the write landed');
}

console.log('');
console.log((fail === 0 ? 'OK ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
