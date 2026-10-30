// T095B112: what each combination of host and extension actually says, and what it needs before
// it can say more.
//
// The `committed` field is new. Nothing in production has it: the deployed native host predates
// the field, and the running extension predates the code that reads it. So the interesting
// question is not "does the new path work" -- that is covered elsewhere -- but "for each pairing,
// what does the operator see, and what has to be deployed to change it".
//
//   host field     extension      what the popup reports                       what would change it
//   absent         new            "旧版 Host 不会报告提交状态"                 upgrade the host
//   true           new            "已写入，但耐久性未确认"                      nothing more
//   false          new            "Host 报告没有已提交证据"                    nothing more
//   absent         old (deployed) a plain error, no distinction at all         reload the extension
//
// The last row cannot be executed here -- it is the T076 build, and reloading it is not part of
// this round. It is recorded as the documented state of the deployed pair, not as a passing test.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 't112-matrix-'));
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

const TEXT = 'internal: the queue was replaced but not synced';
// The stamp lives in a plain script the popup loads; importing it runs the same definition.
await import('./extension/lib/build_stamp.js');
const STAMP = globalThis.BUILD_STAMP;

// hostField: 'absent' | 'true' | 'false'  ->  what a full poll cycle leaves in the record
async function afterFailedAck(hostField) {
  const error = { code: 'internal', message: TEXT };
  if (hostField !== 'absent') {
    error.committed = hostField === 'true';
  }
  let sent = 0;
  const listeners = [];
  const port = {
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
  const client = new NativeClient({ connect: () => port, timeoutMs: 1000 });
  let clientFlag;
  try {
    await client.request('ack', { acked: ['e1'] });
  } catch (err) {
    clientFlag = err.committed;
  }
  const state = { cursor: 0, received: [], lastError: null, consumerId: 'c1' };
  let firstAck = true;
  const delivery = new QueueDelivery({
    consumerId: 'c1',
    request: async (op, args) => {
      if (op === 'poll') {
        return { events: [{ eventId: 'e1', name: 'task.completed', runId: 'r1',
          status: 'completed', createdAt: '2026-10-22T00:00:00Z', message: 'x', replay: true,
          deliverable: false }], cursor: 4, more: false };
      }
      if (op === 'ack' && firstAck) {
        firstAck = false;
        const err = new Error('internal: ' + TEXT);
        err.committed = clientFlag;
        throw err;
      }
      return { newlyAcked: 0 };
    },
    get: async (defaults) => Object.assign({}, defaults, state),
    set: async (values) => { Object.assign(state, values); },
    now: () => '2026-10-22T00:00:01.000Z',
  });
  const result = await delivery.poll();
  return { state, result, view: describeQueueError(state) };
}

const out = {};
for (const hostField of ['absent', 'true', 'false']) {
  out[hostField] = await afterFailedAck(hostField);
  check(out[hostField].result.ok === false, hostField + ': the poll reports the failure');
  check(out[hostField].state.received.length === 1,
        hostField + ': the event is still shown exactly once');
  check(out[hostField].state.cursor === 0, hostField + ': the cursor stays uncommitted');
}

check(out.absent.state.lastErrorCommitted === null,
      'old host: recorded as unknown, which is all it can tell us');
check(out.absent.view.text.includes('旧版 Host'),
      'old host: the popup points at the version mismatch');
check(out.true.state.lastErrorCommitted === true, 'new host true: recorded as committed');
check(out.true.view.text.includes('已写入'), 'new host true: the popup says the write landed');
check(out.false.state.lastErrorCommitted === false, 'new host false: recorded as denied');
check(out.false.view.text.includes('没有已提交证据'), 'new host false: the popup says so');

// The three readings must be three different sentences; two identical strings would mean the
// distinction died somewhere in the middle again.
const texts = new Set([out.absent.view.text, out.true.view.text, out.false.view.text]);
check(texts.size === 3, 'the three host states produce three different sentences');
check(out.true.view.tone === 'warn' && out.absent.view.tone === 'bad'
      && out.false.view.tone === 'bad',
      'only "landed but unconfirmed" gets the warning tone');

// The stamp is the deploy-side half of the same question: which build is this?
check(typeof STAMP === 'string' && /^T\d{3}-[0-9a-f]{8}$/.test(STAMP),
      'the popup stamp is derived from the tree: ' + STAMP);
check(readFileSync('extension/popup.js', 'utf8').includes('globalThis.BUILD_STAMP'),
      'and the popup reads that single definition rather than its own copy');

console.log('');
console.log((fail === 0 ? 'OK ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
