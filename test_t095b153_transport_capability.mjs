// T095B153: the capability contract for a *real* continuation transport. Red first.
//
// What was established before this file (read-only, no guessing):
//
//   * DSH's side of the Bridge is the `@codex-bridge/dsh-desktop-connector` package
//     (v1.0.0, protocol `codex-bridge-dsh/1`). It is a **server**: `transport.mjs` calls
//     `net.createServer`, and its dispatch table is inbound only --
//     `pairing/state|request|revoke`, `project/sync`, `run/start|observe|steer|cancel`,
//     `session/list|open|read|rename|event`. DSH answers the Bridge; it never calls it.
//   * DSH also exposes `/api/codex-bridge-desktop` (POST) to forward a Bridge `client-request`
//     into `clientRpc`. That is again the Bridge asking DSH, not DSH asking the Bridge.
//   * The `mcp__Codex_Bridge__list_tasks/get_task/submit_task` tools belong to the ChatGPT client.
//     Having them there says nothing about the DSH host process, which has no such client.
//
// So there is no outbound, documented, supported "list my tasks / submit a task" channel available
// to this process. These tests encode that as a *contract* rather than a comment: an adapter must
// declare what it is and where it is documented, and the validator refuses everything else. The
// read-only adapter is exercised against an explicitly fake client -- never against a real one.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.T153_DIR || path.join(HERE, 'tools', 'continuation');
const TC = await import(pathToFileURL(path.join(DIR, 'transport_capability.mjs')).href
  + '?r=t153' + Math.random().toString(36).slice(2));

const CONNECTOR_FACTS = {
  api: 'codex-bridge-dsh/1',
  version: '1.0.0',
  package: '@codex-bridge/dsh-desktop-connector',
  direction: 'inbound',
  docsRef: 'connector:src/transport.mjs (net.createServer) + dispatch table',
  ops: { listTasks: false, getTask: false, submitTask: false, observeRuns: true },
};

const CHATGPT_MCP = {
  api: 'mcp:Codex_Bridge',
  version: '1',
  direction: 'outbound',
  docsRef: 'chatgpt-tool-catalog: mcp__Codex_Bridge__list_tasks|get_task|submit_task',
  ops: { listTasks: true, getTask: true, submitTask: true },
};

const GRANT = { kind: 'continuation', sessionId: 'dsh-native-session-0001', epoch: 'epoch-A',
  armedAt: 1793440000000, expiresAt: 1793490000000, maxTasks: 4, scopes: ['repo:agent-relay'] };

test('T153: an adapter that declares nothing is refused', () => {
  assert.equal(TC.validateCapability(null).code, 'declaration_missing');
  assert.equal(TC.validateCapability({}).code, 'declaration_missing');
  assert.equal(TC.validateCapability({ api: 'x', version: '1', direction: 'outbound',
    ops: { listTasks: true } }).code, 'docs_ref_missing');
});

test('T153: the real DSH connector is inbound-only and is refused as a transport', () => {
  const out = TC.validateCapability(CONNECTOR_FACTS);
  assert.equal(out.code, 'direction_not_outbound');
  assert.match(out.reason, /inbound/);
  // It also does not offer task listing or submission at all -- twice not-a-transport.
  assert.equal(CONNECTOR_FACTS.ops.listTasks, false);
  assert.equal(CONNECTOR_FACTS.ops.submitTask, false);
});

test('T153: the ChatGPT-side MCP declaration is outbound but unavailable to this process', async () => {
  assert.equal(TC.validateCapability(CHATGPT_MCP).code, null, 'a well-formed declaration is accepted');
  const probe = await TC.probe({ capability: CHATGPT_MCP, client: null });
  assert.equal(probe.state, 'unavailable');
  assert.equal(probe.code, 'client_absent',
    'nothing fabricates a client: without one injected, the transport is unavailable');
});

test('T153: an outbound declaration must still list the read-only ops it implements', () => {
  assert.equal(TC.validateCapability({ ...CHATGPT_MCP, ops: { getTask: true } }).code,
    'op_unsupported');
  assert.equal(TC.validateCapability({ ...CHATGPT_MCP, ops: { listTasks: true } }).code,
    'op_unsupported', 'get_task alone cannot page a backlog');
});

