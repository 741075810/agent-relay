// Prepared productive engine. The shipped CLI is gated: no deployed cross-writer coordinator exists.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MANIFEST, manifestSha256, sha256, repositoryBaseline, verifyArtifact, verifyWithNamedTest, jobPrompt } from './productive_manifest.mjs';
import { openCampaign } from './productive_state.mjs';
import { exactFinished } from './after_turn_once.mjs';

export function admissionGate() {
  // There is intentionally no config boolean / process-list / directory-lock override.
  // DirectServer and HostClient currently have no enforced exclusive writer admission protocol.
  return { ok: false, code: 'writer_fencing_unavailable', submitted: false,
    missing: ['all-ledger-writers-coordinated', 'atomic-session-admission-lease'] };
}
export function requestIdFor(sessionId, campaignId, index) {
  return 'productive-' + sha256(JSON.stringify([manifestSha256, sessionId, campaignId, index]));
}
export function assertSettledLedger(stateDir) {
  if (existsSync(join(stateDir, '.completion-owner'))) throw Error('preserved_owner');
  const doc = JSON.parse(readFileSync(join(stateDir, 'tasks.json'), 'utf8'));
  if (doc.version !== 1 || !Array.isArray(doc.tasks) || !doc.requestIds) throw Error('ledger_invalid');
  if (doc.tasks.some(t => !['succeeded', 'failed'].includes(t.state) || t.requiresReconcile || t.unknownReason != null)) throw Error('ledger_unsettled');
  // A completed T324 journal is retained, not consumed or used as a productive owner lock.
  return doc.tasks;
}

/**
 * FUTURE trusted embedding contract, not an installed Host API:
 * caller acquires a deployment-wide fence BEFORE constructing DirectServer/TaskStore.
 * lease.assertHeld(scope) must synchronously reject lost ownership and the deployment
 * must enforce that fence at EVERY ledger write and Host prompt admission (legacy paths included).
 * caller keeps the reservation when preserveOwnership=true; this engine never steals/releases it.
 * No adapter satisfying that contract ships here. The CLI below never calls this function.
 */
