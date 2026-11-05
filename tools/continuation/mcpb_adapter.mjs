// T259: standalone, default-off outbound client; not wired to coordinator, extension, or service.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createChannel, endpointFrom, toolObject } from './mcpb_http.mjs';

export const LIMITS = Object.freeze({ maxTasks: 3, maxInFlight: 1, submitRetries: 0,
  readTimeoutMs: 10000, submitTimeoutMs: 15000 });
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const STATES = new Set([...TERMINAL, 'received', 'queued', 'waiting_approval',
  'awaiting_local_approval', 'running', 'starting', 'waiting_user_input']);
const TASK = /^tsk-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, maximum) => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const bodyText = (value, maximum) => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= maximum && !value.includes('\0');
const refused = (code) => ({ ok: false, code });
const fail = (code) => { throw new Error(code); };
const outside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative);
};

export function gitPreflightEnvironment(source) {
  const env = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  // Read named OS/runtime fields only: never enumerate/copy internal credential variables.
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'COMSPEC',
    'ComSpec', 'PATHEXT', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']) {
    if (typeof source[key] === 'string') env[key] = source[key];
  }
  return env;
}

function cleanWorkspace(root) {
  try {
    const options = { encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true,
      env: gitPreflightEnvironment(process.env) };
    const base = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root];
    const top = execFileSync('git', [...base, 'rev-parse', '--show-toplevel'], options).trim();
    if (realpathSync(top) !== root) return 'workspace_not_repository_root';
    const status = execFileSync('git', [...base, 'status', '--porcelain=v1', '--untracked-files=all'], options);
    return status.trim() ? 'dirty_workspace' : null;
  } catch { return 'workspace_unavailable'; }
}

function readJournal(file, binding, token) {
  if (!existsSync(file)) return { version: 1, binding, jobs: [] };
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) fail('journal_invalid');
  let journal;
  try { journal = JSON.parse(readFileSync(file, 'utf8')); } catch { fail('journal_invalid'); }
  if (journal?.version !== 1 || journal.binding !== binding || !Array.isArray(journal.jobs)
    || Object.keys(journal).some((key) => !['version', 'binding', 'jobs'].includes(key))
    || journal.jobs.length > LIMITS.maxTasks) fail('journal_invalid');
  const seen = new Set();
  for (const job of journal.jobs) {
    if (!job || Object.keys(job).length !== 5
      || Object.keys(job).some((key) => !['key', 'intent', 'phase', 'taskId', 'status'].includes(key))) fail('journal_invalid');
    if (!text(job.key, 512) || seen.has(job.key) || job.key.includes(token) || !HASH.test(job.intent)
      || !['unknown', 'submitted', 'terminal'].includes(job.phase)
      || !((job.taskId === null && job.status === null && job.phase === 'unknown')
        || (typeof job.taskId === 'string' && TASK.test(job.taskId) && !job.taskId.includes(token) && STATES.has(job.status)))
      || (job.phase !== 'unknown' && (!TASK.test(job.taskId) || !STATES.has(job.status)))
      || (job.phase === 'terminal' && !TERMINAL.has(job.status))
      || (job.phase === 'submitted' && TERMINAL.has(job.status))) fail('journal_invalid');
    seen.add(job.key);
  }
  if (journal.jobs.filter((job) => job.phase === 'submitted').length > 1) fail('journal_invalid');
  return journal;
}

function saveJournal(file, journal) {
  const tmp = file + '.tmp-' + randomBytes(8).toString('hex');
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(journal) + '\n', 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(tmp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tmp)) unlinkSync(tmp); // only this call's exclusive temporary file
  }
}

