// T287: bounded synthetic allocation regressions. No production files, Host or MCP tasks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createSessionControllerAdapter } from './tools/dsh-direct/adapters.mjs';
import { startHostBridge } from './tools/dsh-direct/host_bridge.mjs';
import { HostClient } from './tools/dsh-direct/host_client.mjs';

const SESSION = 'session-11111111-2222-4333-8444-555566667777';
const REQUEST = 't287-synthetic-request-001';
const TOKEN = 'test-t287-allocations-' + 'a'.repeat(40);
const record = (seq, type, data) => ({ type: 'event', event: { seq, type, data } });
function controller(records) {
  return {
    async list() { return { items: [] }; },
    async prompt() { assert.fail('read regression must never prompt'); },
    async follow() { assert.fail('read regression must not follow or activate'); },
    async projections(_request, signal) { signal.throwIfAborted(); return { asOfSeq: records.length - 1, values: {} }; },
    async page(request, signal) {
      signal.throwIfAborted();
      assert.equal(request.throughSeq, records.length - 1);
      assert.equal(request.address.sessionId, SESSION);
      return { records, hasMore: false };
    },
  };
}
function history(extra = []) {
  return [record(0, 'turn/start', { turn: 4 }),
    record(1, 'user/message', { source: { kind: 'user', rpcId: REQUEST }, content: [] }),
    ...extra.map((data, i) => record(i + 2, 'tool/result', data)),
    record(extra.length + 2, 'assistant/message', { turn: 4, message: { content: [{ type: 'text', text: 'FINAL' }] } }),
    record(extra.length + 3, 'turn/end', { turn: 4, reason: { kind: 'completed' } })];
}
async function fixture(t, records, transform = value => value) {
  const adapter = createSessionControllerAdapter(controller(records));
  const bridge = await startHostBridge({ adapter: transform(adapter), token: TOKEN });
  t.after(() => bridge.close());
  return { adapter, bridge };
}
function endpoint(bridge, format) {
  return bridge.base + '/events?sessionId=' + SESSION + '&requestId=' + REQUEST
    + (format === undefined ? '' : '&eventFormat=' + format);
}
async function get(bridge, format) {
  const response = await fetch(endpoint(bridge, format), { headers: { authorization: 'Bearer ' + TOKEN } });
  const text = await response.text();
  return { status: response.status, bytes: Buffer.byteLength(text), body: JSON.parse(text) };
}

test('T287: one message-aligned page can exceed spread argument limits without losing correlation', async () => {
  // 140k small records, not a large payload or heap-exhaustion test. One page may contain many non-message events.
  const count = 140000;
  const sharedData = {};
  const rows = Array.from({ length: count }, (_, seq) => record(seq, 'tool/progress', sharedData));
  rows[0] = record(0, 'turn/start', { turn: 4 });
  rows[1] = record(1, 'user/message', { source: { kind: 'user', rpcId: REQUEST } });
  rows[count - 2] = record(count - 2, 'assistant/message', { turn: 4, message: { content: [{ type: 'text', text: 'FINAL' }] } });
  rows[count - 1] = record(count - 1, 'turn/end', { turn: 4, reason: { kind: 'completed' } });
  const page = await createSessionControllerAdapter(controller(rows)).getEvents({ sessionId: SESSION, requestId: REQUEST });
  assert.equal(page.events.length, count);
  assert.equal(page.records.length, count);
  assert.equal(page.admission.seq, 1);
  assert.equal(page.turnId, '4');
  assert.equal(page.terminal.seq, count - 1);
  assert.equal(page.assistantText, 'FINAL');
  assert.equal(page.done, true);
});

test('T287: summary wire removes unused payload bytes but preserves exact result evidence', async t => {
  const marker = 'synthetic-tool-body-' + 'x'.repeat(1024 * 1024);
  const { bridge } = await fixture(t, history([{ text: marker }]));
  const summary = await get(bridge, 'summary');
  const legacy = await get(bridge);
  t.diagnostic('synthetic wire bytes: legacy=' + legacy.bytes + ', summary=' + summary.bytes);
  assert.ok(legacy.bytes > 1024 * 1024);
  assert.equal(summary.status, 200);
  assert.ok(summary.bytes < 4096, 'a 1MiB unused tool body must not cross the summary wire');
  assert.ok(summary.body.events.every(event => Object.keys(event).sort().join(',') === 'kind,seq'));
  assert.equal(summary.body.assistantText, 'FINAL');
  assert.equal(summary.body.admission.seq, 1);
  assert.equal(summary.body.turnId, '4');
  assert.equal(summary.body.terminal.seq, 4);
  assert.equal(summary.body.done, true);
  assert.equal(summary.body.cursor, 4);
});