export async function runPreparedOwner({ enabled = false, plan, lease, host, client } = {}) {
  if (!enabled) return { code: 'disabled', submitted: false };
  if (!lease || typeof lease.assertHeld !== 'function') return admissionGate();
  let journal, pending = false, submitted = 0, activeJob = null, lastControl = null;
  const end = performance.now() + MANIFEST.activationMs;
  const scope = { sessionId: plan?.sessionId, stateDir: plan?.stateDir };
  const remaining = deadline => Math.floor(Math.min(end, deadline) - performance.now());
  function held() { if (lease.assertHeld(scope) !== true) throw Error('writer_lease_lost'); }
  async function bounded(fn, deadline = end) {
    held(); const ms = remaining(deadline); if (ms <= 0) throw Error('deadline');
    let timer;
    try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('deadline')), ms);
    })]); } finally { clearTimeout(timer); }
  }
  function control() {
    const c = journal.control();
    if (lastControl && (c.revision < lastControl.revision || (c.revision === lastControl.revision && c.mode !== lastControl.mode))) throw Error('control_revision_invalid');
    if (!lastControl || c.revision !== lastControl.revision) journal.record({ stage: 'control_observed', revision: c.revision, mode: c.mode });
    lastControl = c;
    if (c.mode === 'stop') throw Error('operator_stop');
    return c.mode;
  }
  async function ready(deadline, honorPause = true) {
    for (;;) {
      held(); const mode = control();
      const list = await bounded(() => client.listSessions({ projectId: plan.projectId }), deadline);
      const rows = list?.sessions?.filter(s => s.sessionId === plan.sessionId);
      if (!list?.ok || rows?.length !== 1 || rows[0].cwd !== plan.projectId
        || rows[0].agentAvailable !== true || typeof rows[0].running !== 'boolean') throw Error('idle_unverified');
      if (rows[0].running === false && (!honorPause || mode === 'run')) return;
      await bounded(() => delay(1000), deadline);
    }
  }
  function taskIdentity(t, job, completed = false) {
    if (!t || t.requestId !== job.requestId || t.sessionId !== plan.sessionId || t.projectId !== plan.projectId
      || !/^dshd-[a-f0-9]{16}$/.test(t.taskId) || t.promptSha256 !== job.promptSha256
      || t.requiresReconcile !== false || t.unknownReason != null || t.error != null
      || !['running', 'succeeded'].includes(t.state)
      || (job.taskId && job.taskId !== t.taskId)
      || (completed && (t.state !== 'succeeded' || !t.turnId || t.result?.admission?.found !== true))) throw Error('task_unverified');
  }
  try {
    if (!plan || !/^[a-z0-9-]{1,64}$/.test(plan.campaignId) || typeof plan.sessionId !== 'string'
      || typeof plan.sourceRequestId !== 'string' || !plan.sourceRequestId || typeof plan.sourceTurnId !== 'string' || !plan.sourceTurnId
      || !/^[a-f0-9]{40}$/.test(plan.expectedHead) || !isAbsolute(plan.repoRoot) || !isAbsolute(plan.projectId)
      || !isAbsolute(plan.stateDir) || !isAbsolute(plan.campaignDir)) throw Error('plan_invalid');
    const rel = relative(plan.projectId, plan.repoRoot);
    if (rel.startsWith('..') || isAbsolute(rel)) throw Error('repository_outside_project');
    const evidenceRel = relative(plan.repoRoot, plan.campaignDir);
    if (!evidenceRel.startsWith('..') && !isAbsolute(evidenceRel)) throw Error('journal_inside_repository');
    held();
    assertSettledLedger(plan.stateDir);
    const baseline = repositoryBaseline(plan.repoRoot);
    if (baseline.head !== plan.expectedHead) throw Error('plan_head_changed');
    const jobs = [0, 1].map(index => ({ index, requestId: requestIdFor(plan.sessionId, plan.campaignId, index),
      prompt: jobPrompt(index, baseline) }));
    const old = assertSettledLedger(plan.stateDir);
    if (old.some(t => jobs.some(j => t.requestId === j.requestId))) throw Error('campaign_request_exists');
    journal = openCampaign(plan.campaignDir, { ...plan, baseline, manifest: MANIFEST, jobs: jobs.map(j => ({ index: j.index, requestId: j.requestId, promptSha256: sha256(j.prompt) })) });
    journal.record({ stage: 'activation', maxTasks: 2, jobMs: MANIFEST.jobMs, activationMs: MANIFEST.activationMs, retryCount: 0 });
    const afterTurnEnd = Math.min(end, performance.now() + 120000);
    for (;;) {
      control();
      const page = await bounded(() => host.getEvents({ sessionId: plan.sessionId, requestId: plan.sourceRequestId }), afterTurnEnd);
      if (page.terminal && page.terminal.kind !== 'completed') throw Error('source_not_completed');
      if (exactFinished(page, plan.sourceTurnId)) {
        journal.record({ stage: 'source_completed', requestId: plan.sourceRequestId, turnId: page.turnId,
          admission: page.admission, terminal: page.terminal }); break;
      }
      await bounded(() => delay(1000), afterTurnEnd);
    }
    await ready(afterTurnEnd);
    for (const job of jobs) {
      const deadline = Math.min(end, performance.now() + MANIFEST.jobMs);
      activeJob = { index: job.index, requestId: job.requestId, promptSha256: sha256(job.prompt), taskId: null };
      await ready(deadline);
      const artifactBefore = verifyArtifact(baseline, { pristine: job.index === 0 });
      held(); control();
      assertSettledLedger(plan.stateDir);
      journal.record({ stage: 'admissible', ...activeJob, artifactBefore, sourceTurnId: plan.sourceTurnId });
      // Last pause check; any lost/changed signal stops before invocation, never causes a resubmit.
      if (control() !== 'run') throw Error('paused_before_dispatch');
      held();
      journal.record({ stage: 'dispatch_reserved', ...activeJob });
      pending = true; submitted += 1;
      const receipt = await bounded(() => client.submitTask({ sessionId: plan.sessionId, projectId: plan.projectId,
        requestId: job.requestId, prompt: job.prompt }), deadline);
      const observed = receipt?.task;
      if (observed && observed.requestId === job.requestId && /^dshd-[a-f0-9]{16}$/.test(observed.taskId)) activeJob.taskId = observed.taskId;
      journal.record({ stage: 'receipt_observed', ...activeJob, state: observed?.state ?? null,
        turnId: observed?.turnId ?? null, requiresReconcile: observed?.requiresReconcile ?? null,
        duplicate: receipt?.duplicate ?? null });
      taskIdentity(observed, activeJob);
      if (receipt.ok !== true || receipt.duplicate === true) throw Error('admission_ambiguous');
      let terminal;
      for (;;) {
        held(); control(); // pause permits observations of an in-flight task; stop preserves it immediately.
        try { terminal = (await bounded(() => client.getResult({ taskId: activeJob.taskId }), deadline))?.task; }
        catch (error) {
          if (error.code !== 'task_not_finished') throw error;
          await bounded(() => delay(1000), deadline); continue;
        }
        taskIdentity(terminal, activeJob, true); break;
      }
      const page = await bounded(() => host.getEvents({ sessionId: plan.sessionId, requestId: job.requestId }), deadline);
      if (!exactFinished(page, terminal.turnId) || page.admission.seq !== terminal.result.admission.seq) throw Error('host_terminal_mismatch');
      journal.record({ stage: 'terminal', ...activeJob, turnId: terminal.turnId, state: terminal.state,
        admission: page.admission, terminal: page.terminal });
      pending = false;
      await ready(deadline);
      const verification = job.index === 0 ? verifyArtifact(baseline)
        : verifyWithNamedTest(baseline, Math.min(30000, remaining(deadline)));
      if (remaining(deadline) <= 0) throw Error('deadline');
      journal.record({ stage: 'artifact_verified', ...activeJob, ...verification });
    }
    journal.record({ stage: 'campaign_verified', submitted, manifestSha256 });
    return { code: 'productive_verified', submitted, preserveOwnership: false };
  } catch (error) {
    const code = /^(operator_stop|deadline|writer_lease_lost|source_not_completed|paused_before_dispatch)$/.test(error.message)
      ? error.message : 'campaign_stopped';
    journal?.record({ stage: 'stopped', code, pending, activeJob, submitted });
    return { code, submitted, pending, preserveOwnership: true, detailCode: /^[a-z][a-z0-9_]{1,70}$/.test(error.message) ? error.message : null };
  } finally { journal?.close(); }
}

export async function main(args = process.argv.slice(2)) {
  if (!args.includes('--enable')) { console.log(JSON.stringify({ code: 'disabled', submitted: false })); return; }
  // Safe preflight only: installed components do not provide the required coordination.
  // No credentials/config/plan read, campaign creation, timer, scheduler or DirectServer construction.
  console.log(JSON.stringify(admissionGate())); process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
