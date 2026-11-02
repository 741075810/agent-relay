// T202: the real transport path -- Native Host artifacts -> sidecar -> service -> read-only MCP.
//
// The host directory here is a fabricated copy of the real artifact shape (terminal-source / terminal-origin /
// terminal-arm), with fake run ids. Nothing reads the operator's production state, nothing is installed, and the
// service never claims a DSH run: it records what the host reported, with the artifact it came from.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const SERVICE = path.join(process.cwd(), 'tools', 'service', 'relay_service.mjs');
const INGEST = path.join(process.cwd(), 'tools', 'service', 'host_ingest.mjs');
const MCP = path.join(process.cwd(), 'tools', 'mcp', 'agentrelay_mcp.mjs');
const tempDir = (prefix) => mkdtempSync(path.join(tmpdir(), prefix));

const RUNS = {
  pending: 'aaaa1111-2222-4333-8444-555566667777',
  acked: 'bbbb1111-2222-4333-8444-555566667777',
  baseline: 'cccc1111-2222-4333-8444-555566667777',
};

function fakeHostState() {
  const dir = tempDir('agentrelay-host-');
  writeFileSync(path.join(dir, 'terminal-source.json'), JSON.stringify({
    version: 1, baselineCount: 1, baselineDropped: 0,
    pendingIds: [RUNS.pending], ackedIds: [RUNS.acked], baselineIds: [RUNS.baseline],
  }, null, 2) + '\n');
  writeFileSync(path.join(dir, 'terminal-origin.json'), JSON.stringify({
    version: 1, source: 'bridge-sqlite', readAt: 1793600000, ids: [RUNS.acked, RUNS.pending],
  }, null, 2) + '\n');
  writeFileSync(path.join(dir, 'terminal-arm.json'), JSON.stringify({
    version: 1, epoch: 'epoch-test', takenAt: 1793599999, truncated: false, ids: [],
  }, null, 2) + '\n');
  return dir;
}

async function startService(stateDir) {
  const child = spawn(process.execPath, [SERVICE, '--state-dir', stateDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no start: ' + stderr)), 10000);
    createInterface({ input: child.stdout }).once('line', (line) => { clearTimeout(timer); resolve(JSON.parse(line)); });
  });
  const auth = { 'content-type': 'application/json',
    authorization: 'Bearer ' + readFileSync(ready.tokenFile, 'utf8').trim() };
  return {
    base: ready.base, tokenFile: ready.tokenFile,
    get: (p) => fetch(ready.base + p, { headers: auth }).then(async (r) => ({ status: r.status, body: await r.json() })),
    post: (p, body) => fetch(ready.base + p, { method: 'POST', headers: auth, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() })),
    async stop() {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      });
    },
  };
}

function runIngest(hostDir, service) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INGEST, '--host-state', hostDir, '--service-url', service.base,
      '--service-token-file', service.tokenFile, '--once'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.once('exit', (code) => resolve({ code, out, json: out.trim() ? JSON.parse(out.trim()) : null }));
  });
}

async function mcp(stateDir, service) {
  const child = spawn(process.execPath, [MCP, '--state-dir', stateDir, '--service-url', service.base,
    '--service-token-file', service.tokenFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  });
  const ask = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout ' + method)), 10000);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  await ask('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  return {
    ask,
    call: (name, args) => ask('tools/call', { name, arguments: args || {} }),
    async stop() {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.stdin.end();
        setTimeout(() => { child.kill(); resolve(); }, 2000);
      });
    },
  };
}
const body = (response) => JSON.parse(response.result.content[0].text);

