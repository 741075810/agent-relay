// Explicit finite owner: supported DirectServer reads, one continuation, no Host/plugin changes.
import { readFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { DirectServer, loadConfig } from './mcp_server.mjs';
import { HostClient } from './host_client.mjs';
import { isTaskId, isSessionId } from './protocol.mjs';
import { createContinueOnce, continuationRequestId } from './continue_once.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
export function createCompletionOwner({ enabled = false, client, deadlineMs = 120000,
  intervalMs = 1000 } = {}) {
  let used = false;
  return { async run(plan) {
    if (enabled !== true) return { code: 'disabled', submitted: false };
    if (used) return { code: 'owner_used', submitted: false };
    used = true;
    const end = performance.now() + deadlineMs;
    let submitted = false, receipt = null;
    const remaining = () => Math.floor(end - performance.now());
    async function read(fn) {
      if (remaining() <= 0) throw new Error('deadline');
      let timer;
      try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), remaining());
      })]); } finally { clearTimeout(timer); }
    }
    async function pause() {
      if (remaining() <= 0) throw new Error('deadline');
      await delay(Math.min(intervalMs, remaining()));
    }
    try {
      plan = structuredClone(plan);
      if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300000
        || !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 10000
        || !isTaskId(plan?.sourceTaskId) || !isSessionId(plan?.sessionId)
        || typeof plan.projectId !== 'string' || !plan.projectId
        || typeof plan.nextPrompt !== 'string' || !plan.nextPrompt.trim() || plan.nextPrompt.length > 32000
        || !/^[a-f0-9]{64}$/.test(plan.sourceResultSha256)
        || !/^[a-f0-9]{64}$/.test(plan.successorResultSha256)) return { code: 'invalid_plan', submitted };
      const source = (await read(() => client.getTask({ taskId: plan.sourceTaskId })))?.task;
      if (source?.sessionId !== plan.sessionId || source?.projectId !== plan.projectId
        || source.taskId !== plan.sourceTaskId || !['running', 'succeeded'].includes(source.state)
        || source.requiresReconcile || source.unknownReason != null) return { code: 'source_unverified', submitted };
      async function completed(taskId, requestId) {
        for (;;) {
          let reply;
          try { reply = await read(() => client.getResult({ taskId })); }
          catch (e) { if (e.code === 'task_not_finished') { await pause(); continue; } throw e; }
          const t = reply?.task;
          if (reply?.ok !== true || t?.taskId !== taskId || t.requestId !== requestId
            || t.sessionId !== plan.sessionId || t.projectId !== plan.projectId
            || t.state !== 'succeeded' || t.requiresReconcile !== false || t.unknownReason != null
            || t.error != null || !t.turnId || t.result?.admission?.found !== true
            || typeof t.result?.text !== 'string') throw new Error('result_unverified');
          return t;
        }
      }
      const done = await completed(source.taskId, source.requestId);
      if (source.turnId != null && source.turnId !== done.turnId) return { code: 'source_unverified', submitted };
      if (sha(done.result.text) !== plan.sourceResultSha256) return { code: 'acceptance_failed', submitted };
      for (;;) {
        const listed = await read(() => client.listSessions({ projectId: plan.projectId }));
        const rows = listed?.sessions?.filter(s => s.sessionId === plan.sessionId);
        if (listed?.ok !== true || rows?.length !== 1 || rows[0].cwd !== plan.projectId
          || rows[0].agentAvailable !== true || typeof rows[0].running !== 'boolean') {
          return { code: 'idle_unverified', submitted };
        }
        if (!rows[0].running) break;
        await pause();
      }
      if (remaining() <= 0) throw new Error('deadline');
      const trigger = Object.fromEntries(['taskId', 'requestId', 'sessionId', 'projectId', 'turnId'].map(k => [k, done[k]]));
      receipt = await createContinueOnce({ enabled: true, client, budgetMs: Math.min(remaining(), 120000),
        verifyResult: t => sha(t.result.text) === plan.sourceResultSha256 }).run({ trigger,
        next: { sessionId: plan.sessionId, projectId: plan.projectId, prompt: plan.nextPrompt,
          requestId: continuationRequestId(trigger) } });
      submitted = receipt.submitted;
      if (receipt.code !== 'handoff_recorded') return receipt;
      const successor = await completed(receipt.taskId, receipt.requestId);
      if (sha(successor.result.text) !== plan.successorResultSha256) {
        return { ...receipt, code: 'successor_acceptance_failed', completionVerified: false };
      }
      return { ...receipt, code: 'successor_verified', completionVerified: true, turnId: successor.turnId };
    } catch {
      return { code: submitted ? 'successor_unverified' : 'observation_stopped', submitted,
        taskId: receipt?.taskId ?? null, requestId: receipt?.requestId ?? null };
    }
  } };
}

export async function main(args = process.argv.slice(2)) {
  // Default-off BEFORE touching config, plan, credentials or ledger.
  if (!args.includes('--enable')) { console.log(JSON.stringify({ code: 'disabled', submitted: false })); return; }
  const value = flag => args[args.indexOf(flag) + 1];
  let lock = null, acquired = false;
  try {
    if (!args.includes('--config') || !args.includes('--plan')) throw new Error('arguments');
    const config = loadConfig(resolve(value('--config')));
    const plan = JSON.parse(readFileSync(resolve(value('--plan')), 'utf8'));
    // Mandatory existing ledger owner reservation. Never auto-clear after an interrupted process.
    lock = join(config.stateDir, '.completion-owner');
    mkdirSync(lock); acquired = true;
    const client = new HostClient({ baseUrl: config.hostUrl || null, endpointFile: config.endpointFile || null,
      tokenFile: config.tokenFile, expectKind: config.expectKind, expectProtocol: config.expectProtocol, timeoutMs: 3000 });
    const direct = new DirectServer(config, { client });
    const out = await createCompletionOwner({ enabled: true, client: direct,
      deadlineMs: 120000, intervalMs: 1000 }).run(plan);
    console.log(JSON.stringify(out));
    // Keep the reservation after ambiguous admission; no automatic recovery/reconciliation.
    if (out.code !== 'successor_verified') process.exitCode = 2;
    else { rmdirSync(lock); acquired = false; process.exitCode = 0; }
  } catch {
    console.log(JSON.stringify({ code: acquired ? 'owner_stopped_preserve_lock' : 'owner_start_refused' }));
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