/** No factory side effects. grant is explicit application consent, not a Bridge permission override. */
export function createMcpbAdapter(options = {}) {
  const enabled = options.enabled === true;
  const grant = { ...(options.grant || {}) };
  const projectId = options.projectId, installationId = options.installationId, sessionId = options.sessionId;
  const rootPath = options.workspaceRoot, statePath = options.stateDir;
  const env = options.env || process.env;
  const clock = options.now || (() => Date.now());
  const readMs = options.readTimeoutMs ?? LIMITS.readTimeoutMs;
  const submitMs = options.submitTimeoutMs ?? LIMITS.submitTimeoutMs;
  let busy = false;
  const grantLive = () => {
    const at = clock();
    return Number.isFinite(at) && grant.approvedAt < at && grant.expiresAt > at;
  };

  function configuration() {
    if (!enabled) fail('disabled');
    const at = clock();
    if (!Number.isFinite(at) || grant.kind !== 'continuation' || !text(projectId, 128) || !text(installationId, 256)
      || !text(sessionId, 1024) || grant.projectId !== projectId || grant.installationId !== installationId
      || grant.sessionId !== sessionId || !Number.isFinite(grant.approvedAt) || grant.approvedAt >= at
      || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= at
      || !Number.isSafeInteger(grant.maxTasks) || grant.maxTasks < 1 || grant.maxTasks > LIMITS.maxTasks)
      fail('not_authorised');
    if (![readMs, submitMs].every(Number.isSafeInteger) || readMs < 1 || submitMs < 1
      || readMs > LIMITS.readTimeoutMs || submitMs > LIMITS.submitTimeoutMs) fail('configuration_invalid');
    // These are the ONLY credential inputs. No discovery, file fallback, tunnel lookup, or default URL.
    const endpoint = endpointFrom(env.CODEX_BRIDGE_MCP_URL);
    const token = env.CODEX_BRIDGE_MCP_TOKEN;
    if (typeof token !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(token)) fail('credentials_missing');
    if (!path.isAbsolute(rootPath || '') || !path.isAbsolute(statePath || '')) fail('configuration_invalid');
    const root = realpathSync(rootPath);
    if (grant.workspaceRoot !== rootPath) fail('not_authorised');
    if (!outside(root, path.resolve(statePath))) fail('journal_inside_workspace');
    if ([projectId, installationId, sessionId, rootPath, statePath].some((value) => value.includes(token)))
      fail('configuration_invalid');
    return { endpoint, token, root,
      binding: digest([endpoint, projectId, installationId, sessionId, root]) };
  }

  async function locked(callback, needsClean) {
    if (busy) return refused('busy');
    busy = true;
    let lock = null;
    try {
      const config = configuration();
      if (needsClean) { const problem = cleanWorkspace(config.root); if (problem) fail(problem); }
      // The caller supplies a private existing parent. No recursive directory creation or stale-lock removal.
      const fresh = !existsSync(statePath);
      if (fresh) mkdirSync(statePath, { mode: 0o700 });
      if (lstatSync(statePath).isSymbolicLink() || !lstatSync(statePath).isDirectory()
        || !outside(config.root, realpathSync(statePath))) fail('journal_inside_workspace');
      const lockPath = path.join(statePath, '.mcpb-lock');
      try { mkdirSync(lockPath, { mode: 0o700 }); lock = lockPath; } catch { fail('journal_busy'); }
      const file = path.join(statePath, 'mcpb-intents.json');
      if (!fresh && !existsSync(file)) fail('journal_invalid');
      const journal = readJournal(file, config.binding, config.token);
      if (fresh) saveJournal(file, journal);
      return await callback(config, file, journal);
    } catch (error) {
      const allowed = new Set(['disabled', 'not_authorised', 'configuration_invalid', 'credentials_missing',
        'workspace_not_repository_root', 'workspace_unavailable', 'dirty_workspace', 'journal_inside_workspace',
        'journal_invalid', 'journal_busy', 'capability_unverified', 'protocol_invalid', 'protocol_unsupported',
        'server_request_unsupported', 'rpc_error', 'response_limit', 'http_error', 'timeout', 'transport_error']);
      return refused(allowed.has(error?.message) ? error.message : 'operation_failed');
    } finally {
      if (lock) { try { rmdirSync(lock); } catch { /* never remove someone else's contents */ } }
      busy = false;
    }
  }

  async function channelFor(config, name) {
    const channel = createChannel(config.endpoint, config.token);
    await channel.initialize(readMs);
    const listing = await channel.listTools(readMs);
    if (!Array.isArray(listing?.tools) || listing.tools.length > 128 || listing.nextCursor)
      fail('capability_unverified');
    const matches = listing.tools.filter((tool) => tool.name === name);
    if (matches.length !== 1) fail('capability_unverified');
    const schema = matches[0].inputSchema;
    const needed = name === 'submit_task'
      ? ['prompt', 'project_id', 'provider_id', 'installation_id', 'thread_id', 'client_request_id', 'acceptance_criteria'] : ['task_id'];
    const supported = needed;
    if (schema?.type !== 'object' || !needed.every((key) => Object.hasOwn(schema.properties || {}, key))
      || !Array.isArray(schema.required) || !schema.required.every((key) => supported.includes(key)))
      fail('capability_unverified');
    return channel;
  }

  const ack = (job) => ({ ok: true, code: null, taskId: job.taskId, status: job.status });
  return Object.freeze({
    status: () => ({ enabled, busy, limits: LIMITS, productionVerified: false }),
    async submitTask({ clientRequestId, prompt, acceptanceCriteria = [] } = {}) {
      acceptanceCriteria = Array.isArray(acceptanceCriteria) ? [...acceptanceCriteria] : acceptanceCriteria;
      return locked(async (config, file, journal) => {
        if (!text(clientRequestId, 512) || !bodyText(prompt, 32 * 1024) || !Array.isArray(acceptanceCriteria)
          || acceptanceCriteria.length > 32 || !acceptanceCriteria.every((value) => bodyText(value, 4096))
          || [clientRequestId, prompt, ...acceptanceCriteria].some((value) => value.includes(config.token)))
          return refused('input_invalid');
        const intent = digest([config.binding, prompt, acceptanceCriteria]);
        const prior = journal.jobs.find((job) => job.key === clientRequestId);
        if (prior) {
          if (prior.intent !== intent) return refused('idempotency_conflict');
          return prior.phase === 'unknown' ? refused('unknown_outcome') : ack(prior);
        }
        if (journal.jobs.some((job) => job.phase === 'unknown')) return refused('unknown_outcome');
        if (journal.jobs.some((job) => job.phase === 'submitted')) return refused('active_task');
        if (journal.jobs.length >= grant.maxTasks) return refused('task_limit');
        const channel = await channelFor(config, 'submit_task');
        if (!grantLive()) return refused('not_authorised');
        const dirty = cleanWorkspace(config.root);
        if (dirty) return refused(dirty);
        if (!grantLive()) return refused('not_authorised');
        const job = { key: clientRequestId, intent, phase: 'unknown', taskId: null, status: null };
        journal.jobs.push(job);
        saveJournal(file, journal); // write-ahead, BEFORE the only submit attempt
        try {
          if (!grantLive()) return refused('not_authorised');
          const result = toolObject(await channel.call('submit_task', { project_id: projectId,
            provider_id: 'deepseek-harness-desktop', installation_id: installationId, thread_id: sessionId,
            client_request_id: clientRequestId, prompt, acceptance_criteria: acceptanceCriteria }, submitMs));
          if (result.receipt_type !== 'provider_task' || !TASK.test(result.task_id)
            || !STATES.has(result.status) || result.task_id.includes(config.token)
            || result.reused_existing_task !== false || typeof result.local_approval_required !== 'boolean'
            || !result.wait_policy || typeof result.wait_policy !== 'object' || Array.isArray(result.wait_policy)
            || journal.jobs.some((item) => item !== job && item.taskId === result.task_id)) fail('receipt_invalid');
          job.taskId = result.task_id; job.status = result.status;
          job.phase = TERMINAL.has(result.status) ? 'terminal' : 'submitted';
          saveJournal(file, journal);
          return ack(job);
        } catch { return refused('unknown_outcome'); }
      }, true);
    },
    async getTask(taskId) {
      return locked(async (config, file, journal) => {
        if (journal.jobs.some((job) => job.phase === 'unknown')) return refused('unknown_outcome');
        const job = journal.jobs.find((item) => item.taskId === taskId);
        if (!job || !TASK.test(taskId)) return refused('task_not_owned');
        if (job.phase === 'terminal') return ack(job);
        try {
          const channel = await channelFor(config, 'get_task');
          const result = toolObject(await channel.call('get_task', { task_id: taskId }, readMs));
          const task = result.task;
          if (task?.task_id !== taskId || task.project_id !== projectId
            || task.provider_id !== 'deepseek-harness-desktop' || task.provider_session_id !== sessionId
            || task.installation_id !== installationId || !STATES.has(task.status)) fail('binding_unverified');
          job.status = task.status;
          if (TERMINAL.has(task.status)) job.phase = 'terminal';
          saveJournal(file, journal);
          return ack(job);
        } catch {
          job.phase = 'unknown'; saveJournal(file, journal);
          return refused('unknown_outcome');
        }
      }, false);
    },
  });
}
