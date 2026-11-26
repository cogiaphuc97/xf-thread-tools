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
// Attachment servers that store video files under /data/video/<dir>/<id>-<hash>.mp4
// render a sibling thumb at /data/attachments/<dir>/<id>-<hash>.jpg — same
// id and hash, different family dir and extension. Inline <video> posts
// carry no poster and no unfurl card, so this sibling is the only preview
// source. Returns '' for any other URL shape (non-video dirs, foreign
// extensions, non-http).
export function derivedVideoPoster(u) {
  const m = String(u || '').match(/^(https?:\/\/[^?#]+?)\/data\/video\/(\d+)\/([A-Za-z0-9_-]+)\.mp4(?:[?#]|$)/);
  return m ? m[1] + '/data/attachments/' + m[2] + '/' + m[3] + '.jpg' : '';
}

// Forum "external link exit" gates: the href points back at the forum
// itself (an interstitial the addon serves) while the real target is the
// anchor's visible text (XF autolinks render the full URL) or a base64url
// token in a t=v1.<b64>.<sig> query param. Shape-based — no gate path or
// hostname is matched, so it works for any forum running such a gate.
// Returns the unwrapped absolute URL, or '' when nothing unwrap-safe was
// found (caller keeps the raw href).
export function unwrapExitLink(href, text, forumOrigin) {
  const h = String(href || '');
  const t = String(text || '').trim();
  let u = null;
  try { u = new URL(h, forumOrigin); } catch (e) { return ''; }
  if (u.origin !== forumOrigin) return ''; // only forum-internal hrefs are gates
  if (/^https?:\/\/\S+$/i.test(t)) {
    try { if (new URL(t).origin !== forumOrigin) return t; } catch (e) { /* text not a parseable URL */ }
  }
  const tok = u.searchParams.get('t') || '';
  const b = tok.match(/^v1\.([A-Za-z0-9_-]+)\./);
  if (b) {
    try {
      const pad = '='.repeat((4 - (b[1].length % 4)) % 4);
      const d = atob(b[1].replace(/-/g, '+').replace(/_/g, '/') + pad);
      if (/^https?:\/\//i.test(d)) return d;
    } catch (e) { /* malformed token */ }
  }
  // other redirect-gate families: plain absolute-URL query params
  for (const k of ['url', 'u', 'to', 'target', 'link']) {
    const v = u.searchParams.get(k) || '';
    if (/^https?:\/\//i.test(v)) {
      try { if (new URL(v).origin !== forumOrigin) return v; } catch (e) { /* skip */ }
    }
  }
  return '';
}

// Album pages (path /a/<id>): hosts that group many files behind one
// landing page. The id charset allows dots — XF-style keys are
// `<slug>.<id>` (e.g. /a/some-model-album-pics.3tkY1 — shape from a
// real-world miss), and a dot was what silently dropped such albums at
// CLASSIFICATION.
// Cross-host callers also guard against the forum's own /a/ routes (same
// test the /d/ reclassification uses).
export function isAlbumPageUrl(u) {
  const s = String(u || '');
  if (!/^https?:\/\//i.test(s)) return false;
  const path = s.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
  return /^\/a\/[A-Za-z0-9_.-]{3,64}$/.test(path);
}

// Album display name from the album page HTML <title> (pure). Empty string
// when absent — callers fall back to the URL slug. The page is already
// fetched for child parsing, so this costs no extra request.
export function parseAlbumTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([^<]{1,300})<\/title>/i);
  if (!m) return '';
  return m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// Album group display name (pure): parsed page/API title, else the
// /a/<slug> identifier from the URL (user spec 0.21, Round 8).
export function albumDisplayName(url, name) {
  const nm = String(name || '').trim();
  if (nm) return nm;
  const s = String(url || '');
  const m = s.match(/\/a\/([A-Za-z0-9_.-]{3,64})$/);
  return m ? m[1] : (s || '?');
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
  // ---- bunkr-shaped album pages (0.27): the server-rendered .theItem grid
  // is gone — the file list ships as a JS array assignment inside a script
  // tag (the visual grid hydrates from it client-side):
  //   window.albumFiles = [ { id: 1, name: "uuid.ext",
  //     original: 'Pretty Name.jpg', slug: 'abc123', size: 123 ,
  //     timestamp: "…" }, … ];
  // When the array carries media it IS the authoritative list — stray markup
  // elsewhere on the page cannot inject junk children (the old parser's
  // exactly-one-stray-match bug). Children point at the /f/<slug> file page
  // with thumb '' (styled tile + poster fetch at the cell; the /f/ resolver
  // carries the direct stream). Escaped \' inside names unescapes.
  const af = h.match(/window\.albumFiles\s*=\s*\[([\s\S]*?)\][\s\S]*?<\/script>/);
  if (af) {
    const jsUnesc = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    for (const b of af[1].split('\n},\n')) {
      const om = b.match(/original:\s*'((?:\\.|[^'])*)'/);
      const sm = b.match(/slug:\s*'([^']*)'/);
      if (!om || !sm || !sm[1]) continue;
      const name = jsUnesc(om[1]);
      const kind = VID_EXT_RE.test(name) ? 'video' : (IMG_EXT_RE.test(name) ? 'image' : '');
      if (!kind) continue; // archives / unknown — not grid media
      let url = '';
      try { url = new URL('/f/' + sm[1], baseUrl).href; } catch (e) { continue; }
      out.push({ url: url, kind: kind, thumb: '', name: name });
    }
    if (out.length) return out;
  }
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
  // ---- erome-shaped album pages (0.26 US-002): server-rendered lightbox
  // markup. Images: <div class="img" data-src="FULL"> (data-src is the
  // original; the inline img shares its URL — reuse it as the tile thumb,
  // the thumb-cache caps it). Videos: <video poster=...><source src=...
  // res='720'> — lightbox and inline players duplicate each video; dedupe
  // by src, keep the highest-res source.
  const seen = new Set(out.map((c) => c.url));
  for (const m of h.matchAll(/<div\b[^>]*class="img"[^>]*data-src="(https?:\/\/[^"]+)"/g)) {
    const u = unesc(m[1]);
    if (!u || seen.has(u) || !IMG_EXT_RE.test(u)) continue;
    seen.add(u);
    out.push({ url: u, kind: 'image', thumb: u });
  }
  for (const m of h.matchAll(/<video\b([^>]*)>([\s\S]*?)<\/video>/g)) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    const pm = attrs.match(/poster="([^"]+)"/);
    let best = '', bestRes = -1;
    for (const s of body.matchAll(/<source\b[^>]*\ssrc="([^"]+)"[^>]*>/g)) {
      const rm = s[0].match(/res=["'](\d+)["']/);
      const res = rm ? parseInt(rm[1], 10) : 0;
      if (res > bestRes || (res === bestRes && !best)) { best = unesc(s[1]); bestRes = res; }
    }
    if (best && !seen.has(best) && VID_EXT_RE.test(best)) {
      seen.add(best);
      out.push({ url: best, kind: 'video', thumb: pm ? unesc(pm[1]) : '' });
    }
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
    // album display name (SPA hosts): name or title field, else '' -> slug fallback
    const nm = typeof j.name === 'string' ? j.name : (typeof j.title === 'string' ? j.title : '');
    return { children: children, lastPage: last, name: nm };
  } catch (e) { return null; }
}


