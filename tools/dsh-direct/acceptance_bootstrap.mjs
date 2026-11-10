// Explicit two-task canary. No automatic launch, Bridge identity mapping or installed Host changes.
import { mkdirSync, rmdirSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DirectServer, loadConfig } from './mcp_server.mjs';
import { HostClient } from './host_client.mjs';
import { isSessionId, isTaskId } from './protocol.mjs';
import { createCompletionOwner } from './completion_owner.mjs';

export const SEED_TEXT = 'DIRECT-SEED-OK';
export const NEXT_TEXT = 'DIRECT-NEXT-OK';
export const canaryPrompt = text => `Reply exactly ${text}, with no extra text or whitespace. Do not call tools, modify files, create goals or start another task.`;
const sha = text => createHash('sha256').update(text).digest('hex');
export const seedRequestId = sessionId => 'seed-t324-' + sha(sessionId);
const evidence = t => ({ taskId: t.taskId, requestId: t.requestId, sessionId: t.sessionId,
  projectId: t.projectId, turnId: t.turnId, state: t.state, admission: t.result?.admission ?? null,
  result: [SEED_TEXT, NEXT_TEXT].includes(t.result?.text) ? t.result.text : null });

export function createAcceptanceBootstrap({ enabled = false, client, record, budgetMs = 120000,
  intervalMs = 1000 } = {}) {
  let used = false;
  return { async run({ sessionId, projectId } = {}) {
    if (enabled !== true) return { code: 'disabled', submitted: false };
    if (used) return { code: 'bootstrap_used', submitted: false };
    used = true;
    const end = performance.now() + budgetMs;
    let attempted = false;
    let seed = null;
    async function bounded(fn) {
      const ms = Math.floor(end - performance.now());
      if (ms <= 0) throw new Error('deadline');
      let timer;
      try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), ms);
      })]); } finally { clearTimeout(timer); }
    }
    try {
      if (!isSessionId(sessionId) || typeof projectId !== 'string' || !projectId
        || !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 120000
        || !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 10000
        || typeof record !== 'function') return { code: 'invalid_input', submitted: false };
      const list = await bounded(() => client.listSessions({ projectId }));
      const rows = list?.sessions?.filter(s => s.sessionId === sessionId);
      if (list?.ok !== true || rows?.length !== 1 || rows[0].cwd !== projectId
        || rows[0].running !== false || rows[0].agentAvailable !== true) {
        return { code: 'idle_unverified', submitted: false };
      }
      const requestId = seedRequestId(sessionId);
      await bounded(() => record({ stage: 'seed_reserved', sessionId, projectId, requestId }));
      const receipt = await bounded(() => {
        attempted = true;
        return client.submitTask({ sessionId, projectId, requestId, prompt: canaryPrompt(SEED_TEXT) });
      });
      seed = receipt?.task;
      if (receipt?.ok !== true || !isTaskId(seed?.taskId) || seed.requestId !== requestId
        || seed.sessionId !== sessionId || seed.projectId !== projectId || seed.requiresReconcile !== false
        || seed.unknownReason != null || !['running', 'succeeded'].includes(seed.state)
        || seed.promptSha256 !== sha(canaryPrompt(SEED_TEXT))) throw new Error('seed_unknown');
      await bounded(() => record({ stage: 'seed_receipt', ...evidence(seed) }));
      // Delegate the actual after-completion wait and successor submission to the existing T323 owner.
      const observed = {
        getTask: a => client.getTask(a), listSessions: a => client.listSessions(a),
        submitTask: a => client.submitTask(a),
        getResult: async a => {
          const out = await client.getResult(a);
          if (out?.task?.state === 'succeeded') await record({ stage: 'task_result', ...evidence(out.task) });
          return out;
        },
      };
      const remaining = Math.floor(end - performance.now());
      if (remaining <= 0) throw new Error('deadline');
      const out = await createCompletionOwner({ enabled: true, client: observed,
        deadlineMs: remaining, intervalMs }).run({ sourceTaskId: seed.taskId, sessionId, projectId,
        nextPrompt: canaryPrompt(NEXT_TEXT), sourceResultSha256: sha(SEED_TEXT), successorResultSha256: sha(NEXT_TEXT) });
      await bounded(() => record({ stage: 'owner_outcome', ...out }));
      return { code: out.code === 'successor_verified' ? 'canary_verified' : 'canary_incomplete',
        submitted: true, seedTaskId: seed.taskId, seedRequestId: requestId, successor: out };
    } catch {
      return { code: attempted ? 'canary_unknown' : 'preflight_stopped', submitted: attempted ? 'unknown' : false,
        seedTaskId: seed?.taskId ?? null };
    }
  } };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.includes('--enable')) { console.log(JSON.stringify({ code: 'disabled', submitted: false })); return; }
  const value = flag => args[args.indexOf(flag) + 1];
  let fd = null, locked = false;
  try {
    if (!['--config', '--session', '--project'].every(f => args.includes(f))) throw new Error('arguments');
    const sessionId = value('--session'), projectId = value('--project');
    if (!isSessionId(sessionId)) throw new Error('session');
    const config = loadConfig(resolve(value('--config')));
    if (!config.boundSessionIds.includes(sessionId)) throw new Error('not_bound');
    const lock = join(config.stateDir, '.completion-owner');
    // Never reclaim a T323 reservation; acquire before loading the existing Direct ledger.
    mkdirSync(lock); locked = true;
    const journal = join(config.stateDir, 'canary-t324-' + sha(sessionId) + '.jsonl');
    fd = openSync(journal, 'wx', 0o600); // one bootstrap per session; never overwrite old evidence
    const record = row => { writeSync(fd, JSON.stringify(row) + '\n'); fsyncSync(fd); };
    record({ stage: 'operator_start', sessionId, projectId });
    const host = new HostClient({ baseUrl: config.hostUrl || null, endpointFile: config.endpointFile || null,
      tokenFile: config.tokenFile, expectKind: config.expectKind, expectProtocol: config.expectProtocol, timeoutMs: 3000 });
    const client = new DirectServer(config, { client: host });
    const out = await createAcceptanceBootstrap({ enabled: true, client, record }).run({ sessionId, projectId });
    record({ stage: 'bootstrap_outcome', ...out });
    console.log(JSON.stringify({ ...out, journal }));
    if (out.code === 'canary_verified') {
      closeSync(fd); fd = null; rmdirSync(lock); locked = false;
    } else { process.exitCode = 2; }
    // Failure keeps both reservation and journal; any pending callback must not write to a reused fd.
  } catch {
    console.log(JSON.stringify({ code: locked ? 'bootstrap_stopped_preserve_evidence' : 'bootstrap_start_refused' }));
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
