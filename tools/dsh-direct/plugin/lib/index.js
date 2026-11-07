// dsh-direct Host half: a Cordis plugin that puts the loopback session bridge inside the *existing* Desktop Host.
//
// Shape follows the installed plugins in `~/.dsh/plugins` (e.g. dsh-session-cleaner): `export const name`,
// `export const inject = [<services>]`, `export function apply(ctx, config)`, and teardown registered on the Cordis
// lifecycle so reloading or unloading the plugin closes the socket instead of leaving it behind.
//
// What it will NOT do, on purpose:
//   * it never creates a session -- `sessionController.create` is not called anywhere in this package;
//   * it never prompts a session outside `config.boundSessionIds`;
//   * it does not start at all when `ctx.sessionController` lacks the 0.2.0-rc.2 methods, or when no token file is
//     configured: a half-running bridge is worse than an absent one, because the MCP side would read "no answer" as
//     "the prompt may have been accepted";
//   * it opens no public port, reads no browser token, and touches no Electron file.
//
// The rc.2 protocol details live in ./session-api.mjs and ./adapters.mjs, which are synced byte-for-byte from
// `tools/dsh-direct/` (a test fails the build if they drift).

import { createSessionControllerAdapter, describeCapabilities } from './adapters.mjs';
import { readToken, startHostBridge } from './host_bridge.mjs';

export const name = 'dsh-direct';

// Only the Host service we actually read. `webServer` is not injected: this plugin brings its own loopback listener.
export const inject = ['sessionController'];

const MIN_PORT = 1024;
const MAX_PORT = 65535;

function note(ctx, level, message) {
  const logger = ctx && ctx.logger;
  if (logger && typeof logger[level] === 'function') logger[level](message);
  else if (level === 'error') console.error('[dsh-direct] ' + message);
  else console.log('[dsh-direct] ' + message);
}

/**
 * The listener has to be findable, so one of two things must be configured:
 *   * `port`    -- a fixed loopback port the MCP side can name in `hostUrl`; or
 *   * `endpointFile` -- a descriptor this plugin writes after binding, which the MCP side reads at call time.
 * Neither is a valid configuration, and so is `port: 0` without a descriptor: T272 shipped exactly that, and after a
 * Desktop restart the frozen URL pointed at a dead port while the plugin happily served a new one.
 */
export function describeListener(settings = {}) {
  const hasPort = settings.port !== undefined && settings.port !== null;
  const endpointFile = typeof settings.endpointFile === 'string' && settings.endpointFile ? settings.endpointFile : null;
  if (!hasPort && !endpointFile) {
    return { ok: false, reason: 'config.port or config.endpointFile is required; without one the MCP side cannot find '
      + 'the bridge after a restart' };
  }
  let port = 0;
  if (hasPort) {
    if (settings.port === 0) {
      return { ok: false, reason: 'config.port 0 picks a random port every start; set a fixed port or an endpointFile '
        + 'so the MCP side can find the bridge after a restart' };
    }
    if (!Number.isInteger(settings.port) || settings.port < MIN_PORT || settings.port > MAX_PORT) {
      return { ok: false, reason: 'config.port must be an integer in ' + MIN_PORT + '..' + MAX_PORT
        + ' (a privileged or ephemeral port cannot be named in config.hostUrl)' };
    }
    port = settings.port;
  }
  return { ok: true, port, endpointFile };
}

/**
 * `apply` is the Cordis entry point. Returns a disposer; the same work is also attached to `dispose` so a host that
 * ignores the return value still tears the server down.
 */
