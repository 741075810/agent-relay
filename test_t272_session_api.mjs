// T272: the rc.2 protocol layer, tested against literal shapes taken from the installed package.
//
// No process, no socket: these cases pin the mapping decisions that T271 got wrong, so a future edit to
// `session_api.mjs` cannot quietly go back to `listSessions` / `getEvents` / `{sessionId, text}`.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPageRequest, buildPromptRequest, extractAssistantText, findAdmission,
  mapRemoteError, newestSeq, normalizeList, normalizePage, readPromptValue, REMOTE_METHODS,
} from './tools/dsh-direct/session_api.mjs';
import { createSessionControllerAdapter, describeCapabilities } from './tools/dsh-direct/adapters.mjs';

const SESSION = 'session-11111111-2222-4333-8444-555566667777';

const ROW = {
  sessionId: SESSION,
  agentAvailable: true,
  updatedAt: 1794000000000,
  running: false,
  blank: false,
  cwd: '/workspace/project',
};

test('T272: the required Remote methods are the rc.2 ones, not T271 guesses', () => {
  assert.deepEqual(REMOTE_METHODS, ['list', 'prompt', 'page', 'projections']);
  const caps = describeCapabilities({ list() {}, prompt() {}, page() {}, projections() {} });
  assert.deepEqual(caps.missing, []);
  assert.deepEqual(caps.legacyGuessPresent, []);
  const legacy = describeCapabilities({ listSessions() {}, getEvents() {}, prompt() {} });
  assert.deepEqual(legacy.missing, ['list', 'page', 'projections']);
  assert.deepEqual(legacy.legacyGuessPresent, ['listSessions', 'getEvents'],
    'a build that only has the T271 names must be reported as such');
});

test('T272: list() accepts both shipped result shapes and keeps the one it saw', () => {
  const items = normalizeList({ items: [ROW] });
  assert.equal(items.shape, 'items');
  assert.equal(items.rows.length, 1);
  assert.equal(items.rows[0].cwd, '/workspace/project', 'cwd is the identity rc.2 carries, not a project id');

  const array = normalizeList([ROW]);
  assert.equal(array.shape, 'array', 'the service class returned a bare array in the shipped bytes');

  assert.throws(() => normalizeList({ data: [] }), /neither \{ items \} nor an array/);
  assert.throws(() => normalizeList([{ updatedAt: 1 }]), /no sessionId/);
  assert.equal(normalizeList([{ sessionId: SESSION }]).rows[0].running, null,
    'a missing running field is unknown, not proof of an idle session');
});

test('T272: prompt() builds the rc.2 request exactly', () => {
  const request = buildPromptRequest({ requestId: 'req-0001-abcd', sessionId: SESSION, text: 'hello' });
  assert.deepEqual(request, {
    requestId: 'req-0001-abcd',
    sessionId: SESSION,
    mode: 'queue',
    content: [{ type: 'text', text: 'hello' }],
  });
  assert.equal('clientTimeZone' in request, false, 'omitted when the caller has none');
  assert.equal(buildPromptRequest({ requestId: 'req-0001-abcd', sessionId: SESSION, text: 'x',
    clientTimeZone: 'Europe/Berlin' }).clientTimeZone, 'Europe/Berlin');
  assert.throws(() => buildPromptRequest({ requestId: 'r', sessionId: SESSION, text: '   ' }),
    /non-blank text/, 'blank content is rejected before it reaches the Host');
});

test('T272: only { accepted: true } counts as an acceptance', () => {
  assert.deepEqual(readPromptValue({ accepted: true }), { accepted: true });
  assert.deepEqual(readPromptValue({ accepted: false }), { accepted: false, reason: 'host_did_not_accept' });
  assert.deepEqual(readPromptValue(undefined), { accepted: false, reason: 'host_did_not_accept' });
  assert.deepEqual(readPromptValue({ accepted: 'true' }), { accepted: false, reason: 'host_did_not_accept' });
});

test('T272: page() requires an exact cursor and -1 explicitly names the empty prefix', () => {
  const request = buildPageRequest({ sessionId: SESSION, throughSeq: -1 });
  assert.deepEqual(request, { address: { kind: 'session', sessionId: SESSION }, throughSeq: -1, maxMessages: 60 });
  assert.equal(buildPageRequest({ sessionId: SESSION, throughSeq: 20, beforeSeq: 10 }).beforeSeq, 10);
  assert.throws(() => buildPageRequest({ sessionId: SESSION }), /explicit throughSeq/);
  assert.throws(() => normalizePage({ hasMore: false }), /no records array/);
});

test('T272: admission requires rc.2 user/message.data.source identity, not arbitrary nested rpcId', () => {
  const records = [
    { type: 'event', event: { type: 'user/message', seq: 0, data: {
      content: [{ type: 'text', text: 'mentions req-0001-abcd' }], source: { kind: 'user', rpcId: 'other' } } } },
    { type: 'event', event: { type: 'tool/result', seq: 1, data: { rpcId: 'req-0001-abcd' } } },
    { type: 'event', event: { type: 'user/message', seq: 2,
      data: { message: { source: { kind: 'user', rpcId: 'req-0001-abcd' } } } } },
  ];
  assert.deepEqual(findAdmission(records, 'req-0001-abcd'), { found: false, seq: null, eventType: null });
  records.push({ type: 'event', event: { type: 'user/message', seq: 3,
    data: { content: [], source: { kind: 'user', rpcId: 'req-0001-abcd' } } } });
  assert.deepEqual(findAdmission(records, 'req-0001-abcd'), { found: true, seq: 3, eventType: 'user/message' });
});

