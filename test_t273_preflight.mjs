// T273: the preflight must fail on the defects it was written for, on the real tree, and it must stay read-only.
//
// Each negative case copies a small piece of the real package or document into a temporary directory, injects exactly
// one defect, and asserts the check names it. A checker that only ever prints ok is indistinguishable from no checker.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkConfig, checkDocs, checkPackage, checkPort, collectLocalImports, cordisVersionAt, runPreflight,
  satisfiesRange, summarise,
} from './tools/dsh-direct/preflight.mjs';
import { buildEndpoint, writeEndpointFile } from './tools/dsh-direct/endpoint.mjs';
import { startHostBridge } from './tools/dsh-direct/host_bridge.mjs';
import { createFakeHost } from './tools/dsh-direct/adapters.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(REPO, 'tools', 'dsh-direct', 'plugin');
const SESSION = 'session-11111111-2222-4333-8444-555566667777';

function temp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function byId(checks, id) {
  const found = checks.filter((check) => check.id === id);
  assert.equal(found.length, 1, 'expected exactly one ' + id + ' check, got ' + found.length);
  return found[0];
}

test('T273: the shipped package passes every package check', () => {
  const checks = checkPackage(PLUGIN);
  for (const id of ['package.manifest', 'package.imports', 'package.patch']) {
    assert.equal(byId(checks, id).status, 'ok', id + ': ' + byId(checks, id).detail);
  }
  const imports = byId(checks, 'package.imports');
  assert.match(imports.detail, /6 local module/);
  const manifest = JSON.parse(readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '0.2.0', 'the config contract changed, so the package version did too');
  const files = collectLocalImports(PLUGIN, 'lib/index.js').files;
  assert.deepEqual(files, ['lib/adapters.mjs', 'lib/endpoint.mjs', 'lib/host_bridge.mjs', 'lib/index.js',
    'lib/protocol.mjs', 'lib/session_api.mjs']);
});

test('T273: a package whose files[] omits an imported module is rejected', () => {
  const dir = temp('t273-pkg-');
  try {
    cpSync(PLUGIN, dir, { recursive: true });
    const manifestPath = path.join(dir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.files = ['lib/index.js', 'cordis.patch.yml', 'README.md'];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    const check = byId(checkPackage(dir), 'package.imports');
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /not covered by files\[\]/);
    assert.deepEqual(check.unshipped, ['lib/adapters.mjs', 'lib/endpoint.mjs', 'lib/host_bridge.mjs',
      'lib/protocol.mjs', 'lib/session_api.mjs']);

    rmSync(path.join(dir, 'lib', 'endpoint.mjs'));
    const missing = byId(checkPackage(dir), 'package.imports');
    assert.equal(missing.status, 'fail');
    assert.match(missing.detail, /absent from the package: lib\/endpoint\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T273: a patch file that does not insert this plugin is rejected', () => {
  const dir = temp('t273-patch-');
  try {
    cpSync(PLUGIN, dir, { recursive: true });
    writeFileSync(path.join(dir, 'cordis.patch.yml'), "- insert:\n    - id: someone-else\n      name: 'someone-else'\n",
      'utf8');
    const check = byId(checkPackage(dir), 'package.patch');
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /does not insert this plugin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T273: the declared cordis range is compared with the installed Desktop', async () => {
  assert.deepEqual(satisfiesRange('4.0.4', '>=4.0.0-rc <5'), { ok: true });
  assert.deepEqual(satisfiesRange('4.0.0-rc.13', '>=4.0.0-rc <5'), { ok: true });
  assert.equal(satisfiesRange('5.0.0', '>=4.0.0-rc <5').ok, false);
  assert.equal(satisfiesRange('3.9.9', '>=4.0.0-rc <5').ok, false);
  assert.match(satisfiesRange('4.0.4', 'workspace:~').reason, /unsupported range token/);
  assert.equal(cordisVersionAt(path.join(tmpdir(), 'definitely-not-an-install-' + process.pid)), null);

  // A fixture install tree: proving the check fails on the wrong version does not need the operator's machine.
  const fake = temp('t273-install-');
  try {
    const pkgDir = path.join(fake, 'node_modules', '@deepseek-ai', 'cordis');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '3.9.0' }),
      'utf8');
    const found = cordisVersionAt(fake);
    assert.equal(found.version, '3.9.0');
    const checks = await runPreflight({ home: temp('t273-home2-'), docsRoot: REPO, dshInstall: fake });
    const compat = byId(checks, 'cordis.compat');
    assert.equal(compat.status, 'fail');
    assert.match(compat.detail, /@deepseek-ai\/cordis@3\.9\.0 does not satisfy >=4\.0\.0-rc <5/);
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }

  // When the operator points DSH_INSTALL at a real install, the same path must resolve a 4.x cordis.
  if (process.env.DSH_INSTALL) {
    const real = cordisVersionAt(process.env.DSH_INSTALL);
    assert.ok(real, 'DSH_INSTALL is set but no @deepseek-ai/cordis was found under it');
    assert.match(real.version, /^4\./);
  }
});

