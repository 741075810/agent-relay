// T273: the endpoint descriptor, the fixed-port collision, and identity before a prompt.
//
// These tests exist because of three reproduced defects:
//   * the plugin defaulted to `port: 0`, the doc told the operator to freeze that URL into config.json, and after a
//     Desktop restart the port moved (42609 -> 42610) so the first submit answered 504 and stuck as `unsettled`;
//   * a fixed port that was already taken raised an unhandled 'error' event and killed the process;
//   * nothing verified that the port still belonged to this bridge, so a stale descriptor could be answered by any
//     local process.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFakeHost } from './tools/dsh-direct/adapters.mjs';
import {
  ENDPOINT_FILE_VERSION, assertHealthIdentity, buildEndpoint, readEndpointFile, removeEndpointFile,
  resolveEndpoint, validateEndpoint, writeEndpointFile, EXPECTED_KIND, EXPECTED_PROTOCOL,
} from './tools/dsh-direct/endpoint.mjs';
import { openBridgeCount, startHostBridge } from './tools/dsh-direct/host_bridge.mjs';
import { HostClient } from './tools/dsh-direct/host_client.mjs';
import { CODES } from './tools/dsh-direct/protocol.mjs';

const TOKEN = 't'.repeat(48);
const SESSION = 'session-11111111-2222-4333-8444-555566667777';
const SESSIONS = [{ sessionId: SESSION, cwd: '/work/alpha', title: 'alpha', running: false, blank: false,
  agentAvailable: true, updatedAt: 1794000000000 }];

function scene() {
  const dir = mkdtempSync(path.join(tmpdir(), 't273-ep-'));
  const tokenFile = path.join(dir, 'host.token');
  writeFileSync(tokenFile, TOKEN + '\n', 'utf8');
  return { dir, tokenFile, endpointFile: path.join(dir, 'endpoint.json') };
}

const host = () => createFakeHost({ sessions: SESSIONS, turnsPerTask: 1 });