export function apply(ctx, config) {
  const settings = config || {};
  const boundSessionIds = Array.isArray(settings.boundSessionIds) ? settings.boundSessionIds.slice() : [];
  const tokenFile = typeof settings.tokenFile === 'string' ? settings.tokenFile : null;
  const listener = describeListener(settings);

  // Fail closed, in the order that produces the most useful message.
  const caps = describeCapabilities(ctx ? ctx.sessionController : undefined);
  if (caps.missing.length) {
    note(ctx, 'error', 'refusing to start: the Host does not offer the 0.2.0-rc.2 session methods; missing '
      + caps.missing.join(', ') + (caps.legacyGuessPresent.length
        ? ' (this build exposes T271-guessed names: ' + caps.legacyGuessPresent.join(', ') + ')' : ''));
    return null;
  }
  if (!tokenFile) {
    note(ctx, 'error', 'refusing to start: config.tokenFile is required (a 32+ character bearer token in a file only '
      + 'this account can read)');
    return null;
  }
  if (!boundSessionIds.length) {
    note(ctx, 'error', 'refusing to start: config.boundSessionIds is empty, so no session could ever be prompted');
    return null;
  }
  if (!listener.ok) {
    note(ctx, 'error', 'refusing to start: ' + listener.reason);
    return null;
  }
  let token = null;
  try {
    token = readToken(tokenFile);
  } catch (err) {
    note(ctx, 'error', 'refusing to start: ' + String(err && err.message));
    return null;
  }

  const adapter = createSessionControllerAdapter(ctx.sessionController, { kind: 'cordis_session_controller' });
  // Defence in depth: the MCP side checks its own allowlist, and the plugin checks the same list again at the point
  // where a prompt would actually reach the Host. A caller that bypasses the MCP server still cannot reach another
  // session through this bridge.
  const guarded = {
    kind: adapter.kind,
    protocol: adapter.protocol,
    capabilities: adapter.capabilities,
    async listSessions() {
      const rows = await adapter.listSessions();
      return rows.filter((row) => boundSessionIds.includes(row.sessionId));
    },
    async prompt(request) {
      if (!boundSessionIds.includes(request.sessionId)) {
        return { accepted: false, turnId: null, reason: 'session_not_bound' };
      }
      return adapter.prompt(request);
    },
    async getEvents(request) {
      if (!boundSessionIds.includes(request.sessionId)) {
        return { events: [], records: [], hasMore: false, assistantText: null };
      }
      return adapter.getEvents(request);
    },
    async findAdmission(request) {
      if (!boundSessionIds.includes(request.sessionId)) return { found: false, seq: null, eventType: null };
      return adapter.findAdmission(request);
    },
  };

  let bridge = null;
  let closed = false;
  const ready = startHostBridge({ adapter: guarded, token, port: listener.port,
    endpointFile: listener.endpointFile }).then((started) => {
    bridge = started;
    note(ctx, 'info', 'serving ' + started.base + ' for ' + boundSessionIds.length + ' bound session(s), protocol '
      + String(started.protocol) + (started.endpointFile ? ', endpoint ' + started.endpointFile : ''));
    return started;
  }).catch((err) => {
    // `bind_failed` is the one to look for when a fixed port is already taken: this is a rejection, not a crashed Host.
    note(ctx, 'error', 'bridge failed to start: ' + String(err && err.code ? err.code + ': ' : '')
      + String(err && err.message));
    return null;
  });

  const dispose = async () => {
    if (closed) return;
    closed = true;
    const started = await ready;
    if (started) {
      await started.close();
      note(ctx, 'info', 'bridge on ' + started.base + ' closed');
    }
  };
  // Returning the promise matters: a host that awaits its dispose handlers must see the socket actually closed, not
  // merely asked to close. A host that ignores the return value still gets the teardown, just not synchronised.
  if (ctx && typeof ctx.on === 'function') ctx.on('dispose', () => dispose());
  // Nothing is published onto `ctx`. Cordis 4 rejects an assignment to a property it was not told about ("cannot set
  // property \"dshDirect\" without provide"), and that rejection happens inside `apply`, so the whole row fails to
  // activate in a live Host -- which is exactly what happened the first time this plugin was loaded by a real Desktop.
  // The disposer therefore doubles as the status handle: Cordis calls the returned function on unload and ignores extra
  // properties, while a test can await `ready` without the plugin writing anything onto the host context.
  dispose.ready = ready;
  dispose.boundSessionIds = boundSessionIds.slice();
  dispose.tokenFile = tokenFile;
  dispose.endpointFile = listener.endpointFile;
  dispose.port = listener.port;

  return dispose;
}

/** Reported by the install check: does this Host expose what the plugin needs, and what would it bind? */
export function inspectHost(ctx, config) {
  const settings = config || {};
  const listener = describeListener(settings);
  return {
    name,
    capabilities: describeCapabilities(ctx ? ctx.sessionController : undefined),
    tokenFile: typeof settings.tokenFile === 'string' ? settings.tokenFile : null,
    boundSessionIds: Array.isArray(settings.boundSessionIds) ? settings.boundSessionIds.slice() : [],
    listener: listener.ok ? { port: listener.port, endpointFile: listener.endpointFile, discoverable: true }
      : { port: null, endpointFile: null, discoverable: false, reason: listener.reason },
  };
}
