// DSH Direct preflight: a read-only check that the plugin package, the MCP config and the install document agree with
// each other and with the Desktop actually installed on this machine.
//
// Read-only means: no binding except a deliberate `net.connect` probe, no Desktop restart, no write outside a temporary
// directory, and the token file is measured, never printed.
//
//   node tools/dsh-direct/preflight.mjs --config <config.json>
//   node tools/dsh-direct/preflight.mjs --package <plugin dir> --port 42731
//   node tools/dsh-direct/preflight.mjs --alone            # package + docs only, no config needed
//   ... --json                                             # machine-readable
//   ... --strict                                           # treat `warn` as failure
//
// Exit codes: 0 nothing failed, 1 something failed, 2 the flags themselves were wrong.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_FIELDS, loadConfig } from './mcp_server.mjs';
import { EXPECTED_KIND, EXPECTED_PROTOCOL, assertHealthIdentity, resolveEndpoint } from './endpoint.mjs';
import { CODES, DirectError, HTTP_CONFIG_FIELDS } from './protocol.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const PLACEHOLDER = /^(<[A-Z_]+>|%[A-Z_]+%|\$env:[A-Za-z_]+)/;

/** A check result, so every line of output can be traced to code rather than to prose. */
function result(id, status, detail, extra = {}) {
  return { id, status, detail, ...extra };
}

