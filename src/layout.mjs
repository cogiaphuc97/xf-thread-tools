// layout: Pure grid math: exact spacer metrics, window binary search, speed/ETA formatting, media layout entries (grouping headers + 4-cell rows). (split from the single-file userscript; see scripts/modules.json)
// ---------- virtual grid math (pure — unit-tested, no DOM) ----------
// Windowed rendering needs EXACT heights or the spacer drifts and the
// scroll clamp eats the difference as push-back (the pre-0.7.45 bug).
// Height sources: media row = rowH, uniform by construction (4 aspect-1:1
// cells in the row's own 4-col grid — the row is as tall as one cell,
// measured from a probe row at mount: borders/rounding included, never a
// guess); group headers = headH/subH (CSS-fixed 30/24px, probed too).
// Every entry advances h + gap; total omits the trailing gap.
export function layoutMetrics(entries, rowH, headH, subH, gap) {
  const n = entries.length;
  const top = new Array(n);
  const h = new Array(n);
  let y = 0;
  for (let e = 0; e < n; e++) {
    const en = entries[e];
    const eh = en.idxs ? rowH : (en.hdr === 'sub' ? subH : headH);
    top[e] = y;
    h[e] = eh;
    y += eh + gap;
  }
  return { top: top, h: h, total: n ? y - gap : 0 };
}
// visible window [first, last] over computed tops: first = earliest entry
// whose BOTTOM is below viewTop (an entry straddling viewTop stays in),
// last = last entry whose top is at/below viewBot. bottom(e) = top(e+1)
// − gap, so both bounds are monotonic → two binary searches. Returns
// [first, -1] for an empty layout or a window past the end.
export function windowRange(top, h, viewTop, viewBot) {
  const n = top.length;
  if (!n) return [0, -1];
  let lo = 0, hi = n - 1, first = n;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (top[mid] + h[mid] > viewTop) { first = mid; hi = mid - 1; } else lo = mid + 1;
  }
  if (first >= n) return [n, -1];
  lo = 0; hi = n - 1;
  let beyond = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (top[mid] > viewBot) { beyond = mid; hi = mid - 1; } else lo = mid + 1;
  }
  const last = beyond === -1 ? n - 1 : beyond - 1;
  return last < first ? [first, -1] : [first, last];
}

// ---------- scroll-idle rebuild gate (0.20.0, pure — unit-tested) ----------
// A grid-affecting rebuild is HELD while the user scrolled within the idle
// window: scrolling always wins over data freshness. Boundary: exactly
// idleMs since the last scroll = idle (not held).
export function scrollIdleHeld(lastScrollAt, now, idleMs) {
  return now - lastScrollAt < idleMs;
}
// Probe-height cache validity: probed row/header heights are CSS-fixed, so
// they survive rebuilds and only a generation bump (resize) invalidates.
export function probeHeightsValid(cache, gen) {
  return !!(cache && cache.rowH > 0 && cache.gen === gen);
}

// ---------- dashboard formatting (pure — unit-tested, no DOM) ----------
export function fmtSpeed(bps) {
  if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
  if (bps >= 1024) return (bps / 1024).toFixed(0) + ' KB/s';
  return Math.round(bps) + ' B/s';
}
export function fmtEta(s) {
  if (!s || s < 2) return '';
  if (s < 90) return '≈ ' + Math.max(1, Math.round(s)) + 's';
  if (s < 5400) return '≈ ' + Math.round(s / 60) + 'm';
  return '≈ 90m+';
}

// ---------- media grid grouping/layout (pure — unit-tested, no DOM) ----------
export function buildMediaLayout(items, mode, albumLabel) {
  const lay = [];
  // sequential 4-packs — NO holes (user-facing rule: the grid is always
  // densely packed in every mode). Re-chunking after a retirement is
  // safe now: rows reconcile cell-by-cell by URL, so surviving imgs keep
  // their elements (and their decoded frames) even when they slide into
  // a different row.
  const chunk = (list) => { for (let j = 0; j < list.length; j += 4) lay.push({ idxs: list.slice(j, j + 4) }); };
  // Album sub-tab: one group per parent album, '[host] - [name]' main
  // header (label fn passed by the caller — the pure module never reads
  // runtime caches) with the group's item count at the right end
  if (mode === 'album') {
    const groups = new Map();
    for (let i = 0; i < items.length; i++) {
      const key = String(items[i].album || '');
      let g = groups.get(key);
      if (!g) { g = { key: key, label: albumLabel ? String(albumLabel(key)) : key, list: [] }; groups.set(key, g); }
      g.list.push(i);
    }
    for (const g of groups.values()) {
      lay.push({ hdr: 'main', label: g.label + '  ·  ' + g.list.length, postId: '', album: g.key });
      chunk(g.list);
    }
    return lay;
  }
  if (mode !== 'post' && mode !== 'page' && mode !== 'user') {
    chunk(items.map((_, i) => i));
    return lay;
  }
  const groups = new Map(); // insertion order = first-appearance order
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const author = it.r.author || '?';
    const gkey = mode === 'page' ? 'p' + (it.r.pageN || 1) : mode === 'user' ? 'u' + author : it.r.postId;
    let g = groups.get(gkey);
    if (!g) {
      g = { label: mode === 'page' ? 'Page ' + (it.r.pageN || 1) : mode === 'user' ? author : '#' + it.pos + ' - ' + author,
        postId: it.r.postId, subs: new Map() };
      groups.set(gkey, g);
    }
    let s = g.subs.get(it.r.postId);
    if (!s) { s = { pos: it.pos, author: author, postId: it.r.postId, list: [] }; g.subs.set(it.r.postId, s); }
    s.list.push(i);
  }
  for (const g of groups.values()) {
    lay.push({ hdr: 'main', label: g.label, postId: g.postId });
    for (const s of g.subs.values()) {
      // user groups already name the author in their main header — the
      // post sub-header shows the number only
      if (mode !== 'post') lay.push({ hdr: 'sub', label: mode === 'user' ? '#' + s.pos : '#' + s.pos + ' - ' + s.author, postId: s.postId });
      chunk(s.list);
    }
  }
  return lay;
}