// pairUnfurlPosters (0.25.2): some hosts embed a video as a plain
// <video> tag preceded by XF's link-preview card, and the card's
// bbCodeBlockUnfurl-image IS the poster frame (the video file itself has
// no og:image to fetch). seq is a document-ordered flat walk of the post
// body — ['u', posterUrl, 'v', videoSrc, …] — collected by one combined
// querySelectorAll. A video pairs with the NEAREST PRECEDING unconsumed
// unfurl image (XF renders the card right before its video); an unfurl
// with no following video (image-host cards) is ignored, and a video with
// no preceding card stays posterless.
export function pairUnfurlPosters(seq) {
  const out = {};
  let pending = '';
  for (let i = 0; i + 1 < seq.length; i += 2) {
    if (seq[i] === 'u') pending = seq[i + 1];
    else if (seq[i] === 'v' && pending) { out[seq[i + 1]] = pending; pending = ''; }
  }
  return out;
}

// ---- gofile-shaped SPA albums (0.26 US-003) ----
// These hosts serve an empty app shell for /d/<id> and answer content from
// a JSON API at api.<registrable-domain> with a guest-account token. The
// /d/ path shape is shared with the file-page VIDEO adapter family, so
// album routing is gated by a USER-SET host list (settings.albumHosts) —
// the committed default is empty and carries no hostname.
export function albumHostMatches(url, hosts) {
  let h = '';
  try { h = new URL(String(url || '')).hostname.toLowerCase(); } catch (e) { return false; }
  if (!h) return false;
  const list = Array.isArray(hosts) ? hosts : [];
  for (const raw of list) {
    const s = String(raw || '').trim().toLowerCase().replace(/^[*.]+/, '');
    if (s && (h === s || h.slice(-(s.length + 1)) === '.' + s)) return true;
  }
  return false;
}

