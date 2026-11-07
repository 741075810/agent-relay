// T276: cold-safe fixed-cursor reads and exact rc.2 request/turn/result correlation. No live sessions or files.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeHost, createSessionControllerAdapter } from './tools/dsh-direct/adapters.mjs';
import { buildPageRequest, correlateResult, findAdmission } from './tools/dsh-direct/session_api.mjs';
import { startHostBridge } from './tools/dsh-direct/host_bridge.mjs';

const SESSION = 'session-11111111-2222-4333-8444-555566667777';
const REQUEST = 't276-request-0001';
const TOKEN = 'test-t276-history-' + 'a'.repeat(40);
const signal = () => new AbortController().signal;
const record = (type, data) => ({ type: 'event', event: { type, seq: 0, time: 0, data } });
const start = (turn) => record('turn/start', { turn });
const user = (rpcId) => record('user/message', { content: [{ type: 'text', text: 'question' }],
  source: { kind: 'user', rpcId } });
const answer = (turn, text, extra = {}) => record('assistant/message', { turn, step: 1,
  message: { content: [{ type: 'text', text }] }, ...extra });
const end = (turn, kind = 'completed') => record('turn/end', { turn, reason: { kind } });
const sequence = (records) => records.map((item, seq) => ({ ...item, event: { ...item.event, seq } }));

// A separate literal pagination fixture, not createFakeHost: the installed service ends at throughSeq+1.
function controller(records, { onPage } = {}) {
  const log = sequence(records);
  const calls = [];
  return {
    calls, log,
    async list() { return { items: [] }; },
    async prompt() { assert.fail('history must never prompt'); },
    async follow() { assert.fail('history must never activate via follow'); },
    async projections(request, abort) {
      assert.equal(request.sessionId, SESSION);
      assert.equal(typeof abort.throwIfAborted, 'function');
      abort.throwIfAborted();
      calls.push(['projections']);
      return { asOfSeq: log.length - 1, values: {} };
    },
    async page(request, abort) {
      abort.throwIfAborted();
      assert.equal(request.address.sessionId, SESSION);
      assert.ok(Number.isSafeInteger(request.throughSeq));
      assert.ok(request.throughSeq >= -1 && request.throughSeq < log.length);
      calls.push(['page', { ...request }]);
      onPage?.(log);
      const upper = Math.min(request.throughSeq + 1, request.beforeSeq ?? request.throughSeq + 1);
      let cut = 0;
      let count = 0;
      for (let i = upper - 1; i >= 0; i -= 1) {
        if (!['user/message', 'assistant/message'].includes(log[i].event.type)) continue;
        if (++count >= request.maxMessages) { cut = i; break; }
      }
      return { records: log.slice(cut, upper), hasMore: cut > 0 };
    },
  };
}

test('T276: real -1 semantics are empty, and adapter obtains current cursor from projections', async () => {
  const raw = controller([start(0), user(REQUEST), answer(0, 'answer'), end(0)]);
  const empty = await raw.page(buildPageRequest({ sessionId: SESSION, throughSeq: -1 }), signal());
  assert.deepEqual(empty, { records: [], hasMore: false });
  raw.calls.length = 0;
  const result = await createSessionControllerAdapter(raw).getEvents({ sessionId: SESSION, requestId: REQUEST });
  assert.deepEqual(raw.calls.map((call) => call[0]), ['projections', 'page']);
  assert.equal(raw.calls[1][1].throughSeq, 3);
  assert.equal(result.cursor, 3);
  assert.equal(result.done, true);
  assert.equal(result.assistantText, 'answer');
});

test('T276: admission and turn start beyond a page boundary are found using one fixed snapshot', async () => {
  let advanced = false;
  const raw = controller([start(0), user('older'), answer(0, 'old'), end(0), start(1), user(REQUEST),
    ...Array.from({ length: 130 }, (_, n) => answer(1, 'intermediate ' + n)), answer(1, 'FINAL'), end(1),
    start(2), user('later'), answer(2, 'unrelated'), end(2)], { onPage(log) {
    if (advanced) return;
    advanced = true;
    log.push({ ...end(3), event: { ...end(3).event, seq: log.length } });
  } });
  const cut = raw.log.length - 1;
  const adapter = createSessionControllerAdapter(raw);
  const page = await adapter.getEvents({ sessionId: SESSION, requestId: REQUEST, maxMessages: 2 });
  // The bounded scan deliberately runs out at 32 tiny pages: no unrelated answer may be credited.
  assert.equal(page.done, false);
  assert.equal(page.admission.found, false);
  assert.equal(page.hasMore, true);
  raw.calls.length = 0;
  const found = await adapter.getEvents({ sessionId: SESSION, requestId: REQUEST, throughSeq: cut, maxMessages: 60 });
  assert.equal(found.done, true);
  assert.equal(found.turnId, '1');
  assert.equal(found.assistantText, 'FINAL');
  assert.ok(raw.calls.length > 1);
  assert.ok(raw.calls.every((call) => call[1].throughSeq === cut));
  assert.ok(raw.calls.slice(1).every((call) => Number.isSafeInteger(call[1].beforeSeq)));
  const admission = await adapter.findAdmission({ sessionId: SESSION, requestId: REQUEST, maxMessages: 60 });
  assert.equal(admission.found, true);
  assert.equal(admission.seq, 5);
});

