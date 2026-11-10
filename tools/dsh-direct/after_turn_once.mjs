// Scheduled-task payload: read exact native request/turn completion, never map it to a Direct task.
import { readFileSync, existsSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './mcp_server.mjs';
import { HostClient } from './host_client.mjs';
import { main as bootstrap } from './acceptance_bootstrap.mjs';

export function ledgerPreflight(config, sessionId) {
  if (!config.boundSessionIds.includes(sessionId)) return 'session_not_bound';
  const dir = config.stateDir;
  if (existsSync(join(dir, '.completion-owner'))) return 'preserved_owner';
  const hash = createHash('sha256').update(sessionId).digest('hex');
  if (existsSync(join(dir, 'canary-t324-' + hash + '.jsonl'))) return 'preserved_canary';
  const doc = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8'));
  if (doc.version !== 1 || !Array.isArray(doc.tasks)) return 'ledger_unverified';
  // Conservatively refuse any nonterminal entry; no automatic getResult/reconcile or ledger editing.
  if (doc.tasks.some(t => !['succeeded', 'failed'].includes(t.state) || t.requiresReconcile === true)) {
    return 'ledger_unresolved';
  }
  return null;
}
export function exactFinished(page, turnId) {
  return page?.done === true && page.admission?.found === true && page.turnId === turnId
    && page.terminal?.kind === 'completed';
}
export async function main(args = process.argv.slice(2)) {
  if (!args.includes('--enable')) { console.log('{"code":"disabled"}'); return; }
  const planPath = args[args.indexOf('--plan') + 1];
  let audit, fd;
  try {
    const plan = JSON.parse(readFileSync(resolve(planPath), 'utf8'));
    audit = plan.auditFile;
    if (!plan.requestId || !plan.turnId || !plan.sessionId || !plan.projectId
      || !Number.isFinite(plan.expiresAt) || Date.now() >= plan.expiresAt) throw new Error('plan_invalid_or_expired');
    const config = loadConfig(plan.configPath);
    let code = ledgerPreflight(config, plan.sessionId);
    if (code) throw new Error(code);
    if (args.includes('--check-only')) { console.log('{"code":"preflight_pass"}'); return; }
    // Permanently single-use even if scheduler restarts this plan; preserve on every outcome.
    fd = openSync(resolve(planPath) + '.attempt', 'wx'); closeSync(fd); fd = null;
    const host = new HostClient({ baseUrl: config.hostUrl || null, endpointFile: config.endpointFile || null,
      tokenFile: config.tokenFile, timeoutMs: 3000 });
    const end = Math.min(Date.now() + 120000, plan.expiresAt);
    let ready = false;
    while (Date.now() < end) {
      const page = await host.getEvents({ sessionId: plan.sessionId, requestId: plan.requestId });
      if (page.terminal && page.terminal.kind !== 'completed') throw new Error('source_not_completed');
      if (exactFinished(page, plan.turnId)) {
        const rows = (await host.listSessions()).filter(s => s.sessionId === plan.sessionId);
        if (rows.length !== 1 || rows[0].cwd !== plan.projectId || rows[0].agentAvailable !== true
          || typeof rows[0].running !== 'boolean') throw new Error('idle_unverified');
        if (rows[0].running === false) { ready = true; break; }
      }
      await delay(1000);
    }
    if (!ready || Date.now() >= end) throw new Error('after_turn_deadline');
    code = ledgerPreflight(config, plan.sessionId);
    if (code) throw new Error(code);
    writeFileSync(audit, JSON.stringify({ code: 'bootstrap_start', sessionId: plan.sessionId,
      requestId: plan.requestId, turnId: plan.turnId }) + '\n', { flag: 'wx' });
    await bootstrap(['--enable', '--config', plan.configPath, '--session', plan.sessionId, '--project', plan.projectId]);
    // Bootstrap stdout/journal supplies exact receipts; no receipt is inferred from process start.
  } catch (e) {
    const allowed = ['session_not_bound','preserved_owner','preserved_canary','ledger_unresolved','ledger_unverified',
      'idle_unverified','source_not_completed','after_turn_deadline','plan_invalid_or_expired'];
    const result = { code: allowed.includes(e.message) ? e.message : 'owner_refused' };
    console.log(JSON.stringify(result)); process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
