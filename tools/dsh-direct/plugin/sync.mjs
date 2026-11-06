// Sync the plugin's runtime copies from tools/dsh-direct.
//
// A Cordis plugin installed into `~/.dsh/plugins/dsh-direct` cannot import files outside its own directory, so the
// four modules it needs are copied into `plugin/lib/` verbatim. Copies drift; `test_t272_plugin.mjs` compares bytes and
// fails the gate when they do. Run this after changing any of the four sources:
//
//   node tools/dsh-direct/plugin/sync.mjs
//
// It refuses to overwrite a file whose content differs from both the source and the previous copy, so a local edit in
// plugin/lib is reported instead of silently discarded.

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SYNCED = Object.freeze(['protocol.mjs', 'session_api.mjs', 'endpoint.mjs', 'adapters.mjs',
  'host_bridge.mjs']);

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(here, '..');
const targetDir = path.join(here, 'lib');

export function sync({ dryRun = false } = {}) {
  const report = [];
  for (const name of SYNCED) {
    const from = path.join(sourceDir, name);
    const to = path.join(targetDir, name);
    const source = readFileSync(from, 'utf8');
    const current = existsSync(to) ? readFileSync(to, 'utf8') : null;
    if (current === source) {
      report.push({ name, action: 'unchanged' });
      continue;
    }
    if (dryRun) {
      report.push({ name, action: current === null ? 'would-create' : 'would-update' });
      continue;
    }
    copyFileSync(from, to);
    report.push({ name, action: current === null ? 'created' : 'updated' });
  }
  return report;
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
  const report = sync({ dryRun: process.argv.includes('--dry-run') });
  for (const item of report) process.stdout.write(item.name + ': ' + item.action + '\n');
}
