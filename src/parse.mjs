// parse: Pure parsing/classification: reaction-count text (EN/VI), link filtering, link partition/group/filter, post sorting, size estimation. (split from the single-file userscript; see scripts/modules.json)
import { DEFAULT_CAP_BYTES } from './config.mjs';
import { IMG_EXT_RE, VID_EXT_RE } from './media.mjs';

// --- step 5: reaction count text parser (EN + VI), pure ---
export const OTHERS_RE = /(?:and|và)\s+(\d+)\s+(?:others|người khác)\s*$/i;
// truncated-list badge tail (custom styles): "UserA, UserB +247",
// "UserA, UserB, … +247" — the name list is cut and the count rides a
// "+N" suffix instead of the stock "and N others" phrase
export const PLUS_RE = /(?:…|\.\.\.|,)?\s*\+\s*(\d+)\s*$/;
export const ELLIPSIS_RE = /…|\.{3}/g;
export const NAME_SEP_RE = /\s+(?:and|và)\s+/i;

/**
 * Parse an XF reactionsBar-link text into a reaction count.
 * Observed live forms (2026-10-29): 'Aman899'; 'Em Bị Đâm and TrìnhCa8';
 * 'longdevilk3, thead, adidasphatt and 15 others'; VI: 'A, B và C', 'X và 5 người khác'.
 * Names are split on ',' and on terminal 'and'/'và'; a trailing
 * 'and|và N others|người khác' contributes N. Empty/null/no-bar input yields 0.
 *
 * 0.23.2 truncated-list shapes: the MOST-reacted post is the only one whose
 * name list XF truncates — stock renders 'A, B and N others', but custom
 * styles badge the tail as 'A, B +N' / 'A, B, … +N' or collapse to a bare
 * count ('247', '❤ 247'). Without these, a 200-react post parses as 2-3
 * and sorts to the bottom. A text with NO letters anywhere is treated as a
 * bare count badge (a name list always carries letters); ellipsis tokens
 * never count as names.
 */
export function parseReactionCount(text) {
  if (text === null || text === undefined) return 0;
  const s = String(text).trim().replace(/\s+/g, ' ');
  if (!s) return 0;
  // bare count badge: digits + icon/symbol noise only, no letters
  if (!/[a-zà-ỹ]/i.test(s)) {
    const digits = s.replace(/\D+/g, ' ').trim();
    if (digits && digits.indexOf(' ') === -1) return parseInt(digits, 10) || 0;
    return 0; // icon-only / symbol noise — no count to read
  }
  let names = s;
  let others = 0;
  const m = s.match(OTHERS_RE);
  const p = m ? null : s.match(PLUS_RE);
  if (m) {
    others = parseInt(m[1], 10) || 0;
    names = s.slice(0, m.index);
  } else if (p) {
    others = parseInt(p[1], 10) || 0;
    names = s.slice(0, p.index);
  }
  let count = 0;
  names = names.replace(ELLIPSIS_RE, ','); // truncation markers are not names
  for (const commaPart of names.split(',')) {
    for (const part of commaPart.split(NAME_SEP_RE)) {
      if (part.trim()) count += 1;
    }
  }
  return count + others;
}