function coveredBy(files, relative) {
  const normalised = relative.replace(/\\/g, '/');
  return files.some((entry) => {
    const pattern = entry.replace(/\\/g, '/').replace(/^\.\//, '');
    return normalised === pattern || normalised.startsWith(pattern.replace(/\/$/, '') + '/');
  });
}

const IMPORT_RE = /(?:from\s+|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Follow relative ESM imports from the manifest entry file, so a module the package forgets to ship is caught here. */
export function collectLocalImports(packageDir, entryFile) {
  const seen = new Set();
  const missing = [];
  const queue = [entryFile];
  while (queue.length) {
    const relative = queue.shift();
    if (seen.has(relative)) continue;
    seen.add(relative);
    const absolute = path.join(packageDir, relative);
    if (!existsSync(absolute)) {
      missing.push(relative);
      continue;
    }
    const text = readFileSync(absolute, 'utf8');
    const dir = path.posix.dirname(relative.replace(/\\/g, '/'));
    for (const match of text.matchAll(IMPORT_RE)) {
      const target = path.posix.normalize(path.posix.join(dir, match[1]));
      if (!seen.has(target)) queue.push(target);
    }
  }
  return { files: [...seen].sort(), missing };
}

export function checkPackage(packageDir) {
  const checks = [];
  const manifestPath = path.join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) {
    return [result('package.manifest', 'fail', 'no package.json at ' + packageDir, { packageDir })];
  }
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return [result('package.manifest', 'fail', 'package.json is not valid JSON: ' + String(err.message))];
  }
  const problems = [];
  if (typeof manifest.name !== 'string' || !manifest.name) problems.push('name is missing');
  if (manifest.type !== 'module') problems.push('type must be "module" for an ESM Cordis plugin');
  if (typeof manifest.main !== 'string') problems.push('main is missing');
  if (typeof manifest.version !== 'string') problems.push('version is missing');
  if (!manifest.dsh || !manifest.dsh.bundle || typeof manifest.dsh.bundle.patch !== 'string') {
    problems.push('dsh.bundle.patch is missing, so the Desktop has no patch file to load');
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) problems.push('files[] is missing');
  if (problems.length) {
    checks.push(result('package.manifest', 'fail', problems.join('; '), { packageDir }));
  } else {
    checks.push(result('package.manifest', 'ok', manifest.name + '@' + manifest.version + ' declares main '
      + manifest.main + ', dsh.bundle.patch ' + manifest.dsh.bundle.patch + ', files ' + manifest.files.join(',')));
  }

  const mainRelative = manifest.main ? manifest.main.replace(/^\.\//, '') : null;
  if (mainRelative) {
    const imports = collectLocalImports(packageDir, mainRelative);
    const unshipped = imports.files.filter((file) => !coveredBy(manifest.files || [], file));
    if (imports.missing.length) {
      checks.push(result('package.imports', 'fail', 'imported modules are absent from the package: '
        + imports.missing.join(', '), { missing: imports.missing }));
    } else if (unshipped.length) {
      checks.push(result('package.imports', 'fail', 'modules the entry imports are not covered by files[]: '
        + unshipped.join(', ') + ' (an npm pack or a copy of only files[] would break at load)',
      { unshipped }));
    } else {
      checks.push(result('package.imports', 'ok', imports.files.length + ' local module(s) reachable from '
        + mainRelative + ' and all covered by files[]'));
    }
  }

  const patchRelative = manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch
    ? manifest.dsh.bundle.patch.replace(/^\.\//, '') : null;
  if (patchRelative) {
    const patchPath = path.join(packageDir, patchRelative);
    if (!existsSync(patchPath)) {
      checks.push(result('package.patch', 'fail', 'dsh.bundle.patch names a file that does not exist: ' + patchRelative));
    } else {
      const text = readFileSync(patchPath, 'utf8');
      const wants = ['insert:', 'id: ' + manifest.name, "name: '" + manifest.name + "'"];
      const absent = wants.filter((needle) => !text.includes(needle));
      if (absent.length) {
        checks.push(result('package.patch', 'fail', 'cordis patch does not insert this plugin: missing '
          + absent.join(' | '), { present: text.trim() }));
      } else {
        checks.push(result('package.patch', 'ok', patchRelative + ' inserts id ' + manifest.name));
      }
    }
  }
  return checks;
}

/** Compare the declared cordis peer range with the cordis version the Desktop actually ships. */
export function cordisVersionAt(dshInstall) {
  const candidates = [
    path.join(dshInstall, 'node_modules', '@deepseek-ai', 'cordis', 'package.json'),
    path.join(dshInstall, 'resources', 'app', 'node_modules', '@deepseek-ai', 'cordis', 'package.json'),
    path.join(dshInstall, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'package.json'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (typeof parsed.version === 'string') return { version: parsed.version, file: candidate };
    } catch { /* try the next candidate */ }
  }
  return null;
}

/** `>=4.0.0-rc <5` -> the small subset this project needs: >=X and <Y, with optional -rc style suffixes. */
export function satisfiesRange(version, range) {
  const parts = String(range).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { ok: false, reason: 'empty range' };
  const numeric = String(version).split('-')[0].split('.').map(Number);
  const weight = (v) => (v[0] || 0) * 1e6 + (v[1] || 0) * 1e3 + (v[2] || 0);
  for (const part of parts) {
    const match = /^(>=|<=|>|<|=)?\s*v?([0-9]+(?:\.[0-9]+){0,2})(-[0-9A-Za-z.]+)?$/.exec(part);
    if (!match) return { ok: false, reason: 'unsupported range token "' + part + '"' };
    const operator = match[1] || '=';
    const target = match[2].split('.').map(Number);
    const left = weight(numeric);
    const right = weight(target);
    const different = left !== right;
    const verdict = operator === '>=' ? left >= right : operator === '<=' ? left <= right
      : operator === '>' ? left > right : operator === '<' ? left < right : !different;
    if (!verdict) return { ok: false, reason: version + ' does not satisfy ' + part };
    // A `>=x.y.z-rc` bound is satisfied by the release, and also by a later -rc; the numeric compare above is enough
    // because the plugin only needs Cordis 4 semantics, which every 4.x prerelease already has.
  }
  return { ok: true };
}

const KEY_HINT = new Map([
  ['tokenFile', 'the 32+ character bearer token file'],
  ['stateDir', 'the ledger + endpoint directory'],
  ['endpointFile', 'the descriptor the plugin writes at bind time'],
  ['hostUrl', 'a pinned loopback URL (fixed port only)'],
  ['boundSessionIds', 'the only sessions this server may prompt'],
  ['boundCwds', 'bind by workspace path instead of id'],
  ['worktreeRoot', 'optional worktree precheck'],
  ['maxPolls', 'how many times get_result may collect'],
  ['http', 'the optional Streamable HTTP transport (off by default)'],
]);

export function checkConfig(configPath) {
  const checks = [];
  let config = null;
  try {
    config = loadConfig(configPath);
    const locator = config.endpointFile ? 'endpointFile ' + config.endpointFile : 'hostUrl ' + config.hostUrl;
    checks.push(result('config.schema', 'ok', 'config is valid; locator: ' + locator + '; bound '
      + config.boundSessionIds.length + ' id(s), ' + config.boundCwds.length + ' cwd(s)'));
  } catch (err) {
    const code = err instanceof DirectError ? err.code : CODES.internal;
    checks.push(result('config.schema', 'fail', code + ': ' + String(err && err.message),
      { details: err && err.details ? err.details : null }));
    return { checks, config: null };
  }
  const tokenPath = config.tokenFile;
  if (!existsSync(tokenPath)) {
    checks.push(result('config.token', 'fail', 'the token file does not exist; the plugin would refuse to start and '
      + 'the MCP server would answer host_unreachable', { tokenFile: tokenPath }));
  } else {
    const text = readFileSync(tokenPath, 'utf8').trim();
    const stat = statSync(tokenPath);
    if (text.length < 32) {
      checks.push(result('config.token', 'fail', 'the token file holds ' + text.length + ' characters; 32 is the '
        + 'minimum', { length: text.length }));
    } else {
      checks.push(result('config.token', 'ok', 'token file holds ' + text.length + ' characters, ' + stat.size
        + ' bytes on disk (contents not read into the report)'));
    }
  }
  try {
    const resolved = resolveEndpoint({ hostUrl: config.hostUrl || null, endpointFile: config.endpointFile || null });
    if (config.endpointFile && resolved.source === 'endpointFile') {
      checks.push(result('endpoint.locate', 'ok', 'descriptor names ' + resolved.base + ' (endpointId '
        + String(resolved.endpointId).slice(0, 8) + '..., pid ' + String(resolved.descriptor.pid) + ')'));
    } else {
      checks.push(result('endpoint.locate', 'ok', 'pinned URL ' + resolved.base));
    }
  } catch (err) {
    checks.push(result('endpoint.locate', 'fail', (err instanceof DirectError ? err.code : 'internal') + ': '
      + String(err && err.message)));
  }
  checks.push(...checkHttpConfig(config));
  return { checks, config };
}

/**
 * The HTTP transport is optional, so "off" is a passing state and must be reported as a fact rather than skipped: an
 * operator reading the report needs to know whether a loopback listener will exist after start.
 */
export function checkHttpConfig(config) {
  const http = config && config.http ? config.http : null;
  if (!http) {
    return [result('http.config', 'ok', 'config.http is absent or disabled; this deployment serves stdio only')];
  }
  const checks = [];
  checks.push(result('http.config', 'ok', 'Streamable HTTP enabled on http://' + http.host + ':' + http.port + http.path
    + ' (' + http.maxSessions + ' sessions max, ' + http.maxConcurrentRequests + ' concurrent tool calls, '
    + http.requestTimeoutMs + ' ms request timeout)'));
  const problems = [];
  if (!existsSync(http.authTokenFile)) {
    problems.push('the HTTP token file does not exist, so the transport would refuse to start');
  } else {
    const text = readFileSync(http.authTokenFile, 'utf8').trim();
    if (text.length < 32) problems.push('the HTTP token holds ' + text.length + ' characters; 32 is the minimum');
    if (config.tokenFile === http.authTokenFile) {
      problems.push('the HTTP token and the Host token are the same file; a client that must talk to the MCP listener '
        + 'would then also hold the Host bearer token');
    }
  }
  if (http.allowedOrigins.length === 0) {
    checks.push(result('http.origins', 'warn', 'allowedOrigins is empty: every request carrying an Origin header is '
      + 'refused with 403. Right for a CLI client; a browser client needs its exact origin listed'));
  } else {
    checks.push(result('http.origins', 'ok', http.allowedOrigins.length + ' origin(s) allowed: '
      + http.allowedOrigins.join(', ')));
  }
  if (problems.length) checks.push(result('http.token', 'fail', problems.join('; '), { problems }));
  else checks.push(result('http.token', 'ok', 'HTTP token file holds a long enough secret and is not the Host token'));
  return checks;
}

/** Connect without sending anything a Host would act on: /health is unauthenticated and has no side effects. */
export async function probeHealth(base, { timeoutMs = 1500, expected = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(base + '/health', { signal: controller.signal });
    const body = await response.json();
    return { ok: true, status: response.status, body };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message) };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkEndpoint(config, { port = null } = {}) {
  const checks = [];
  let base = null;
  let expected = { kind: EXPECTED_KIND, protocol: EXPECTED_PROTOCOL };
  try {
    if (config) {
      const resolved = resolveEndpoint({ hostUrl: config.hostUrl || null, endpointFile: config.endpointFile || null });
      base = resolved.base;
      // The config may narrow the expectation (a test config declares the offline fake). When it does not, the real
      // 0.2.0-rc.2 identity is required, so a fake cannot pass by accident.
      expected = { kind: config.expectKind || EXPECTED_KIND, protocol: config.expectProtocol || EXPECTED_PROTOCOL };
      if (resolved.endpointId) expected = { ...expected, endpointId: resolved.endpointId };
    } else if (Number.isInteger(port)) {
      base = 'http://127.0.0.1:' + port;
    }
  } catch (err) {
    checks.push(result('endpoint.identity', 'fail', (err instanceof DirectError ? err.code : 'internal')
      + ': ' + String(err && err.message)));
    return checks;
  }
  if (!base) return checks;
  const health = await probeHealth(base);
  if (!health.ok) {
    checks.push(result('endpoint.identity', 'warn', 'nothing is answering ' + base + ' right now (' + health.reason
      + '). That is expected while the Desktop is closed, and is the state the MCP side turns into host_unreachable;'
      + ' start or restart the Desktop and run this again before trusting B'));
    return checks;
  }
  try {
    assertHealthIdentity(health.body, expected);
    checks.push(result('endpoint.identity', 'ok', 'the port answers as ' + health.body.kind + ' speaking '
      + health.body.protocol + (health.body.endpointId ? ' (endpointId matches the descriptor)' : '')));
  } catch (err) {
    checks.push(result('endpoint.identity', 'fail', (err instanceof DirectError ? err.code : 'internal') + ': '
      + String(err && err.message), { details: err && err.details ? err.details : null }));
  }
  return checks;
}

/** Is a fixed port usable? `in-use-by-us` is fine (a previous instance), `in-use-by-other` is not. */
export function checkPort(port) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      resolve(result('port.availability', 'fail', 'port ' + port + ' is outside 1024..65535'));
      return;
    }
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (status, detail) => {
      socket.destroy();
      resolve(result('port.availability', status, detail, { port }));
    };
    socket.setTimeout(1200);
    socket.once('connect', () => done('warn', 'port ' + port + ' is already accepting connections; if that is a '
      + 'previous dsh-direct bridge it is harmless (the identity check will confirm), otherwise pick another port'));
    socket.once('timeout', () => done('warn', 'port ' + port + ' did not answer a connect attempt within 1200 ms'));
    socket.once('error', (err) => {
      if (err && err.code === 'ECONNREFUSED') done('ok', 'port ' + port + ' is free on 127.0.0.1');
      else done('fail', 'port ' + port + ' cannot be probed: ' + String(err && err.code));
    });
  });
}