test('T273: the install document and the example config are checked against the schema', () => {
  const clean = checkDocs(REPO);
  assert.equal(byId(clean, 'docs.consistency').status, 'ok', byId(clean, 'docs.consistency').detail);

  const dir = temp('t273-docs-');
  try {
    mkdirSync(path.join(dir, 'tools', 'dsh-direct'), { recursive: true });
    const doc = readFileSync(path.join(REPO, 'tools', 'dsh-direct', 'INSTALL-WINDOWS.md'), 'utf8');
    const example = readFileSync(path.join(REPO, 'tools', 'dsh-direct', 'config.example.json'), 'utf8');

    // (a) T272's defect: two different token paths in one document.
    writeFileSync(path.join(dir, 'tools', 'dsh-direct', 'INSTALL-WINDOWS.md'),
      doc.replace('<HOME>/.dsh/dsh-direct/host.token', '<USERPROFILE>/dsh-direct/host.token'), 'utf8');
    writeFileSync(path.join(dir, 'tools', 'dsh-direct', 'config.example.json'), example, 'utf8');
    const twoPaths = byId(checkDocs(dir), 'docs.consistency');
    assert.equal(twoPaths.status, 'fail');
    assert.match(twoPaths.detail, /more than one token file|not <HOME>\/\.dsh\/dsh-direct\/host\.token/);

    // (b) T272's other defect: teaching `port: 0`, which cannot be found after a restart.
    writeFileSync(path.join(dir, 'tools', 'dsh-direct', 'INSTALL-WINDOWS.md'),
      doc.replace('port: 42731', 'port: 0'), 'utf8');
    const randomPort = byId(checkDocs(dir), 'docs.consistency');
    assert.equal(randomPort.status, 'fail');
    assert.match(randomPort.detail, /port: 0/);

    // (c) an example field the server never reads.
    writeFileSync(path.join(dir, 'tools', 'dsh-direct', 'INSTALL-WINDOWS.md'), doc, 'utf8');
    const broken = JSON.parse(example);
    broken.hostPort = 42731;
    writeFileSync(path.join(dir, 'tools', 'dsh-direct', 'config.example.json'),
      JSON.stringify(broken, null, 2) + '\n', 'utf8');
    const unknownField = byId(checkDocs(dir), 'docs.consistency');
    assert.equal(unknownField.status, 'fail');
    assert.match(unknownField.detail, /hostPort/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T273: config validation fails closed on each wrong shape', () => {
  const dir = temp('t273-cfg-');
  const tokenFile = path.join(dir, 'host.token');
  writeFileSync(tokenFile, 'x'.repeat(64), 'utf8');
  const base = { tokenFile, stateDir: path.join(dir, 'state'), boundSessionIds: [SESSION] };
  const write = (name, value) => {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
    return file;
  };
  try {
    const both = checkConfig(write('both.json', { ...base, hostUrl: 'http://127.0.0.1:42731',
      endpointFile: path.join(dir, 'endpoint.json') }));
    assert.equal(byId(both.checks, 'config.schema').status, 'fail');
    assert.match(byId(both.checks, 'config.schema').detail, /mutually exclusive/);

    const neither = checkConfig(write('neither.json', base));
    assert.match(byId(neither.checks, 'config.schema').detail, /hostUrl or config\.endpointFile is required/);

    const unbound = checkConfig(write('unbound.json', { ...base, boundSessionIds: [],
      endpointFile: path.join(dir, 'endpoint.json') }));
    assert.match(byId(unbound.checks, 'config.schema').detail, /not_bound/);

    const shortToken = path.join(dir, 'short.token');
    writeFileSync(shortToken, 'too-short', 'utf8');
    const short = checkConfig(write('short.json', { ...base, tokenFile: shortToken,
      endpointFile: path.join(dir, 'endpoint.json') }));
    assert.equal(byId(short.checks, 'config.token').status, 'fail');
    assert.match(byId(short.checks, 'config.token').detail, /9 characters/);
    assert.equal(JSON.stringify(short.checks).includes('too-short'), false, 'the token value must never be echoed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T273: the preflight reads a live endpoint, and reports the wrong owner as a failure', async () => {
  const dir = temp('t273-live-');
  const tokenFile = path.join(dir, 'host.token');
  writeFileSync(tokenFile, 'y'.repeat(64), 'utf8');
  const endpointFile = path.join(dir, 'endpoint.json');
  const bridge = await startHostBridge({ adapter: createFakeHost({ sessions: [] }), token: 'y'.repeat(64),
    endpointFile });
  try {
    const configPath = path.join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ endpointFile, tokenFile, stateDir: path.join(dir, 'state'),
      boundSessionIds: [SESSION], expectKind: 'offline_fake' }, null, 2) + '\n', 'utf8');
    const checks = await runPreflight({ configPath, home: dir });
    assert.equal(byId(checks, 'config.schema').status, 'ok');
    assert.equal(byId(checks, 'config.token').status, 'ok');
    assert.equal(byId(checks, 'endpoint.identity').status, 'ok', byId(checks, 'endpoint.identity').detail);
    assert.equal(byId(checks, 'docs.consistency').status, 'ok');
    assert.equal(byId(checks, 'install.state').status, 'ok');
    assert.equal(summarise(checks).failed, false);
    assert.equal(existsSync(path.join(dir, 'state')), false, 'a preflight must not create the state directory');
  } finally {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T273: a descriptor whose port is owned by a different bridge fails identity', async () => {
  const dir = temp('t273-stale-');
  const tokenFile = path.join(dir, 'host.token');
  writeFileSync(tokenFile, 'z'.repeat(64), 'utf8');
  const endpointFile = path.join(dir, 'endpoint.json');
  const live = await startHostBridge({ adapter: createFakeHost({ sessions: [] }), token: 'z'.repeat(64) });
  try {
    // The descriptor claims the live port but an id that bridge never issued: exactly what a stale file looks like
    // after a restart, and what a reused port looks like when another program grabbed it.
    writeEndpointFile(endpointFile, buildEndpoint({ port: live.port, kind: 'cordis_session_controller',
      protocol: 'dsh-api-session-controller@0.2.0-rc.2' }));
    const configPath = path.join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ endpointFile, tokenFile, stateDir: path.join(dir, 'state'),
      boundSessionIds: [SESSION] }, null, 2) + '\n', 'utf8');
    const checks = await runPreflight({ configPath, home: dir });
    const identity = byId(checks, 'endpoint.identity');
    assert.equal(identity.status, 'fail');
    assert.match(identity.detail, /host_identity_mismatch/);
    assert.equal(summarise(checks).exitCode, 1);
  } finally {
    await live.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T273: the port probe distinguishes free from occupied without binding', async () => {
  const server = createServer((req, res) => { res.writeHead(204); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const busy = server.address().port;
  try {
    const occupied = await checkPort(busy);
    assert.equal(occupied.status, 'warn');
    assert.match(occupied.detail, /already accepting connections/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const free = await checkPort(busy);
  assert.equal(free.status, 'ok');
  assert.match(free.detail, /is free on 127\.0\.0\.1/);
  const outOfRange = await checkPort(80);
  assert.equal(outOfRange.status, 'fail');
});

test('T273: the preflight writes nothing into a home directory it inspects', async () => {
  const home = temp('t273-home-');
  try {
    const before = readdirSync(home);
    const checks = await runPreflight({ home, docsRoot: REPO });
    assert.equal(byId(checks, 'install.state').status, 'ok');
    assert.match(byId(checks, 'install.state').detail, /plugin directory is absent/);
    assert.deepEqual(readdirSync(home), before, 'inspecting an install state must not create anything');
    assert.equal(existsSync(path.join(home, '.dsh')), false);
    const helper = path.join(REPO, 'tools', 'dsh-direct', 'preflight.mjs');
    assert.match(readFileSync(helper, 'utf8'), /--strict/, 'the CLI documents its own flags');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