test('T287: legacy and unknown event formats preserve existing full payload contract', async t => {
  const { bridge } = await fixture(t, history([{ text: 'legacy-payload' }]));
  for (const format of [undefined, 'future-format']) {
    const page = await get(bridge, format);
    assert.equal(page.status, 200);
    assert.equal(page.body.events[2].data.text, 'legacy-payload');
    assert.equal(page.body.done, true);
  }
});

test('T287: summary path does not serialize an irrelevant payload at all', async t => {
  const { bridge } = await fixture(t, history(), adapter => ({
    ...adapter,
    async getEvents(request) {
      const page = await adapter.getEvents(request);
      page.events[0].data = { toJSON() { throw new Error('unused event payload serialized'); } };
      return page;
    },
  }));
  const page = await get(bridge, 'summary');
  assert.equal(page.status, 200);
  assert.equal(page.body.assistantText, 'FINAL');
  assert.equal(page.body.done, true);
});

test('T287: ordinary HostClient requests compact events while keeping legacy response compatibility', async t => {
  const { bridge } = await fixture(t, history([{ text: 'unused-client-data' }]));
  const dir = mkdtempSync(path.join(tmpdir(), 't287-client-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'fixture.token');
  writeFileSync(tokenFile, TOKEN);
  const client = new HostClient({ baseUrl: bridge.base, tokenFile });
  const page = await client.getEvents({ sessionId: SESSION, requestId: REQUEST });
  assert.equal(page.assistantText, 'FINAL');
  assert.ok(page.events.every(event => !Object.hasOwn(event, 'data')));
  assert.equal(page.events[2].kind, 'tool/result');
});

test('T287: summary format never credits another request', async t => {
  const records = history([{ text: 'noise' }]);
  records[1].event.data.source.rpcId = 'another-request';
  const { bridge } = await fixture(t, records);
  const page = await get(bridge, 'summary');
  assert.equal(page.body.done, false);
  assert.equal(page.body.admission.found, false);
  assert.equal(page.body.assistantText, null);
});

test('T287: summary preserves a matching interrupted terminal without successful answer', async t => {
  const records = history();
  records.at(-1).event.data.reason.kind = 'interrupted';
  const { bridge } = await fixture(t, records);
  const page = await get(bridge, 'summary');
  assert.equal(page.body.admission.found, true);
  assert.equal(page.body.turnId, '4');
  assert.equal(page.body.terminal.kind, 'interrupted');
  assert.equal(page.body.done, false);
  assert.equal(page.body.assistantText, null);
});

test('T287: new client accepts a legacy Host that ignores eventFormat', async t => {
  let calls = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/health') return res.end(JSON.stringify({ ok: true, loopbackOnly: true,
      kind: 'cordis_session_controller', protocol: 'dsh-api-session-controller@0.2.0-rc.2' }));
    assert.equal(url.pathname, '/events');
    assert.equal(url.searchParams.get('eventFormat'), 'summary');
    assert.equal(req.headers.authorization, 'Bearer ' + TOKEN);
    calls++;
    res.end(JSON.stringify({ ok: true, events: [{ seq: 2, kind: 'tool/result', data: { text: 'legacy' } }],
      cursor: 4, done: true, assistantText: 'FINAL', admission: { found: true, seq: 1 },
      turnId: '4', terminal: { kind: 'completed', seq: 4 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const dir = mkdtempSync(path.join(tmpdir(), 't287-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'fixture.token'); writeFileSync(tokenFile, TOKEN);
  const client = new HostClient({ baseUrl: 'http://127.0.0.1:' + server.address().port, tokenFile });
  const page = await client.getEvents({ sessionId: SESSION, requestId: REQUEST });
  assert.equal(calls, 1); assert.equal(page.events[0].data.text, 'legacy');
  assert.equal(page.assistantText, 'FINAL'); assert.equal(page.done, true);
});