export function hostKey(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

/**
 * Filter raw post-body hrefs down to external http(s) links (pure).
 * Drops: pure-# anchors, non-http(s), same-host links (www-insensitive,
 * port-aware), /members/ profile links, /post-N permalinks/share gadgets.
 */
export function filterLinks(hrefList, ownHost) {
  if (!Array.isArray(hrefList) || !ownHost) return [];
  const own = hostKey(ownHost);
  const out = [];
  for (const raw of hrefList) {
    if (typeof raw !== 'string' || raw === '') continue;
    if (raw.charAt(0) === '#') continue;
    if (!/^https?:\/\//i.test(raw)) continue;
    let u;
    try { u = new URL(raw); } catch (e) { continue; }
    if (u.pathname.indexOf('/members/') !== -1) continue;
    if (/\/post-\d+\/?$/.test(u.pathname)) continue;
    if (hostKey(u.host) === own) continue;
    out.push(u.href);
  }
  return out;
}

export function partitionLinks(hrefList) {
  const imageLinks = [];
  const videoLinks = [];
  const links = [];
  for (const raw of Array.isArray(hrefList) ? hrefList : []) {
    if (typeof raw !== 'string' || raw === '') continue;
    if (IMG_EXT_RE.test(raw)) imageLinks.push(raw);
    else if (VID_EXT_RE.test(raw)) videoLinks.push(raw);
    else links.push(raw);
  }
  return { imageLinks, videoLinks, links };
}

/** Hostname (www-stripped, lowercase, port kept) of a URL; '' when unparseable (pure). */
export function extractDomain(url) {
  if (typeof url !== 'string' || url === '') return '';
  try { return hostKey(new URL(url).host); } catch (e) { return ''; }
}

/**
 * Collapse consecutive same-post link items into one group per post (pure).
 * Items arrive in table order (record order, then link order), so a linear
 * scan is enough. Output: [{ r, pos, urls: [...] }, ...] — one per post.
 */
export function groupLinkItems(items) {
  const groups = [];
  for (const it of Array.isArray(items) ? items : []) {
    const lastG = groups[groups.length - 1];
    if (lastG && lastG.r.postId === it.r.postId) lastG.urls.push(it.url);
    else groups.push({ r: it.r, pos: it.pos, urls: [it.url] });
  }
  return groups;
}

/**
 * Links-tab search + column filters (pure).
 * query: case-insensitive substring of the URL OR the author name.
 * users/domains: Set of allowed values; null/undefined = no filtering.
 */
export function applyLinkFilters(items, opts) {
  const o = opts || {};
  const q = typeof o.query === 'string' ? o.query.trim().toLowerCase() : '';
  const users = o.users instanceof Set ? o.users : null;
  const domains = o.domains instanceof Set ? o.domains : null;
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (q && String(it.url).toLowerCase().indexOf(q) === -1
      && String(it.r.author || '').toLowerCase().indexOf(q) === -1) continue;
    if (users && !users.has(it.r.author || '')) continue;
    if (domains && !domains.has(extractDomain(it.url))) continue;
    out.push(it);
  }
  return out;
}

/**
 * Sort post records: reactionCount desc, zero-reaction posts last,
 * ties keep thread (input) order. Returns a new array; input untouched.
 */
export function sortPosts(posts) {
  if (!Array.isArray(posts)) return [];
  const decorated = posts.map((p, i) => ({ p: p || {}, i }));
  decorated.sort((a, b) => {
    const ra = typeof a.p.reactionCount === 'number' && a.p.reactionCount > 0 ? a.p.reactionCount : 0;
    const rb = typeof b.p.reactionCount === 'number' && b.p.reactionCount > 0 ? b.p.reactionCount : 0;
    if (ra > 0 && rb > 0 && ra !== rb) return rb - ra;
    if (ra > 0 && rb <= 0) return -1;
    if (rb > 0 && ra <= 0) return 1;
    return a.i - b.i;
  });
  return decorated.map((d) => d.p);
}

/**
 * Persistence-cap gate (pure). Given a running byte total and a cap,
 * returns { totalBytes, capBytes, stopPersist } — stopPersist true means
 * the caller must stop writing to IndexedDB and keep data in memory.
 */
export function estimateSize(totalBytes, capBytes) {
  const cap = typeof capBytes === 'number' && capBytes > 0 ? capBytes : DEFAULT_CAP_BYTES;
  const total = typeof totalBytes === 'number' && isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  return { totalBytes: total, capBytes: cap, stopPersist: total > cap };
}

// Panel item ordering (0.23.0): order the collected panel items — media
// tiles and links rows share one item shape { r, url, pos, kind, ord } —
// by source-post page number or reaction count. `r.pageN` (missing -> 1)
// and `r.reactionCount` (missing -> 0 — every item carries its post's
// count, zero-react posts included) come from the extraction record; ties
// break by `pos` (post position) then `ord` (raw stream position) so the
// sort is total and stable. Any other mode (undefined, or legacy 'default'
// saved pre-0.23.2 before the option was removed) returns the SAME
// reference untouched — the default render path stays allocation-free.
export function orderItems(items, mode) {
  if (mode !== 'page' && mode !== 'react') return items;
  const val = (it) => it && it.r || {};
  const tie = (a, b) => (a.pos - b.pos) || (a.ord - b.ord);
  const byPage = (a, b) => ((val(a).pageN || 1) - (val(b).pageN || 1)) || tie(a, b);
  const byReact = (a, b) => ((val(b).reactionCount || 0) - (val(a).reactionCount || 0)) || tie(a, b);
  return items.slice().sort(mode === 'page' ? byPage : byReact);
}
