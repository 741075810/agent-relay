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
  assert.deepEqual(REMOTE_METHODS, ['list', 'prompt', 'page']);
  const caps = describeCapabilities({ list() {}, prompt() {}, page() {} });
  assert.deepEqual(caps.missing, []);
  assert.deepEqual(caps.legacyGuessPresent, []);
  const legacy = describeCapabilities({ listSessions() {}, getEvents() {}, prompt() {} });
  assert.deepEqual(legacy.missing, ['list', 'page']);
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

test('T272: page() asks for the newest page with the -1 sentinel', () => {
  const request = buildPageRequest({ sessionId: SESSION });
  assert.deepEqual(request, { address: { kind: 'session', sessionId: SESSION }, throughSeq: -1, maxMessages: 60 });
  assert.equal(buildPageRequest({ sessionId: SESSION, beforeSeq: 10 }).beforeSeq, 10);
  assert.throws(() => normalizePage({ hasMore: false }), /no records array/);
});

test('T272: admission is found by rpcId key, never by prompt text', () => {
  const records = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: 0, data: { turn: 0 } } },
    { type: 'event', event: { type: 'user/message', seq: 2, time: 0,
      data: { message: { content: [{ type: 'text', text: 'mentions req-0001-abcd in passing' }],
        source: { kind: 'user', rpcId: 'other-request-id' } } } } },
  ];
  assert.deepEqual(findAdmission(records, 'req-0001-abcd'), { found: false, seq: null, eventType: null },
    'text that merely contains the id is not an admission');

  records.push({ type: 'event', event: { type: 'user/message', seq: 4, time: 0,
    data: { message: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user',
      rpcId: 'req-0001-abcd' } } } } });
  assert.deepEqual(findAdmission(records, 'req-0001-abcd'), { found: true, seq: 4, eventType: 'user/message' });
});

test('T272: assistant text is read from assistant/message events only', () => {
  const records = [
    { type: 'event', event: { type: 'user/message', seq: 1, time: 0,
      data: { message: { content: [{ type: 'text', text: 'question' }] } } } },
    { type: 'event', event: { type: 'assistant/message', seq: 2, time: 0,
      data: { turn: 0, step: 1, message: { content: [{ type: 'text', text: 'first' },
        { type: 'text', text: 'second' }] } } } },
  ];
  assert.equal(extractAssistantText(records), 'first\nsecond');
  assert.equal(extractAssistantText([records[0]]), null);
  assert.equal(newestSeq(records), 2);
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
    assert.deepEqual(err.details.missing, ['list', 'prompt', 'page']);
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
    async page(request, signal) {
      calls.push(['page', request, signal === undefined]);
      return { records: [{ type: 'event', event: { type: 'assistant/message', seq: 7, time: 0,
        data: { message: { content: [{ type: 'text', text: 'answer' }] } } } }], hasMore: false };
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

  const page = await adapter.getEvents({ sessionId: SESSION });
  assert.equal(page.assistantText, 'answer');
  assert.equal(page.events[0].kind, 'assistant/message');
  assert.equal(calls[2][1].throughSeq, -1);

  // The neutral signature must never claim the guessed names.
  assert.equal('listSessions' in adapter, true, 'the *adapter* keeps its own stable method names');
  assert.equal(typeof controller.listSessions, 'undefined');
});