test('T272: assistant text needs admission and completed end, and excludes reasoning and tool arguments', () => {
  const records = [
    { type: 'event', event: { type: 'turn/start', seq: 0, data: { turn: 0 } } },
    { type: 'event', event: { type: 'user/message', seq: 1,
      data: { content: [], source: { kind: 'user', rpcId: 'req-0001-abcd' } } } },
    { type: 'event', event: { type: 'assistant/message', seq: 2,
      data: { turn: 0, step: 1, message: { content: [{ type: 'text', text: 'first' },
        { type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'second' }] } } } },
    { type: 'event', event: { type: 'turn/end', seq: 3, data: { turn: 0, reason: { kind: 'completed' } } } },
  ];
  assert.equal(extractAssistantText(records, 'req-0001-abcd'), 'first\nsecond');
  assert.equal(extractAssistantText(records), null);
  assert.equal(extractAssistantText(records.slice(0, -1), 'req-0001-abcd'), null);
  assert.equal(newestSeq(records), 3);
});

test('T272: Host error codes map onto our own, and an unknown code is a host_error', () => {
  assert.equal(mapRemoteError({ code: 'session/not-found', message: 'x' }).code, 'session_not_found');
  assert.equal(mapRemoteError({ code: 'session/writer-held', message: 'x' }).code, 'session_writer_held');
  assert.equal(mapRemoteError({ code: 'session/agent-busy', message: 'x' }).code, 'session_busy');
  assert.equal(mapRemoteError({ code: 'gateway/bad-request', message: 'x' }).code, 'invalid_arguments');
  assert.equal(mapRemoteError({ code: 'gateway/cancelled', message: 'x' }).code, 'cancelled');
  assert.equal(mapRemoteError({ code: 'session/model-unavailable', message: 'x' }).code, 'host_refused');
  assert.equal(mapRemoteError({ code: 'gateway/uplink-overflow', message: 'x' }).code, 'host_error');
  assert.equal(mapRemoteError({ code: undefined, message: 'socket closed' }).code, 'host_error');
});

test('T272: the adapter refuses a Host that only offers the T271 guesses', () => {
  assert.throws(() => createSessionControllerAdapter({ listSessions() {}, getEvents() {} }), (err) => {
    assert.equal(err.code, 'host_capability_missing');
    assert.deepEqual(err.details.missing, ['list', 'prompt', 'page', 'projections']);
    assert.deepEqual(err.details.legacyGuessPresent, ['listSessions', 'getEvents']);
    return true;
  });
});

test('T272: the adapter maps a real rc.2 controller onto the neutral shape', async () => {
  const calls = [];
  const controller = {
    async list(request, signal) {
      calls.push(['list', request, signal === undefined]);
      return { items: [ROW] };
    },
    async prompt(request, signal) {
      calls.push(['prompt', request, signal === undefined]);
      return { accepted: true };
    },
    async projections(request, signal) {
      signal.throwIfAborted();
      calls.push(['projections', request]);
      return { asOfSeq: 3, values: {} };
    },
    async page(request, signal) {
      signal.throwIfAborted();
      calls.push(['page', request, signal === undefined]);
      return { records: [
        { type: 'event', event: { type: 'turn/start', seq: 0, data: { turn: 0 } } },
        { type: 'event', event: { type: 'user/message', seq: 1,
          data: { content: [], source: { kind: 'user', rpcId: 'req-0002-abcd' } } } },
        { type: 'event', event: { type: 'assistant/message', seq: 2,
          data: { turn: 0, step: 1, message: { content: [{ type: 'text', text: 'answer' }] } } } },
        { type: 'event', event: { type: 'turn/end', seq: 3, data: { turn: 0, reason: { kind: 'completed' } } } },
      ], hasMore: false };
    },
  };
  const adapter = createSessionControllerAdapter(controller);
  assert.equal(adapter.protocol, 'dsh-api-session-controller@0.2.0-rc.2');
  const rows = await adapter.listSessions();
  assert.equal(rows[0].listShape, 'items');
  assert.equal(rows[0].sessionId, SESSION);

  const receipt = await adapter.prompt({ requestId: 'req-0002-abcd', sessionId: SESSION, text: 'go' });
  assert.equal(receipt.accepted, true);
  assert.equal(calls[1][1].content[0].text, 'go');

  const page = await adapter.getEvents({ sessionId: SESSION, requestId: 'req-0002-abcd' });
  assert.equal(page.assistantText, 'answer');
  assert.equal(page.events[2].kind, 'assistant/message');
  assert.equal(calls[2][0], 'projections');
  assert.equal(calls[3][1].throughSeq, 3);
  assert.equal(page.done, true);
  assert.equal(page.turnId, '0');

  // The neutral signature must never claim the guessed names.
  assert.equal('listSessions' in adapter, true, 'the *adapter* keeps its own stable method names');
  assert.equal(typeof controller.listSessions, 'undefined');
});
