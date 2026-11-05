// ==UserScript==
// @name         xf-thread-tools
// @namespace    xf-thread-tools
// @version      0.7.43
// @description  XenForo 2: sort thread posts by reaction count across all pages (cached) + floating media panel (images / external links).
// @author       xf-thread-tools
// @match        *://*/threads/*
// @match        *://*/t/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @noframes
// @updateURL   https://raw.githubusercontent.com/cogiaphuc97/xf-thread-tools/main/xf-thread-tools.user.js
// @downloadURL https://raw.githubusercontent.com/cogiaphuc97/xf-thread-tools/main/xf-thread-tools.user.js
// ==/UserScript==

/*
 * Plan: .omc/plans/2026-10-29-xf-thread-tools.md (steps 1-9).
 * The four pure functions (parseReactionCount, filterLinks, sortPosts, estimateSize)
 * touch no DOM and no GM_* API; they are UMD-exported at the bottom for node:test.
 * All browser/GM/DOM code runs only when the runtime guard (step 2) passes.
 */

(function () {
  'use strict';

  /* =====================================================================
   * Constants (step 1 config) + PURE FUNCTIONS — no DOM, no GM_*
   * ===================================================================== */

  const SETTINGS_KEY = 'xfThreadTools:settings';
  const DEFAULT_CAP_BYTES = 100 * 1024 * 1024; // 100 MB persistence cap
  const DEFAULT_SETTINGS = {
    delayMs: 350,                // politeness delay between page fetches
    chunkSize: 50,               // sorted-view render chunk
    rowCap: 500,                 // panel rows rendered before "show more" (Links tab)
    capBytes: DEFAULT_CAP_BYTES, // IndexedDB persistence cap
    autoFetch: 1,                // 1 = fetch the whole thread in background on page load
    basePath: '',                // '' = forum at site root; '/forum' for subpath installs
    forceAnimations: 0,          // 1 = run UI animations even under prefers-reduced-motion
    mediaGroup: 'flat',          // media grid grouping: flat | post | page | user
    selectors: {}                // per-site selector overrides, merged over BASE_SEL
  };
  const BASE_SEL = {
    post: 'article.message--post[data-content^="post-"]',
    postBody: '.bbWrapper',
    author: '.message-name',
    date: 'time[datetime]',
    reactionsBar: '.reactionsBar.js-reactionsList',
    reactionsLink: 'a.reactionsBar-link',
    image: 'img.bbImage',
    attachment: 'a[href*="attachments"]',
    quote: 'blockquote.bbCodeBlock--quote',
    signature: '.message-signature',
    pageNav: '.pageNav',
    pageNavPage: '.pageNav-page',
    toolbar: '.p-title-pageAction, .p-title .buttonGroup, .p-title',
    toolbarFallback: '.pageContent, .p-body'
  };

  // --- step 5: reaction count text parser (EN + VI), pure ---
  const OTHERS_RE = /(?:and|và)\s+(\d+)\s+(?:others|người khác)\s*$/i;
  const NAME_SEP_RE = /\s+(?:and|và)\s+/i;

  /**
   * Parse an XF reactionsBar-link text into a reaction count.
   * Observed live forms (2026-10-29): 'Aman899'; 'Em Bị Đâm and TrìnhCa8';
   * 'longdevilk3, thead, adidasphatt and 15 others'; VI: 'A, B và C', 'X và 5 người khác'.
   * Names are split on ',' and on terminal 'and'/'và'; a trailing
   * 'and|và N others|người khác' contributes N. Empty/null/no-bar input yields 0.
   */
  function parseReactionCount(text) {
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

  function hostKey(host) {
    return String(host || '').toLowerCase().replace(/^www\./, '');
  }

  /**
   * Filter raw post-body hrefs down to external http(s) links (pure).
   * Drops: pure-# anchors, non-http(s), same-host links (www-insensitive,
   * port-aware), /members/ profile links, /post-N permalinks/share gadgets.
   */
  function filterLinks(hrefList, ownHost) {
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

  const IMG_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp)(?:[?#]|$)/i;
  const VID_EXT_RE = /\.(mp4|webm|mkv|mov|avi|m4v)(?:[?#]|$)/i;

  /**
   * Partition post-body hrefs into media links (image/video file URLs, which
   * belong on the Files/Videos tabs, not Links) and page links (pure).
   */
  // Boilerplate fingerprint: a URL that appears in the posts of N or more
  // DISTINCT authors is signature/"sent via app" footer content, not something
  // any one author posted. Catches both real signatures (flickr gear lists,
  // proxy-wrapped banner images) and forum-injected footers that live inside
  // the post body markup with no structural marker at all.
  function boilerplateUrls(records, minAuthors) {
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
  function isSmilieUrl(u) {
    const s = String(u || '');
    if (!s) return false;
    let d = s;
    try { d = decodeURIComponent(s); } catch (e) { /* malformed escape — raw test still applies */ }
    return s.indexOf('/smilies/') !== -1 || s.indexOf('/smilie.') !== -1
      || d.indexOf('/smilies/') !== -1 || d.indexOf('/smilie.') !== -1;
  }

  // ---------- bulk download: pure helpers ----------
  // Filenames are embedded in a zip this script writes itself (STORE — media
  // is already compressed, so re-compressing gains nothing). Every segment is
  // sanitized (no traversal, no control chars) and capped at 120 chars.
  function sanitizeFileSeg(s) {
    return String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._-]+/, '').replace(/\.{2,}/g, '.').slice(0, 120);
  }
  // Outer zip FILE name — deliberately unlike sanitizeFileSeg: the anchor
  // download attribute takes Unicode + spaces, so the Vietnamese title stays
  // readable. Only filesystem-illegal characters die. (Zip ENTRY names keep
  // using sanitizeFileSeg — those live inside the zip we write by hand.)
  function siteTagFromHost(host) {
    const parts = String(host || '').toLowerCase().replace(/^www\./, '').split(':')[0].split('.').filter(Boolean);
    const core = parts.length >= 2 ? parts[parts.length - 2] : (parts[0] || 'site');
    return core.charAt(0).toUpperCase() + core.slice(1);
  }
  function cleanThreadTitle(raw) {
    let t = String(raw || '').replace(/[\x00-\x1f]+/g, ' ').trim();
    t = t.replace(/^(?:\s*\[[^\]]{0,40}\]\s*)+/, ''); // leading [tag] groups
    const bar = t.indexOf(' | ');
    if (bar > 0) t = t.slice(0, bar); // trailing " | Forum" suffix
    return t.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  }
  function zipFileName(tag, title) {
    const t = cleanThreadTitle(title);
    if (!t) return (tag || 'thread') + '.zip';
    return '[' + (tag || 'Site') + '] ' + t + '.zip';
  }
  function dlBasename(url, kind, idx) {
    let b = '';
    try { b = new URL(url).pathname.split('/').filter(Boolean).pop() || ''; } catch (e) { /* keep '' */ }
    b = sanitizeFileSeg(b);
    // attachment URLs end without a real extension (`/attachments/name-jpg.12345/`)
    // — a `.12345` ext is unopenable. Force a kind-based one when missing.
    const extOk = /\.(jpe?g|png|gif|webp|avif|jfif|bmp|mp4|webm|mov|mkv|m4v)$/i.test(b);
    const dflt = kind === 'video' ? '.mp4' : '.jpg';
    if (!b) b = (kind === 'video' ? 'video-' : 'image-') + (idx + 1) + dflt;
    else if (!extOk) b = b.replace(/\.+$/, '') + dflt;
    return b;
  }

  // HQ image candidate chain: post-body images with a `.md`/`.th` marker
  // before the extension are MEDIUM variants. Two shapes: marker-only
  // `<uuid>.md.jpg` (full size = same path minus the marker) and
  // dims-prefixed `<WxH>_<name>.md.jpg`. Shape-based only (no hostnames);
  // hosts without the marker never enter the chain. Candidates walk
  // drop-marker(+dims) → drop-marker → the post URL itself.
  const HQ_IMG_RE = /^(.*\/)(.+)\.(md|th)\.(jpe?g|png|webp|gif)$/i;
  function hqCandidates(url) {
    const m = String(url || '').match(HQ_IMG_RE);
    if (!m) return [url];
    const d = m[2].match(/^(\d+x\d+)_(.+)$/);
    const cands = [m[1] + (d ? d[2] : m[2]) + '.' + m[4]]; // drop marker (+ dims if present)
    if (d) cands.push(m[1] + m[2] + '.' + m[4]);            // drop marker, keep dims
    cands.push(url);
    return cands;
  }
  // Turn the current media list into download jobs. Images walk the same HQ
  // candidate chain as the grid (full-size first, marker variant fallback) so
  // a download run grabs never-rendered cells at full size too; embed player
  // tiles have no direct media file and are counted as skips. Duplicate URLs
  // are dropped. Names are seq-prefixed so two posts sharing a basename
  // cannot clobber each other inside the zip.
  function buildDlJobs(items) {
    const seen = new Set();
    const jobs = [];
    let skip = 0;
    for (const it of (Array.isArray(items) ? items : [])) {
      if (it.kind === 'embed') { skip++; continue; }
      const base = it.kind === 'video' ? String(it.url || '').replace(/#.*$/, '') : String(it.url || '');
      if (!base || seen.has(base)) continue;
      seen.add(base);
      const cands = it.kind === 'image' ? hqCandidates(base) : [base];
      jobs.push({
        cands: cands,
        kind: it.kind,
        name: String(jobs.length + 1).padStart(3, '0') + '_' + dlBasename(cands[0], it.kind, jobs.length)
      });
    }
    return { jobs: jobs, skip: skip };
  }

  // Minimal zip (method 0 / STORE) writer — no dependencies. Layout per
  // PKWARE APPNOTE: per-file local header + bytes, then the central
  // directory, then the end-of-central-directory record. UTF-8 names via the
  // general-purpose flag 0x0800. Offsets/sizes are 32-bit; the caller caps
  // the run well under 4 GB.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function dosDateTime(d) {
    const y = Math.max(1980, d.getFullYear());
    const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    const date = (((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    return { time: time, date: date };
  }
  function u16le(v) { return new Uint8Array([v & 255, (v >>> 8) & 255]); }
  function u32le(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
  function concatU8(list) {
    let n = 0;
    for (const a of list) n += a.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const a of list) { out.set(a, o); o += a.length; }
    return out;
  }
  function zipLocalHeader(nameU8, crc, size, dt) {
    return concatU8([u32le(0x04034b50), u16le(20), u16le(0x0800), u16le(0), u16le(dt.time), u16le(dt.date),
      u32le(crc), u32le(size), u32le(size), u16le(nameU8.length), u16le(0), nameU8]);
  }
  function zipCentralEntry(nameU8, crc, size, dt, offset) {
    return concatU8([u32le(0x02014b50), u16le(20), u16le(20), u16le(0x0800), u16le(0), u16le(dt.time), u16le(dt.date),
      u32le(crc), u32le(size), u32le(size), u16le(nameU8.length), u16le(0), u16le(0), u16le(0), u16le(0),
      u32le(0), u32le(offset), nameU8]);
  }
  function zipEocd(count, cdSize, cdOffset) {
    return concatU8([u32le(0x06054b50), u16le(0), u16le(0), u16le(count), u16le(count), u32le(cdSize), u32le(cdOffset), u16le(0)]);
  }
  // files: [{ name, data: Uint8Array }] -> Uint8Array of the whole zip.
  function zipStoreU8(files) {
    const enc = new TextEncoder();
    const dt = dosDateTime(new Date());
    const parts = [];
    const cds = [];
    let off = 0;
    for (const f of files) {
      const nameU8 = enc.encode(f.name);
      const crc = crc32(f.data);
      const lh = zipLocalHeader(nameU8, crc, f.data.length, dt);
      parts.push(lh, f.data);
      cds.push(zipCentralEntry(nameU8, crc, f.data.length, dt, off));
      off += lh.length + f.data.length;
    }
    const cd = concatU8(cds);
    return concatU8(parts.concat([cd, zipEocd(files.length, cd.length, off)]));
  }

  // Embed-page poster extractor: given the HTML of a video-host /embed/ page,
  // pull a thumbnail URL. Hosts expose og:image / og:image:secure_url, plyr
  // players carry data-poster, plain players a poster= attribute. Decodes the
  // common HTML entities attribute values arrive with. '' when nothing found.
  function parseEmbedPoster(html) {
    const h = String(html || '');
    if (!h) return '';
    const dec = (s) => s
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const pats = [
      /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i,
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /data-poster=["']([^"']+)["']/i,
      /<video[^>]+poster=["']([^"']+)["']/i
    ];
    for (const re of pats) {
      const m = h.match(re);
      if (m && /^https?:\/\//i.test(m[1])) return dec(m[1]);
    }
    return '';
  }

  // Sign-endpoint builder for embed URLs: hosts running the turbo-style
  // player expose <origin>/api/sign?v=<ID> next to their /embed/<ID> pages,
  // returning {success, url} where url is a time-limited direct mp4. ''
  // when the URL is not that shape — caller keeps the iframe player.
  function embedSignUrl(u) {
    try {
      const url = new URL(String(u || ''), 'https://x.invalid');
      if (!/^https?:$/.test(url.protocol)) return '';
      const m = url.pathname.match(/\/embed\/([^/?#]+)/);
      if (!m) return '';
      return url.origin + '/api/sign?v=' + encodeURIComponent(m[1]);
    } catch (e) { return ''; }
  }

  // Sign-response parser: {url, exp} on success (exp parsed from the signed
  // URL's ?exp= seconds), null on anything else.
  function parseSignResponse(text) {
    try {
      const j = JSON.parse(String(text || ''));
      if (j && j.success && typeof j.url === 'string' && /^https?:\/\//.test(j.url)) {
        const m = j.url.match(/[?&]exp=(\d+)/);
        return { url: j.url, exp: m ? parseInt(m[1], 10) : 0 };
      }
    } catch (e) { /* not JSON / error page */ }
    return null;
  }

  // Token-sign parser (bunkr-style sign endpoints answer {token, ex}, and the
  // caller appends ?token=&ex= to the unsigned CDN url themselves).
  function parseSignToken(text) {
    try {
      const j = JSON.parse(String(text || ''));
      if (j && typeof j.token === 'string' && j.token && j.ex) {
        return { token: j.token, exp: parseInt(j.ex, 10) || 0 };
      }
    } catch (e) { /* not JSON / error page */ }
    return null;
  }

  // File-page carrier parser: given the HTML of a host's /v/ or /f/ page,
  // find the direct media. Carriers, in trust order:
  //   1. jsCDN + signUrl vars (bunkr family) — unsigned CDN url + a sign
  //      endpoint that must be called with ?path=<pathname> first
  //   2. og:video / og:video:secure_url meta
  //   3. <video src> / <source src> absolute http
  // Returns {src, sign} | {src} | null.
  function parseVideoPage(html) {
    const h = String(html || '');
    if (!h) return null;
    const unesc = (s) => s.replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    const cdn = h.match(/var\s+jsCDN\s*=\s*"([^"]+)"/);
    const sgn = h.match(/var\s+signUrl\s*=\s*"([^"]+)"/);
    if (cdn && /^https?:\/\//.test(unesc(cdn[1]))) {
      if (sgn && /^https?:\/\//.test(unesc(sgn[1]))) return { src: unesc(cdn[1]), sign: unesc(sgn[1]) };
      return { src: unesc(cdn[1]) };
    }
    const og = h.match(/<meta[^>]+property=["']og:video(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/i)
      || h.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::secure_url|:url)?["']/i);
    if (og && /^https?:\/\//i.test(og[1])) return { src: unesc(og[1]) };
    const st = h.match(/<source[^>]+src=["'](https?:\/\/[^"']+)["']/i)
      || h.match(/<video[^>]+src=["'](https?:\/\/[^"']+)["']/i);
    if (st) return { src: unesc(st[1]) };
    return null;
  }

  // Videos-tab URLs that are actually host file PAGES (the .mp4-looking path
  // 403s or serves HTML as a direct <video> src) — these resolve through
  // parseVideoPage before playback. /v/<name>.mp4 and /f/<something> are the
  // file-page shapes; extension-bearing URLs elsewhere are real direct files.
  function isVideoPageUrl(u) {
    const s = String(u || '');
    if (!/^https?:\/\//i.test(s)) return false;
    const path = s.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
    return /^\/v\/[^/]+\.(mp4|webm|mkv|mov|m4v)$/i.test(path) || /^\/f\/[^/]+$/i.test(path);
  }

  function partitionLinks(hrefList) {
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
  function extractDomain(url) {
    if (typeof url !== 'string' || url === '') return '';
    try { return hostKey(new URL(url).host); } catch (e) { return ''; }
  }

  /**
   * Collapse consecutive same-post link items into one group per post (pure).
   * Items arrive in table order (record order, then link order), so a linear
   * scan is enough. Output: [{ r, pos, urls: [...] }, ...] — one per post.
   */
  function groupLinkItems(items) {
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
  function applyLinkFilters(items, opts) {
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
  function sortPosts(posts) {
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
  function estimateSize(totalBytes, capBytes) {
    const cap = typeof capBytes === 'number' && capBytes > 0 ? capBytes : DEFAULT_CAP_BYTES;
    const total = typeof totalBytes === 'number' && isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
    return { totalBytes: total, capBytes: cap, stopPersist: total > cap };
  }

  /* =====================================================================
   * Step 2: runtime guard — exit silently on non-XF / non-thread pages.
   * In Node (tests) document is undefined and nothing below ever runs.
   * ===================================================================== */
  const rootEl = typeof document !== 'undefined' ? document.documentElement : null;
  if (rootEl && rootEl.id === 'XF' && rootEl.dataset && rootEl.dataset.template === 'thread_view') {
    try {
      main();
    } catch (err) {
      console.warn('[xf-thread-tools] init failed: ' + ((err && err.message) || err));
    }
  }

  /* =====================================================================
   * Browser implementation (steps 3-9). Everything here may touch DOM/GM.
   * ===================================================================== */
  function main() {
    // ---------- settings (GM_setValue-backed; localStorage fallback) ----------
    function readStore(key, def) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(key);
          return v === undefined || v === null ? def : v;
        }
      } catch (e) { /* fall through */ }
      try {
        if (typeof localStorage !== 'undefined') {
          const v = localStorage.getItem(key);
          return v === null ? def : JSON.parse(v);
        }
      } catch (e) { /* fall through */ }
      return def;
    }
    function writeStore(key, val) {
      try {
        if (typeof GM_setValue === 'function') { GM_setValue(key, val); return; }
      } catch (e) { /* fall through */ }
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(val));
      } catch (e) { /* ignore */ }
    }

    const settings = Object.assign({}, DEFAULT_SETTINGS, readStore(SETTINGS_KEY, {}));
    if (!settings.selectors || typeof settings.selectors !== 'object') settings.selectors = {};
    const SEL = Object.assign({}, BASE_SEL, settings.selectors);

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---------- step 3: thread meta ----------
    // XF ships two thread routes: /threads/{slug}.{id} and the short /t/{slug}.{id}.
    // Remember BOTH the prefix and the full slug segment: rebuilt URLs must
    // reuse the exact route the user is on (some sites' WAF/SEO rules 404 or
    // redirect slugless /threads/{id} shapes).
    const route = (function () {
      const m = location.pathname.match(/\/(threads|t)\/([^/?#]+)/);
      if (!m) return null;
      const seg = decodeURIComponent(m[2]);
      const dot = seg.lastIndexOf('.');
      const tail = dot >= 0 ? seg.slice(dot + 1) : seg;
      return { prefix: m[1], seg: seg, id: /^\d+$/.test(tail) ? tail : seg };
    })();
    if (!route) return; // non-standard thread route: stay silent
    const threadId = route.id;

    const threadKey = threadId;

    function getCurrentPage() {
      const m = location.pathname.match(/\/page-(\d+)/);
      return m ? parseInt(m[1], 10) : 1;
    }

    function getPageCount() {
      const nav = document.querySelector(SEL.pageNav);
      if (!nav) return 1;
      let max = 1;
      nav.querySelectorAll(SEL.pageNavPage).forEach((el) => {
        const t = (el.textContent || '').trim();
        if (/^\d+$/.test(t)) max = Math.max(max, parseInt(t, 10));
      });
      if (max === 1) {
        nav.querySelectorAll('a[href*="page-"]').forEach((a) => {
          const m = (a.getAttribute('href') || '').match(/page-(\d+)/);
          if (m) max = Math.max(max, parseInt(m[1], 10));
        });
      }
      return max;
    }

    // ---------- shared state ----------
    const hub = {
      records: new Map(),            // postId -> record
      meta: { threadKey: threadKey, pageCount: getPageCount(), postIds: [], fetchedAt: 0, complete: false },
      progress: { done: 0, total: 0 },
      fetchRunning: false,
      abortRef: null,                // { aborted: boolean }
      pagesDone: new Set(),          // fetched page numbers (resume support)
      capNotice: false,
      partialNotice: false
    };
    let recordsVersion = 0;          // bumped on every records mutation
    let posMap = null;
    let posMapVersion = -1;
    let sorterPending = false;
    let seededPage = -1;             // page number seeded from the live DOM
    let currentRun = null;

    function orderedRecords() {
      const arr = Array.from(hub.records.values());
      arr.sort((a, b) => (a.pageN - b.pageN) || (a.seq - b.seq));
      return arr;
    }

    function posOf(postId) {
      if (!posMap || posMapVersion !== recordsVersion) {
        posMap = new Map(orderedRecords().map((r, i) => [r.postId, i + 1]));
        posMapVersion = recordsVersion;
      }
      return posMap.get(postId);
    }

    function absolutize(u) {
      try { return new URL(u, location.origin).href; } catch (e) { return ''; }
    }

    // ---------- step 5: extractor ----------
    function lazyBodyHtml(bodyEl) {
      const c = bodyEl.cloneNode(true);
      c.querySelectorAll('img').forEach((im) => {
        im.setAttribute('loading', 'lazy');
        im.removeAttribute('data-xf-init');
      });
      return c.innerHTML;
    }

    function extractPost(art, pageN, seq) {
      const dc = art.getAttribute('data-content') || '';
      const postId = dc.indexOf('post-') === 0 ? dc.slice(5) : dc;
      const authorEl = art.querySelector(SEL.author);
      const dateEl = art.querySelector(SEL.date);
      // Signatures carry their OWN .bbWrapper (XF2: aside.message-signature >
      // div.bbWrapper). A post with no/empty body would otherwise extract the
      // signature as the post body — take the first body OUTSIDE the signature.
      let body = null;
      for (const b of art.querySelectorAll(SEL.postBody)) {
        if (!b.closest(SEL.signature)) { body = b; break; }
      }

      let reactionCount = 0;
      const bar = art.querySelector(SEL.reactionsBar);
      if (bar && bar.classList.contains('is-active')) {
        const link = bar.querySelector(SEL.reactionsLink);
        if (link) reactionCount = parseReactionCount(link.textContent);
      }

      const rawLinks = [];
      const images = [];
      const videos = [];
      const embeds = [];
      // Quoted content is a COPY of another post's media/links — collect only
      // what THIS post authored (probe 2026-10-29: 9 of 19 bbImage were inside
      // blockquote.bbCodeBlock--quote on a live page). Signature content is
      // boilerplate the author did not write in this post — skip it too.
      const skip = (el) => !!((el.closest && (el.closest(SEL.quote) || el.closest(SEL.signature))));
      if (body) {
        body.querySelectorAll('a[href]').forEach((a) => {
          if (!skip(a)) rawLinks.push(a.getAttribute('href') || '');
        });
        body.querySelectorAll(SEL.image).forEach((im) => {
          if (skip(im)) return;
          // smilies are not content media: XF marks them with class "smilie"
          // ("smilie--sprite67", "smilie smilie--emoji", …); legacy editors
          // also embed them as plain bbImage <img> whose URL hits /smilies/
          if ([].some.call(im.classList, (t) => t === 'smilie' || t.indexOf('smilie--') === 0)) return;
          // Lazy-loaded images carry a 1×1 svg data-URI placeholder in src;
          // the real URL lives in data-src/data-url (voz-style lazy loading).
          // Placeholder-first means src must be discarded when it is data:/blob:.
          let s = im.getAttribute('src') || '';
          if (/^(data|blob):/i.test(s)) {
            s = im.getAttribute('data-src') || im.getAttribute('data-url') || im.getAttribute('data-lazy-src') || '';
          }
          if (s && !isSmilieUrl(s)) images.push(absolutize(s));
        });
        // HTML5 videos: <video class="videotag"><source src> (site media threads)
        body.querySelectorAll('video').forEach((v) => {
          if (skip(v)) return;
          const srcEl = v.querySelector('source');
          const s = (srcEl && srcEl.getAttribute('src')) || v.getAttribute('src') || '';
          if (s) videos.push(absolutize(s));
        });
        // Third-party embed iframes (video hosts): the real <video> lives in a
        // cross-origin document we cannot read, and its src is a signed URL
        // that expires — the iframe src itself is the only stable, playable
        // identifier. Lazy variants carry the URL in data-src.
        body.querySelectorAll('iframe').forEach((f) => {
          if (skip(f)) return;
          let s = f.getAttribute('src') || '';
          if (!s || /^(data|blob):/i.test(s)) s = f.getAttribute('data-src') || '';
          if (/^https?:/i.test(s)) embeds.push(absolutize(s));
        });
      }
      // XF2 attachment blocks (.message-attachments) sit OUTSIDE .bbWrapper —
      // scan the whole article; video-file attachments go to Videos by extension
      art.querySelectorAll(SEL.attachment).forEach((a) => {
        if (skip(a)) return;
        const h = a.getAttribute('href') || '';
        if (!h) return;
        const abs = absolutize(h);
        if (VID_EXT_RE.test(abs)) videos.push(abs);
        else images.push(abs);
      });

      // media-file anchors (lightbox wraps img.bbImage in <a>) belong on the
      // Files/Videos tabs, not Links — partition before filtering
      const parts = partitionLinks(rawLinks);
      for (const u of parts.imageLinks) images.push(absolutize(u));
      for (const u of parts.videoLinks) videos.push(absolutize(u));
      const imgSet = new Set(images.filter(Boolean));
      const vidSet = new Set(videos.filter(Boolean));
      const embSet = new Set(embeds.filter(Boolean));
      return {
        threadKey: threadKey,
        postId: postId,
        pageN: pageN,
        seq: seq,
        author: authorEl ? (authorEl.textContent || '').trim() : '',
        date: dateEl ? (dateEl.getAttribute('datetime') || '') : '',
        reactionCount: reactionCount,
        bodyHtml: body ? lazyBodyHtml(body) : '',
        links: filterLinks(parts.links, location.host).filter((u) => !imgSet.has(u) && !vidSet.has(u) && !embSet.has(u)),
        images: Array.from(new Set(images.filter(Boolean))),
        videos: Array.from(new Set(videos.filter(Boolean))),
        embeds: Array.from(new Set(embeds.filter(Boolean)))
      };
    }

    function extractPostsFromDoc(doc, pageN) {
      const out = [];
      let seq = 0;
      const arts = Array.from(doc.querySelectorAll(SEL.post));
      for (const art of arts) {
        try { out.push(extractPost(art, pageN, seq)); seq += 1; } catch (e) { /* skip malformed post */ }
      }
      return out;
    }

    function seedLivePage() {
      const page = getCurrentPage();
      if (seededPage === page) return;
      const recs = extractPostsFromDoc(document, page);
      for (const r of recs) hub.records.set(r.postId, r);
      seededPage = page;
      recordsVersion += 1;
      cachePutPosts(recs); // step 5b: postId keyPath dedupes at write
    }

    function measure(rec) {
      try { return JSON.stringify(rec).length * 2; } catch (e) { return 0; } // UTF-16 estimate
    }

    // ---------- step 6: IndexedDB cache with 100 MB cap + memory fallback ----------
    const cache = {
      mode: 'none',
      db: null,
      memPosts: new Map(),
      memThreads: new Map(),
      stopPersist: false,
      totalBytes: 0,

      open() {
        return new Promise((resolve, reject) => {
          let req;
          try { req = indexedDB.open('xf-thread-tools', 1); } catch (e) { reject(e); return; }
          // A pending open that never settles would hang boot forever with no
          // error anywhere — bail to the in-memory cache instead
          const bail = setTimeout(() => { try { req.transaction ? null : null; } catch (e) {} reject(new Error('open timeout')); }, 3000);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('posts')) {
              db.createObjectStore('posts', { keyPath: 'postId' }).createIndex('threadKey', 'threadKey');
            }
            if (!db.objectStoreNames.contains('threads')) {
              db.createObjectStore('threads', { keyPath: 'threadKey' });
            }
          };
          req.onblocked = () => { clearTimeout(bail); reject(new Error('blocked by another connection')); };
          req.onsuccess = () => { clearTimeout(bail); resolve(req.result); };
          req.onerror = () => { clearTimeout(bail); reject(req.error); };
        });
      },

      async init() {
        try {
          if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable');
          this.db = await this.open();
          this.mode = 'idb';
        } catch (err) {
          this.mode = 'memory';
          console.warn('[xf-thread-tools] IndexedDB unavailable (' + ((err && err.message) || err) + ') — session-only in-memory cache.');
        }
      },

      degradeToMemory(err) {
        this.mode = 'memory';
        console.warn('[xf-thread-tools] IndexedDB failed (' + ((err && err.message) || err) + ') — falling back to in-memory cache.');
      },

      putPosts(recs) {
        const self = this;
        if (!recs.length) return Promise.resolve();
        for (const r of recs) {
          this.memPosts.set(r.postId, r);
          this.totalBytes += measure(r);
        }
        const est = estimateSize(this.totalBytes, settings.capBytes);
        if (est.stopPersist && !this.stopPersist) {
          this.stopPersist = true;
          hub.capNotice = true;
          console.warn('[xf-thread-tools] cache cap reached (' + Math.round(est.capBytes / 1048576) + ' MB) — further posts kept in memory only.');
          notify();
        }
        if (this.mode !== 'idb' || this.stopPersist) return Promise.resolve();
        return new Promise((resolve) => {
          let tx;
          try { tx = self.db.transaction('posts', 'readwrite'); } catch (err) { self.degradeToMemory(err); resolve(); return; }
          const st = tx.objectStore('posts');
          for (const r of recs) st.put(r); // keyPath postId -> dedupe (step 5b)
          tx.oncomplete = () => resolve();
          tx.onerror = () => { self.degradeToMemory(tx.error); resolve(); };
          tx.onabort = () => { self.degradeToMemory(tx.error); resolve(); };
        });
      },

      getAllPosts(tk) {
        const self = this;
        if (this.mode === 'idb') {
          return new Promise((resolve) => {
            let req;
            try {
              const tx = self.db.transaction('posts', 'readonly');
              req = tx.objectStore('posts').index('threadKey').getAll(tk);
            } catch (err) { self.degradeToMemory(err); req = null; }
            if (!req) { resolve(self.memPostsFor(tk)); return; }
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => { self.degradeToMemory(req.error); resolve(self.memPostsFor(tk)); };
          });
        }
        return Promise.resolve(this.memPostsFor(tk));
      },

      memPostsFor(tk) {
        const out = [];
        for (const r of this.memPosts.values()) if (r.threadKey === tk) out.push(r);
        return out;
      },

      getThreadMeta(tk) {
        const self = this;
        if (this.mode === 'idb') {
          return new Promise((resolve) => {
            let req;
            try { req = self.db.transaction('threads', 'readonly').objectStore('threads').get(tk); }
            catch (err) { self.degradeToMemory(err); req = null; }
            if (!req) { resolve(self.memThreads.get(tk) || null); return; }
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => { self.degradeToMemory(req.error); resolve(self.memThreads.get(tk) || null); };
          });
        }
        return Promise.resolve(this.memThreads.get(tk) || null);
      },

      putThreadMeta(meta) {
        const self = this;
        this.memThreads.set(meta.threadKey, meta);
        if (this.mode !== 'idb' || this.stopPersist) return Promise.resolve();
        return new Promise((resolve) => {
          let tx;
          try { tx = self.db.transaction('threads', 'readwrite'); } catch (err) { self.degradeToMemory(err); resolve(); return; }
          tx.objectStore('threads').put(meta);
          tx.oncomplete = () => resolve();
          tx.onerror = () => { self.degradeToMemory(tx.error); resolve(); };
          tx.onabort = () => { self.degradeToMemory(tx.error); resolve(); };
        });
      },

      clearThread(tk) {
        const self = this;
        for (const [k, r] of Array.from(this.memPosts.entries())) {
          if (r.threadKey === tk) this.memPosts.delete(k);
        }
        this.memThreads.delete(tk);
        this.totalBytes = 0;
        this.stopPersist = false;
        if (this.mode !== 'idb') return Promise.resolve();
        return new Promise((resolve) => {
          let tx;
          try { tx = self.db.transaction('posts', 'readwrite'); } catch (err) { self.degradeToMemory(err); resolve(); return; }
          const idx = tx.objectStore('posts').index('threadKey');
          let req;
          try { req = idx.openCursor(IDBKeyRange.only(tk)); } catch (err) { resolve(); return; }
          req.onsuccess = () => {
            const cur = req.result;
            if (cur) { cur.delete(); cur.continue(); }
          };
          tx.oncomplete = () => {
            const tx2 = (function () {
              try { return self.db.transaction('threads', 'readwrite'); } catch (err) { self.degradeToMemory(err); return null; }
            })();
            if (!tx2) { resolve(); return; }
            try { tx2.objectStore('threads').delete(tk); } catch (e) { /* already degraded */ }
            tx2.oncomplete = () => resolve();
            tx2.onerror = () => resolve();
          };
          tx.onerror = () => { self.degradeToMemory(tx.error); resolve(); };
          tx.onabort = () => { self.degradeToMemory(tx.error); resolve(); };
        });
      }
    };

    function cachePutPosts(recs) { cache.putPosts(recs).catch(() => {}); }

    // ---------- step 4: sequential, abortable, stop-with-partial fetcher ----------
    function threadUrl(suffix) {
      return location.origin + settings.basePath + '/' + route.prefix + '/' + route.seg + suffix;
    }

    async function runFetch(force) {
      hub.fetchRunning = true;
      hub.abortRef = { aborted: false };
      hub.partialNotice = false;
      let warned = false;
      const warnOnce = (msg) => {
        if (warned) return;
        warned = true;
        hub.partialNotice = true;
        console.warn('[xf-thread-tools] ' + msg + ' — keeping partial data.');
      };
      try {
        if (force) {
          // refresh deletes old records first
          await cache.clearThread(threadKey);
          hub.records.clear();
          hub.pagesDone.clear();
          recordsVersion += 1;
          seededPage = -1;
          clearVRows(); // rebuilt records -> cached rows are stale
        }
        seedLivePage(); // current page comes free from the live DOM
        if (seededPage > 0) hub.pagesDone.add(seededPage);
        const total = hub.meta.pageCount;
        hub.progress = { done: 0, total: total };
        notify();
        for (let n = 1; n <= total; n++) {
          if (hub.abortRef.aborted) break;
          if (n === seededPage) { hub.progress.done = n; notify(); continue; }
          if (!force && hub.pagesDone.has(n)) { hub.progress.done = n; notify(); continue; } // resume: page already cached
          let html = null;
          try {
            const res = await fetch(threadUrl('/page-' + n), { credentials: 'include' });
            if (!res.ok) { warnOnce('fetch stopped: HTTP ' + res.status + ' on page ' + n); break; }
            html = await res.text();
          } catch (err) {
            warnOnce('fetch stopped: network error on page ' + n + ' (' + ((err && err.message) || err) + ')');
            break;
          }
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const recs = extractPostsFromDoc(doc, n);
          for (const r of recs) hub.records.set(r.postId, r);
          recordsVersion += 1;
          cachePutPosts(recs);
          hub.pagesDone.add(n);
          hub.progress.done = n;
          notify();
          if (n < total && !hub.abortRef.aborted && settings.delayMs > 0) await sleep(settings.delayMs);
        }
        const complete =
          (!hub.abortRef.aborted && !warned && !cache.stopPersist) ||
          (hub.meta.pageCount === 1 && seededPage === 1);
        hub.meta.complete = complete;
        hub.meta.fetchedAt = Date.now();
        hub.meta.postIds = orderedRecords().map((r) => r.postId);
        hub.meta.pagesDone = Array.from(hub.pagesDone);
        cache.putThreadMeta(hub.meta).catch(() => {});
      } finally {
        hub.fetchRunning = false;
        hub.abortRef = null;
        notify();
      }
    }

    function ensure(force) {
      if (currentRun) return currentRun;
      // Partial data is usable as-is for the PANEL: never auto-refetch after a
      // cancel or mid-run failure. Explicit refresh (force=true) is the only
      // refetch path. (The SORTER uses ensureForSort — it must not sort a
      // subset silently.)
      if (!force && (hub.meta.complete || hub.records.size > 0)) {
        if (!hub.progress || (!hub.progress.total && hub.meta.pageCount)) {
          hub.progress = { done: hub.meta.complete ? hub.meta.pageCount : hub.pagesDone.size, total: hub.meta.pageCount };
        }
        notify();
        return Promise.resolve();
      }
      currentRun = runFetch(force).catch(() => {}).then(() => { currentRun = null; });
      return currentRun;
    }

    // Sort path: complete data or RESUME the fetch of missing pages (pagesDone
    // skips already-cached pages, so a canceled run never restarts from page 1).
    function ensureForSort() {
      if (hub.meta.complete) return Promise.resolve();
      if (currentRun) return currentRun;
      currentRun = runFetch(false).catch(() => {}).then(() => { currentRun = null; });
      return currentRun;
    }

    function notify() {
      updateProgressText();
      if (sorterPending && !hub.fetchRunning) {
        sorterPending = false;
        sorter.start();
      }
      schedulePanelRender();
    }

    // ---------- step 7: sorter (clone rendering, chunked) ----------
    function setSortBtn(label, busy) {
      const b = document.getElementById('xft-sort-btn');
      if (!b) return;
      b.textContent = label;
      b.disabled = !!busy;
    }

    function buildClone(rec) {
      const art = document.createElement('article');
      art.className = 'message message--post xf-fetched';
      // step 7: clones carry NO data-content / data-xf-init and no action bars,
      // so XF delegated handlers (quote/reply/react) never fire on them.
      art.setAttribute('data-post-id', rec.postId);
      const head = document.createElement('div');
      head.className = 'xft-clone-head';
      const pos = posOf(rec.postId);
      head.textContent = '#' + (pos || rec.postId) + ' · ' + (rec.author || '?') + (rec.date ? ' · ' + rec.date : '');
      const body = document.createElement('div');
      body.className = 'bbWrapper';
      body.innerHTML = rec.bodyHtml || '';
      body.querySelectorAll('img').forEach((im) => im.setAttribute('loading', 'lazy'));
      body.querySelectorAll('[data-xf-init]').forEach((el) => el.removeAttribute('data-xf-init'));
      art.append(head, body);
      return art;
    }

    const sorter = {
      active: false,
      container: null,
      originals: null,   // node references of the original articles (never destroyed)
      anchor: null,      // node right after the last original article at sort time
      marker: null,
      moreBtn: null,
      sorted: null,
      rendered: 0,
      observer: null,

      toggle() {
        if (this.active) { this.restore(); return; }
        if (sorterPending) {
          // second click while waiting for the fetch cancels it; partial data then sorts
          if (hub.abortRef) hub.abortRef.aborted = true;
          return;
        }
        sorterPending = true;
        // NOT disabled: a second click while pending cancels the fetch and
        // sorts the partial data (toggle's abort branch above)
        setSortBtn('⚡ …', false);
        updateProgressText();
        const p = ensureForSort();
        if (!hub.fetchRunning) {
          // data already complete: runFetch resolved synchronously-ish, or cached
          p.then(() => {
            if (sorterPending && !hub.fetchRunning) { sorterPending = false; sorter.start(); }
          });
        }
        // otherwise notify() renders when the fetch run ends
      },

      start() {
        const first = document.querySelector(SEL.post);
        if (!first) { setSortBtn('⚡ Sort by reactions', false); return; }
        this.container = first.parentElement;
        this.originals = Array.from(this.container.querySelectorAll(SEL.post));
        const last = this.originals[this.originals.length - 1];
        this.anchor = last ? last.nextSibling : null;
        this.marker = document.createElement('div');
        this.marker.className = 'xft-sort-marker';
        this.container.insertBefore(this.marker, this.anchor);
        this.moreBtn = document.createElement('button');
        this.moreBtn.type = 'button';
        this.moreBtn.className = 'button xft-show-more';
        this.moreBtn.textContent = 'Show more';
        this.moreBtn.addEventListener('click', () => this.renderChunk());
        this.container.insertBefore(this.moreBtn, this.anchor);
        this.sorted = sortPosts(orderedRecords());
        this.rendered = 0;
        this.active = true;
        this.observer = new IntersectionObserver((entries) => {
          if (entries.some((en) => en.isIntersecting)) this.renderChunk();
        }, { rootMargin: '800px' });
        this.observer.observe(this.moreBtn);
        this.renderChunk();
        // label partial sorts: records exist but the thread is not fully fetched
        // (canceled fetch / HTTP stop / cache cap) — the view is a subset
        setSortBtn(hub.meta.complete ? '↕ Chronological' : '↕ Chronological (partial)', false);
      },

      renderChunk() {
        if (!this.active) return;
        const liveById = new Map(this.originals.map((el) => {
          const dc = el.getAttribute('data-content') || '';
          return [dc.indexOf('post-') === 0 ? dc.slice(5) : dc, el];
        }));
        const end = Math.min(this.rendered + settings.chunkSize, this.sorted.length);
        for (let i = this.rendered; i < end; i++) {
          const rec = this.sorted[i];
          let node = liveById.get(rec.postId);
          if (node && !node.classList.contains('xft-placed')) {
            node.classList.add('xft-placed'); // originals are moved, never destroyed
          } else {
            node = buildClone(rec);
          }
          this.container.insertBefore(node, this.marker);
        }
        this.rendered = end;
        if (end >= this.sorted.length) {
          if (this.observer) this.observer.disconnect();
          if (this.moreBtn) { this.moreBtn.remove(); this.moreBtn = null; }
          if (this.marker) { this.marker.remove(); this.marker = null; }
        } else if (this.moreBtn) {
          this.moreBtn.hidden = false;
        }
      },

      restore() {
        if (this.observer) this.observer.disconnect();
        if (this.moreBtn) { this.moreBtn.remove(); this.moreBtn = null; }
        if (this.marker) { this.marker.remove(); this.marker = null; }
        if (this.container) this.container.querySelectorAll('.xf-fetched').forEach((n) => n.remove());
        if (this.originals) {
          for (const el of this.originals) {
            el.classList.remove('xft-placed');
            this.container.insertBefore(el, this.anchor); // exact original order (AC1)
          }
        }
        this.active = false;
        this.container = null;
        this.originals = null;
        this.anchor = null;
        this.sorted = null;
        this.rendered = 0;
        this.observer = null;
        setSortBtn('⚡ Sort by reactions', false);
      }
    };

    // ---------- step 8: media panel ----------
    let panel = null;
    let progressEl = null;
    let panelBodyEl = null;
    let panelCountEl = null;
    let panelCancelBtn = null;
    let panelRefreshBtn = null;
    let vScrollRaf = 0;
    let vResizeObserver = null;
    let noteEl = null;
    let tabFilesBtn = null;
    let tabLinksBtn = null;
    // Links-tab auto-load: sentinel div observed at the end of the list —
    // reaching it extends rowLimit, so there is no "Show more" button
    let linksSentinel = null;
    let linksObserver = null;
    // Media grid: rows are cached by index and MOVED, never destroyed —
    // scroll re-ranges and fetch-tick rebuilds would otherwise kill lazy
    // image loads mid-flight and leave blank cells. Cleared whenever the
    // item list itself changes identity (tab/sub-tab/search/filter/refresh).
    const vrowCache = new Map();
    // clearing the MAP alone leaves the row ELEMENTS in the DOM as orphans —
    // after a Refresh they keep showing pre-refresh cells (short/blank rows
    // mid-grid). Always detach on clear.
    function clearVRows() {
      // stash the scroll BEFORE detaching rows: removing them collapses the
      // content height, the browser clamps scrollTop to 0, and the rebuild
      // would then "keep" a zero position (the list jumps to the top on
      // every broken-item rerender)
      if (panelBodyEl && vScrollKeep === null) vScrollKeep = panelBodyEl.scrollTop;
      // also stash an ITEM anchor: a numeric scrollTop goes stale the moment
      // a removal rebuild drops rows ABOVE the viewport — the clamp then
      // pulls the view back (the bottom push-back). The anchor is restored
      // to the first visible item's NEW offset after the rebuild.
      if (panelBodyEl && vAnchorKeep === null) vAnchorKeep = captureScrollAnchor(panelBodyEl.scrollTop);
      for (const el of vrowCache.values()) el.remove();
      vrowCache.clear();
      // cleared rows MUST rebuild: with the signature intact, renderPanelBody
      // early-returns on its sig guard and the grid stays empty forever
      // (broken-removal rerenders that change no counts, Refresh when the
      // refetched data has the same shape)
      lastPanelSignature = '';
    }
    // first visible media item + pixel offset inside its row (null when no
    // grid is mounted). Used by clearVRows and the rebuild path.
    let vAnchorKeep = null;
    function captureScrollAnchor(st) {
      if (!vGrid || !vGrid.topPad || !vGrid.topPad.isConnected || !vGrid.items.length || !vGrid.layout.length) return null;
      try {
        const topsA = layoutTops(vGrid.layout, vRowHMeasured || gridRowH());
        let lo = 0, hi = vGrid.layout.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (topsA[mid + 1] > st) hi = mid; else lo = mid + 1; }
        // the search can land on a group HEADER (no idxs) — anchor to the
        // first media ROW at/after it, or the header's offset is measured
        // against the wrong entry height
        while (lo < vGrid.layout.length && !vGrid.layout[lo].idxs) lo += 1;
        const ent = vGrid.layout[lo];
        if (ent && ent.idxs && vGrid.items[ent.idxs[0]]) return { url: vGrid.items[ent.idxs[0]].url, off: Math.max(0, st - topsA[lo]), top: topsA[lo] };
      } catch (e) { /* anchor is best-effort — numeric fallback stands */ }
      return null;
    }
    // top offset of the entry (row) containing an item URL, or null
    function entryTopFor(url, items, lay, pitch) {
      const idx = items.findIndex((it) => it.url === url);
      if (idx < 0) return null;
      const tops = layoutTops(lay, pitch);
      for (let k = 0; k < lay.length; k++) {
        const en = lay[k];
        if (!en.idxs) continue;
        if (en.idxs[0] > idx) return null;
        if (idx <= en.idxs[en.idxs.length - 1]) return tops[k];
      }
      return null;
    }
    let vRowHMeasured = 0;
    let vGrid = null; // live media-grid state {topPad,vrows,bottomPad,items,identity,renderRange}
    // Smilies/stickers rehosted on image hosts carry NO url/class marker —
    // only their size gives them away (measured: forum smilies 24px, imgur
    // stickers 50–129px incl. animated gifs, real photos 320px+). Detected at
    // render; the next panel pass drops them, so stale caches heal without a
    // Refresh. If a real photo ever gets eaten, lower this constant.
    const tinyMediaUrls = new Set();
    // 140, not 200: real content images at 180px (cdn.anh.moe) were being
    // retired — measured stickers top out at 129px, so 140 keeps them out
    // while real media survives
    const TINY_MEDIA_MAX = 140;
    // Media that errored at load: dropped from the grid on the next render.
    // Removals are debounced+batched so a wave of dead links collapses into
    // ONE layout pass instead of cells popping out one by one.
    const brokenMediaUrls = new Set();
    let brokenRerenderTimer = null;
    let vScrollKeep = null; // scroll stashed by clearVRows, consumed by the rebuild
    // while a removal wave animates out, rebuilt rows must NOT re-run the
    // pop-in (the whole grid would flash). Rows built inside this window
    // carry .xft-nopop.
    let popSuppressUntil = 0;
    function scheduleBrokenRerender() {
      if (brokenRerenderTimer) return;
      brokenRerenderTimer = setTimeout(() => {
        brokenRerenderTimer = null;
        // a rebuild mid-wheel is what made the bottom of the list fight the
        // user (restore yanked scrollTop while they scrolled) — hold the
        // removal wave until the wheel stream pauses
        if (performance.now() - lastUserScrollAt < 300) { scheduleBrokenRerender(); return; }
        // NO clearVRows/teardown: detaching every row collapses the content
        // height for a frame, the clamp pulls the view back, and the swap
        // below re-clamps again — the push-back. Sig-based rows make the
        // teardown unnecessary: reset the signature and let renderPanelBody
        // take the growth path (re-point items/layout, re-range in place).
        lastPanelSignature = '';
        schedulePanelRender();
      }, 300);
    }
    // Embed posters: thumbnail URL per embed URL, parsed from the embed page's
    // og:image/data-poster. GM_xmlhttpRequest is required for hosts that send
    // no CORS headers (page fetch() is blocked); a failed look-up caches ''
    // so a tile is never re-fetched. Persisted, pruned to keep storage flat.
    const EMBED_POSTERS_KEY = 'xfThreadTools:embedPosters';
    const embedPosters = readStore(EMBED_POSTERS_KEY, {}) || {};
    const embedPosterInflight = new Map();
    const failedEmbedPosters = new Set();
    // a capped failure is not permanent within the session: the tile retries
    // on its next rebuild (scroll back / tab switch / refresh) once cooled
    const posterCooldown = new Map();
    function saveEmbedPosters() {
      const keys = Object.keys(embedPosters);
      if (keys.length > 300) {
        for (const k of keys.slice(0, keys.length - 300)) delete embedPosters[k];
      }
      writeStore(EMBED_POSTERS_KEY, embedPosters);
    }
    // Poster look-ups run through a serialized queue: firing every visible
    // tile's request at once (a dense Video tab = 8-16 parallel GETs, cookie
    // -less) trips the host's CDN challenges — the first few come back 200,
    // the rest 403 and stayed blank for the whole session. Two concurrent
    // max, 350ms between starts, and each URL retries with backoff before
    // its session cap kicks in.
    const posterNetQueue = [];
    let posterNetActive = 0;
    let posterNetLast = 0;
    const POSTER_NET_MAX = 2;
    const POSTER_NET_GAP = 350;
    function runPosterNet(job) {
      posterNetQueue.push(job);
      pumpPosterNet();
    }
    function pumpPosterNet() {
      if (posterNetActive >= POSTER_NET_MAX || !posterNetQueue.length) return;
      const job = posterNetQueue.shift();
      posterNetActive++; // reserve the slot at SCHEDULE time — the delayed
      // start still counts, or parallel 350ms waits expire together and
      // start several jobs in the same tick (burst is exactly what breaks)
      const now = Date.now();
      const wait = Math.max(0, posterNetLast + POSTER_NET_GAP - now);
      posterNetLast = now + wait; // chain the NEXT start off this reserved
      // time — both slots must not compute from the same stale timestamp
      setTimeout(() => {
        job(() => { posterNetActive--; pumpPosterNet(); });
      }, wait);
    }
    function fetchEmbedPoster(url, cb) {
      if (embedPosterInflight.has(url)) { embedPosterInflight.get(url).push(cb); return; }
      const queue = [cb];
      embedPosterInflight.set(url, queue);
      let attempts = 0;
      const finish = (poster) => {
        if (poster) {
          embedPosters[url] = poster;
          saveEmbedPosters();
        } else {
          // exhausted — not persisted (a transient failure would blank the
          // tile on every future visit); retried on the next page load, and
          // within THIS session after a cool-down (initial-view bursts that
          // later succeed must not leave the first tiles blank forever)
          failedEmbedPosters.add(url);
          posterCooldown.set(url, Date.now() + 30000);
        }
        for (const fn of queue) fn(poster || '');
        embedPosterInflight.delete(url);
      };
      const attempt = () => {
        attempts++;
        // non-200 / network error / challenge page: retry with backoff, then cap
        const retryable = () => {
          if (attempts >= 3) finish('');
          else setTimeout(attempt, 1200 * attempts);
        };
        const ok = (text) => {
          const poster = parseEmbedPoster(text);
          if (poster) finish(poster);
          else retryable(); // 200 but no poster — may be an interstitial
        };
        if (typeof GM_xmlhttpRequest === 'function') {
          runPosterNet((done) => {
            try {
              GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 10000,
                onload: (r) => { done(); if (r && r.status && r.status !== 200) retryable(); else ok(r ? r.responseText : ''); },
                onerror: () => { done(); retryable(); },
                ontimeout: () => { done(); retryable(); }
              });
            } catch (e) { done(); retryable(); }
          });
          return;
        }
        runPosterNet((done) => {
          fetch(url, { credentials: 'omit' })
            .then((r) => r.text())
            .then((t) => { done(); ok(t); })
            .catch(() => { done(); retryable(); });
        });
      };
      attempt();
    }
    function ensureEmbedPoster(url, cb) {
      if (Object.prototype.hasOwnProperty.call(embedPosters, url)) { cb(embedPosters[url]); return; }
      if (failedEmbedPosters.has(url)) {
        if (Date.now() < (posterCooldown.get(url) || 0)) { cb(''); return; }
        failedEmbedPosters.delete(url); // cooled down — try again on this rebuild
      }
      fetchEmbedPoster(url, cb);
    }

    // Direct-stream resolver: for embed URLs whose host exposes a sign
    // endpoint, exchange the embed URL for a time-limited direct mp4 and
    // cache it until ~60s before its exp. Video clicks are single-shot, so
    // no queue — but a cached answer must never outlive its token.
    const EMBED_STREAMS_KEY = 'xfThreadTools:embedStreams';
    const embedStreams = readStore(EMBED_STREAMS_KEY, {}) || {};
    const embedStreamInflight = new Map();
    function saveEmbedStreams() {
      const keys = Object.keys(embedStreams);
      if (keys.length > 200) {
        for (const k of keys.slice(0, keys.length - 200)) delete embedStreams[k];
      }
      writeStore(EMBED_STREAMS_KEY, embedStreams);
    }
    // GM-or-fetch GET returning responseText; single-shot, no queue (stream
    // resolution is click-driven, one URL at a time)
    function gmGetText(url, onOk, onErr) {
      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            timeout: 10000,
            onload: (r) => onOk(r && r.responseText || ''),
            onerror: onErr,
            ontimeout: onErr
          });
          return;
        } catch (e) { /* fall through to fetch */ }
      }
      fetch(url, { credentials: 'omit' })
        .then((r) => r.text())
        .then(onOk)
        .catch(onErr);
    }
    function resolveEmbedStream(url, cb) {
      const now = Math.floor(Date.now() / 1000);
      const c = embedStreams[url];
      if (c && c.exp - now > 60) { cb(c.url); return; }
      const sign = embedSignUrl(url);
      if (!sign && !isVideoPageUrl(url)) { cb(''); return; }
      if (embedStreamInflight.has(url)) { embedStreamInflight.get(url).push(cb); return; }
      const queue = [cb];
      embedStreamInflight.set(url, queue);
      const finish = (hit) => {
        if (hit) {
          embedStreams[url] = { url: hit.url, exp: hit.exp || (now + 600) };
          saveEmbedStreams();
          for (const fn of queue) fn(hit.url);
        } else {
          for (const fn of queue) fn('');
        }
        embedStreamInflight.delete(url);
      };
      // route 2: file-page hosts (bunkr-style /v/ or /f/ pages) — fetch the
      // page, extract the carrier, sign it if the page says so
      const resolveViaPage = () => {
        const pageDone = (text) => {
          const carrier = parseVideoPage(text);
          if (!carrier) { finish(null); return; }
          if (carrier.sign) {
            let path = '';
            try { path = new URL(carrier.src).pathname; } catch (e) { finish(null); return; }
            const signDone = (st) => {
              const tok = parseSignToken(st);
              if (!tok) { finish(null); return; }
              finish({ url: carrier.src + (carrier.src.indexOf('?') === -1 ? '?' : '&')
                + 'token=' + encodeURIComponent(tok.token) + '&ex=' + tok.exp, exp: tok.exp });
            };
            gmGetText(carrier.sign + '?path=' + encodeURIComponent(path), signDone, () => finish(null));
          } else {
            finish({ url: carrier.src, exp: 0 });
          }
        };
        gmGetText(url, pageDone, () => finish(null));
      };
      const ok = (text) => finish(parseSignResponse(text));
      if (sign) {
        gmGetText(sign, ok, () => finish(null));
      } else {
        resolveViaPage();
      }
    }
    let settingsView = null;
    let panelTab = 'files';
    let panelSubTab = 'all';        // media sub-tab: all | image | video
    // every view (tab × sub-tab × group) remembers its own scroll position —
    // switching views restores where the user left THAT list, it must not
    // inherit the scroll of the list being left
    const scrollMemory = {};
    let lastRenderedView = null;
    let lastUserScrollAt = 0; // ANY user scroll (wheel/drag/keys) — restores must not fight an active scroller
    let programmaticScrollAt = 0; // last time OUR code wrote the scroll position (apply/jump/normalizer)
    function viewKey() { return panelTab === 'links' ? 'links' : panelSubTab + ':' + settings.mediaGroup; }
    function saveViewScroll() { if (panelBodyEl) scrollMemory[viewKey()] = panelBodyEl.scrollTop; }
    // smooth for short hops, instant for long virtualized jumps (a smooth
    // glide across 50k px of virtual padding is a blur, not an animation).
    // The bottom target is re-asserted for a few frames: virtualized content
    // height settles as the row pitch is measured, and the first landing can
    // end short of the true bottom.
    function jumpScroll(top) {
      if (!panelBodyEl) return;
      const apply = (n, smooth) => {
        if (!panelBodyEl || n < 0) return;
        const target = top ? 0 : panelBodyEl.scrollHeight - panelBodyEl.clientHeight;
        const far = Math.abs(target - panelBodyEl.scrollTop) > 4000;
        programmaticScrollAt = performance.now();
        panelBodyEl.scrollTo({ top: target, behavior: smooth && !far ? 'smooth' : 'auto' });
        if (!top) requestAnimationFrame(() => apply(n - 1, false));
      };
      apply(3, true);
    }
    let subtabsEl = null;
    let subTabBtns = {};
    let linksBarEl = null;
    let linkSearchEl = null;
    let linkUserSel = null;         // Set of allowed authors; null = no filter
    let linkDomainSel = null;       // Set of allowed domains; null = no filter
    let viewerItems = [];           // media items the fullscreen viewer navigates
    let viewerIndex = -1;
    let viewerKeyHandler = null;
    let rowLimit = settings.rowCap;
    let renderQueued = false;

    function mkBtn(label, fn, cls) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls || 'xft-btn';
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    }

    // dead media URL: mark the containing cell/thumb (CSS shows the ⚠
    // placeholder), not just the <img> that may be replaced by the video retry
    function markMediaBroken(el, url) {
      const host = el.closest('.xft-cell, .xft-vthumb, .xft-vslot');
      (host || el).classList.add('xft-broken');
      if (url) {
        brokenMediaUrls.add(url);
        animateOutCells(url);
        scheduleBrokenRerender();
      }
    }
    // fade every visible cell showing this URL out BEFORE the batched
    // removal re-render, so dead items shrink away instead of popping out
    function animateOutCells(url) {
      const pan = document.getElementById('xft-panel');
      if (!pan) return;
      let n = 0;
      for (const el of pan.querySelectorAll('.xft-cell img, .xft-cell video')) {
        if (el.src === url) {
          const c = el.closest('.xft-cell');
          if (c) { c.classList.add('xft-out'); n++; }
        }
      }
      if (n) popSuppressUntil = performance.now() + 450;
    }
    // loaded media: fade the element in and stop the cell/slot shimmer
    function markMediaLoaded(el) {
      el.classList.add('xft-ok');
      const host = el.closest('.xft-cell, .xft-vslot, .xft-embed-host');
      if (host) {
        host.classList.remove('xft-loading');
        // image viewer slot: size the box to the image's own aspect so
        // vertical photos don't sit in a fixed-width box with black gaps
        if (el.tagName === 'IMG' && host.classList.contains('xft-vimg')) sizeVImgSlot(host, el);
      }
    }

    // image slot sizing: 80vh tall (or width-capped), sized on BOTH axes to
    // the image's aspect. Small images are SCALED UP to fill the slot — a
    // tiny natural size must not leave a big black box. Two phases:
    // 1) sync, from naturalWidth (may lie: EXIF-rotated phone photos)
    // 2) rAF, from the img's RENDERED rect — under max-w/max-h contain CSS
    //    the rect carries the true aspect (EXIF-corrected). The slot is then
    //    re-fit to that aspect and the img is told to fill it 100%
    //    (object-fit:contain UPSCALES, so small images fill the height too)
    function sizeVImgSlot(slot, img) {
      const fit = (ar) => {
        const hMax = window.innerHeight * 0.8;
        const h = Math.min(hMax, Math.min(window.innerWidth * 0.92, 1120) / ar);
        slot.style.width = Math.round(Math.max(120, h * ar)) + 'px';
        slot.style.height = Math.round(Math.max(120, h)) + 'px';
      };
      const ar = img.naturalWidth / img.naturalHeight;
      if (isFinite(ar) && ar > 0) fit(ar);
      requestAnimationFrame(() => {
        if (!slot.isConnected || !img.isConnected) return;
        const b = img.getBoundingClientRect();
        if (b.width > 20 && b.height > 20) {
          fit(b.width / b.height);
          img.style.width = '100%';
          img.style.height = '100%';
          img.style.objectFit = 'contain';
        }
      });
    }

    // HQ image upgrade (0.7.35–0.7.36): some hosts embed a MEDIUM variant in
    // post bodies — filename `<name>.md.jpg` (uuid form, VERIFIED: the
    // original is `<name>.jpg` in the same dir) or `<WxH>_<name>.md.jpg`
    // (dims-prefixed form). Shape-based only (no hostnames); hosts without
    // the .md/.th marker (site attachments, plain uploaders) never enter
    // the chain. Candidates walk drop-marker(+dims) → drop-marker → the
    // post URL itself; the reached stage is remembered per session so
    // rebuilds skip dead candidates. (HQ_IMG_RE + hqCandidates live in the
    // pure section — the bulk-download job builder shares them.)
    const hqStage = new Map();
    const hqTriedRetry = new Set(); // URLs whose HQ candidate got its one retry
    // full-size fetches are much heavier than the medium files the page
    // ships — mounting a big range at once (panel open, jump to bottom)
    // bursts the CDN and the 403s cascade into permanent .md fallbacks.
    // Same serialized queue the poster fetches use: 3 concurrent, spaced.
    const hqNet = { active: 0, queue: [], last: 0 };
    const HQ_NET_MAX = 3;
    const HQ_NET_GAP = 250;
    function runHqNet(job) { hqNet.queue.push(job); pumpHqNet(); }
    function pumpHqNet() {
      if (hqNet.active >= HQ_NET_MAX || !hqNet.queue.length) return;
      const job = hqNet.queue.shift();
      hqNet.active++;
      const now = Date.now();
      const wait = Math.max(0, hqNet.last + HQ_NET_GAP - now);
      hqNet.last = now + wait;
      setTimeout(() => job(() => { hqNet.active--; pumpHqNet(); }), wait);
    }

    // ---------- bulk download (media tab) ----------
    // Fetches every listed file (GM XHR — no CORS limits; fetch() fallback),
    // zips them STORE into ONE <thread title>.zip (Pics/ + Videos/ inside)
    // and saves it via a blob anchor — no GM_download needed, no per-file
    // download prompts. Embed player tiles have no direct media file and are
    // skipped + reported. Fetches are serialized 2-at-a-time for the same
    // CDN-burst reason as the HQ queue; a second click cancels the run.
    const dlRun = { running: false, cancel: false, phase: 'idle', total: 0, done: 0, fail: 0, skip: 0, bytes: 0, lastErr: '' };
    const dlNet = { active: 0, queue: [], last: 0 };
    const DL_NET_MAX = 2;
    const DL_NET_GAP = 400;
    const DL_BYTE_CAP = 3500 * 1024 * 1024; // zip offsets are 32-bit — stop well under 4 GB
    let dlJobs = [];
    let dlBtnEl = null;
    let dlBarEl = null, dlNameEl = null, dlFillEl = null, dlStatsEl = null, dlCancelEl = null, dlCloseEl = null;
    let dlSpeedWin = []; // [{t, b}] byte deltas — rolling 3s window for the speed readout
    let dlDashAt = 0;    // dash repaint throttle stamp
    function threadTitleRaw() {
      const h = document.querySelector('h1.p-title-value');
      let t = '';
      if (h) {
        // thread prefixes/tags ride INSIDE the h1 (XF renders them as label
        // links) — clone and drop them so the tag is not part of the name
        const c = h.cloneNode(true);
        c.querySelectorAll('a,[class*="label"],[class*="prefix"]').forEach((n) => n.remove());
        t = c.textContent || '';
      }
      if (!t.trim()) t = document.title || '';
      return t;
    }
    function zipName() {
      return zipFileName(siteTagFromHost(location.hostname), threadTitleRaw());
    }
    function updateDlBtn() {
      if (!dlBtnEl) return;
      dlBtnEl.textContent = dlRun.running ? 'Stop' : 'Download';
      dlBtnEl.classList.toggle('xft-dl-run', !!dlRun.running);
      dlBtnEl.title = dlRun.running
        ? 'Stop the bulk download'
        : 'Download the ' + panelSubTab + ' list as one zip (Pics/ + Videos/, named after the thread). '
          + 'Embed player tiles are skipped (no direct file).';
    }
    function dlSpeed() {
      const now = performance.now();
      dlSpeedWin = dlSpeedWin.filter((e) => now - e.t < 3000);
      let s = 0;
      for (const e of dlSpeedWin) s += e.b;
      return s / 3;
    }
    function fmtSpeed(bps) {
      if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
      if (bps >= 1024) return (bps / 1024).toFixed(0) + ' KB/s';
      return Math.round(bps) + ' B/s';
    }
    function setStat(el, text) { if (el.textContent !== text) el.textContent = text; }
    // status dashboard: % bar, downloading/downloaded/failed counts, speed, cancel
    function updateDlDash() {
      if (!dlBarEl) return;
      const fetching = dlRun.phase === 'fetch';
      dlBarEl.classList.toggle('xft-dlzip', dlRun.phase === 'zip');
      const finished = dlRun.total ? dlRun.done + dlRun.fail : 0;
      if (fetching) {
        dlFillEl.style.width = (dlRun.total ? Math.floor((finished / dlRun.total) * 100) : 0) + '%';
        while (dlStatsEl.children.length < 5) dlStatsEl.appendChild(document.createElement('span'));
        const c = dlStatsEl.children;
        setStat(c[0], (dlRun.total ? Math.floor((finished / dlRun.total) * 100) : 0) + '%');
        setStat(c[1], '↓ ' + dlNet.active);
        c[1].className = dlNet.active ? 'xft-dl-on' : '';
        setStat(c[2], '✓ ' + dlRun.done);
        c[2].className = 'xft-dl-ok';
        setStat(c[3], '✗ ' + dlRun.fail);
        c[3].className = dlRun.fail ? 'xft-dl-bad' : '';
        setStat(c[4], fmtSpeed(dlSpeed()));
      } else if (dlRun.phase === 'zip') {
        dlFillEl.style.width = '100%';
        dlStatsEl.textContent = 'Zipping ' + dlRun.done + ' files · ' + (dlRun.bytes / 1048576).toFixed(1) + ' MB';
      } else if (dlRun.phase === 'done' || dlRun.phase === 'error') {
        dlFillEl.style.width = dlRun.phase === 'done' ? '100%' : '0%';
        dlStatsEl.textContent = dlRun.phase === 'error'
          ? (dlRun.lastErr || 'zip error')
          : (dlRun.cancel ? 'Stopped — ' : '✓ Saved ')
            + dlRun.done + '/' + dlRun.total + ' files'
            + (dlRun.fail ? ' · ' + dlRun.fail + ' failed' : '')
            + (dlRun.skip ? ' · ' + dlRun.skip + ' embeds skipped' : '')
            + ' · ' + (dlRun.bytes / 1048576).toFixed(1) + ' MB';
      }
      dlCancelEl.hidden = !fetching;
      dlCloseEl.hidden = fetching || dlRun.phase === 'zip';
    }
    function dlDashTick() {
      if (dlRun.phase !== 'fetch') return;
      const now = performance.now();
      if (now - dlDashAt < 150) return;
      dlDashAt = now;
      updateDlDash();
    }
    function dlPump() {
      if (!dlRun.running) return;
      if (!dlNet.queue.length) { if (dlNet.active === 0) dlFinish(); return; }
      if (dlNet.active >= DL_NET_MAX) return;
      const job = dlNet.queue.shift();
      dlNet.active++;
      const now = Date.now();
      const wait = Math.max(0, dlNet.last + DL_NET_GAP - now);
      dlNet.last = now + wait;
      setTimeout(() => {
        if (!dlRun.running) { dlNet.active--; return; }
        dlTry(job, 0, () => { dlNet.active--; dlPump(); });
      }, wait);
    }
    function dlAfter(release) {
      updateDlDash();
      release();
    }
    function dlByte(b) {
      dlSpeedWin.push({ t: performance.now(), b: b });
      dlDashTick();
    }
    function dlTry(job, ci, release) {
      dlFetch(job.cands[ci], (blob) => {
        if (dlRun.cancel) { release(); return; }
        if (blob) {
          dlRun.done++;
          dlRun.bytes += blob.size;
          job.blob = blob;
          if (dlRun.bytes > DL_BYTE_CAP) { // stop scheduling; keep what's fetched
            dlRun.lastErr = 'size cap reached — zip truncated';
            dlNet.queue.length = 0;
          }
          dlAfter(release);
          return;
        }
        if (dlRun.running && ci + 1 < job.cands.length) { dlTry(job, ci + 1, release); return; }
        dlRun.fail++;
        dlAfter(release);
      }, dlByte);
    }
    function dlFetch(url, cb, onProg) {
      let settled = false;
      const done = (blob) => { if (!settled) { settled = true; cb(blob); } };
      if (typeof GM_xmlhttpRequest === 'function') {
        let last = 0;
        GM_xmlhttpRequest({
          method: 'GET', url: url, responseType: 'blob', timeout: 180000,
          onprogress: (r) => { if (onProg && r && r.loaded > last) { onProg(r.loaded - last); last = r.loaded; } },
          onload: (r) => done(r && (r.status === 200 || r.status === 0) && r.response ? r.response : null),
          onerror: () => done(null),
          ontimeout: () => done(null)
        });
        return;
      }
      fetch(url, { referrerPolicy: 'no-referrer' })
        .then(async (r) => {
          if (!r.ok) { done(null); return; }
          if (!r.body || !r.body.getReader) { done(await r.blob()); return; }
          const reader = r.body.getReader();
          const chunks = [];
          for (;;) {
            const st = await reader.read();
            if (st.done) break;
            chunks.push(st.value);
            if (onProg) onProg(st.value.length);
          }
          done(new Blob(chunks));
        })
        .catch(() => done(null));
    }
    async function buildZipBlob(files) { // files: [{ name, blob }]
      const enc = new TextEncoder();
      const dt = dosDateTime(new Date());
      const parts = [];
      const cds = [];
      let off = 0;
      for (const f of files) {
        const buf = new Uint8Array(await f.blob.arrayBuffer()); // one full read for the CRC
        const crc = crc32(buf);
        const nameU8 = enc.encode(f.name);
        const lh = zipLocalHeader(nameU8, crc, buf.length, dt);
        parts.push(lh, f.blob); // splice the original blob — bytes are not copied twice
        cds.push(zipCentralEntry(nameU8, crc, buf.length, dt, off));
        off += lh.length + buf.length;
      }
      const cd = concatU8(cds);
      return new Blob(parts.concat([cd, zipEocd(files.length, cd.length, off)]), { type: 'application/zip' });
    }
    function dlSaveZip(zip) {
      const u = URL.createObjectURL(zip);
      const a = document.createElement('a');
      a.href = u;
      a.download = zipName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 60000);
    }
    function dlFinish() {
      dlRun.running = false;
      updateDlBtn();
      if (dlRun.cancel || !dlRun.done) {
        dlRun.phase = 'done';
        updateDlDash();
        return;
      }
      // zip assembly needs the main thread free for arrayBuffer reads — defer
      // a tick so the final stats paint first
      dlRun.phase = 'zip';
      updateDlDash();
      setTimeout(() => {
        buildZipBlob(dlJobs.filter((j) => j.blob).map((j) => ({
          name: (j.kind === 'video' ? 'Videos/' : 'Pics/') + j.name, blob: j.blob
        })))
          .then((z) => { dlSaveZip(z); dlRun.phase = 'done'; updateDlDash(); })
          .catch((e) => {
            dlRun.lastErr = 'zip failed: ' + (e && e.message ? e.message : e);
            dlRun.phase = 'error';
            updateDlDash();
          });
      }, 30);
    }
    function startBulkDownload() {
      if (dlRun.running) { // second click = cancel affordance
        dlRun.cancel = true;
        dlRun.running = false;
        dlNet.queue.length = 0;
        dlFinish();
        return;
      }
      const pd = panelData();
      const res = buildDlJobs(collectMediaItems(pd).items);
      dlJobs = res.jobs;
      dlRun.running = true;
      dlRun.cancel = false;
      dlRun.total = dlJobs.length;
      dlRun.done = 0;
      dlRun.fail = 0;
      dlRun.skip = res.skip;
      dlRun.bytes = 0;
      dlRun.lastErr = '';
      dlSpeedWin = [];
      if (!dlJobs.length) {
        dlRun.running = false;
        dlRun.phase = 'idle';
        updateDlBtn();
        if (dlBarEl) {
          dlBarEl.hidden = false;
          dlBarEl.classList.remove('xft-dlzip');
          dlFillEl.style.width = '0%';
          dlCancelEl.hidden = true;
          dlCloseEl.hidden = false;
          dlStatsEl.textContent = res.skip ? 'Only embed tiles — no direct files to download.' : 'Nothing to download on this tab.';
          setTimeout(() => { if (dlRun.phase === 'idle') dlBarEl.hidden = true; }, 2500);
        }
        return;
      }
      dlNet.queue = dlJobs.slice();
      dlRun.phase = 'fetch';
      if (dlBarEl) {
        dlNameEl.textContent = zipName();
        dlNameEl.title = zipName();
        dlBarEl.hidden = false;
      }
      updateDlBtn();
      updateDlDash();
      dlPump();
    }

    // Build the <img>/<video> element for a grid cell, viewer, or filmstrip
    // thumb. An <img> that fails to load is retried once as <video> —
    // extension-based classification cannot know a URL's real bytes (video
    // links without .mp4 extensions exist); if the video also fails, the
    // element is marked .xft-broken.
    function buildMediaEl(kind, url, thumb) {
      if (kind === 'embed') {
        // Embed thumbs: base no-fetch tile (hosts rate-limit, some embeds
        // autostart); the poster — parsed from the embed page's og:image —
        // fills it in async when it arrives. The viewer mounts the live
        // iframe on click.
        if (thumb) {
          const tile = document.createElement('div');
          tile.className = 'xft-vtile';
          const fill = (poster) => {
            // no isConnected gate: the row may be scrolled out of range (kept
            // in vrowCache, detached) when the poster arrives — filling a
            // detached tile is fine, the image loads and shows on re-insert
            const cell = tile.closest('.xft-cell');
            if (!poster) { if (cell) cell.classList.remove('xft-loading'); return; }
            if (tile.querySelector('img')) return;
            const im = document.createElement('img');
            im.alt = '';
            im.addEventListener('error', () => { im.remove(); if (cell) cell.classList.remove('xft-loading'); }, { once: true });
            im.addEventListener('load', () => { im.classList.add('xft-ok'); if (cell) cell.classList.remove('xft-loading'); }, { once: true });
            im.src = poster;
            tile.appendChild(im);
          };
          // deferred a tick: the cached path resolves synchronously, before
          // renderRange has inserted the row into the document
          ensureEmbedPoster(url, (p) => setTimeout(() => fill(p), 0));
          return tile;
        }
        // native <video> first: hosts exposing a sign endpoint serve the
        // raw mp4 — no third-party player UI. Any failure (no endpoint,
        // sign error, stream error) falls back to the embed iframe.
        const host = document.createElement('div');
        host.className = 'xft-embed-host xft-loading';
        let mode = 'none';
        const mountIframe = () => {
          if (mode === 'iframe') return;
          mode = 'iframe';
          const f = document.createElement('iframe');
          f.src = url;
          f.allow = 'fullscreen';
          f.allowFullscreen = true;
          f.addEventListener('error', () => markMediaBroken(f));
          host.textContent = '';
          host.appendChild(f);
          host.classList.remove('xft-loading');
        };
        const mountVideo = (src) => {
          if (mode !== 'none' || !src) return;
          mode = 'video';
          const v = document.createElement('video');
          v.controls = true;
          v.autoplay = true;
          // the CDN rejects foreign Referers — media requests must go out
          // with none, or playback 403s
          v.referrerPolicy = 'no-referrer';
          v.src = src;
          v.addEventListener('error', () => { mode = 'none'; mountIframe(); }, { once: true });
          v.addEventListener('loadeddata', () => markMediaLoaded(v), { once: true });
          host.appendChild(v);
          host.classList.remove('xft-loading');
        };
        resolveEmbedStream(url, (src) => { if (src) mountVideo(src); else mountIframe(); });
        return host;
      }
      if (kind === 'video') {
        if (thumb) {
          // Video thumbs do NOT fetch: media hosts rate-limit (a video-heavy
          // thread = hundreds of queued metadata requests stuck LOADING,
          // rendering black cells that never error). A styled tile + the
          // cell's ▶ badge is instant and reliable; the viewer streams the
          // real video on click.
          const tile = document.createElement('div');
          tile.className = 'xft-vtile';
          return tile;
        }
        const v = document.createElement('video');
        v.controls = true;
        v.autoplay = true;
        // file-PAGE urls (host /v/ or /f/ pages carrying the media behind a
        // sign endpoint or page parse) resolve to the direct src first; the
        // raw page URL is never playable as bytes. Resolution failure falls
        // back to the raw URL — same broken-tile behavior as before.
        if (isVideoPageUrl(url)) {
          resolveEmbedStream(url, (src) => {
            if (!src) { v.src = url; return; }
            // resolved CDNs reject foreign Referers — request with none
            v.referrerPolicy = 'no-referrer';
            v.src = src;
          });
        } else {
          v.src = url;
        }
        v.addEventListener('error', () => markMediaBroken(v, url));
        v.addEventListener('loadeddata', () => markMediaLoaded(v), { once: true });
        // cached failures never fire events — probe after a moment
        setTimeout(() => {
          if (v.readyState === 0 && v.networkState === 3) markMediaBroken(v, url); // NETWORK_NO_SOURCE
        }, 800);
        return v;
      }
      const im = document.createElement('img');
      // thumbs are only created in-range by the virtualizer — eager loading
      // avoids loading=lazy deferral bugs on re-inserted cached rows
      if (!thumb) im.loading = 'lazy';
      const cands = hqCandidates(url);
      let ci = Math.min(hqStage.get(url) || 0, cands.length - 1);
      const isHqStage = (i) => cands.length > 1 && i < cands.length - 1;
      const setStage = (i) => {
        ci = i;
        hqStage.set(url, i);
        if (!isHqStage(i)) { im.src = cands[i]; return; } // post URL: unqueued
        runHqNet((done) => {
          // stage moved on while queued (cell rebuilt elsewhere) — give the slot back
          if (ci !== i || im.src === cands[i]) { done(); return; }
          let released = false;
          const rel = () => { if (!released) { released = true; done(); } };
          im.addEventListener('load', rel, { once: true });
          im.addEventListener('error', rel, { once: true });
          setTimeout(rel, 20000); // a hung request must not pin the slot
          im.src = cands[i];
        });
      };
      im.addEventListener('error', function onErr() {
        // HQ candidates first: a transient failure (rate-limit burst) gets ONE
        // delayed retry — the gate keeps a src-less/failed img invisible, so
        // the retry happens inside the shimmer with no broken-icon flicker.
        // A second failure falls to the next candidate; only the post URL
        // itself failing starts the video retry.
        if (isHqStage(ci)) {
          if (ci === 0 && !hqTriedRetry.has(url)) {
            hqTriedRetry.add(url);
            im.removeAttribute('src');
            setTimeout(() => { if (ci === 0) setStage(0); }, 1500);
            return;
          }
          setStage(ci + 1);
          return;
        }
        im.removeEventListener('error', onErr);
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        v.src = url;
        v.addEventListener('error', () => markMediaBroken(v, url));
        v.addEventListener('loadedmetadata', () => { if (im.parentNode) im.replaceWith(v); markMediaLoaded(v); });
        v.load();
      });
      setStage(ci);
      // A failure cached by Chrome replays instantly with NO error event, and
      // 1×1 placeholders (svg data-URIs, hotlink-block pixels) "load" as a
      // single stretched pixel = a blank cell. nw<=1 + complete = dead either
      // way — probe for both, or the cell renders blank forever. A src-LESS
      // img (waiting in the HQ queue, or mid-retry) is complete with nw=0
      // but NOT dead — probing it retired whole ranges of healthy cells.
      const checkDead = () => { if (im.getAttribute('src') && im.complete && im.naturalWidth <= 1) markMediaBroken(im, url); };
      const checkTiny = () => {
        // 2..140px square-ish = smilie/sticker (no URL marker exists) —
        // retire the item. Animate the cell out first, then the debounced
        // rerender (same one broken media uses) drops it in one batched pass.
        if (im.naturalWidth > 1 && im.naturalWidth <= TINY_MEDIA_MAX
          && im.naturalHeight > 1 && im.naturalHeight <= TINY_MEDIA_MAX
          && !tinyMediaUrls.has(url)) {
          tinyMediaUrls.add(url);
          animateOutCells(url);
          scheduleBrokenRerender();
        }
      };
      if (im.getAttribute('src') && im.complete) { checkDead(); checkTiny(); if (im.naturalWidth > 1) markMediaLoaded(im); }
      else {
        im.addEventListener('load', () => { checkDead(); checkTiny(); markMediaLoaded(im); });
        setTimeout(() => { checkDead(); checkTiny(); }, 800);
      }
      return im;
    }

    function updateProgressText() {
      const t = hub.progress.total ? (hub.progress.done + '/' + hub.progress.total) : '–';
      const busy = !!hub.fetchRunning;
      if (progressEl) {
        if (busy) progressEl.innerHTML = '<span class="xft-spinner" aria-hidden="true"></span>' + t;
        else progressEl.textContent = t;
      }
      // while a fetch is in flight the panel buttons lock: no re-Refresh
      // mid-run and no accidental Stop (fetch runs to completion)
      if (panelCancelBtn) panelCancelBtn.disabled = busy;
      if (panelRefreshBtn) panelRefreshBtn.disabled = busy;
      // NOT disabled while pending: the second click cancels + sorts partial
      if (sorterPending) setSortBtn('⚡ ' + t + '…', false);
    }

    function schedulePanelRender() {
      if (!panelIsOpen() || renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        renderPanelBody();
      });
    }

    function setTab(t) {
      saveViewScroll();
      panelTab = t;
      rowLimit = settings.rowCap;
      clearVRows(); // row indices no longer map to the same items
      if (tabFilesBtn) tabFilesBtn.classList.toggle('xft-tab-active', t === 'media');
      if (tabLinksBtn) tabLinksBtn.classList.toggle('xft-tab-active', t === 'links');
      if (subtabsEl) subtabsEl.hidden = t !== 'media';
      if (linksBarEl) linksBarEl.hidden = t !== 'links';
      renderPanelBody();
    }

    function setSubTab(t) {
      saveViewScroll();
      panelSubTab = t;
      clearVRows(); // different kind filter -> different item list
      for (const k of ['all', 'image', 'video']) {
        if (subTabBtns[k]) subTabBtns[k].classList.toggle('xft-tab-active', k === t);
      }
      renderPanelBody();
    }

    function updateSubTabCounts(c) {
      if (subTabBtns.all) subTabBtns.all.textContent = 'All ' + c.all;
      if (subTabBtns.image) subTabBtns.image.textContent = 'Image ' + c.image;
      if (subTabBtns.video) subTabBtns.video.textContent = 'Video ' + c.video;
    }

    // fullscreen media viewer: prev/next, thumbnail filmstrip below the
    // preview (the media around the current item), keyboard arrows, Esc
    function closeViewer(instant) {
      const v = document.getElementById('xft-viewer');
      if (viewerKeyHandler) {
        document.removeEventListener('keydown', viewerKeyHandler);
        viewerKeyHandler = null;
      }
      if (!v) return;
      if (!instant) {
        v.classList.add('xft-vclose');
        setTimeout(() => v.remove(), 160);
      } else v.remove();
    }

    function openViewerAt(i) {
      const nav = !!document.getElementById('xft-viewer');
      if (i < 0 || i >= viewerItems.length) return;
      viewerIndex = i;
      const it = viewerItems[i];
      closeViewer(true); // navigation swaps instantly — no close animation
      const v = document.createElement('div');
      v.id = 'xft-viewer';
      if (!nav) v.classList.add('xft-vwin'); // animate only a fresh open
      const media = buildMediaEl(it.kind, it.url, false);
      // every viewer media sits in a FIXED-HEIGHT stage so paging next/prev
      // never shifts the bar/filmstrip; the slot inside is sized to the
      // image's own aspect once loaded (small images upscale to fill)
      let mediaBox = media;
      let stage = null;
      if (it.kind === 'image' || it.kind === 'video') {
        stage = document.createElement('div');
        stage.className = 'xft-vstage';
        mediaBox = document.createElement('div');
        // image slots shrink to the image's own aspect once loaded (no
        // black side gaps on vertical photos); video keeps the 16:9 box
        mediaBox.className = 'xft-vslot xft-loading' + (it.kind === 'image' ? ' xft-vimg' : '');
        mediaBox.appendChild(media);
        stage.appendChild(mediaBox);
      }
      const bar = document.createElement('div');
      bar.className = 'xft-viewer-bar';
      const info = document.createElement('span');
      info.textContent = (viewerIndex + 1) + '/' + viewerItems.length + ' · [#' + it.pos + '] ' + (it.author || '?');
      const prev = mkBtn('‹ Prev', () => openViewerAt(viewerIndex - 1));
      const next = mkBtn('Next ›', () => openViewerAt(viewerIndex + 1));
      prev.disabled = viewerIndex === 0;
      next.disabled = viewerIndex === viewerItems.length - 1;
      const go = mkBtn('Go to comment', () => { jumpTo(it.postId); }); // viewer stays open — user request
      const close = mkBtn('✕ Close', closeViewer);
      bar.append(info, prev, next, go, close);
      v.append(bar, stage || mediaBox);
      if (viewerItems.length > 1) {
        const strip = document.createElement('div');
        strip.className = 'xft-viewer-strip';
        const from = Math.max(0, viewerIndex - 15);
        const to = Math.min(viewerItems.length, viewerIndex + 16);
        for (let k = from; k < to; k++) {
          const t = viewerItems[k];
          const th = document.createElement('div');
          th.className = 'xft-vthumb' + (k === viewerIndex ? ' xft-vthumb-active' : '');
          th.appendChild(buildMediaEl(t.kind, t.url, true));
          const idx = k;
          th.addEventListener('click', () => openViewerAt(idx));
          strip.appendChild(th);
        }
        v.appendChild(strip);
        requestAnimationFrame(() => {
          const act = strip.querySelector('.xft-vthumb-active');
          if (act) act.scrollIntoView({ inline: 'center', block: 'nearest' });
        });
      }
      v.addEventListener('click', (e) => { if (e.target === v) closeViewer(); });
      document.body.appendChild(v);
      // cached-complete images never fire load — size their slot now
      if (it.kind === 'image' && media.complete && media.naturalWidth) {
        sizeVImgSlot(mediaBox, media);
        mediaBox.classList.remove('xft-loading');
      }
      viewerKeyHandler = (e) => {
        if (e.key === 'ArrowLeft') openViewerAt(viewerIndex - 1);
        else if (e.key === 'ArrowRight') openViewerAt(viewerIndex + 1);
        else if (e.key === 'Escape') closeViewer();
      };
      document.addEventListener('keydown', viewerKeyHandler);
    }

    function jumpTo(postId) {
      const el = document.querySelector(
        'article[data-content="post-' + postId + '"], article.xf-fetched[data-post-id="' + postId + '"]'
      );
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('xft-pulse');
        void el.offsetWidth; // restart animation
        el.classList.add('xft-pulse');
        setTimeout(() => el.classList.remove('xft-pulse'), 3200);
      } else {
        window.open(threadUrl('/post-' + postId), '_blank');
      }
    }

    let lastPanelSignature = '';

    // ---------- media grouping (v0.7.31) ----------
    // layout = ordered render entries for the virtualizer: full-width group
    // headers ({hdr:'main'|'sub', label}) and media rows ({idxs:[item
    // indices]}). 'post' groups by post; 'page'/'user' add a '#pos - author'
    // sub-header per post inside each group. flat = media rows only.
    // Groups are built from the FILTERED item list, so sub-tab switches
    // (All/Image/Video) keep the grouping but drop empty groups.
    function buildMediaLayout(items, mode) {
      const lay = [];
      const chunk = (list) => { for (let j = 0; j < list.length; j += 4) lay.push({ idxs: list.slice(j, j + 4) }); };
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
    // prefix-sum entry tops — headers (24/30px + gap) are shorter than media
    // rows, so the virtualizer can no longer assume a uniform pitch
    function layoutTops(lay, pitch) {
      const tops = new Array(lay.length + 1);
      tops[0] = 0;
      for (let i = 0; i < lay.length; i++) tops[i + 1] = tops[i] + (lay[i].idxs ? pitch : (lay[i].hdr === 'sub' ? 24 : 30) + 6);
      return tops;
    }

    // shared preamble for the render pass AND bulk download: ordered records
    // (fetch-frontier filtered), post positions, boilerplate set. The
    // download list must match the grid exactly — one source of truth.
    function panelData() {
      const ordered = orderedRecords();
      // while a fetch runs, media renders strictly page 1 → last: the live
      // page is seeded instantly but must NOT appear until every earlier
      // page has landed (jump to page 20 → grid fills 1,2,3… in order)
      let orderedShown = ordered;
      if (hub.fetchRunning) {
        let f = 0;
        while (hub.pagesDone.has(f + 1)) f += 1;
        orderedShown = ordered.filter((r) => r.pageN <= f);
      }
      const posMap = new Map(ordered.map((r, i) => [r.postId, i + 1]));
      // signature/"sent via app" boilerplate: URLs recurring across >=3
      // distinct authors — filtered at render so stale caches heal without Refresh
      const boiler = boilerplateUrls(ordered, 3);
      return { ordered: ordered, orderedShown: orderedShown, posMap: posMap, boiler: boiler };
    }
    // media items for the active sub-tab + per-kind counts
    function collectMediaItems(d) {
      const all = [];
      // stale caches (pre-0.7.9) hold 1×1 data-URI placeholders alongside
      // their real URLs (attachment-scan twins) — drop the placeholders so
      // already-cached threads heal without a Refresh; smilies and
      // signature/footer boilerplate are filtered the same way
      const real = (list) => (list || []).filter((u) => !/^(data|blob):/i.test(u || '') && !isSmilieUrl(u) && !d.boiler.has(String(u || '')) && !tinyMediaUrls.has(String(u || '')) && !brokenMediaUrls.has(String(u || '')));
      for (const r of d.orderedShown) {
        for (const url of real(r.images)) all.push({ r: r, url: url, pos: d.posMap.get(r.postId) || 0, kind: 'image' });
        for (const url of real(r.videos)) all.push({ r: r, url: url, pos: d.posMap.get(r.postId) || 0, kind: 'video' });
        for (const url of real(r.embeds)) all.push({ r: r, url: url, pos: d.posMap.get(r.postId) || 0, kind: 'embed' });
      }
      // embeds are videos hosted elsewhere — they count under the Video tab
      const mediaCounts = { all: all.length, image: 0, video: 0 };
      for (const it of all) mediaCounts[it.kind === 'embed' ? 'video' : it.kind] += 1;
      const items = panelSubTab === 'all' ? all : all.filter((it) => it.kind === panelSubTab || (panelSubTab === 'video' && it.kind === 'embed'));
      return { all: all, items: items, mediaCounts: mediaCounts };
    }

    function renderPanelBody() {
      if (!panelIsOpen() || !panelBodyEl) return;
      const pd = panelData();
      const boiler = pd.boiler;
      let items = [];
      let filtered = [];
      let mediaCounts = null;
      if (panelTab === 'media') {
        const m = collectMediaItems(pd);
        mediaCounts = m.mediaCounts;
        updateSubTabCounts(mediaCounts);
        items = m.items;
        viewerItems = items.map((it) => ({ kind: it.kind, url: it.url, postId: it.r.postId, pos: it.pos, author: it.r.author }));
      } else {
        for (const r of pd.orderedShown) {
          for (const url of r.links) if (!boiler.has(url)) items.push({ r: r, url: url, pos: pd.posMap.get(r.postId) || 0, kind: 'link' });
        }
        filtered = applyLinkFilters(items, {
          query: linkSearchEl ? linkSearchEl.value : '',
          users: linkUserSel,
          domains: linkDomainSel
        });
      }
      // skip rebuild when nothing changed — background fetch progress ticks
      // must not churn the grid or reset the user's scroll position
      // (sub-tab + search + filter selections are part of the signature)
      const sig = panelTab + ':' + panelSubTab + ':' + settings.mediaGroup + ':' + rowLimit + ':' + JSON.stringify([
        linkSearchEl ? linkSearchEl.value : '',
        linkUserSel ? Array.from(linkUserSel).sort() : null,
        linkDomainSel ? Array.from(linkDomainSel).sort() : null,
        items.length,
        panelTab === 'media' ? 0 : items.length ? items[items.length - 1].r.postId : 0
      ]);
      if (sig === lastPanelSignature) { updateCountOnly(items.length); return; }
      lastPanelSignature = sig;
      // Media tab, same kind filter, grid still mounted: the change is item
      // GROWTH from fetch ticks or REMOVAL from a retirement wave. Keep the
      // DOM exactly as-is — point the grid at the new list and re-range. A
      // teardown here is what caused blank cells (lazy loads killed
      // mid-flight) and scroll-position loss.
      if (panelTab === 'media' && vGrid && vGrid.topPad.isConnected && vGrid.identity === panelSubTab + ':' + settings.mediaGroup) {
        // removals above the viewport shift the content under the user —
        // overflow-anchor is OFF for the virtualizer, so compensate manually:
        // keep the first visible ITEM at the same pixel (native anchoring
        // cannot survive rows detaching, which is why it is disabled)
        const anchor = captureScrollAnchor(panelBodyEl.scrollTop);
        vGrid.items = items;
        vGrid.layout = buildMediaLayout(items, settings.mediaGroup);
        vGrid.renderRange();
        if (anchor) {
          const newTop = entryTopFor(anchor.url, vGrid.items, vGrid.layout, vRowHMeasured || gridRowH());
          if (newTop !== null && Math.abs(newTop - anchor.top) > 1) {
            programmaticScrollAt = performance.now();
            panelBodyEl.scrollTop = Math.max(0, panelBodyEl.scrollTop - (anchor.top - newTop));
            vGrid.renderRange();
          }
        }
        updateCountOnly(items.length); // growth ticks must refresh the count too
        return;
      }
      // clearVRows stashed the pre-collapse position — prefer it over the
      // now-clamped live scrollTop. A VIEW switch (tab/sub-tab/group) instead
      // restores the position the user left the NEW view at — each list owns
      // its own scroll; it must not inherit the outgoing view's offset.
      const keepScroll = vScrollKeep !== null ? vScrollKeep : panelBodyEl.scrollTop;
      vScrollKeep = null;
      const viewChanged = viewKey() !== lastRenderedView;
      lastRenderedView = viewKey();
      let scrollTarget = viewChanged ? (scrollMemory[viewKey()] || 0) : keepScroll;
      // removal rebuilds (retirement waves) shift everything under a numeric
      // offset — restore against the first visible ITEM instead
      let anchor = (!viewChanged && panelTab === 'media') ? (vAnchorKeep || captureScrollAnchor(keepScroll)) : null;
      vAnchorKeep = null;
      panelCountEl.textContent = panelTab === 'links' && filtered.length !== items.length
        ? filtered.length + '/' + items.length + ' items'
        : items.length + ' items';
      // build the new body OFF to the side — the old content must stay
      // mounted while building: wiping first (`textContent=''`) collapses
      // the height to 0 for a frame, the browser clamps scrollTop, and the
      // restore then fights the user's active scrolling (bottom-of-list
      // stutter). replaceChildren swaps in ONE mutation and the scroll
      // survives natively.
      const frag = document.createDocumentFragment();
      if (panelTab === 'media') {
        // virtualized grid: only visible rows (+buffer) exist in the DOM
        const topPad = document.createElement('div');
        const vrows = document.createElement('div');
        vrows.className = 'xft-vrows';
        const bottomPad = document.createElement('div');
        frag.append(topPad, vrows, bottomPad);
        const gap = 6;
        let rowH = gridRowH(); // estimate; corrected by measurement below
        const builtLayout = buildMediaLayout(items, settings.mediaGroup);
        if (anchor) {
          // resolve the anchor item's row in the NEW layout and retarget the
          // restore there (numeric keepScroll may point into shifted space)
          const newTop = entryTopFor(anchor.url, items, builtLayout, vRowHMeasured || rowH);
          if (newTop !== null) scrollTarget = Math.max(0, newTop + anchor.off);
          // anchor item itself retired → numeric keepScroll stands
        }
        const renderRange = () => {
          const gItems = vGrid ? vGrid.items : items;
          const lay = vGrid ? vGrid.layout : builtLayout;
          const st = panelBodyEl.scrollTop;
          const vh = panelBodyEl.clientHeight || 600;
          const pitch = vRowHMeasured || rowH;
          const tops = layoutTops(lay, pitch);
          // first entry whose bottom passes the viewport top (headers make
          // the pitch non-uniform — binary search over the prefix sums)
          let lo = 0, hi = lay.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (tops[mid + 1] > st) hi = mid; else lo = mid + 1; }
          const first = Math.max(0, lo - 1); // one look-back keeps a header above the fold mounted
          lo = first; hi = lay.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (tops[mid] < st + vh) lo = mid + 1; else hi = mid; }
          const last = Math.min(lay.length, lo + 1);
          for (const idx of Array.from(vrowCache.keys())) {
            if (idx < first || idx >= last) { vrowCache.get(idx).remove(); vrowCache.delete(idx); }
          }
          for (let r = first; r < last; r++) {
            const e = lay[r];
            // entry signature: a row cached while the list was SHORTER (or a
            // header whose group moved) must rebuild — sig mismatch = rebuild
            const esig = e.idxs ? 'r' + e.idxs[0] + ':' + e.idxs.length : 'h' + e.hdr + ':' + e.label;
            let rowEl = vrowCache.get(r);
            if (rowEl && rowEl.dataset.xftSig !== esig) {
              rowEl.remove();
              vrowCache.delete(r);
              rowEl = null;
            }
            if (!rowEl) {
              if (e.idxs) {
                rowEl = document.createElement('div');
                rowEl.className = 'xft-vrow';
                // removal wave just animated cells out — rebuilt rows must not
                // pop back in or the whole grid flashes
                if (performance.now() < popSuppressUntil) rowEl.classList.add('xft-nopop');
                for (const i of e.idxs) {
                  const it = gItems[i];
                  const cell = document.createElement('div');
                  cell.className = 'xft-cell';
                  cell.title = '[#' + it.pos + '] ' + (it.r.author || '?') + ' — open';
                  const isVideo = it.kind === 'video' || it.kind === 'embed';
                  const thumb = buildMediaEl(it.kind, it.url, true);
                  // shimmer while the media loads (cached-complete images come
                  // back already ok'd — no flash for them)
                  if ((it.kind === 'image' || it.kind === 'embed')
                    && !(thumb.tagName === 'IMG' && thumb.classList.contains('xft-ok'))) cell.classList.add('xft-loading');
                  const label = document.createElement('span');
                  label.className = 'xft-cell-label';
                  label.textContent = '#' + it.pos + ' ' + (it.r.author || '?');
                  cell.append(thumb, label);
                  if (isVideo) {
                    const badge = document.createElement('span');
                    badge.className = 'xft-cell-badge';
                    badge.textContent = '▶';
                    cell.appendChild(badge);
                  }
                  cell.addEventListener('click', () => openViewerAt(i));
                  rowEl.appendChild(cell);
                }
              } else {
                rowEl = document.createElement('div');
                rowEl.className = 'xft-ghead' + (e.hdr === 'sub' ? ' xft-gsub' : '');
                const lab = document.createElement('span');
                lab.className = 'xft-glabel';
                lab.textContent = e.label;
                const line = document.createElement('span');
                line.className = 'xft-gline';
                rowEl.append(lab, line);
                if (e.postId) {
                  rowEl.classList.add('xft-gjump');
                  rowEl.title = e.label + ' — jump to post';
                  rowEl.addEventListener('click', () => jumpTo(e.postId));
                }
              }
              rowEl.dataset.xftSig = esig;
              vrowCache.set(r, rowEl);
            }
            // reconcile in place: re-inserting a row (appendChild is remove+
            // insert) makes Chrome re-evaluate loading=lazy visibility and
            // can strand an image deferred forever — only touch misplaced rows
            const slot = r - first;
            if (vrows.children[slot] !== rowEl) {
              vrows.insertBefore(rowEl, vrows.children[slot] || null);
            }
          }
          // cap the cache so a very long scroll does not pin the whole list
          if (vrowCache.size > 300) {
            const mid = (first + last) / 2;
            for (const idx of Array.from(vrowCache.keys()).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid)).slice(200)) {
              vrowCache.get(idx).remove();
              vrowCache.delete(idx);
            }
          }
          // measure the REAL row pitch once and keep it across rebuilds: a
          // few px of estimate drift per row turns into thousands of px of
          // scroll jumps on huge virtualized lists (measure a MEDIA row —
          // group headers have fixed CSS heights of their own). Sub-50px
          // readings are garbage (half-attached row / mid-transition width)
          // and would poison every later pad computation — reject them.
          const mediaRow = vrows.querySelector('.xft-vrow');
          if (mediaRow) {
            // integer-quantized: 1fr grid columns give rows fractional pixel
            // heights that round differently per row — a pitch that flaps
            // ±1px between renders is catastrophic, every pad offset is
            // first_index × pitch, so 1px at deep scroll swings the content
            // height by thousands of px and the clamp yanks the view back.
            // Accept only the first reading or a REAL change (>4px, e.g. a
            // scrollbar appearing/reserving width).
            const real = Math.round(mediaRow.getBoundingClientRect().height + gap);
            if (real > 50 && (!vRowHMeasured || Math.abs(real - vRowHMeasured) > 4)) vRowHMeasured = real;
          }
          topPad.style.height = tops[first] + 'px';
          bottomPad.style.height = Math.max(0, tops[lay.length] - tops[last]) + 'px';
        };
        vGrid = { topPad: topPad, vrows: vrows, bottomPad: bottomPad, items: items, layout: builtLayout, identity: panelSubTab + ':' + settings.mediaGroup, renderRange: renderRange };
        renderRange();
        panelBodyEl.onscroll = () => {
          if (vScrollRaf) return;
          vScrollRaf = requestAnimationFrame(() => { vScrollRaf = 0; if (vGrid) vGrid.renderRange(); });
        };
        if (vResizeObserver) vResizeObserver.disconnect();
        vResizeObserver = new ResizeObserver(() => { if (vGrid) vGrid.renderRange(); });
        vResizeObserver.observe(panelBodyEl);
      } else {
        panelBodyEl.onscroll = null;
        if (vResizeObserver) { vResizeObserver.disconnect(); vResizeObserver = null; }
        // grouped rows: the post label ([#pos] author) renders once per post
        // in a fixed-width first column; the post's links stack beneath it
        const groups = groupLinkItems(filtered);
        const max = Math.min(filtered.length, rowLimit);
        let n = 0;
        for (const g of groups) {
          if (n >= max) break;
          for (let i = 0; i < g.urls.length && n < max; i++, n++) {
            const row = document.createElement('div');
            row.className = 'xft-lrow' + (i === 0 ? ' xft-lrow-first' : '');
            const c1 = document.createElement('div');
            if (i === 0) {
              c1.className = 'xft-lcell-label';
              c1.textContent = '[#' + g.pos + '] ' + (g.r.author || '?');
              c1.title = c1.textContent + ' — ' + g.urls.length + ' link(s) — jump to post';
              c1.addEventListener('click', () => jumpTo(g.r.postId));
            }
            const c2 = document.createElement('div');
            c2.className = 'xft-lcell-link';
            const a = document.createElement('a');
            a.href = g.urls[i];
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = g.urls[i];
            a.title = g.urls[i];
            c2.appendChild(a);
            row.append(c1, c2);
            frag.appendChild(row);
          }
        }
        if (!filtered.length && items.length) {
          const none = document.createElement('div');
          none.className = 'xft-empty';
          none.textContent = 'No links match your search/filters.';
          frag.appendChild(none);
        }
      }
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'xft-empty';
        empty.textContent = hub.fetchRunning
          ? 'Fetching…'
          : (mediaCounts && mediaCounts.all > 0 ? 'No ' + panelSubTab + 's in this thread.' : 'Nothing found yet.');
        frag.appendChild(empty);
      }
      panelBodyEl.replaceChildren(frag);
      if (keepScroll || scrollTarget) {
        // restore AFTER a frame: at sync time the pads may still carry a
        // stale pitch and the content height can be briefly smaller than
        // the target — a sync set clamps and the view lands at the top.
        // The pre-pass re-renders with ATTACHED rows (refreshing the
        // measured pitch and pads) before the offset is applied, and the
        // restore only moves the list when it landed FAR from where it
        // belongs: small drift while the user is mid-wheel must be left
        // alone or the list pushes back against the scroll (bottom stutter).
        const target = scrollTarget;
        const apply = (n) => {
          if (!panelBodyEl || !panelBodyEl.isConnected || n < 0) return;
          if (panelTab === 'media' && vGrid) vGrid.renderRange();
          const max = panelBodyEl.scrollHeight - panelBodyEl.clientHeight;
          const want = Math.min(target, max);
          const displace = Math.abs(panelBodyEl.scrollTop - want);
          const userActive = performance.now() - lastUserScrollAt < 250;
          // never fight an active wheel — EXCEPT the collapse signature
          // (scrollTop clamped to the very top), where the list must be
          // recovered even mid-scroll or the view stays lost
          const collapsed = panelBodyEl.scrollTop < 80 && target > 80;
          if (displace > 80 && (!userActive || collapsed)) {
            programmaticScrollAt = performance.now();
            panelBodyEl.scrollTop = want;
            if (panelTab === 'media' && vGrid) vGrid.renderRange();
            requestAnimationFrame(() => apply(n - 1)); // height keeps settling — re-assert once more
          }
        };
        requestAnimationFrame(() => apply(2));
      }
      // media grid is window-virtualized and renders what the viewport shows —
      // row capping (and this button) only applies to the Links tab
      // auto-load replaces the old Show-more button: a sentinel at the list
      // end extends rowLimit when scrolled into view (media grid is
      // window-virtualized and needs no capping)
      if (linksObserver) linksObserver.disconnect();
      if (panelTab === 'links' && filtered.length > rowLimit) {
        if (!linksObserver) {
          linksObserver = new IntersectionObserver(() => {
            rowLimit += settings.rowCap;
            renderPanelBody();
          }, { root: panelBodyEl, rootMargin: '600px' });
        }
        if (!linksSentinel || !linksSentinel.isConnected) {
          linksSentinel = document.createElement('div');
          linksSentinel.className = 'xft-sentinel';
        }
        panelBodyEl.appendChild(linksSentinel);
        linksObserver.observe(linksSentinel);
      }
      const notes = [];
      if (hub.capNotice || cache.stopPersist) notes.push('Cache cap reached — new data kept in memory only (not persisted).');
      if (hub.partialNotice) notes.push('Fetch stopped early — list is partial.');
      noteEl.hidden = !notes.length;
      noteEl.textContent = notes.join(' ');
    }


    function buildSettingsView() {
      const wrap = document.createElement('div');
      wrap.className = 'xft-settings';
      const mkField = (labelText, value) => {
        const row = document.createElement('label');
        row.className = 'xft-set-row';
        const t = document.createElement('span');
        t.textContent = labelText;
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = String(value);
        row.append(t, inp);
        wrap.appendChild(row);
        return inp;
      };
      const inDelay = mkField('fetch delay (ms)', settings.delayMs);
      const inChunk = mkField('render chunk', settings.chunkSize);
      const inRows = mkField('panel row cap (Links)', settings.rowCap);
      const inAuto = mkField('auto fetch on load (1/0)', settings.autoFetch ? 1 : 0);
      const inAnim = mkField('force animations (1/0)', settings.forceAnimations ? 1 : 0);
      const inBase = mkField('base path (subpath installs)', settings.basePath);
      const save = mkBtn('Save', () => {
        const num = (v, def) => {
          const n = parseInt(v, 10);
          return isFinite(n) && n > 0 ? n : def;
        };
        settings.delayMs = num(inDelay.value, DEFAULT_SETTINGS.delayMs);
        settings.chunkSize = num(inChunk.value, DEFAULT_SETTINGS.chunkSize);
        settings.rowCap = num(inRows.value, DEFAULT_SETTINGS.rowCap);
        settings.autoFetch = parseInt(inAuto.value, 10) === 1 ? 1 : 0;
        settings.forceAnimations = parseInt(inAnim.value, 10) === 1 ? 1 : 0;
        settings.basePath = inBase.value.trim().replace(/\/+$/, '');
        applyAnimOverride();
        writeStore(SETTINGS_KEY, settings);
        wrap.hidden = true;
        setTab(panelTab);
      });
      wrap.appendChild(save);
      wrap.hidden = true;
      return wrap;
    }

    // prefers-reduced-motion kills every animation + the drawer transition.
    // With forceAnimations the <html> gains .xft-anim-force and the
    // reduce-motion rules (scoped to html:not(.xft-anim-force)) stop applying.
    function applyAnimOverride() {
      document.documentElement.classList.toggle('xft-anim-force', settings.forceAnimations === 1);
    }

    function panelIsOpen() {
      return !!(panel && panel.classList.contains('xft-open'));
    }

    function updateCountOnly(n) {
      if (panelCountEl) panelCountEl.textContent = n + ' items';
    }

    // virtualized-grid row pitch: square 4-col cells (kept in sync with .xft-vrow CSS)
    function gridRowH() {
      const gap = 6;
      const cols = 4;
      const cellW = (panelBodyEl.clientWidth - 20 - (cols - 1) * gap) / cols;
      return cellW + 2 + gap;
    }

    // normalize wheel scrolling: one notch = one grid row, no matter how tall
    // the virtualized content is (a flick must not fly hundreds of rows);
    // small deltas (trackpad pixel scrolling) stay native
    function installWheelNormalizer() {
      let pend = 0;
      let raf = 0;
      panelBodyEl.addEventListener('wheel', (e) => {
        lastUserScrollAt = performance.now();
        if (panelTab !== 'media') return; // Links tab keeps native scrolling
        e.preventDefault();
        // every wheel event contributes at most one row of travel, no native
        // path at all — free-spin/high-res wheels sending small rapid deltas
        // cannot fling through the virtualized list
        const rowH = gridRowH();
        const d = e.deltaMode === 1 ? e.deltaY * (rowH / 3) : e.deltaY;
        pend += Math.max(-rowH, Math.min(rowH, d));
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          programmaticScrollAt = performance.now();
          panelBodyEl.scrollBy({ top: pend, behavior: 'auto' });
          pend = 0;
        });
      }, { passive: false });
      // scrollbar DRAGS / trackpad / keyboard scrolling never fire wheel —
      // treat any scroll event not caused by our own writes as user activity
      panelBodyEl.addEventListener('scroll', () => {
        if (performance.now() - programmaticScrollAt > 40) lastUserScrollAt = performance.now();
      }, { passive: true });
    }

    function setPanelOpen(open) {
      if (!panel) return;
      panel.classList.toggle('xft-open', open);
      const edge = document.getElementById('xft-edge-btn');
      if (edge) edge.classList.toggle('xft-edge-hidden', open);
      if (open) {
        rowLimit = settings.rowCap;
        renderPanelBody();
        ensure(false);
      }
    }

    // column filter: button + popup checkbox list built from current table
    // values (distinct users / distinct link domains); click outside closes
    function buildFilterControl(label, getValues, getSel, setSel) {
      const wrap = document.createElement('div');
      wrap.className = 'xft-filter';
      let pop = null;
      const close = () => { if (pop) { pop.remove(); pop = null; } };
      const btn = mkBtn(label, () => {
        if (pop) { close(); return; }
        const vals = getValues();
        const sel = getSel(); // Set of allowed values, or null = everything
        pop = document.createElement('div');
        pop.className = 'xft-fpop';
        const applyState = () => {
          const boxes = Array.from(pop.querySelectorAll('input[type=checkbox]'));
          const checked = new Set(boxes.filter((b) => b.checked).map((b) => b.value));
          setSel(checked.size === vals.length ? null : checked);
          btn.classList.toggle('xft-filter-on', checked.size !== vals.length);
        };
        const head = document.createElement('div');
        head.className = 'xft-fpop-head';
        head.append(
          mkBtn('All', () => { pop.querySelectorAll('input[type=checkbox]').forEach((b) => { b.checked = true; }); applyState(); }),
          mkBtn('None', () => { pop.querySelectorAll('input[type=checkbox]').forEach((b) => { b.checked = false; }); applyState(); })
        );
        pop.appendChild(head);
        if (!vals.length) {
          const none = document.createElement('div');
          none.className = 'xft-empty';
          none.textContent = 'No values yet.';
          pop.appendChild(none);
        }
        for (const v of vals) {
          const lab = document.createElement('label');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = v;
          cb.checked = !sel || sel.has(v);
          cb.addEventListener('change', applyState);
          const sp = document.createElement('span');
          sp.textContent = v === '' ? '(no name)' : v;
          sp.title = v;
          lab.append(cb, sp);
          pop.appendChild(lab);
        }
        wrap.appendChild(pop);
      });
      document.addEventListener('click', (e) => { if (pop && !wrap.contains(e.target)) close(); });
      wrap.appendChild(btn);
      return wrap;
    }

    // Links-tab toolbar: search box (matches link URL or author) + the two
    // column filters. Sits below the tab row, always visible on Links.
    function buildLinksBar() {
      const bar = document.createElement('div');
      bar.className = 'xft-linksbar';
      linkSearchEl = document.createElement('input');
      linkSearchEl.type = 'search';
      linkSearchEl.placeholder = 'Search link or user…';
      let debounce = 0;
      linkSearchEl.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { rowLimit = settings.rowCap; clearVRows(); renderPanelBody(); }, 150);
      });
      bar.appendChild(linkSearchEl);
      // user column: one checkbox per author that has at least one link
      bar.appendChild(buildFilterControl('User ▾', () => {
        const seen = new Set();
        const vals = [];
        for (const r of orderedRecords()) {
          const a = r.author || '';
          if ((r.links || []).length && !seen.has(a)) { seen.add(a); vals.push(a); }
        }
        return vals;
      }, () => linkUserSel, (s) => { linkUserSel = s; renderPanelBody(); }));
      // link column: one checkbox per distinct link domain
      bar.appendChild(buildFilterControl('Domain ▾', () => {
        const seen = new Set();
        const vals = [];
        for (const r of orderedRecords()) {
          for (const u of (r.links || [])) {
            const d = extractDomain(u);
            if (d && !seen.has(d)) { seen.add(d); vals.push(d); }
          }
        }
        return vals;
      }, () => linkDomainSel, (s) => { linkDomainSel = s; renderPanelBody(); }));
      bar.hidden = true;
      return bar;
    }

    function buildEdgeButton() {
      const b = document.createElement('button');
      b.type = 'button';
      b.id = 'xft-edge-btn';
      b.textContent = '📁 Media';
      b.title = 'Open media panel';
      b.addEventListener('click', () => setPanelOpen(true));
      document.body.appendChild(b);
    }

    // settings drawer: slide/drop in on open, fade out on close (the plain
    // hidden flip is instant and reads as a glitch)
    let settingsCloseTimer = null;
    function toggleSettings() {
      if (!settingsView) return;
      if (settingsCloseTimer) { clearTimeout(settingsCloseTimer); settingsCloseTimer = null; }
      if (settingsView.hidden) {
        settingsView.hidden = false;
        settingsView.classList.remove('xft-vclose');
        requestAnimationFrame(() => settingsView.classList.add('xft-vwin'));
      } else {
        settingsView.classList.remove('xft-vwin');
        settingsView.classList.add('xft-vclose');
        settingsCloseTimer = setTimeout(() => {
          settingsCloseTimer = null;
          settingsView.hidden = true;
          settingsView.classList.remove('xft-vclose');
        }, 160);
      }
    }

    function buildPanel() {
      panel = document.createElement('div');
      panel.id = 'xft-panel';
      panel.className = 'xft-panel';

      const head = document.createElement('div');
      head.className = 'xft-head';
      const title = document.createElement('span');
      title.className = 'xft-title';
      title.textContent = 'xf-thread-tools';
      progressEl = document.createElement('span');
      progressEl.className = 'xft-progress';
      progressEl.textContent = '–';
      const cancelBtn = mkBtn('■ Stop', () => { if (hub.abortRef) hub.abortRef.aborted = true; });
      const refreshBtn = mkBtn('↻ Refresh', () => { ensure(true); });
      panelCancelBtn = cancelBtn;
      panelRefreshBtn = refreshBtn;
      const gearBtn = mkBtn('⚙', () => toggleSettings());
      const closeBtn = mkBtn('✕', () => setPanelOpen(false));
      head.append(title, progressEl, cancelBtn, refreshBtn, gearBtn, closeBtn);

      const tabs = document.createElement('div');
      tabs.className = 'xft-tabs';
      tabFilesBtn = mkBtn('Media', () => setTab('media'), 'xft-btn xft-tab');
      tabLinksBtn = mkBtn('Links', () => setTab('links'), 'xft-btn xft-tab');
      panelCountEl = document.createElement('span');
      panelCountEl.className = 'xft-count';
      panelCountEl.textContent = '0 items';
      tabs.append(tabFilesBtn, tabLinksBtn, panelCountEl);

      // media sub-tabs (All / Image / Video), below the main tab row
      subtabsEl = document.createElement('div');
      subtabsEl.className = 'xft-subtabs';
      subtabsEl.hidden = true;
      subTabBtns.all = mkBtn('All', () => setSubTab('all'), 'xft-btn xft-subtab');
      subTabBtns.image = mkBtn('Image', () => setSubTab('image'), 'xft-btn xft-subtab');
      subTabBtns.video = mkBtn('Video', () => setSubTab('video'), 'xft-btn xft-subtab');
      subTabBtns.all.classList.add('xft-tab-active');
      // group-by picker lives in the sub-tab row: flat | post | page | user.
      // Persisted in settings, so switching All/Image/Video keeps the group.
      const groupSel = document.createElement('select');
      groupSel.className = 'xft-gsel';
      groupSel.title = 'Group media by';
      groupSel.setAttribute('aria-label', 'Group media by');
      for (const g of [['flat', 'Flat'], ['post', 'Post'], ['page', 'Page'], ['user', 'User']]) {
        const o = document.createElement('option');
        o.value = g[0];
        o.textContent = 'Group: ' + g[1];
        groupSel.appendChild(o);
      }
      groupSel.value = settings.mediaGroup;
      groupSel.addEventListener('change', () => {
        saveViewScroll();
        settings.mediaGroup = groupSel.value;
        writeStore(SETTINGS_KEY, settings);
        clearVRows();
        renderPanelBody();
      });
      // bulk download: zips the current list (Pics/ + Videos/) as one file
      const dlBtn = mkBtn('Download', startBulkDownload, 'xft-btn xft-subtab xft-dlbtn');
      dlBtnEl = dlBtn;
      updateDlBtn();
      subtabsEl.append(subTabBtns.all, subTabBtns.image, subTabBtns.video, groupSel, dlBtn);

      // bulk download status dashboard: file name, % bar, counts, speed, cancel
      dlBarEl = document.createElement('div');
      dlBarEl.className = 'xft-dlbar';
      dlBarEl.hidden = true;
      dlNameEl = document.createElement('span');
      dlNameEl.className = 'xft-dlname';
      dlCancelEl = mkBtn('Cancel', () => { if (dlRun.running) startBulkDownload(); }, 'xft-btn xft-dlcancel');
      dlCloseEl = mkBtn('✕', () => { dlBarEl.hidden = true; }, 'xft-btn xft-dlclose');
      dlCloseEl.hidden = true;
      const dlTop = document.createElement('div');
      dlTop.className = 'xft-dltop';
      dlTop.append(dlNameEl, dlCancelEl, dlCloseEl);
      const dlProg = document.createElement('div');
      dlProg.className = 'xft-dlprog';
      dlFillEl = document.createElement('i');
      dlProg.appendChild(dlFillEl);
      dlStatsEl = document.createElement('div');
      dlStatsEl.className = 'xft-dlstats';
      dlBarEl.append(dlTop, dlProg, dlStatsEl);

      linksBarEl = buildLinksBar();

      settingsView = buildSettingsView();
      panelBodyEl = document.createElement('div');
      panelBodyEl.className = 'xft-body';
      // go-to-top / go-to-bottom shortcuts, floating over the list
      const jumps = document.createElement('div');
      jumps.className = 'xft-jumps';
      const jumpTop = mkBtn('⤒', () => jumpScroll(true), 'xft-btn xft-jumpbtn');
      const jumpBottom = mkBtn('⤓', () => jumpScroll(false), 'xft-btn xft-jumpbtn');
      jumpTop.title = 'Go to top';
      jumpBottom.title = 'Go to bottom';
      jumps.append(jumpTop, jumpBottom);
      noteEl = document.createElement('div');
      noteEl.className = 'xft-note';
      noteEl.hidden = true;

      panel.append(head, tabs, subtabsEl, dlBarEl, linksBarEl, settingsView, panelBodyEl, jumps, noteEl);
      document.body.appendChild(panel);
      setTab('media');
      buildEdgeButton();
      installWheelNormalizer();
    }

    // ---------- step 9: toolbar injection ----------
    function injectToolbar() {
      const host = document.querySelector(SEL.toolbar) || document.querySelector(SEL.toolbarFallback)
        || document.querySelector('.p-body') || document.querySelector('.p-title');
      if (!host) {
        console.warn('[xf-thread-tools] toolbar anchor not found — buttons not injected.');
        return;
      }
      const sortBtn = document.createElement('button');
      sortBtn.type = 'button';
      sortBtn.id = 'xft-sort-btn';
      sortBtn.className = 'button button--link';
      sortBtn.textContent = '⚡ Sort by reactions';
      sortBtn.addEventListener('click', () => sorter.toggle());
      host.append(sortBtn);
    }

    function injectStyles() {
      // Design system: shadcn/ui's token set (zinc palette, HSL custom
      // properties, --radius scale) ported to plain CSS. Everything is
      // scoped with the --xft-* prefix so the host page is untouched;
      // component classes consume tokens only — never raw colors.
      const st = document.createElement('style');
      st.textContent = [
        ':root{',
        '--xft-bg:0 0% 100%;--xft-fg:240 10% 3.9%;--xft-card:0 0% 100%;--xft-popover:0 0% 100%;',
        '--xft-muted:240 4.8% 95.9%;--xft-muted-fg:240 3.8% 46.1%;',
        '--xft-primary:240 5.9% 10%;--xft-primary-fg:0 0% 98%;',
        '--xft-secondary:240 4.8% 95.9%;--xft-secondary-fg:240 5.9% 10%;',
        '--xft-accent:240 4.8% 95.9%;--xft-accent-fg:240 5.9% 10%;',
        '--xft-destructive:0 84.2% 60.2%;--xft-border:240 5.9% 90%;--xft-input:240 5.9% 90%;--xft-ring:240 5.9% 10%;',
        '--xft-radius:0.5rem;',
        '}',
        '@media (prefers-color-scheme:dark){:root{',
        '--xft-bg:240 10% 3.9%;--xft-fg:0 0% 98%;--xft-card:240 10% 3.9%;--xft-popover:240 10% 3.9%;',
        '--xft-muted:240 3.7% 15.9%;--xft-muted-fg:240 5% 64.9%;',
        '--xft-primary:0 0% 98%;--xft-primary-fg:240 5.9% 10%;',
        '--xft-secondary:240 3.7% 15.9%;--xft-secondary-fg:0 0% 98%;',
        '--xft-accent:240 3.7% 15.9%;--xft-accent-fg:0 0% 98%;',
        '--xft-destructive:0 62.8% 50.6%;--xft-border:240 3.7% 15.9%;--xft-input:240 3.7% 15.9%;--xft-ring:240 4.9% 83.9%;',
        '}}',
        // ---- surfaces ----
        '#xft-panel{position:fixed;top:0;right:0;bottom:0;width:560px;max-width:100vw;display:flex;flex-direction:column;background:hsl(var(--xft-bg));color:hsl(var(--xft-fg));border-left:1px solid hsl(var(--xft-border));box-shadow:0 10px 40px hsl(240 10% 3.9%/.18);z-index:9999;font:12px/1.5 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Inter,Roboto,\'Helvetica Neue\',Arial,sans-serif;transform:translateX(100%);transition:transform .28s cubic-bezier(.16,1,.3,1)}',
        '#xft-panel.xft-open{transform:translateX(0)}',
        '#xft-edge-btn{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:9998;border:1px solid hsl(var(--xft-border));border-right:none;border-radius:calc(var(--xft-radius) - 2px) 0 0 calc(var(--xft-radius) - 2px);background:hsl(var(--xft-bg));color:hsl(var(--xft-fg));padding:14px 9px;cursor:pointer;font:12px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Inter,sans-serif;writing-mode:vertical-rl;box-shadow:0 4px 16px hsl(240 10% 3.9%/.15);transition:background .15s,opacity .2s}',
        '#xft-edge-btn:hover{background:hsl(var(--xft-accent))}',
        '#xft-edge-btn.xft-edge-hidden{opacity:0;pointer-events:none}',
        // ---- button (secondary / outline / ghost variants) ----
        '.xft-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;padding:0 10px;border:1px solid transparent;border-radius:calc(var(--xft-radius) - 4px);background:hsl(var(--xft-secondary));color:hsl(var(--xft-secondary-fg));font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s,color .15s;user-select:none}',
        '.xft-btn:hover{background:hsl(var(--xft-accent));color:hsl(var(--xft-accent-fg))}',
        '.xft-btn:focus-visible,#xft-edge-btn:focus-visible,.xft-cell:focus-visible,.xft-vthumb:focus-visible{outline:2px solid transparent;box-shadow:0 0 0 2px hsl(var(--xft-bg)),0 0 0 4px hsl(var(--xft-ring))}',
        '.xft-btn:disabled{opacity:.45;cursor:default;pointer-events:none}',
        // fetch spinner (page-loading indicator)
        '.xft-spinner{display:inline-block;vertical-align:-1px;width:11px;height:11px;margin-right:4px;border:2px solid hsl(var(--xft-border));border-top-color:hsl(var(--xft-primary));border-radius:50%;animation:xft-rot .7s linear infinite}',
        '@keyframes xft-rot{to{transform:rotate(360deg)}}',
        // removal fade-out + pop suppression on rebuild
        '.xft-cell.xft-out{animation:xft-out .22s ease-in both;pointer-events:none}',
        '.xft-vrow.xft-nopop img,.xft-vrow.xft-nopop video,.xft-vrow.xft-nopop .xft-vtile{animation:none}',
        // viewer + settings open/close
        '#xft-viewer.xft-vwin{animation:xft-pop .2s ease-out}',
        '#xft-viewer.xft-vclose{animation:xft-out .16s ease-in both}',
        '.xft-settings.xft-vwin{animation:xft-drop .18s ease-out}',
        '.xft-settings.xft-vclose{animation:xft-out .14s ease-in both}',
        '@keyframes xft-drop{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}',
        // ---- bars / rows ----
        '.xft-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid hsl(var(--xft-border));user-select:none}',
        '.xft-title{font-weight:600;letter-spacing:-.01em;margin-right:auto;white-space:nowrap}',
        '.xft-progress{font-variant-numeric:tabular-nums;color:hsl(var(--xft-muted-fg));margin-right:4px}',
        // shadcn TabsList: muted rounded track; active trigger = surface + shadow
        '.xft-tabs{display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:1px solid hsl(var(--xft-border));background:hsl(var(--xft-muted))}',
        '.xft-tabs .xft-tab{background:transparent;border-color:transparent;color:hsl(var(--xft-muted-fg))}',
        '.xft-tabs .xft-tab:hover{background:hsl(var(--xft-fg)/.08);color:hsl(var(--xft-fg))}',
        '.xft-tabs .xft-tab-active,.xft-tabs .xft-tab-active:hover{background:hsl(var(--xft-bg));color:hsl(var(--xft-fg));border-color:hsl(var(--xft-border));box-shadow:0 1px 2px hsl(240 10% 3.9%/.1)}',
        '.xft-count{margin-left:auto;color:hsl(var(--xft-muted-fg));font-variant-numeric:tabular-nums}',
        '.xft-subtabs{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid hsl(var(--xft-border))}',
        '.xft-subtabs[hidden]{display:none}',
        '.xft-subtab{font-size:11px;height:22px;padding:0 8px;background:transparent;color:hsl(var(--xft-muted-fg))}',
        '.xft-subtab:hover{background:hsl(var(--xft-accent));color:hsl(var(--xft-accent-fg))}',
        // shadcn Toggle active: secondary chip, readable on the plain panel bg
        '.xft-subtab.xft-tab-active,.xft-subtab.xft-tab-active:hover{background:hsl(var(--xft-secondary));color:hsl(var(--xft-fg));font-weight:600}',
        '.xft-gsel{margin-left:auto;height:22px;font-size:11px;background:hsl(var(--xft-secondary));color:hsl(var(--xft-fg));border:1px solid hsl(var(--xft-border));border-radius:6px;padding:0 4px;cursor:pointer;outline:none}',
        '.xft-dlbtn{min-width:70px;text-align:center}',
        '.xft-dlbar{padding:8px 10px;border-bottom:1px solid hsl(var(--xft-border));background:hsl(var(--xft-muted));display:flex;flex-direction:column;gap:6px}',
        '.xft-dltop{display:flex;align-items:center;gap:6px;min-width:0}',
        '.xft-dlname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}',
        '.xft-dlprog{height:6px;border-radius:99px;background:hsl(var(--xft-border));overflow:hidden}',
        '.xft-dlprog>i{display:block;height:100%;width:0;background:hsl(var(--xft-ring));border-radius:99px;transition:width .25s}',
        '.xft-dlstats{display:flex;gap:12px;color:hsl(var(--xft-muted-fg));font-variant-numeric:tabular-nums;font-size:11px;white-space:nowrap;overflow:hidden}',
        '.xft-dl-ok{color:hsl(142 60% 45%)}',
        '.xft-dl-bad{color:hsl(var(--xft-destructive))}',
        '.xft-dl-on{color:hsl(var(--xft-fg))}',
        '.xft-dlzip .xft-dlprog>i{width:100%;background:linear-gradient(90deg,transparent,hsl(var(--xft-ring)),transparent);background-size:200% 100%;animation:xft-dlslide 1.1s linear infinite}',
        '@keyframes xft-dlslide{from{background-position:200% 0}to{background-position:-200% 0}}',
        '.xft-dl-run{background:hsl(var(--xft-ring)/.18)!important;border-color:hsl(var(--xft-ring))!important}',
        '.xft-jumps{position:absolute;right:10px;bottom:14px;display:flex;flex-direction:column;gap:6px;z-index:5}',
        '.xft-jumpbtn{width:30px;height:30px;padding:0;font-size:14px;line-height:1;border-radius:8px;box-shadow:0 2px 8px hsl(240 10% 3.9%/.25)}',
        // group headers: label + hairline filler; heights are FIXED (30/24px)
        // and mirrored in layoutTops() — the virtualizer's scroll math
        // depends on them
        '.xft-ghead{display:flex;align-items:center;gap:8px;height:30px;user-select:none}',
        '.xft-ghead.xft-gjump{cursor:pointer}',
        '.xft-glabel{font-size:12px;font-weight:600;color:hsl(var(--xft-fg));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70%}',
        '.xft-gline{flex:1 1 auto;border-top:1px solid hsl(var(--xft-border))}',
        '.xft-gsub{height:24px;padding-left:14px}',
        '.xft-gsub .xft-glabel{font-weight:500;font-size:11px;color:hsl(var(--xft-muted-fg))}',
        '.xft-linksbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid hsl(var(--xft-border))}',
        '.xft-linksbar[hidden]{display:none}',
        // shadcn Input
        '.xft-linksbar input[type=search]{flex:1;min-width:0;height:26px;border:1px solid hsl(var(--xft-input));border-radius:calc(var(--xft-radius) - 4px);padding:0 8px;font:12px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Inter,sans-serif;background:transparent;color:hsl(var(--xft-fg))}',
        '.xft-linksbar input[type=search]::placeholder{color:hsl(var(--xft-muted-fg))}',
        '.xft-linksbar input[type=search]:focus-visible{outline:2px solid transparent;border-color:hsl(var(--xft-ring));box-shadow:0 0 0 2px hsl(var(--xft-ring)/.25)}',
        '.xft-filter{position:relative}',
        '.xft-filter-on{background:hsl(var(--xft-primary));color:hsl(var(--xft-primary-fg));font-weight:600}',
        '.xft-filter-on:hover{background:hsl(var(--xft-primary));color:hsl(var(--xft-primary-fg));opacity:.9}',
        // ---- body / grid ----
        '.xft-body{overflow-y:auto;flex:1;padding:8px 10px;scrollbar-width:thin;scrollbar-color:hsl(var(--xft-border)) transparent;overscroll-behavior:contain;overflow-anchor:none}',
        '.xft-body::-webkit-scrollbar{width:8px}',
        '.xft-body::-webkit-scrollbar-thumb{background:hsl(var(--xft-muted));border-radius:4px}',
        '.xft-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}',
        '.xft-vrows{display:flex;flex-direction:column;gap:6px}',
        '.xft-vrow{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}',
        '.xft-cell{position:relative;aspect-ratio:1;overflow:hidden;border:1px solid hsl(var(--xft-border));border-radius:calc(var(--xft-radius) - 2px);cursor:zoom-in;background:hsl(var(--xft-muted));padding:0;transition:box-shadow .15s}',
        '.xft-cell:hover{box-shadow:0 0 0 2px hsl(var(--xft-ring)/.35)}',
        '.xft-cell img,.xft-cell video{width:100%;height:100%;object-fit:cover;display:block}',
        // video thumbs: no fetch — a muted gradient tile with the ▶ badge
        '.xft-cell .xft-vtile{width:100%;height:100%;background:linear-gradient(160deg,hsl(var(--xft-muted)),hsl(var(--xft-muted-fg)/.14));display:flex;align-items:center;justify-content:center;position:relative}',
        // the video ▶ marker is the .xft-cell-badge chip — do not add a second one here
        '.xft-cell-label{position:absolute;left:0;right:0;bottom:0;background:linear-gradient(transparent,hsl(240 10% 3.9%/.82));color:hsl(0 0% 98%);font-size:10px;padding:12px 5px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}',
        // shadcn Badge (secondary) for the ▶ marker
        '.xft-cell-badge{position:absolute;top:4px;right:4px;background:hsl(240 10% 3.9%/.72);color:hsl(0 0% 98%);border-radius:9999px;font-size:10px;font-weight:500;padding:1px 7px;pointer-events:none}',
        '.xft-broken{opacity:.15;filter:grayscale(1)}',
        // a dead link renders as an explicit placeholder, never a black void
        '.xft-cell.xft-broken,.xft-vthumb.xft-broken{background:hsl(var(--xft-muted))}',
        '.xft-cell.xft-broken::after{content:"⚠ broken link";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;color:hsl(var(--xft-muted-fg));pointer-events:none}',
        '.xft-vthumb.xft-broken::after{content:"⚠";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:16px;color:hsl(0 0% 98%/.7)}',
        // ---- links table ----
        '.xft-lrow{display:grid;grid-template-columns:170px 1fr;gap:8px;align-items:baseline;padding:3px 0;border-bottom:1px solid hsl(var(--xft-border)/.5)}',
        '.xft-lrow-first{padding-top:6px}',
        '.xft-lcell-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;color:hsl(var(--xft-fg));font-weight:500;background:none}',
        '.xft-lcell-label:hover,.xft-lcell-label:focus-visible{text-decoration:underline;text-underline-offset:2px;color:hsl(var(--xft-primary))}',
        '.xft-lcell-link{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
        '.xft-lcell-link a{color:hsl(var(--xft-muted-fg));text-decoration:none}',
        '.xft-lcell-link a:hover{color:hsl(var(--xft-fg));text-decoration:underline;text-underline-offset:2px}',
        '.xft-empty{padding:12px 0;color:hsl(var(--xft-muted-fg))}',
        // ---- popover ----
        '.xft-fpop{position:absolute;top:calc(100% + 6px);right:0;min-width:200px;max-width:280px;max-height:280px;overflow:auto;scrollbar-width:thin;background:hsl(var(--xft-popover));border:1px solid hsl(var(--xft-border));border-radius:calc(var(--xft-radius) - 2px);box-shadow:0 8px 30px hsl(240 10% 3.9%/.22);padding:6px;z-index:20}',
        '.xft-fpop-head{display:flex;gap:6px;padding:2px 2px 6px;border-bottom:1px solid hsl(var(--xft-border)/.6);margin-bottom:4px}',
        '.xft-fpop-head .xft-btn{height:22px;padding:0 8px;font-size:11px;background:transparent;color:hsl(var(--xft-muted-fg))}',
        '.xft-fpop label{display:flex;align-items:center;gap:6px;padding:3px 5px;border-radius:calc(var(--xft-radius) - 4px);font-size:11px;color:hsl(var(--xft-fg));cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.xft-fpop label:hover{background:hsl(var(--xft-accent))}',
        '.xft-fpop label span{overflow:hidden;text-overflow:ellipsis}',
        // ---- notice / settings ----
        '.xft-note{padding:6px 10px;border-top:1px solid hsl(var(--xft-border));color:hsl(32 95% 30%);background:hsl(38 92% 50%/.14);font-size:11px}',
        '.xft-note[hidden]{display:none}',
        '.xft-settings{padding:8px;border-bottom:1px solid hsl(var(--xft-border))}',
        '.xft-settings[hidden]{display:none}',
        '.xft-set-row{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:11px;color:hsl(var(--xft-fg))}',
        '.xft-set-row span{flex:0 0 150px;color:hsl(var(--xft-muted-fg))}',
        '.xft-set-row input{flex:1;height:24px;border:1px solid hsl(var(--xft-input));border-radius:calc(var(--xft-radius) - 4px);padding:0 6px;font-size:11px;background:transparent;color:hsl(var(--xft-fg))}',
        '.xft-set-row input:focus-visible{outline:2px solid transparent;border-color:hsl(var(--xft-ring));box-shadow:0 0 0 2px hsl(var(--xft-ring)/.25)}',
        // ---- viewer (always dark media surface, independent of theme) ----
        '#xft-viewer{position:fixed;inset:0;background:hsl(240 10% 3.9%/.94);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}',
        '#xft-viewer iframe{width:min(92vw,1120px);aspect-ratio:16/9;max-height:80vh;border:0;border-radius:calc(var(--xft-radius) - 2px);background:#000}',
        // every viewer media sits in ONE fixed-size slot: no size popping
        // between items; shimmer until loaded
        '.xft-vslot{position:relative;height:80vh;width:min(92vw,1120px);display:flex;align-items:center;justify-content:center;background:#000;border-radius:calc(var(--xft-radius) - 2px);overflow:hidden}',
        // fixed-height media stage: paging must not move bar/filmstrip
        '.xft-vstage{height:80vh;width:min(92vw,1120px);display:flex;align-items:center;justify-content:center}',
        // image slot: narrow placeholder box while loading; JS sets the
        // exact aspect width on load (markMediaLoaded / openViewerAt)
        '.xft-vslot.xft-vimg{width:min(45vh,420px)}',
        '.xft-vslot img,.xft-vslot video{max-width:100%;max-height:100%;object-fit:contain}',
        // media renders PROGRESSIVELY while loading (no opacity gate): a
        // progressive JPEG paints blurry-then-sharp on its own — a real
        // blur-up with zero extra requests (hosts offer no tiny-image URLs)
        // reveal-on-load (lazy-load style): while an image streams, it stays
        // hidden inside its shimmer skeleton (no progressive part-by-part
        // painting); when it loads, it fades in sharp as a whole. Cached
        // images are already .xft-ok at build → render instantly.
        '.xft-cell img,.xft-vthumb img,.xft-vslot img{opacity:0;filter:blur(6px);transition:opacity .35s ease,filter .35s ease}',
        '.xft-cell img.xft-ok,.xft-vthumb img.xft-ok,.xft-vslot img.xft-ok{opacity:1;filter:blur(0)}',
        // tiles and video thumbs still pop on build (no progressive paint)
        '.xft-cell video,.xft-cell .xft-vtile{animation:xft-pop .3s ease-out both}',
        // skeleton: bright sweeping band + soft breathing base — strong
        // enough to read as animation, not a static tint
        '.xft-cell.xft-loading,.xft-vslot.xft-loading,.xft-embed-host.xft-loading{animation:xft-skel-pulse 1.6s ease-in-out infinite}',
        '.xft-cell.xft-loading::after,.xft-vslot.xft-loading::after,.xft-embed-host.xft-loading::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(100deg,transparent 20%,hsl(0 0% 98%/.20) 46%,hsl(0 0% 98%/.28) 50%,hsl(0 0% 98%/.20) 54%,transparent 80%);animation:xft-shimmer 1.1s linear infinite}',
        '@keyframes xft-shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}',
        '@keyframes xft-pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}',
        '@keyframes xft-skel-pulse{0%,100%{background-color:hsl(240 6% 16%)}50%{background-color:hsl(240 6% 20%)}}',
        // AFTER the loading rules on purpose: a cell that is both loading
        // and dying must fade out, not keep shimmering (same specificity,
        // source order wins)
        '.xft-cell.xft-out{animation:xft-out .22s ease-in both;pointer-events:none}',
        '@keyframes xft-out{to{opacity:0;transform:scale(.9)}}',
        '@media (prefers-reduced-motion: reduce){html:not(.xft-anim-force) .xft-cell.xft-loading::after,html:not(.xft-anim-force) .xft-vslot.xft-loading::after,html:not(.xft-anim-force) .xft-embed-host.xft-loading::after{animation:none}html:not(.xft-anim-force) .xft-cell.xft-loading,html:not(.xft-anim-force) .xft-vslot.xft-loading,html:not(.xft-anim-force) .xft-embed-host.xft-loading{animation:none}html:not(.xft-anim-force) .xft-cell img,html:not(.xft-anim-force) .xft-cell video,html:not(.xft-anim-force) .xft-cell .xft-vtile{animation:none;transition:none}html:not(.xft-anim-force) .xft-vthumb img,html:not(.xft-anim-force) .xft-vslot img{transition:none}html:not(.xft-anim-force) .xft-spinner,html:not(.xft-anim-force) #xft-viewer,html:not(.xft-anim-force) .xft-settings,html:not(.xft-anim-force) .xft-cell.xft-out{animation:none}}',
        // embed viewer box is sized BEFORE the video arrives (sign round-trip
        // + metadata load would otherwise grow the box from zero and pop)
        '.xft-embed-host{position:relative;display:flex;align-items:center;justify-content:center;width:min(92vw,1120px);aspect-ratio:16/9;max-height:80vh;border-radius:calc(var(--xft-radius) - 2px);background:#000;overflow:hidden}',
        '#xft-viewer .xft-embed-host video{width:100%;height:100%;object-fit:contain;display:block;background:#000}',
        '#xft-viewer .xft-embed-host iframe{width:100%;height:100%;border:0;background:#000}',
        '.xft-viewer-bar{display:flex;gap:8px;align-items:center;color:hsl(0 0% 98%);font-size:12px}',
        '#xft-viewer .xft-btn{background:hsl(240 5% 20%/.85);color:hsl(0 0% 98%);border-color:hsl(240 5% 32%)}',
        '#xft-viewer .xft-btn:hover{background:hsl(240 5% 28%);color:hsl(0 0% 98%)}',
        '#xft-viewer .xft-btn:disabled{opacity:.4}',
        '.xft-viewer-strip{display:flex;gap:6px;overflow-x:auto;max-width:94vw;padding:4px;scrollbar-width:thin}',
        '.xft-vthumb{flex:0 0 72px;width:72px;height:72px;border:2px solid transparent;border-radius:calc(var(--xft-radius) - 4px);overflow:hidden;cursor:pointer;background:hsl(240 5% 12%);position:relative;padding:0}',
        '.xft-vthumb img,.xft-vthumb video{width:100%;height:100%;object-fit:cover;display:block;opacity:.7;transition:opacity .15s}',
        '.xft-vthumb:hover img,.xft-vthumb:hover video{opacity:1}',
        '.xft-vthumb-active{border-color:hsl(0 0% 98%)}',
        '.xft-vthumb-active img,.xft-vthumb-active video{opacity:1}',
        '.xft-vtile img{width:100%;height:100%;object-fit:cover;display:block}',
        // ---- sorted clones / misc (host-page surface) ----
        'article.xf-fetched{border:1px solid hsl(var(--xft-border)/.6);border-radius:var(--xft-radius);margin:8px 0;padding:8px 12px;background:transparent}',
        '.xft-clone-head{font-size:11px;color:hsl(var(--xft-muted-fg));margin-bottom:6px}',
        '.xft-show-more{display:block;margin:8px auto}',
        '.xft-sort-marker{display:none}',
        '.xft-pulse{outline:3px solid transparent;animation:xftpulse 1.6s ease-out 2}',
        '@keyframes xftpulse{0%{outline-color:hsl(38 92% 50%)}100%{outline-color:transparent}}',
        '#xft-sort-btn{margin-left:4px;cursor:pointer}',
        '@media (prefers-reduced-motion:reduce){html:not(.xft-anim-force) #xft-panel,html:not(.xft-anim-force) .xft-btn,html:not(.xft-anim-force) #xft-edge-btn,html:not(.xft-anim-force) .xft-cell{transition:none}html:not(.xft-anim-force) .xft-pulse{animation:none}html:not(.xft-anim-force) .xft-dlzip .xft-dlprog>i{animation:none;background:hsl(var(--xft-ring))}html:not(.xft-anim-force) .xft-dlprog>i{transition:none}}'
      ].join('');
      document.head.appendChild(st);
    }

    // ---------- boot ----------
    (async function init() {
      injectStyles();
      await cache.init();
      const savedMeta = await cache.getThreadMeta(threadKey);
      if (savedMeta) {
        // load complete AND partial caches — partial data stays usable (resume)
        const recs = await cache.getAllPosts(threadKey);
        for (const r of recs) hub.records.set(r.postId, r);
        recordsVersion += 1;
        hub.meta = Object.assign({ threadKey: threadKey, pageCount: getPageCount(), postIds: [], pagesDone: [], fetchedAt: 0, complete: false }, savedMeta);
        hub.meta.pageCount = Math.max(hub.meta.pageCount, getPageCount());
        hub.pagesDone = new Set(savedMeta.pagesDone || []);
        // always re-seed the live page: current-page records refresh with the
        // latest extractor (new media forms appear without a full ↻ Refresh)
        seedLivePage();
        if (seededPage > 0) hub.pagesDone.add(seededPage);
        hub.progress = { done: hub.meta.complete ? hub.meta.pageCount : hub.pagesDone.size, total: hub.meta.pageCount };
        if (hub.meta.pageCount === 1 && hub.pagesDone.has(1)) {
          hub.meta.complete = true;
          hub.meta.fetchedAt = Date.now();
          hub.meta.postIds = orderedRecords().map((r) => r.postId);
          hub.meta.pagesDone = Array.from(hub.pagesDone);
          cache.putThreadMeta(hub.meta).catch(() => {});
        }
      } else {
        seedLivePage();
        if (hub.meta.pageCount === 1 && seededPage === 1) {
          // whole single-page thread is already in the live DOM: no fetch needed
          hub.meta.complete = true;
          hub.meta.fetchedAt = Date.now();
          hub.meta.pagesDone = Array.from(hub.pagesDone);
          hub.meta.postIds = orderedRecords().map((r) => r.postId);
          cache.putThreadMeta(hub.meta).catch(() => {});
        }
      }
      injectToolbar();
      buildPanel();
      applyAnimOverride();
      updateProgressText();
      // background full-thread fetch: starts on page load, resumes partials,
      // never waits for the user to open the panel (setting: autoFetch)
      if (settings.autoFetch && !hub.meta.complete && !currentRun) {
        currentRun = runFetch(false).catch(() => {}).then(() => { currentRun = null; });
      }
    })();
  }

  // UMD export of the pure functions for node:test (no DOM / GM usage in them).
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseReactionCount, filterLinks, sortPosts, estimateSize, partitionLinks, extractDomain, groupLinkItems, applyLinkFilters, boilerplateUrls, isSmilieUrl, parseEmbedPoster, embedSignUrl, parseSignResponse, parseSignToken, parseVideoPage, isVideoPageUrl, hqCandidates, sanitizeFileSeg, siteTagFromHost, cleanThreadTitle, zipFileName, dlBasename, buildDlJobs, crc32, zipStoreU8 };
})();
