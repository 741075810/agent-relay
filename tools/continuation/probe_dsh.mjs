// T095B155: print the native continuation capability matrix for this install. Read-only.
//
//   node tools/continuation/probe_dsh.mjs <runtime-manifest.json> [bundles] [tools]
//
// `bundles` and `tools` are comma-separated and optional; they decide the `enabled` column, not the
// `supported` one. Nothing is written, started or submitted: this is a reader.

import { readFileSync } from 'node:fs';
import { probeRuntime } from './dsh_native.mjs';

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error('usage: node tools/continuation/probe_dsh.mjs <runtime-manifest.json> [bundles] [tools]');
  process.exit(2);
}
const split = (value) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : []);
const probe = probeRuntime({
  manifestPath,
  readFile: (p) => readFileSync(p, 'utf8'),
  profileBundles: split(process.argv[3]),
  toolNames: split(process.argv[4]),
});

if (probe.state !== 'read_only') {
  console.log(JSON.stringify(probe, null, 2));
  process.exit(1);
}

console.log('manifest      : ' + probe.manifestPath + ' (' + probe.packageCount + ' packages)');
console.log('supported     : ' + probe.supported.join(', '));
console.log('enabled now   : ' + Object.entries(probe.enabled)
  .map(([k, v]) => k + '=' + (v ? 'yes' : 'no')).join(' '));
console.log('');
console.log('capability      present  packages');
for (const [key, value] of Object.entries(probe.capabilities)) {
  console.log('  ' + key.padEnd(20) + String(value.present).padEnd(9)
    + (value.packages.join(',') || '-'));
}
console.log('');
console.log('gaps:');
for (const gap of probe.gaps) {
  console.log('  ' + gap.code);
  console.log('    why         : ' + gap.why);
  console.log('    shortest    : ' + gap.shortestPath);
}
console.log('');
console.log('auto-continues without a human: ' + probe.autoContinuesWithoutHuman
  + ' (goal rounds run, but a restart disarms the goal)');
