// One fixed docs-maintenance campaign. No caller-supplied prompts, commands or write paths.
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const MANIFEST = Object.freeze({
  id: 't336-shell-prerequisite-docs-v1',
  path: 'tools/dsh-direct/AFTER_TURN_ONCE.md',
  before: 'Node >=22, pwsh, ScheduledTasks cmdlets and running Schedule service; existing Direct config/ledger,',
  after: 'Node >=22, Windows PowerShell 5.1 or PowerShell 7, ScheduledTasks cmdlets and running Schedule service;\nexisting Direct config/ledger,',
  test: 'test_t331_scheduler_shell.ps1',
  maxTasks: 2, jobMs: 900000, activationMs: 1800000, retryCount: 0,
});
export const manifestSha256 = sha256(JSON.stringify(MANIFEST));
const commandOptions = root => ({ cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 131072,
  windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
function git(root, args) {
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], commandOptions(root));
}
// Two spellings of one directory must compare equal, and nothing else may.
//
// `realpathSync()` keeps the case it was handed, while `git rev-parse --show-toplevel` answers
// with the volume's own spelling, so `C:` + `USERS` + `TEMP` and `C:` + `Users` + `Temp` were
// two different strings for one repository: `repository_root_mismatch` from a root that was
// exactly right. That is what run 42992116493 published from the Windows runner, whose temp
// path is not spelled the way the disk stores it. `realpathSync.native` is used when present
// because it also expands an 8.3 short name to the long one, which the same comparison used to
// reject; folding case is Windows-only, because on POSIX two spellings are two directories.
const fold = value => (process.platform === 'win32' ? value.toLowerCase() : value);
function canonicalPath(value) {
  try {
    return fold((realpathSync.native ?? realpathSync)(resolve(value)));
  } catch {
    return null;
  }
}
function nominalPath(value) {
  return fold(resolve(value));
}
function regular(root, relative) {
  const file = join(root, relative);
  // Still "a regular file reached without a detour": a symlink canonicalises to its target,
  // which is a different path from the one asked for. Only letter case is forgiven.
  if (!lstatSync(file).isFile() || canonicalPath(file) !== nominalPath(file)) {
    throw Error('non_regular_campaign_file');
  }
  return readFileSync(file, 'utf8');
}
export function expectedDocument(source) {
  if (source.split(MANIFEST.before).length !== 2 || source.includes(MANIFEST.after)) throw Error('baseline_anchor_mismatch');
  return source.replace(MANIFEST.before, MANIFEST.after);
}
export function repositoryBaseline(repoRoot) {
  const root = realpathSync(repoRoot);
  // Same directory, whichever way it is spelled; a subdirectory or another repository still
  // canonicalises to something else, which is what this line is for.
  if (canonicalPath(git(root, ['rev-parse', '--show-toplevel']).trim()) !== canonicalPath(root)) {
    throw Error('repository_root_mismatch');
  }
  if (git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) !== '') throw Error('worktree_not_clean');
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const source = git(root, ['show', head + ':' + MANIFEST.path]);
  if (regular(root, MANIFEST.path) !== source) throw Error('baseline_worktree_mismatch');
  const test = regular(root, MANIFEST.test);
  if (test !== git(root, ['show', head + ':' + MANIFEST.test])) throw Error('test_not_pinned');
  return { repoRoot: root, head, originalSha256: sha256(source), expectedSha256: sha256(expectedDocument(source)),
    testSha256: sha256(test), manifestSha256 };
}
export function verifyArtifact(baseline, { pristine = false } = {}) {
  const root = baseline.repoRoot;
  if (baseline.manifestSha256 !== manifestSha256 || git(root, ['rev-parse', 'HEAD']).trim() !== baseline.head) throw Error('baseline_head_changed');
  const source = git(root, ['show', baseline.head + ':' + MANIFEST.path]);
  if (sha256(source) !== baseline.originalSha256 || sha256(expectedDocument(source)) !== baseline.expectedSha256) throw Error('baseline_hash_mismatch');
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status !== (pristine ? '' : ' M ' + MANIFEST.path + '\0')) throw Error('diff_outside_manifest');
  const content = regular(root, MANIFEST.path);
  if (content !== (pristine ? source : expectedDocument(source))) throw Error('artifact_content_mismatch');
  if (sha256(regular(root, MANIFEST.test)) !== baseline.testSha256) throw Error('named_test_changed');
  return { path: MANIFEST.path, head: baseline.head, sha256: sha256(content), exactDiff: true };
}
export function verifyWithNamedTest(baseline, timeoutMs = 30000) {
  if (process.platform !== 'win32') throw Error('windows_test_required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('test_budget_invalid');
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || systemRoot.trim() !== systemRoot || !/^[a-z]:[\\/]/i.test(systemRoot)) throw Error('system_root_unavailable');
  const artifact = verifyArtifact(baseline);
  const shell = join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  if (!lstatSync(shell).isFile()) throw Error('test_shell_missing');
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', join(baseline.repoRoot, MANIFEST.test)],
    { ...commandOptions(baseline.repoRoot), timeout: timeoutMs, shell: false });
  if (result.error || result.signal || result.status !== 0) throw Error('named_test_failed');
  const after = verifyArtifact(baseline);
  if (after.sha256 !== artifact.sha256) throw Error('artifact_changed_during_test');
  return { ...after, test: MANIFEST.test, testExitCode: result.status, testSha256: baseline.testSha256,
    testOutputSha256: sha256(result.stdout || ''), verifiedBy: 'owner_git_and_process_exit' };
}
export function jobPrompt(index, baseline) {
  const boundary = `Repository ${JSON.stringify(baseline.repoRoot)} at HEAD ${baseline.head}. `
    + 'Exactly this approved maintenance job; no other jobs, commits, pushes, network, settings, grants, sessions or cleanup. ';
  if (index === 0) return boundary + `Edit ONLY ${MANIFEST.path}. Replace exactly one occurrence of ${JSON.stringify(MANIFEST.before)} with ${JSON.stringify(MANIFEST.after)}. Preserve every other byte. Do not run tests or commands unrelated to this edit. Return a short factual diff summary.`;
  if (index === 1) return boundary + `Read-only verification: check the only diff is that exact prerequisite replacement in ${MANIFEST.path}. Run only the named local test with Windows PowerShell: powershell.exe -NoProfile -NonInteractive -File ${MANIFEST.test}. Do not edit any repository file, fix failures or repeat a command. Report its exit code. The external owner independently checks the diff and reruns this fixed test; prose is not acceptance.`;
  throw Error('job_index_invalid');
}
