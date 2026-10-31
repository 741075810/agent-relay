// T095B152: the event side of continuation -- a durable mirror of completed tasks, plus paging.
//
// Why a mirror at all: the host's `terminal-list` returns a capped window (40 candidates in the
// production sample, with a `truncated` flag). Anything older than that window is unreachable by
// polling, so a coordinator that "just polls" will silently skip work once the backlog grows. The
// mirror is the fix that works with the interfaces this repository actually has: every poll is
// appended to a durable, ordered log, and work is claimed from that log rather than from the live
// window. If a poll comes back truncated, the coordinator raises `event_gap` instead of pretending
// the window is the whole world -- see `coordinator.mjs`.
//
// What this is not: a reader for the Bridge's own ledger. That file's shape is not documented to us
// and reading it by guesswork would be the exact failure mode this repository keeps paying for. The
// documented path for a future adapter is `LedgerAdapter` in README.md: page over a supported,
// explicitly-versioned source, and keep `event_gap` until it proves coverage.

export const PAGE = 100;

export function createMirror(seed = {}) {
  if (seed && typeof seed === 'object' && Array.isArray(seed.events)) {
    return { version: 1, seq: Number.isSafeInteger(seed.seq) ? seed.seq : 0,
      events: seed.events.map((e) => ({ ...e })) };
  }
  return { version: 1, seq: 0, events: [] };
}

export function appendEvent(mirror, event) {
  const next = createMirror(mirror);
  const key = String(event.key || (event.runId + '|' + event.status + '|' + event.epoch));
  if (next.events.some((e) => e.key === key)) {
    // The same completion seen twice is the normal case (a poll that overlaps the previous one),
    // so it is not an error and it does not consume sequence numbers.
    return { mirror: next, added: false, key };
  }
  next.seq += 1;
  next.events.push({ seq: next.seq, key, runId: event.runId, status: event.status,
    epoch: event.epoch, sessionId: event.sessionId || null, at: event.at || null });
  return { mirror: next, added: true, key };
}

export function hasEvent(mirror, key) {
  return mirror.events.some((e) => e.key === key);
}

/** One page of the mirror, oldest first. `done` means there is nothing after this page. */
export function scan(mirror, options = {}) {
  const afterSeq = Number.isSafeInteger(options.afterSeq) ? options.afterSeq : 0;
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : PAGE;
  const rest = mirror.events.filter((e) => e.seq > afterSeq).sort((a, b) => a.seq - b.seq);
  const events = rest.slice(0, limit);
  const nextSeq = events.length > 0 ? events[events.length - 1].seq : afterSeq;
  return { events, nextSeq, done: rest.length <= events.length };
}

/**
 * Fold a `terminal-list` reply into the mirror.
 *
 * `gap` is the important field. A reply that says `truncated: true` means the host is holding back
 * events it knows about; the mirror cannot fill that hole, so the coordinator must stop claiming
 * work until a subsequent reply proves the source is whole again.
 */
export function ingestList(mirror, reply, options = {}) {
  let next = createMirror(mirror);
  const epoch = options.epoch || (reply && reply.armEpoch) || null;
  const sessionId = options.sessionId || null;
  const at = Number.isFinite(options.at) ? options.at : null;
  const candidates = reply && Array.isArray(reply.candidates) ? reply.candidates : [];
  const added = [];
  for (const cand of candidates) {
    if (!cand || typeof cand.runId !== 'string') continue;
    const out = appendEvent(next, { runId: cand.runId, status: cand.status, epoch,
      sessionId, at: Number.isFinite(cand.endedAtMs) ? cand.endedAtMs : at });
    next = out.mirror;
    if (out.added) added.push(out.key);
  }
  const truncated = reply && reply.truncated === true;
  const count = reply && Number.isSafeInteger(reply.count) ? reply.count : candidates.length;
  return { mirror: next, added, gap: truncated || count > candidates.length,
    truncated, count, seen: candidates.length };
}