// pageUrl -> API origin: drop the first DNS label when the host has 3+
// (app host -> registrable domain), then prefix api. No port kept: the
// content API is a separate service, not the page origin.
export function gofileApiOrigin(pageUrl) {
  try {
    const u = new URL(String(pageUrl || ''));
    const parts = u.hostname.split('.');
    const dom = parts.length > 2 ? parts.slice(-2).join('.') : u.hostname;
    return u.protocol + '//api.' + dom;
  } catch (e) { return ''; }
}

// ---- cyberdrop-shaped server-rendered albums (0.27) ----
// The /a/ page lists files as anchors <a id="file" href="/f/<id>"> (attr
// order varies); the direct url is NOT in the page — a public per-file
// info API carries it, with the final url one auth hop further:
//   GET <api-origin>/api/file/info/<id> -> {name|filename, auth_url}
//   GET <auth_url>                      -> {url}
export function parseCyberdropFileAnchors(html) {
  const h = String(html || '');
  const out = [];
  const seen = new Set();
  for (const m of h.matchAll(/<a\b([^>]*)>/g)) {
    const attrs = m[1] || '';
    if (!/(?:^|\s)id=["']file["'](?:\s|$)/.test(attrs)) continue;
    const href = attrs.match(/href=["']\/f\/([A-Za-z0-9_.-]{1,64})["']/);
    if (!href || seen.has(href[1])) continue;
    seen.add(href[1]);
    out.push(href[1]);
  }
  return out;
}

// info response -> {name, authUrl} | null (parse failure)
export function parseCyberdropFileinfo(text) {
  try {
    const j = JSON.parse(String(text || ''));
    if (!j || typeof j !== 'object') return null;
    const name = typeof j.filename === 'string' && j.filename ? j.filename : (typeof j.name === 'string' ? j.name : '');
    const authUrl = typeof j.auth_url === 'string' ? j.auth_url : '';
    if (!name || !/^https?:\/\//.test(authUrl)) return null;
    return { name: name, authUrl: authUrl };
  } catch (e) { return null; }
}

// auth response -> direct url | ''
export function parseCyberdropAuth(text) {
  try {
    const j = JSON.parse(String(text || ''));
    const u = j && typeof j.url === 'string' ? j.url : '';
    return /^https?:\/\//.test(u) ? u : '';
  } catch (e) { return ''; }
}

export function gofileAccountsUrl(apiOrigin) {
  return String(apiOrigin || '').replace(/\/+$/, '') + '/accounts';
}

export function gofileContentsUrl(apiOrigin, contentId, token) {
  return String(apiOrigin || '').replace(/\/+$/, '') + '/contents/' + encodeURIComponent(String(contentId || '')) + '?wt=' + encodeURIComponent(String(token || ''));
}

// POST /accounts response -> guest token ('' on any parse failure)
export function parseGofileAccounts(text) {
  try {
    const j = JSON.parse(String(text || ''));
    const tok = j && j.data && j.data.token;
    return typeof tok === 'string' && tok ? tok : '';
  } catch (e) { return ''; }
}

// GET /contents/<id> response -> {children:[{url,kind,thumb}], name} or
// null on parse failure (caller treats null as a FETCH FAILURE, [] as a
// resolved-empty album). Files only — folder children are skipped (nested
// folders are rare in shared media links; v1 stays flat).
export function parseGofileContents(text) {
  try {
    const j = JSON.parse(String(text || ''));
    const d = j && j.data;
    if (!d || typeof d !== 'object' || !d.children || typeof d.children !== 'object') return null;
    const children = [];
    for (const c of Object.values(d.children)) {
      if (!c || c.type === 'folder') continue;
      const link = typeof c.link === 'string' ? c.link : '';
      if (!/^https?:\/\//.test(link)) continue;
      const name = typeof c.name === 'string' ? c.name : '';
      const mime = String(c.mimetype || c.mimeType || '');
      let kind = '';
      if (/^image\//i.test(mime)) kind = 'image';
      else if (/^video\//i.test(mime)) kind = 'video';
      else if (name) kind = VID_EXT_RE.test(name) ? 'video' : (IMG_EXT_RE.test(name) ? 'image' : '');
      if (!kind) continue;
      children.push({ url: link, kind: kind, thumb: '' });
    }
    return { children: children, name: typeof d.name === 'string' ? d.name : '' };
  } catch (e) { return null; }
}