test('T202: host artifacts travel sidecar -> service and keep their ids, states and source', async () => {
  const hostDir = fakeHostState();
  const serviceDir = tempDir('agentrelay-svc-');
  const service = await startService(serviceDir);
  try {
    const pushed = await runIngest(hostDir, service);
    assert.equal(pushed.code, 0, pushed.out);
    assert.equal(pushed.json.accepted, 3);
    assert.deepEqual(pushed.json.rejected, []);
    assert.equal(pushed.json.origin, 'bridge-sqlite', 'the origin recorded by the host is forwarded verbatim');

    const runs = await service.get('/runs');
    const byId = new Map(runs.body.runs.map((run) => [run.runId, run]));
    assert.equal(byId.get(RUNS.pending).state, 'pending');
    assert.equal(byId.get(RUNS.acked).state, 'acked');
    assert.equal(byId.get(RUNS.baseline).state, 'baseline');
    for (const run of runs.body.runs) {
      assert.equal(run.origin, 'native_host');
      assert.equal(run.simulated, false, 'a host report is not a simulated task');
      assert.equal(run.hostSource, 'native_host.terminal-source');
    }
    // No task was created: the service did not invent work from a notification.
    const tasks = await service.get('/tasks');
    assert.equal(tasks.body.tasks.length, 0);
  } finally {
    await service.stop();
    rmSync(hostDir, { recursive: true, force: true });
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T202: a second ingest is idempotent, and a state change is carried through', async () => {
  const hostDir = fakeHostState();
  const serviceDir = tempDir('agentrelay-svc-');
  const service = await startService(serviceDir);
  try {
    await runIngest(hostDir, service);
    const again = await runIngest(hostDir, service);
    assert.equal(again.code, 0);
    assert.equal(again.json.accepted, 3);
    const runs = await service.get('/runs');
    assert.equal(runs.body.runs.length, 3, 'no duplicate records');

    // The host moves a run from pending to acked; the service follows and keeps one record.
    writeFileSync(path.join(hostDir, 'terminal-source.json'), JSON.stringify({
      version: 1, baselineCount: 1, baselineDropped: 0,
      pendingIds: [], ackedIds: [RUNS.acked, RUNS.pending], baselineIds: [RUNS.baseline],
    }, null, 2) + '\n');
    await runIngest(hostDir, service);
    const after = await service.get('/runs');
    assert.equal(after.body.runs.length, 3);
    assert.equal(after.body.runs.find((r) => r.runId === RUNS.pending).state, 'acked');
  } finally {
    await service.stop();
    rmSync(hostDir, { recursive: true, force: true });
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T202: the service refuses malformed host candidates and says which item failed', async () => {
  const serviceDir = tempDir('agentrelay-svc-');
  const service = await startService(serviceDir);
  try {
    const result = await service.post('/host/candidates', { candidates: [
      { runId: 'short', state: 'acked', hostSource: 'native_host.terminal-source' },
      { runId: RUNS.acked, state: 'delivered', hostSource: 'native_host.terminal-source' },
      { runId: RUNS.acked, state: 'acked', hostSource: 'somewhere_else' },
      { runId: RUNS.acked, state: 'acked', hostSource: 'native_host.terminal-source' },
    ] });
    assert.equal(result.status, 200);
    assert.equal(result.body.rejected.length, 3);
    assert.deepEqual(result.body.rejected.map((r) => r.error),
      ['run_id_invalid', 'state_unknown', 'host_source_unknown']);
    assert.equal(result.body.accepted.length, 1);
    assert.equal(result.body.accepted[0].runId, RUNS.acked);
    assert.match(result.body.note, /not proof of a DSH run/);
  } finally {
    await service.stop();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T202: host candidates need the token like everything else', async () => {
  const serviceDir = tempDir('agentrelay-svc-');
  const service = await startService(serviceDir);
  try {
    const anonymous = await fetch(service.base + '/host/candidates', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidates: [{ runId: RUNS.acked, state: 'acked',
        hostSource: 'native_host.terminal-source' }] }) });
    assert.equal(anonymous.status, 401);
    const read = await fetch(service.base + '/runs');
    assert.equal(read.status, 401);
  } finally {
    await service.stop();
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T202: an absent or unreadable host directory is reported, not guessed', async () => {
  const serviceDir = tempDir('agentrelay-svc-');
  const service = await startService(serviceDir);
  const emptyHost = tempDir('agentrelay-empty-');
  try {
    const missing = await runIngest(emptyHost, service);
    assert.equal(missing.code, 4);
    assert.equal(missing.json.code, 'host_state_absent');

    writeFileSync(path.join(emptyHost, 'terminal-source.json'), '{ this is not json', 'utf8');
    const broken = await runIngest(emptyHost, service);
    assert.equal(broken.code, 4);
    assert.equal(broken.json.code, 'host_state_unreadable');

    const runs = await service.get('/runs');
    assert.equal(runs.body.runs.length, 0, 'nothing was invented from a broken source');
  } finally {
    await service.stop();
    rmSync(emptyHost, { recursive: true, force: true });
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T202: the read-only MCP tool shows the host runs with their provenance', async () => {
  const hostDir = fakeHostState();
  const serviceDir = tempDir('agentrelay-svc-');
  const service = await startService(serviceDir);
  const client = await mcp(tempDir('agentrelay-mcp-'), service);
  try {
    const tools = (await client.ask('tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(tools.includes('relay_host_runs'));

    await runIngest(hostDir, service);
    const data = body(await client.call('relay_host_runs', {}));
    assert.equal(data.runs.length, 3);
    assert.equal(data.runs.every((run) => run.origin === 'native_host'), true);
    assert.match(data.note, /did not observe the page/);
    assert.equal(JSON.stringify(data).includes('"simulated":true'), false);
  } finally {
    await client.stop();
    await service.stop();
    rmSync(hostDir, { recursive: true, force: true });
    rmSync(serviceDir, { recursive: true, force: true });
  }
});

test('T202: host runs survive a service restart', async () => {
  const hostDir = fakeHostState();
  const serviceDir = tempDir('agentrelay-svc-');
  const first = await startService(serviceDir);
  try {
    await runIngest(hostDir, first);
  } finally {
    await first.stop();
  }
  const second = await startService(serviceDir);
  try {
    const runs = await second.get('/runs');
    assert.equal(runs.body.runs.length, 3);
    assert.deepEqual(runs.body.runs.map((r) => r.runId).sort(),
      [RUNS.acked, RUNS.baseline, RUNS.pending].sort());
    const again = await runIngest(hostDir, second);
    assert.equal(again.code, 0);
    assert.equal(again.json.accepted, 3, 'all three are re-offered and recognised');
    assert.deepEqual(again.json.rejected, []);
    const after = await second.get('/runs');
    assert.equal(after.body.runs.length, 3, 'a re-offer never creates a second record');
    assert.equal(after.body.runs.every((run) => run.simulated === false), true);
  } finally {
    await second.stop();
    rmSync(hostDir, { recursive: true, force: true });
    rmSync(serviceDir, { recursive: true, force: true });
  }
});