test('T153: submission is refused without a continuation grant, and refused even with one', async () => {
  const noGrant = await TC.probe({ capability: CHATGPT_MCP, client: fakeClient(), grant: null });
  assert.equal(noGrant.canSubmit, false);
  assert.equal(noGrant.code, 'submit_not_authorised');

  // With a grant the *authorisation* is fine, but there is no supported submit implementation, so
  // it is still refused -- and it must say which of the two reasons applied.
  const withGrant = await TC.probe({ capability: CHATGPT_MCP, client: fakeClient(), grant: GRANT });
  assert.equal(withGrant.canSubmit, false);
  assert.equal(withGrant.code, 'submit_not_implemented');
});

test('T153: the read-only adapter pages by cursor and redacts prompt text', async () => {
  const client = fakeClient();
  const adapter = TC.createReadOnlyAdapter({ capability: CHATGPT_MCP, client });
  const page1 = await adapter.listTasks({ cursor: null, limit: 2 });
  assert.deepEqual(page1.tasks.map((t) => t.id), ['tsk-1', 'tsk-2']);
  const page2 = await adapter.listTasks({ cursor: page1.nextCursor, limit: 2 });
  assert.deepEqual(page2.tasks.map((t) => t.id), ['tsk-3']);
  assert.equal(page2.nextCursor, null, 'a short page ends the listing');
  assert.equal(client.calls.every((c) => c.tool === 'list_tasks'), true);

  const one = await adapter.getTask('tsk-1');
  assert.equal(one.id, 'tsk-1');
  assert.equal(one.status, 'completed');
  assert.equal(/SECRET/.test(JSON.stringify(one)), false, 'prompt bodies are redacted');
  assert.equal(one.promptRedacted, true);
});

test('T153: the adapter refuses tools outside the read-only whitelist', async () => {
  const client = fakeClient();
  const adapter = TC.createReadOnlyAdapter({ capability: CHATGPT_MCP, client });
  for (const tool of ['submit_task', 'cancel_task', 'run_start', 'shell']) {
    const before = client.calls.length;
    assert.equal(await adapter.callRaw(tool, {}), 'tool_not_allowed', tool);
    assert.equal(client.calls.length, before, 'nothing was sent upstream for ' + tool);
  }
  await assert.rejects(() => adapter.submitTask({ title: 'x' }), /submit_not_implemented/);
});

test('T153: a malformed upstream reply is an error, not a silent empty list', async () => {
  const adapter = TC.createReadOnlyAdapter({ capability: CHATGPT_MCP,
    client: { calls: [], async callTool() { return { tasks: 'nope' }; } } });
  await assert.rejects(() => adapter.listTasks({ cursor: null, limit: 2 }),
    /invalid_upstream_shape/);
  const legacy = TC.createReadOnlyAdapter({ capability: CHATGPT_MCP,
    client: { calls: [], async callTool() { return { items: [{ id: 'tsk-9', status: 'running' }],
      next_cursor: 'abc' }; } } });
  const page = await legacy.listTasks({ cursor: null, limit: 2 });
  assert.deepEqual(page.tasks.map((t) => t.id), ['tsk-9']);
  assert.equal(page.nextCursor, 'abc', 'both documented field spellings are accepted');
});

test('T153: this environment reports unavailable, with the reason recorded', async () => {
  const probe = await TC.probeEnvironment();
  assert.equal(probe.state, 'unavailable');
  assert.equal(probe.code, 'no_supported_outbound_channel');
  assert.equal(probe.evidence.connectorDirection, 'inbound');
  assert.equal(probe.evidence.mcpClientInHost, false);
});

function fakeClient() {
  const data = {
    'tsk-1': { id: 'tsk-1', status: 'completed', title: 'approved task 1', prompt: 'SECRET body' },
    'tsk-2': { id: 'tsk-2', status: 'completed', title: 'approved task 2', prompt: 'other' },
    'tsk-3': { id: 'tsk-3', status: 'failed', title: 'approved task 3', prompt: 'third' },
  };
  return {
    calls: [],
    async callTool(tool, args) {
      this.calls.push({ tool, args });
      if (tool === 'list_tasks') {
        const ids = Object.keys(data);
        const start = args.cursor ? ids.indexOf(args.cursor) : 0;
        const slice = ids.slice(start, start + args.limit);
        const next = start + slice.length < ids.length ? ids[start + slice.length] : null;
        return { tasks: slice.map((id) => data[id]), next_cursor: next };
      }
      if (tool === 'get_task') return data[args.id];
      throw new Error('unexpected tool ' + tool);
    },
  };
}