test('T273: a descriptor is validated, not trusted', () => {
  const good = buildEndpoint({ port: 42731, kind: EXPECTED_KIND, protocol: EXPECTED_PROTOCOL });
  assert.equal(good.version, ENDPOINT_FILE_VERSION);
  assert.equal(good.base, 'http://127.0.0.1:42731');
  assert.ok(good.endpointId.length >= 8);
  assert.equal(validateEndpoint(good).port, 42731);

  const rejects = [
    [{ ...good, version: 2 }, 'unsupported endpoint file version'],
    [{ ...good, base: 'http://10.0.0.5:42731' }, 'loopback http URL'],
    [{ ...good, base: 'http://127.0.0.1:42731', port: 42732 }, 'disagrees with its base URL'],
    [{ ...good, base: 'http://127.0.0.1:80', port: 80 }, 'privileged port'],
    [{ ...good, endpointId: 'short' }, 'no endpointId'],
  ];
  for (const [value, needle] of rejects) {
    assert.throws(() => validateEndpoint(value), (err) => {
      assert.equal(err.code, CODES.invalid_arguments);
      assert.match(err.message, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    }, needle);
  }
  assert.throws(() => buildEndpoint({ port: 0 }), (err) => err.code === CODES.invalid_arguments);
});

test('T273: exactly one locator, and a missing descriptor is not a silence', () => {
  assert.throws(() => resolveEndpoint({}), (err) => err.code === CODES.invalid_arguments);
  assert.throws(() => resolveEndpoint({ hostUrl: 'http://127.0.0.1:42731', endpointFile: 'x.json' }),
    (err) => err.code === CODES.invalid_arguments);
  assert.throws(() => resolveEndpoint({ hostUrl: 'http://192.168.1.4:42731' }),
    (err) => err.code === CODES.invalid_arguments);
  assert.throws(() => resolveEndpoint({ hostUrl: 'http://127.0.0.1:80' }), (err) => err.code === CODES.invalid_arguments);
  const pinned = resolveEndpoint({ hostUrl: 'http://127.0.0.1:42731' });
  assert.deepEqual({ base: pinned.base, source: pinned.source, endpointId: pinned.endpointId },
    { base: 'http://127.0.0.1:42731', source: 'hostUrl', endpointId: null });

  const sc = scene();
  try {
    assert.throws(() => readEndpointFile(path.join(sc.dir, 'absent.json')), (err) => {
      assert.equal(err.code, CODES.host_unreachable, 'a missing descriptor means the plugin never bound, not "no Host"');
      assert.equal(err.details.reason, 'ENOENT');
      return true;
    });
    writeFileSync(sc.endpointFile, '{ not json', 'utf8');
    assert.throws(() => readEndpointFile(sc.endpointFile), (err) => {
      assert.equal(err.code, CODES.invalid_arguments);
      assert.match(err.message, /not valid JSON/);
      return true;
    });
  } finally {
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T273: the bridge publishes its descriptor and removes only its own', async () => {
  const sc = scene();
  let bridge = null;
  try {
    bridge = await startHostBridge({ adapter: host(), token: TOKEN, endpointFile: sc.endpointFile });
    const written = readEndpointFile(sc.endpointFile);
    assert.equal(written.base, bridge.base);
    assert.equal(written.endpointId, bridge.endpointId);
    assert.equal(written.port, bridge.port);

    const health = await (await fetch(bridge.base + '/health')).json();
    assert.equal(health.endpointId, bridge.endpointId, '/health must echo the id the descriptor carries');

    // A successor overwrote the file: closing the old bridge must not delete the new descriptor.
    const successor = buildEndpoint({ port: bridge.port, kind: EXPECTED_KIND, protocol: EXPECTED_PROTOCOL });
    writeEndpointFile(sc.endpointFile, successor);
    await bridge.close();
    bridge = null;
    assert.equal(existsSync(sc.endpointFile), true, 'a stale close must not remove a successor endpoint file');
    assert.equal(readEndpointFile(sc.endpointFile).endpointId, successor.endpointId);
    assert.equal(removeEndpointFile(sc.endpointFile, successor.endpointId), true);
    assert.equal(existsSync(sc.endpointFile), false);
    assert.equal(openBridgeCount(), 0);
  } finally {
    if (bridge) await bridge.close();
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T273: a taken fixed port is a bind_failed rejection, not a dead process', async () => {
  const sc = scene();
  try {
    const first = await startHostBridge({ adapter: host(), token: TOKEN, port: 42741 });
    await assert.rejects(startHostBridge({ adapter: host(), token: TOKEN, port: 42741 }), (err) => {
      assert.equal(err.code, CODES.bind_failed, 'EADDRINUSE must surface as a code the plugin can log');
      assert.equal(err.details.reason, 'EADDRINUSE');
      assert.equal(err.details.port, 42741);
      return true;
    });
    // The first bridge must be untouched by the failed second attempt.
    const sessions = await (await fetch(first.base + '/sessions',
      { headers: { authorization: 'Bearer ' + TOKEN } })).json();
    assert.equal(sessions.sessions.length, 1);
    await first.close();
    assert.equal(openBridgeCount(), 0);

    // Disposing must release the socket: a new instance binds the same port immediately.
    const again = await startHostBridge({ adapter: host(), token: TOKEN, port: 42741 });
    assert.equal(again.port, 42741);
    await again.close();
  } finally {
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T273: a client given the descriptor follows a restarted bridge without being rebuilt', async () => {
  const sc = scene();
  try {
    const first = await startHostBridge({ adapter: host(), token: TOKEN, endpointFile: sc.endpointFile });
    const client = new HostClient({ endpointFile: sc.endpointFile, tokenFile: sc.tokenFile, timeoutMs: 3000,
      expectKind: 'offline_fake' });
    const rows = await client.listSessions();
    assert.equal(rows.length, 1);
    const firstBase = client.baseUrl;

    await first.close();
    const second = await startHostBridge({ adapter: host(), token: TOKEN, endpointFile: sc.endpointFile });
    assert.notEqual(second.base, firstBase, 'a fresh bind after close must be visible as a different base');

    // Same client instance: refresh() picks up the new descriptor, verification is redone for the new endpointId.
    const afterRestart = await client.listSessions();
    assert.equal(afterRestart.length, 1);
    assert.equal(client.baseUrl, second.base);
    assert.equal(client.verified, true);
    await second.close();
    assert.equal(openBridgeCount(), 0);
  } finally {
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T273: a stale descriptor pointing at somebody else is refused before any prompt', async () => {
  const sc = scene();
  let promptHits = 0;
  const stranger = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, kind: EXPECTED_KIND, protocol: EXPECTED_PROTOCOL, loopbackOnly: true,
        endpointId: 'not-the-one-in-the-file' }));
      return;
    }
    if (req.url === '/prompt') promptHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: [] }));
  });
  await new Promise((resolve) => stranger.listen(0, '127.0.0.1', resolve));
  const port = stranger.address().port;
  try {
    writeEndpointFile(sc.endpointFile, buildEndpoint({ port, kind: EXPECTED_KIND, protocol: EXPECTED_PROTOCOL }));
    const client = new HostClient({ endpointFile: sc.endpointFile, tokenFile: sc.tokenFile, timeoutMs: 3000 });
    await assert.rejects(client.listSessions(), (err) => {
      assert.equal(err.code, CODES.host_identity_mismatch);
      assert.match(err.message, /different bridge instance/);
      assert.equal(err.details.expected.endpointId.length > 0, true);
      return true;
    });
    assert.equal(promptHits, 0, 'identity is checked before a prompt, never after');
  } finally {
    await new Promise((resolve) => stranger.close(resolve));
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T273: a stranger that is not even a DSH bridge is named as such', async () => {
  const sc = scene();
  const stranger = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hello: 'i am a static server' }));
  });
  await new Promise((resolve) => stranger.listen(0, '127.0.0.1', resolve));
  try {
    const client = new HostClient({ baseUrl: 'http://127.0.0.1:' + stranger.address().port,
      tokenFile: sc.tokenFile, timeoutMs: 3000 });
    await assert.rejects(client.listSessions(), (err) => {
      assert.equal(err.code, CODES.host_identity_mismatch);
      assert.match(err.message, /loopback DSH bridge/);
      return true;
    });
    assert.equal(assertHealthIdentity.length, 1);
  } finally {
    await new Promise((resolve) => stranger.close(resolve));
    rmSync(sc.dir, { recursive: true, force: true });
  }
});

test('T273: identity expectations default to the real 0.2.0-rc.2 values', () => {
  assert.equal(EXPECTED_KIND, 'cordis_session_controller');
  assert.equal(EXPECTED_PROTOCOL, 'dsh-api-session-controller@0.2.0-rc.2');
  assert.throws(() => assertHealthIdentity({ ok: true, kind: 'offline_fake', protocol: EXPECTED_PROTOCOL,
    loopbackOnly: true }), (err) => {
    assert.equal(err.code, CODES.host_identity_mismatch);
    assert.match(String(err.details.expected.kind), /cordis_session_controller/);
    return true;
  }, 'the offline fake must not pass for a live Host unless the caller says it is a fake');
  const raw = readFileSync(new URL('./tools/dsh-direct/adapters.mjs', import.meta.url), 'utf8');
  assert.match(raw, /dsh-api-session-controller@0\.2\.0-rc\.2/);
});
