// imgnet: pure scheduling math for the shared preview-net queue (imgPageNet).
// DOM-free on purpose: the runtime computes each job's `urgent` flag (no
// element = user-initiated fetch; element = connected + viewport-visible)
// and hands the queue here. The picker owns the three invariants that are
// easy to get wrong inline: per-origin politeness caps, visible-first pick
// order, and the aging bound that keeps off-screen jobs from starving.
//
// Job shape (fields read here): { origin: string, at: number, urgent: boolean }

// Next job index to start, or -1 when nothing is startable.
//  - `active`      : jobs currently in flight, all origins combined
//  - `perOrigin`   : plain object origin -> in-flight count
//  - `opts.global` : max total in flight (default 12)
//  - `opts.perOrigin`: max in flight per origin (default 4)
//  - `opts.originCaps`: plain object origin -> override cap for that origin
//    (adaptive penalty: an origin that served failures runs 2-concurrent —
//    some CDN families challenge bursts above 2 — while healthy origins
//    keep the fast default; behavior-based, no hostnames)
//  - `opts.ageMs`  : queued this long => urgent (default 10000, starvation bound)
// Order: an eligible urgent job (flagged, or aged) beats any earlier
// non-urgent job; otherwise the earliest eligible job wins (FIFO).
// A job whose origin is saturated is skipped, never started.
export function netPick(queue, active, perOrigin, opts, now) {
  const o = opts || {};
  const global = o.global > 0 ? o.global | 0 : 12;
  const cap = o.perOrigin > 0 ? o.perOrigin | 0 : 4;
  const caps = o.originCaps || null;
  const ageMs = o.ageMs > 0 ? o.ageMs : 10000;
  if (active >= global) return -1;
  let fallback = -1;
  for (let i = 0; i < queue.length; i++) {
    const j = queue[i];
    const c = caps && caps[j.origin] > 0 ? caps[j.origin] | 0 : cap;
    if ((perOrigin[j.origin] || 0) >= c) continue; // origin saturated — keep scanning
    if (j.urgent || (now - (j.at || 0)) >= ageMs) return i; // visible/aged first
    if (fallback < 0) fallback = i; // first startable non-urgent (FIFO)
  }
  return fallback;
}
