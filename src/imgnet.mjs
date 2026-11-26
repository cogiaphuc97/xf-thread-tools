// imgnet: pure scheduling math for the shared preview-net queue (imgPageNet).
// DOM-free on purpose: the runtime computes each job's pick key (element
// viewport state + visual position) and hands the queue here. The picker
// owns the invariants that are easy to get wrong inline: per-origin
// politeness caps and the tiered visible-first / layout-order pick.
//
// Job shape (fields read here): { origin: string, at: number,
//   tier: number, rank: number }
// tier 0 = no element (user-initiated: viewer, downloads, landing pages)
// tier 1 = element connected AND inside viewport±300px — what the viewer
//          is looking at loads first
// tier 2 = element connected anywhere — picked by VISUAL position
//          (rank = top*1e5 + left), so off-screen rows follow the CURRENT
//          layout left-to-right, top-to-bottom; a mid-session re-sort
//          re-ranks automatically because the DOM is re-read every pump
// tier 3 = element detached (recycled cell) — FIFO by age, drains when
//          nothing else is startable
// The old aging-as-urgent escape is gone on purpose: on a long thread
// everything aged past 10s within the first minute, which flattened the
// queue back to enqueue order and starved the viewport (the bottom-to-top
// loading report). Detached jobs cannot starve: tiers 0-2 drain strictly
// before tier 3, and a re-attached cell jumps back to tier 1/2.

// Next job index to start, or -1 when nothing is startable.
//  - `active`      : jobs currently in flight, all origins combined
//  - `perOrigin`   : plain object origin -> in-flight count
//  - `opts.global` : max total in flight (default 12)
//  - `opts.perOrigin`: max in flight per origin (default 4)
//  - `opts.originCaps`: plain object origin -> override cap for that origin
//    (adaptive penalty: an origin that served failures runs 2-concurrent —
//    some CDN families challenge bursts above 2 — while healthy origins
//    keep the fast default; behavior-based, no hostnames)
// Order: smallest (tier, rank, at) among startable jobs. A job whose
// origin is saturated is skipped, never started.
export function netPick(queue, active, perOrigin, opts) {
  const o = opts || {};
  const global = o.global > 0 ? o.global | 0 : 12;
  const cap = o.perOrigin > 0 ? o.perOrigin | 0 : 4;
  const caps = o.originCaps || null;
  if (active >= global) return -1;
  let best = -1;
  for (let i = 0; i < queue.length; i++) {
    const j = queue[i];
    const c = caps && caps[j.origin] > 0 ? caps[j.origin] | 0 : cap;
    if ((perOrigin[j.origin] || 0) >= c) continue; // origin saturated — keep scanning
    if (best < 0) { best = i; continue; }
    const b = queue[best];
    const jt = j.tier == null ? 3 : j.tier;
    const bt = b.tier == null ? 3 : b.tier;
    if (jt !== bt) { if (jt < bt) best = i; continue; }
    const jr = j.rank == null ? j.at : j.rank;
    const br = b.rank == null ? b.at : b.rank;
    if (jr !== br) { if (jr < br) best = i; continue; }
    if ((j.at || 0) < (b.at || 0)) best = i;
  }
  return best;
}
