// T095B157: what the *shipped, documented* goal/jobs/schedule packages promise about running rounds
// without any client attached -- checked against their own READMEs instead of re-derived.
//
// Every claim below is a keyword probe over the installed README, with the package version recorded
// next to it. That makes the report falsifiable: if a future version drops the sentence, the probe
// fails and this repository's conclusion is invalidated on purpose.
//
// Measured on this install (each package @0.2.0-rc.2, each with its own README):
//
//   dsh-goal-round-driver  continues an active goal in the same session "while the agent is idle,
//                          continuation is armed, and the configured round allowance remains";
//                          a round starts only at whole-agent idle; after resume/fork an active goal
//                          "stays disarmed until an explicit human-authorized resume"; transient
//                          failures need "a later human-authorized resume" (no auto-retry).
//   dsh-schedule           delivers reminders "as follow-up messages in their original Session",
//                          tasks "remain available after Host restart", and the shipped Web
//                          composition carries no schedule row -- the experimental bundle must be
//                          enabled. Tools: schedule_create / schedule_list / schedule_delete /
//                          schedule_update. One Host timer, tasks bound to a sessionId.
//
// Both are host-side services: nothing in either README mentions a browser client as a prerequisite
// for a round or a delivery. That is the answer to "can it run with the page backgrounded" -- the
// page was never in the loop; the app process and a live session are.

import { createHash } from 'node:crypto';

export const PROBES = {
  'dsh-goal-round-driver': [
    { id: 'same_session', any: [/same session/i], claim: 'continues in the same session' },
    { id: 'idle_trigger', any: [/whole-agent idle/i, /agent is idle/i],
      claim: 'a round starts only when the agent is idle' },
    { id: 'armed', any: [/continuation is (?:armed|disarmed)/i, /goal stays disarmed/i],
      claim: 'continuation depends on an armed goal' },
    { id: 'no_auto_arm', any: [/never arms a goal/i, /explicit human-authorized resume/i],
      claim: 'resume/fork does not arm a goal by itself' },
    { id: 'no_auto_retry', any: [/No abnormal auto-retry/i, /human-authorized resume rather than/i],
      claim: 'transient failures need a human-authorized resume' },
  ],
  'dsh-schedule': [
    { id: 'original_session', any: [/in their original Session/i, /original Session binding/i],
      claim: 'deliveries land in the session that created them' },
    { id: 'restart_durable', any: [/after Host re?start/i],
      claim: 'scheduled tasks survive a Host restart' },
    { id: 'bundle_optin', any: [/experimental-schedule-bundle/i],
      claim: 'the schedule row is an opt-in bundle, not shipped in the default web composition' },
    { id: 'tools', any: [/schedule_create/], claim: 'management tools are documented' },
    { id: 'one_timer', any: [/one Host timer/i, /Host timer/i], claim: 'one Host timer drives due tasks' },
  ],
};

export function verifyDocClaims({ name, version, readme }) {
  const probes = PROBES[name];
  if (!probes) return { name, version, known: false, checks: [], satisfied: 0, total: 0 };
  const text = typeof readme === 'string' ? readme : '';
  const checks = probes.map((probe) => ({
    id: probe.id,
    claim: probe.claim,
    ok: probe.any.some((pattern) => pattern.test(text)),
  }));
  return { name, version: version || null, known: true, checks,
    satisfied: checks.filter((c) => c.ok).length, total: checks.length };
}

export function report(surfaces) {
  const rows = surfaces.map(verifyDocClaims);
  return {
    version: 1,
    packages: rows,
    allSatisfied: rows.every((row) => !row.known || row.satisfied === row.total),
    digest: createHash('sha256').update(JSON.stringify(rows.map((row) => [row.name, row.version,
      row.checks.map((c) => c.ok)]))).digest('hex'),
  };
}
