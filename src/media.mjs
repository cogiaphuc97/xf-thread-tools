// media: Pure media classification and resolution helpers: image/video extension gates, smilie + boilerplate fingerprint, image landing-page parse, HQ .md/.th candidate chain, album page/API parse. (split from the single-file userscript; see scripts/modules.json)
export const IMG_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp)(?:[?#]|$)/i;
export const VID_EXT_RE = /\.(mp4|webm|mkv|mov|avi|m4v)(?:[?#]|$)/i;

/**
 * Partition post-body hrefs into media links (image/video file URLs, which
 * belong on the Files/Videos tabs, not Links) and page links (pure).
 */
// Boilerplate fingerprint: a URL that appears in the posts of N or more
// DISTINCT authors is signature/"sent via app" footer content, not something
// any one author posted. Catches both real signatures (flickr gear lists,
// proxy-wrapped banner images) and forum-injected footers that live inside
// the post body markup with no structural marker at all.
export function boilerplateUrls(records, minAuthors) {
  const min = minAuthors || 3;
  const authors = new Map();
  const add = (u, r) => {
    const u2 = String(u || '');
    if (!u2 || /^(data|blob):/i.test(u2)) return;
    if (!authors.has(u2)) authors.set(u2, new Set());
    authors.get(u2).add(String(r.author || ''));
  };
  for (const r of Array.isArray(records) ? records : []) {
    for (const u of (r.links || [])) add(u, r);
    for (const u of (r.images || [])) add(u, r);
  }
  const out = new Set();
  for (const [u, set] of authors) if (set.size >= min) out.add(u);
  return out;
}

// Smilie detector: raw OR decodeURIComponent'd URL — lazy-image themes wrap
// smilies in image proxies where the /smilies/ path only exists percent-
// encoded (proxy.php?image=https%3A%2F%2F…%2Fsmilies%2Fx.png), so testing the
// raw string alone lets them through both the extraction and render gates.
export function isSmilieUrl(u) {
  const s = String(u || '');
  if (!s) return false;
  let d = s;
  try { d = decodeURIComponent(s); } catch (e) { /* malformed escape — raw test still applies */ }
  return s.indexOf('/smilies/') !== -1 || s.indexOf('/smilie.') !== -1
    || d.indexOf('/smilies/') !== -1 || d.indexOf('/smilie.') !== -1;
}

// Image-page resolution: some hosts embed a RE-ENCODED copy (random uuid,
// /th/ directory, ...) while the original full-quality file is only linked
// from the image's own landing page (/img/<short-id>, no extension). The
// landing href is captured at extraction; the page is fetched and parsed
// for its direct-image carriers when quality matters (viewer, downloads).
export function imagePageHref(href) {
  try {
    const u = new URL(String(href || ''), 'https://x.invalid');
    if (!/^https?:$/.test(u.protocol)) return '';
    if (!/^\/img\/[A-Za-z0-9_-]{3,64}$/.test(u.pathname)) return '';
    return u.origin + u.pathname;
  } catch (e) { return ''; }
}
// Ordered direct-image candidates from a landing page's HTML, by carrier
// trust: meta-refresh redirect > og:image/twitter:image > <img src> > <a>
// links. Signed URLs (?s=…) keep their query verbatim.
export function parseImagePage(html) {
  const h = String(html || '');
  if (!h) return [];
  const out = [];
  const unesc = (s) => s.replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  const IMG_EXT = /\.(jpe?g|png|webp|gif|avif)([?#]|$)/i;
  const push = (s) => {
    const t = unesc(String(s || '')).trim();
    if (/^https?:\/\//i.test(t) && IMG_EXT.test(t) && out.indexOf(t) === -1) out.push(t);
  };
  const rf = h.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"']+)["']/i)
    || h.match(/<meta[^>]+content=["'][^"']*url=([^"']+)["'][^>]+http-equiv=["']?refresh["']?/i);
  if (rf) push(rf[1]);
  const ogs = h.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]+content=["']([^"']+)["']/gi);
  for (const m of ogs) push(m[1]);
  const ogs2 = h.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["']/gi);
  for (const m of ogs2) push(m[1]);
  const imgs = h.matchAll(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi);
  for (const m of imgs) push(m[1]);
  const links = h.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["']/gi);
  for (const m of links) push(m[1]);
  return out;
}
// JSON data endpoint answer for image landing pages: {image:{original_url}}
// — the SPA's own API carries the direct, UNSIGNED original.
export function parseImageApiResponse(text) {
  try {
    const j = JSON.parse(String(text || ''));
    const im = j && j.image;
    const u = im && String(im.original_url || '');
    if (u && /^https?:\/\//.test(u)) return u;
  } catch (e) { /* not JSON — fall back to the page parser */ }
  return '';
}
// HQ image candidate chain: post-body images with a `.md`/`.th` marker
// before the extension are MEDIUM variants. Two shapes: marker-only
// `<uuid>.md.jpg` (full size = same path minus the marker) and
// dims-prefixed `<WxH>_<name>.md.jpg`. Shape-based only (no hostnames);
// hosts without the marker never enter the chain. Candidates walk
// drop-marker(+dims) → drop-marker → the post URL itself.
export const HQ_IMG_RE = /^(.*\/)(.+)\.(md|th)\.(jpe?g|png|webp|gif)$/i;
export function hqCandidates(url) {
  const m = String(url || '').match(HQ_IMG_RE);
  if (!m) return [url];
  const d = m[2].match(/^(\d+x\d+)_(.+)$/);
  const cands = [m[1] + (d ? d[2] : m[2]) + '.' + m[4]]; // drop marker (+ dims if present)
  if (d) cands.push(m[1] + m[2] + '.' + m[4]);            // drop marker, keep dims
  cands.push(url);
  return cands;
}
// Album pages (path /a/<id>, no extension): hosts that group many files
// behind one landing page. Cross-host callers also guard against the
// forum's own /a/ routes (same test the /d/ reclassification uses).
export function isAlbumPageUrl(u) {
  const s = String(u || '');
  if (!/^https?:\/\//i.test(s)) return false;
  const path = s.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
  return /^\/a\/[A-Za-z0-9_-]{3,64}$/.test(path);
}

// Server-rendered album page parser: each grid item block carries the
// filename in a title attr, a download href (/f/<slug>) and an absolute
// thumbnail img. Archive/other extensions are skipped — only playable
// media becomes a grid child. Relative hrefs resolve against the album
// page URL. Returns [{url, kind, thumb}].
export function parseAlbumPage(html, baseUrl) {
  const h = String(html || '');
  const out = [];
  if (!h) return out;
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  // split on the item-block class marker; each chunk is one item's markup
  const blocks = h.split(/class="[^"]*\btheItem\b/).slice(1);
  for (const b of blocks) {
    const t = b.match(/title="([^"]{1,300})"/);
    const name = t ? unesc(t[1]) : '';
    const href = b.match(/href="(\/f\/[A-Za-z0-9_-]{3,64})"/);
    if (!name || !href) continue;
    const kind = VID_EXT_RE.test(name) ? 'video' : (IMG_EXT_RE.test(name) ? 'image' : '');
    if (!kind) continue; // archives / unknown — not grid media
    let url = '';
    try { url = new URL(href[1], baseUrl).href; } catch (e) { continue; }
    const th = b.match(/src="(https?:\/\/[^"]+)"/); // icons are relative — absolute srcs only
    out.push({ url: url, kind: kind, thumb: th ? unesc(th[1]) : '' });
  }
  return out;
}

// JSON album API parser (SPA hosts whose /a/ page is an empty shell but
// expose <origin>/api/albums/<id>): images[] entries carry the DIRECT
// original url plus a thumb; kind comes from mime. pageId is the item's
// own landing-page id — used to dedup against the same image embedded in
// a post at medium quality. Returns {children, lastPage} | null.
export function parseAlbumApiResponse(text) {
  try {
    const j = JSON.parse(String(text || ''));
    if (!j || !Array.isArray(j.images)) return null;
    const children = [];
    for (const im of j.images) {
      if (!im || typeof im.original_url !== 'string' || !/^https?:\/\//.test(im.original_url)) continue;
      const mime = String(im.mime || '');
      const kind = mime.indexOf('video/') === 0 ? 'video' : (mime.indexOf('image/') === 0 ? 'image' : '');
      if (!kind) continue;
      children.push({
        url: im.original_url,
        kind: kind,
        thumb: typeof im.thumb_url === 'string' ? im.thumb_url : '',
        pageId: typeof im.encoded_id === 'string' ? im.encoded_id : ''
      });
    }
    const pag = j.pagination || {};
    const last = Math.max(1, parseInt(pag.last_page, 10) || 1);
    return { children: children, lastPage: last };
  } catch (e) { return null; }
}

