// parse: Pure parsing/classification: reaction-count text (EN/VI), link filtering, link partition/group/filter, post sorting, size estimation. (split from the single-file userscript; see scripts/modules.json)
import { DEFAULT_CAP_BYTES } from './config.mjs';
import { IMG_EXT_RE, VID_EXT_RE } from './media.mjs';

// --- step 5: reaction count text parser (EN + VI), pure ---
export const OTHERS_RE = /(?:and|và)\s+(\d+)\s+(?:others|người khác)\s*$/i;
export const NAME_SEP_RE = /\s+(?:and|và)\s+/i;

/**
 * Parse an XF reactionsBar-link text into a reaction count.
 * Observed live forms (2026-10-29): 'Aman899'; 'Em Bị Đâm and TrìnhCa8';
 * 'longdevilk3, thead, adidasphatt and 15 others'; VI: 'A, B và C', 'X và 5 người khác'.
 * Names are split on ',' and on terminal 'and'/'và'; a trailing
 * 'and|và N others|người khác' contributes N. Empty/null/no-bar input yields 0.
 */
export function parseReactionCount(text) {
  if (text === null || text === undefined) return 0;
  const s = String(text).trim().replace(/\s+/g, ' ');
  if (!s) return 0;
  let names = s;
  let others = 0;
  const m = s.match(OTHERS_RE);
  if (m) {
    others = parseInt(m[1], 10) || 0;
    names = s.slice(0, m.index);
  }
  let count = 0;
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
