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

const DEFAULT_PORT = 0;

function note(ctx, level, message) {
  const logger = ctx && ctx.logger;
  if (logger && typeof logger[level] === 'function') logger[level](message);
  else if (level === 'error') console.error('[dsh-direct] ' + message);
  else console.log('[dsh-direct] ' + message);
}

/**
 * `apply` is the Cordis entry point. Returns a disposer; the same work is also attached to `dispose` so a host that
 * ignores the return value still tears the server down.
 */
export function apply(ctx, config) {
  const settings = config || {};
  const boundSessionIds = Array.isArray(settings.boundSessionIds) ? settings.boundSessionIds.slice() : [];
  const tokenFile = typeof settings.tokenFile === 'string' ? settings.tokenFile : null;
  const declaredPort = Number.isInteger(settings.port) ? settings.port : DEFAULT_PORT;

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
  const ready = startHostBridge({ adapter: guarded, token, port: declaredPort }).then((started) => {
    bridge = started;
    note(ctx, 'info', 'serving ' + started.base + ' for ' + boundSessionIds.length + ' bound session(s), protocol '
      + String(started.protocol));
    return started;
  }).catch((err) => {
    note(ctx, 'error', 'bridge failed to start: ' + String(err && err.message));
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
  // Exposed for a host that wants to report status; not read by anything in this package.
  if (ctx) ctx.dshDirect = { ready, dispose, boundSessionIds: boundSessionIds.slice(), tokenFile };

  return dispose;
}

/** Reported by the install check: does this Host expose what the plugin needs, and what would it bind? */
export function inspectHost(ctx, config) {
  const settings = config || {};
  return {
    name,
    capabilities: describeCapabilities(ctx ? ctx.sessionController : undefined),
    tokenFile: typeof settings.tokenFile === 'string' ? settings.tokenFile : null,
    boundSessionIds: Array.isArray(settings.boundSessionIds) ? settings.boundSessionIds.slice() : [],
  };
}