test('T276: older/later turns and tool steps never complete the requested open turn', () => {
  const old = [start(0), user('older'), answer(0, 'OLD'), end(0)];
  const pending = [start(1), user(REQUEST), answer(1, 'working', { message: { content: [
    { type: 'text', text: 'working' }, { type: 'tool-call', arguments: { text: 'not an answer', rpcId: REQUEST } },
  ] } })];
  assert.equal(correlateResult(sequence([...old, ...pending]), REQUEST).done, false);
  const closed = sequence([...old, ...pending, answer(1, 'FINAL'), end(1),
    start(2), user('later'), answer(2, 'LATER'), end(2)]);
  const result = correlateResult(closed, REQUEST);
  assert.equal(result.assistantText, 'FINAL');
  assert.equal(result.terminal.kind, 'completed');
  assert.equal(result.turnId, '1');
  assert.equal(correlateResult(closed, 'missing').done, false);
  assert.equal(correlateResult(closed, undefined).done, false);
  assert.equal(correlateResult(sequence([...pending, end(1)]), REQUEST).done, false,
    'tool-call text is not a final answer even on a concluded turn');
});

test('T276: interrupted or noncompleted turns expose terminal evidence without success', () => {
  for (const kind of ['error', 'aborted', 'blocked', 'max-tokens', 'interrupted']) {
    const result = correlateResult(sequence([start(1), user(REQUEST), answer(1, 'partial'), end(1, kind)]), REQUEST);
    assert.equal(result.done, false, kind);
    assert.equal(result.assistantText, null, kind);
    assert.equal(result.terminal.kind, kind);
  }
  const result = correlateResult(sequence([start(1), user(REQUEST), answer(1, 'partial', { interrupted: true }),
    end(1)]), REQUEST);
  assert.equal(result.done, false);
  assert.equal(result.terminal.kind, 'completed');
});

test('T276: arbitrary rpcId keys, forged nested old shape, and missing turn start fail closed', () => {
  const spoof = sequence([start(1), record('tool/result', { rpcId: REQUEST }),
    record('user/message', { message: { source: { kind: 'user', rpcId: REQUEST } } }), answer(1, 'wrong'), end(1)]);
  assert.equal(findAdmission(spoof, REQUEST).found, false);
  assert.equal(correlateResult(spoof, REQUEST).done, false);
  const partial = correlateResult(sequence([user(REQUEST), answer(1, 'not enough'), end(1)]), REQUEST);
  assert.equal(partial.admission.found, true);
  assert.equal(partial.turnId, null);
  assert.equal(partial.done, false);
});

test('T276: a missing projections capability and malformed history are explicit failures', async () => {
  assert.throws(() => createSessionControllerAdapter({ list() {}, prompt() {}, page() {} }),
    (error) => error.code === 'host_capability_missing' && error.details.missing.includes('projections'));
  const raw = controller([start(0), user(REQUEST), answer(0, 'answer'), end(0)]);
  raw.page = async () => ({ records: [raw.log[3]], hasMore: true });
  // A repeated page cannot advance the next backward cursor.
  await assert.rejects(createSessionControllerAdapter(raw).getEvents({ sessionId: SESSION, requestId: REQUEST }),
    (error) => error.code === 'host_error');
});

test('T276: fake is cursor-faithful, keeps prior turns, deduplicates and requires AbortSignal', async () => {
  const raw = createFakeHost({ sessions: [{ sessionId: SESSION, cwd: '/test' }], pagesPerTurn: 1 });
  const adapter = createSessionControllerAdapter(raw, { kind: 'offline_fake' });
  await assert.rejects(raw.page({ address: { sessionId: SESSION }, throughSeq: -1 }), /AbortSignal/);
  await assert.rejects(raw.prompt({ requestId: REQUEST }), /AbortSignal/);
  await adapter.prompt({ sessionId: SESSION, requestId: REQUEST, text: 'first' });
  const first = await adapter.getEvents({ sessionId: SESSION, requestId: REQUEST });
  assert.equal(first.done, true);
  await adapter.prompt({ sessionId: SESSION, requestId: 't276-request-0002', text: 'second' });
  await adapter.getEvents({ sessionId: SESSION, requestId: 't276-request-0002' });
  await adapter.prompt({ sessionId: SESSION, requestId: REQUEST, text: 'first' });
  assert.equal(raw.control.admissions().length, 2);
  const original = await adapter.getEvents({ sessionId: SESSION, requestId: REQUEST });
  assert.equal(original.assistantText, first.assistantText);
  assert.equal(original.turnId, '0');
  assert.deepEqual(await raw.page(buildPageRequest({ sessionId: SESSION, throughSeq: -1 }), signal()),
    { records: [], hasMore: false });
  await assert.rejects(raw.page(buildPageRequest({ sessionId: SESSION, throughSeq: 1000 }), signal()), /past cursor/);
});

test('T276: /events uses one correlated cut, not a second admission query', async () => {
  const raw = controller([start(0), user(REQUEST), answer(0, 'answer'), end(0)]);
  const adapter = createSessionControllerAdapter(raw);
  adapter.findAdmission = () => assert.fail('second snapshot forbidden');
  const bridge = await startHostBridge({ adapter, token: TOKEN });
  try {
    const response = await fetch(bridge.base + '/events?sessionId=' + SESSION + '&requestId=' + REQUEST,
      { headers: { authorization: 'Bearer ' + TOKEN } });
    const page = await response.json();
    assert.equal(page.done, true);
    assert.equal(page.admission.seq, 1);
    assert.equal(page.cursor, 3);
    assert.equal(page.terminal.kind, 'completed');
    assert.equal(page.turnId, '0');
    assert.equal(raw.calls.filter((call) => call[0] === 'projections').length, 1);
    const closing = bridge.close();
    assert.equal(bridge.close(), closing, 'all close callers await the same completion');
    await closing;
  } finally {
    await bridge.close();
  }
});