const DOC = 'tools/dsh-direct/INSTALL-WINDOWS.md';
const EXAMPLE = 'tools/dsh-direct/config.example.json';

/**
 * The document and the example are the two things an operator copies by hand, so they are checked against the code:
 * every config key must exist, the token path must be the same file in every place it appears, and the listener
 * guidance must not send anyone back to a random port.
 */
export function checkDocs(root = REPO_ROOT) {
  const checks = [];
  const docPath = path.join(root, DOC);
  const examplePath = path.join(root, EXAMPLE);
  if (!existsSync(docPath) || !existsSync(examplePath)) {
    return [result('docs.consistency', 'fail', 'INSTALL-WINDOWS.md or config.example.json is missing')];
  }
  const doc = readFileSync(docPath, 'utf8');
  const problems = [];

  let example = null;
  try {
    example = JSON.parse(readFileSync(examplePath, 'utf8'));
  } catch (err) {
    problems.push('config.example.json is not valid JSON: ' + String(err.message));
  }
  if (example) {
    const unknown = Object.keys(example).filter((key) => key !== '$comment' && !CONFIG_FIELDS.includes(key));
    if (unknown.length) problems.push('config.example.json uses fields loadConfig does not read: ' + unknown.join(', '));
    if (!example.endpointFile && !example.hostUrl) {
      problems.push('config.example.json sets neither endpointFile nor hostUrl');
    }
    if (example.endpointFile && example.hostUrl) {
      problems.push('config.example.json sets both endpointFile and hostUrl, which loadConfig rejects');
    }
    // The shipped example is what an operator copies, so it must show the HTTP transport the way it ships: present,
    // documented and off.
    if (!example.http) {
      problems.push('config.example.json has no http block, so the Streamable HTTP transport is undocumented there');
    } else {
      const badHttp = Object.keys(example.http).filter((key) => !key.startsWith('$')
        && !HTTP_CONFIG_FIELDS.includes(key));
      if (badHttp.length) {
        problems.push('config.example.json http block uses fields loadHttpConfig does not read: ' + badHttp.join(', '));
      }
      if (example.http.enabled !== false) {
        problems.push('config.example.json ships config.http.enabled other than false; the transport must be off in the '
          + 'file an operator copies');
      }
      for (const key of ['authTokenFile', 'allowedOrigins']) {
        if (example.http[key] === undefined) problems.push('config.example.json http block omits ' + key);
      }
    }
  }

  // Every occurrence of a host.token *path* must point at the same file. T272 shipped two different ones: the token was
  // created under `<HOME>/.dsh/dsh-direct/host.token` and then configured as `<USERPROFILE>/dsh-direct/host.token`.
  // A bare file name (`Join-Path $base 'host.token'`) is a file name, not a claim about the directory, so it is skipped.
  const tokenPaths = [...doc.matchAll(/[^\s'"`(]*host\.token/g)]
    .map((m) => m[0].replace(/[\\/]+/g, '/'))
    .filter((p) => p.includes('/'));
  const normalised = new Set(tokenPaths.map((p) => p.replace(/^.*?(\.dsh|dsh-direct)/, '$1')));
  if (normalised.size > 1) {
    problems.push('the document names more than one token file: ' + [...normalised].join(' vs '));
  }
  const wrong = [...normalised].filter((p) => !p.startsWith('.dsh/dsh-direct/host.token'));
  if (wrong.length) {
    problems.push('the token path is not <HOME>/.dsh/dsh-direct/host.token: ' + wrong.join(', ')
      + ' (the token is created in step 2 and read by the plugin and the MCP server; one path, three readers)');
  }

  if (!/endpointFile/.test(doc)) {
    problems.push('INSTALL-WINDOWS.md never mentions endpointFile, so it teaches a configuration the plugin now refuses '
      + '(a random port nobody can find)');
  }
  if (/port:\s*0\b/.test(doc)) {
    problems.push('INSTALL-WINDOWS.md still tells the reader to use port: 0');
  }
  // The hint table and the schema must agree, and the fields an operator cannot install without must actually be
  // documented. (The previous loop iterated `Object.keys` of a Map, which is always empty: it checked nothing.)
  for (const key of KEY_HINT.keys()) {
    if (!CONFIG_FIELDS.includes(key)) problems.push('KEY_HINT names an unknown field: ' + key);
  }
  for (const key of ['endpointFile', 'tokenFile', 'http']) {
    if (!doc.includes(key)) {
      problems.push('INSTALL-WINDOWS.md never mentions ' + key + ', so a field that changes behaviour is undocumented');
    }
  }

  if (problems.length) checks.push(result('docs.consistency', 'fail', problems.join('; '), { problems }));
  else {
    checks.push(result('docs.consistency', 'ok', 'the example only uses known fields and every host.token path in the '
      + 'document is the same file, with endpointFile documented'));
  }
  return checks;
}

/**
 * The patch files an install can land in, newest layout first. A Desktop install keeps its user layer per profile
 * (`<HOME>/.dsh/profiles/<name>/cordis.patch.yml`) and only the CLI-era layout used `<HOME>/.dsh/cordis.patch.yml`,
 * which does not exist on a Desktop machine at all -- reporting "the profile patch does not exist" there was wrong
 * about the machine, so both layouts are searched and each hit is named.
 */
export function findProfilePatches(home) {
  const dshRoot = path.join(home, '.dsh');
  const patches = [];
  const profilesDir = path.join(dshRoot, 'profiles');
  if (existsSync(profilesDir)) {
    let names = [];
    try {
      names = readdirSync(profilesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
        .map((entry) => entry.name)
        .sort();
    } catch { names = []; }
    for (const name of names) {
      const file = path.join(profilesDir, name, 'cordis.patch.yml');
      if (existsSync(file)) patches.push({ label: 'profile ' + name, file });
    }
  }
  const legacy = path.join(dshRoot, 'cordis.patch.yml');
  if (existsSync(legacy)) patches.push({ label: 'root', file: legacy });
  return patches;
}

/** Where the plugin would live, read-only: reporting only, nothing is created or changed. */
export function checkInstallState(home = process.env.USERPROFILE || process.env.HOME || '') {
  const checks = [];
  if (!home) return [result('install.state', 'not-checked', 'no HOME/USERPROFILE to look under')];
  const pluginDir = path.join(home, '.dsh', 'plugins', 'dsh-direct');
  const present = existsSync(pluginDir);
  const patches = findProfilePatches(home).map((patch) => ({
    label: patch.label,
    mentions: readFileSync(patch.file, 'utf8').includes('dsh-direct'),
  }));
  const naming = patches.filter((patch) => patch.mentions).map((patch) => patch.label);
  const where = patches.length === 0
    ? 'no patch layer exists under .dsh (neither a profile layer nor the legacy root layer)'
    : (naming.length === 0
      ? 'no patch layer mentions dsh-direct (' + patches.map((p) => p.label).join(', ') + ')'
      : 'mentioned in ' + naming.join(', ') + ' (text presence only; not an activation check)');
  // Informational either way: an absent install is the documented pre-install state, not a defect.
  checks.push(result('install.state', 'ok',
    'plugin directory ' + (present ? 'exists' : 'is absent') + '; ' + where
      + '. Nothing was written; installing is the operator step in ' + DOC + '.'));
  return checks;
}

export async function runPreflight({ configPath = null, packageDir = null, port = null, docsRoot = REPO_ROOT,
  home = null, dshInstall = null } = {}) {
  const checks = [];
  const pkg = packageDir || path.join(REPO_ROOT, 'tools', 'dsh-direct', 'plugin');
  checks.push(...checkPackage(pkg));

  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  } catch { /* already reported by checkPackage */ }
  const declared = manifest && manifest.peerDependencies ? manifest.peerDependencies.cordis : null;
  // No hardcoded install path: this repository must not carry one machine's layout. `--dsh-install` (or DSH_INSTALL)
  // names it, and without either the check says so instead of guessing.
  const install = dshInstall || process.env.DSH_INSTALL || null;
  const found = install ? cordisVersionAt(install) : null;
  if (!declared) {
    checks.push(result('cordis.compat', 'warn', 'the manifest declares no peerDependencies.cordis'));
  } else if (!install) {
    checks.push(result('cordis.compat', 'not-checked', 'no Desktop install directory given; pass --dsh-install <dir> or '
      + 'set DSH_INSTALL to check the declared range ' + declared + ' against the shipped @deepseek-ai/cordis'));
  } else if (!found) {
    checks.push(result('cordis.compat', 'not-checked', 'no @deepseek-ai/cordis found under ' + install
      + '; the declared range is ' + declared));
  } else {
    const verdict = satisfiesRange(found.version, declared);
    checks.push(result('cordis.compat', verdict.ok ? 'ok' : 'fail',
      '@deepseek-ai/cordis@' + found.version + (verdict.ok ? ' satisfies ' : ' does not satisfy ') + declared
      + (verdict.reason ? ' (' + verdict.reason + ')' : ''), { version: found.version, file: found.file }));
  }

  let config = null;
  if (configPath) {
    const configChecks = checkConfig(path.resolve(configPath));
    config = configChecks.config;
    checks.push(...configChecks.checks);
  } else {
    checks.push(result('config.schema', 'not-checked', 'no --config given; pass one to check the MCP side end to end'));
  }

  checks.push(...(await checkEndpoint(config, { port })));
  if (Number.isInteger(port)) checks.push(await checkPort(port));
  checks.push(...checkDocs(docsRoot));
  checks.push(...checkInstallState(home || undefined));
  return checks;
}

export function summarise(checks, { strict = false } = {}) {
  const counts = { ok: 0, warn: 0, fail: 0, 'not-checked': 0 };
  for (const check of checks) counts[check.status] = (counts[check.status] || 0) + 1;
  const failed = counts.fail > 0 || (strict && counts.warn > 0);
  return { counts, failed, exitCode: failed ? 1 : 0 };
}

function parseArgs(argv) {
  const options = { configPath: null, packageDir: null, port: null, json: false, strict: false, home: null,
    dshInstall: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--alone') continue;
    else if (arg === '--config') options.configPath = argv[++i];
    else if (arg === '--package') options.packageDir = argv[++i];
    else if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--home') options.home = argv[++i];
    else if (arg === '--dsh-install') options.dshInstall = argv[++i];
    else return { error: 'unknown argument: ' + arg };
  }
  if (options.port !== null && !Number.isInteger(options.port)) {
    return { error: '--port needs an integer' };
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.error) {
    process.stderr.write('preflight: ' + options.error + '\n');
    return 2;
  }
  const checks = await runPreflight(options);
  const summary = summarise(checks, { strict: options.strict });
  if (options.json) {
    process.stdout.write(JSON.stringify({ checks, summary }, null, 2) + '\n');
  } else {
    for (const check of checks) {
      process.stdout.write(check.status.padEnd(11) + ' ' + check.id.padEnd(20) + ' ' + check.detail + '\n');
    }
    process.stdout.write('\n' + summary.counts.ok + ' ok, ' + summary.counts.warn + ' warn, ' + summary.counts.fail
      + ' fail, ' + summary.counts['not-checked'] + ' not-checked -> '
      + (summary.failed ? 'NOT READY' : 'ready for the operator install step') + '\n');
  }
  return summary.exitCode;
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; });
}
