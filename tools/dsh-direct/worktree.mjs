// DSH Direct: read-only worktree precheck.
//
// The only thing this module does to a repository is read it. It runs `git status --porcelain=v2` and `git rev-parse
// HEAD` with `--no-optional-locks`, so it cannot take the index lock away from an operator who is working, and it
// reports what it saw instead of "cleaning" anything: the caller decides, and `submit_task` refuses a dirty tree by
// default rather than letting a task trample uncommitted work.

import { spawn } from 'node:child_process';

import { CODES, DirectError } from './protocol.mjs';

function git(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', ['--no-optional-locks'].concat(args), { cwd, stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.once('error', (error) => resolve({ ok: false, code: 'spawn_failed', out: '', err: String(error && error.message) }));
    child.once('exit', (code) => resolve({ ok: code === 0, code, out, err }));
  });
}

export async function precheckWorktree(root) {
  const head = await git(root, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    // Not a repository (or git is absent) is a refusal, not a clean tree: "could not look" is not "nothing there".
    throw new DirectError(CODES.worktree_dirty, 'the worktree could not be read, so it is not proven clean', {
      root, reason: head.code === 'spawn_failed' ? 'git_unavailable' : 'not_a_repository',
      stderr: head.err.trim().slice(0, 400) });
  }
  const status = await git(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
  if (!status.ok) {
    throw new DirectError(CODES.worktree_dirty, 'the worktree status could not be read', { root,
      stderr: status.err.trim().slice(0, 400) });
  }
  const lines = status.out.split('\n').filter(Boolean);
  const entries = lines.filter((line) => !line.startsWith('#'));
  const branch = (lines.find((line) => line.startsWith('# branch.head ')) || '').replace('# branch.head ', '').trim()
    || null;
  return { root, clean: entries.length === 0, head: head.out.trim(), branch, entries: entries.slice(0, 50),
    entryCount: entries.length, readOnly: true };
}
