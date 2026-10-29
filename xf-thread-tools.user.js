// ==UserScript==
// @name         xf-thread-tools
// @namespace    xf-thread-tools
// @version      0.7.11
// @description  XenForo 2: sort thread posts by reaction count across all pages (cached) + floating media panel (images / external links).
// @author       xf-thread-tools
// @match        *://*/threads/*
// @match        *://*/t/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
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
          if (s && !/\/smilies\//i.test(s)) images.push(absolutize(s));
        });
        // HTML5 videos: <video class="videotag"><source src> (site media threads)
        body.querySelectorAll('video').forEach((v) => {
          if (skip(v)) return;
          const srcEl = v.querySelector('source');
          const s = (srcEl && srcEl.getAttribute('src')) || v.getAttribute('src') || '';
          if (s) videos.push(absolutize(s));
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
      return {
        threadKey: threadKey,
        postId: postId,
        pageN: pageN,
        seq: seq,
        author: authorEl ? (authorEl.textContent || '').trim() : '',
        date: dateEl ? (dateEl.getAttribute('datetime') || '') : '',
        reactionCount: reactionCount,
        bodyHtml: body ? lazyBodyHtml(body) : '',
        links: filterLinks(parts.links, location.host).filter((u) => !imgSet.has(u) && !vidSet.has(u)),
        images: Array.from(new Set(images.filter(Boolean))),
        videos: Array.from(new Set(videos.filter(Boolean)))
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
          vrowCache.clear(); // rebuilt records -> cached rows are stale
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
    let vRowHMeasured = 0;
    let vGrid = null; // live media-grid state {topPad,vrows,bottomPad,items,identity,renderRange}
    let settingsView = null;
    let panelTab = 'files';
    let panelSubTab = 'all';        // media sub-tab: all | image | video
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
    function markMediaBroken(el) {
      const host = el.closest('.xft-cell, .xft-vthumb');
      (host || el).classList.add('xft-broken');
    }

    // Build the <img>/<video> element for a grid cell, viewer, or filmstrip
    // thumb. An <img> that fails to load is retried once as <video> —
    // extension-based classification cannot know a URL's real bytes (video
    // links without .mp4 extensions exist); if the video also fails, the
    // element is marked .xft-broken.
    function buildMediaEl(kind, url, thumb) {
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
        v.src = url;
        v.addEventListener('error', () => markMediaBroken(v));
        // cached failures never fire events — probe after a moment
        setTimeout(() => {
          if (v.readyState === 0 && v.networkState === 3) markMediaBroken(v); // NETWORK_NO_SOURCE
        }, 800);
        return v;
      }
      const im = document.createElement('img');
      // thumbs are only created in-range by the virtualizer — eager loading
      // avoids loading=lazy deferral bugs on re-inserted cached rows
      if (!thumb) im.loading = 'lazy';
      im.addEventListener('error', function onErr() {
        im.removeEventListener('error', onErr);
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        v.src = url;
        v.addEventListener('error', () => markMediaBroken(v));
        v.addEventListener('loadedmetadata', () => { if (im.parentNode) im.replaceWith(v); });
        v.load();
      });
      im.src = url;
      // A failure cached by Chrome replays instantly with NO error event, and
      // 1×1 placeholders (svg data-URIs, hotlink-block pixels) "load" as a
      // single stretched pixel = a blank cell. nw<=1 + complete = dead either
      // way — probe for both, or the cell renders blank forever
      if (im.complete && im.naturalWidth <= 1) markMediaBroken(im);
      else {
        im.addEventListener('load', () => { if (im.naturalWidth <= 1) markMediaBroken(im); });
        setTimeout(() => { if (im.complete && im.naturalWidth <= 1) markMediaBroken(im); }, 800);
      }
      return im;
    }

    function updateProgressText() {
      const t = hub.progress.total ? (hub.progress.done + '/' + hub.progress.total) : '–';
      if (progressEl) progressEl.textContent = t;
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
      panelTab = t;
      rowLimit = settings.rowCap;
      vrowCache.clear(); // row indices no longer map to the same items
      if (tabFilesBtn) tabFilesBtn.classList.toggle('xft-tab-active', t === 'media');
      if (tabLinksBtn) tabLinksBtn.classList.toggle('xft-tab-active', t === 'links');
      if (subtabsEl) subtabsEl.hidden = t !== 'media';
      if (linksBarEl) linksBarEl.hidden = t !== 'links';
      renderPanelBody();
    }

    function setSubTab(t) {
      panelSubTab = t;
      vrowCache.clear(); // different kind filter -> different item list
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
    function closeViewer() {
      const v = document.getElementById('xft-viewer');
      if (v) v.remove();
      if (viewerKeyHandler) {
        document.removeEventListener('keydown', viewerKeyHandler);
        viewerKeyHandler = null;
      }
    }

    function openViewerAt(i) {
      if (i < 0 || i >= viewerItems.length) return;
      viewerIndex = i;
      const it = viewerItems[i];
      closeViewer();
      const v = document.createElement('div');
      v.id = 'xft-viewer';
      const media = buildMediaEl(it.kind, it.url, false);
      const bar = document.createElement('div');
      bar.className = 'xft-viewer-bar';
      const info = document.createElement('span');
      info.textContent = (viewerIndex + 1) + '/' + viewerItems.length + ' · [#' + it.pos + '] ' + (it.author || '?');
      const prev = mkBtn('‹ Prev', () => openViewerAt(viewerIndex - 1));
      const next = mkBtn('Next ›', () => openViewerAt(viewerIndex + 1));
      prev.disabled = viewerIndex === 0;
      next.disabled = viewerIndex === viewerItems.length - 1;
      const go = mkBtn('Go to comment', () => { closeViewer(); jumpTo(it.postId); });
      const close = mkBtn('✕ Close', closeViewer);
      bar.append(info, prev, next, go, close);
      v.append(bar, media);
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

    function renderPanelBody() {
      if (!panelIsOpen() || !panelBodyEl) return;
      const ordered = orderedRecords();
      const posMap = new Map(ordered.map((r, i) => [r.postId, i + 1]));
      // signature/"sent via app" boilerplate: URLs recurring across >=3
      // distinct authors — filtered at render so stale caches heal without Refresh
      const boiler = boilerplateUrls(ordered, 3);
      let items = [];
      let filtered = [];
      let mediaCounts = null;
      if (panelTab === 'media') {
        const all = [];
        // stale caches (pre-0.7.9) hold 1×1 data-URI placeholders alongside
        // their real URLs (attachment-scan twins) — drop the placeholders so
        // already-cached threads heal without a Refresh; smilies and
        // signature/footer boilerplate are filtered the same way
        const real = (list) => (list || []).filter((u) => !/^(data|blob):/i.test(u || '') && !/\/smilies\//i.test(u || '') && !boiler.has(String(u || '')));
        for (const r of ordered) {
          for (const url of real(r.images)) all.push({ r: r, url: url, pos: posMap.get(r.postId) || 0, kind: 'image' });
          for (const url of real(r.videos)) all.push({ r: r, url: url, pos: posMap.get(r.postId) || 0, kind: 'video' });
        }
        mediaCounts = { all: all.length, image: 0, video: 0 };
        for (const it of all) mediaCounts[it.kind] += 1;
        updateSubTabCounts(mediaCounts);
        items = panelSubTab === 'all' ? all : all.filter((it) => it.kind === panelSubTab);
        viewerItems = items.map((it) => ({ kind: it.kind, url: it.url, postId: it.r.postId, pos: it.pos, author: it.r.author }));
      } else {
        for (const r of ordered) {
          for (const url of r.links) if (!boiler.has(url)) items.push({ r: r, url: url, pos: posMap.get(r.postId) || 0, kind: 'link' });
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
      const sig = panelTab + ':' + panelSubTab + ':' + rowLimit + ':' + JSON.stringify([
        linkSearchEl ? linkSearchEl.value : '',
        linkUserSel ? Array.from(linkUserSel).sort() : null,
        linkDomainSel ? Array.from(linkDomainSel).sort() : null,
        items.length,
        panelTab === 'media' ? 0 : items.length ? items[items.length - 1].r.postId : 0
      ]);
      if (sig === lastPanelSignature) { updateCountOnly(items.length); return; }
      lastPanelSignature = sig;
      // Media tab, same kind filter, grid still mounted: the only change is
      // item GROWTH from fetch ticks. Keep the DOM exactly as-is — point the
      // grid at the longer list and re-range. A teardown here is what caused
      // blank cells (lazy loads killed mid-flight) and scroll-position loss.
      if (panelTab === 'media' && vGrid && vGrid.topPad.isConnected && vGrid.identity === panelSubTab) {
        vGrid.items = items;
        vGrid.renderRange();
        updateCountOnly(items.length); // growth ticks must refresh the count too
        return;
      }
      const keepScroll = panelBodyEl.scrollTop;
      panelCountEl.textContent = panelTab === 'links' && filtered.length !== items.length
        ? filtered.length + '/' + items.length + ' items'
        : items.length + ' items';
      panelBodyEl.textContent = '';
      const frag = document.createDocumentFragment();
      if (panelTab === 'media') {
        // virtualized grid: only visible rows (+buffer) exist in the DOM
        const topPad = document.createElement('div');
        const vrows = document.createElement('div');
        vrows.className = 'xft-vrows';
        const bottomPad = document.createElement('div');
        frag.append(topPad, vrows, bottomPad);
        const cols = 4;
        const gap = 6;
        let rowH = gridRowH(); // estimate; corrected by measurement below
        const renderRange = () => {
          const gItems = vGrid ? vGrid.items : items;
          const gRows = Math.ceil(gItems.length / cols);
          const st = panelBodyEl.scrollTop;
          const vh = panelBodyEl.clientHeight || 600;
          const pitch = vRowHMeasured || rowH;
          const first = Math.max(0, Math.floor(st / pitch) - 1);
          const last = Math.min(gRows, Math.ceil((st + vh) / pitch) + 1);
          for (const idx of Array.from(vrowCache.keys())) {
            if (idx < first || idx >= last) vrowCache.get(idx).remove();
          }
          for (let r = first; r < last; r++) {
            let rowEl = vrowCache.get(r);
            if (!rowEl) {
              rowEl = document.createElement('div');
              rowEl.className = 'xft-vrow';
              for (let c = 0; c < cols; c++) {
                const i = r * cols + c;
                if (i >= gItems.length) break;
                const it = gItems[i];
                const cell = document.createElement('div');
                cell.className = 'xft-cell';
                cell.title = '[#' + it.pos + '] ' + (it.r.author || '?') + ' — open';
                const isVideo = it.kind === 'video';
                const thumb = buildMediaEl(it.kind, it.url, true);
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
          // scroll jumps on huge virtualized lists
          if (vrows.firstElementChild) {
            const real = vrows.firstElementChild.getBoundingClientRect().height + gap;
            if (real > 0) vRowHMeasured = real;
          }
          topPad.style.height = (first * pitch) + 'px';
          bottomPad.style.height = (Math.max(0, gRows - last) * pitch) + 'px';
        };
        vGrid = { topPad: topPad, vrows: vrows, bottomPad: bottomPad, items: items, identity: panelSubTab, renderRange: renderRange };
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
      panelBodyEl.appendChild(frag);
      if (keepScroll) panelBodyEl.scrollTop = keepScroll;
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
        settings.basePath = inBase.value.trim().replace(/\/+$/, '');
        writeStore(SETTINGS_KEY, settings);
        wrap.hidden = true;
        setTab(panelTab);
      });
      wrap.appendChild(save);
      wrap.hidden = true;
      return wrap;
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
          panelBodyEl.scrollBy({ top: pend, behavior: 'auto' });
          pend = 0;
        });
      }, { passive: false });
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
        debounce = setTimeout(() => { rowLimit = settings.rowCap; vrowCache.clear(); renderPanelBody(); }, 150);
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
      const gearBtn = mkBtn('⚙', () => { settingsView.hidden = !settingsView.hidden; });
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
      subtabsEl.append(subTabBtns.all, subTabBtns.image, subTabBtns.video);

      linksBarEl = buildLinksBar();

      settingsView = buildSettingsView();
      panelBodyEl = document.createElement('div');
      panelBodyEl.className = 'xft-body';
      noteEl = document.createElement('div');
      noteEl.className = 'xft-note';
      noteEl.hidden = true;

      panel.append(head, tabs, subtabsEl, linksBarEl, settingsView, panelBodyEl, noteEl);
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
        '#xft-viewer img,#xft-viewer video{max-width:92vw;max-height:80vh;object-fit:contain;border-radius:calc(var(--xft-radius) - 2px)}',
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
        // ---- sorted clones / misc (host-page surface) ----
        'article.xf-fetched{border:1px solid hsl(var(--xft-border)/.6);border-radius:var(--xft-radius);margin:8px 0;padding:8px 12px;background:transparent}',
        '.xft-clone-head{font-size:11px;color:hsl(var(--xft-muted-fg));margin-bottom:6px}',
        '.xft-show-more{display:block;margin:8px auto}',
        '.xft-sort-marker{display:none}',
        '.xft-pulse{outline:3px solid transparent;animation:xftpulse 1.6s ease-out 2}',
        '@keyframes xftpulse{0%{outline-color:hsl(38 92% 50%)}100%{outline-color:transparent}}',
        '#xft-sort-btn{margin-left:4px;cursor:pointer}',
        '@media (prefers-reduced-motion:reduce){#xft-panel,.xft-btn,#xft-edge-btn,.xft-cell{transition:none}.xft-pulse{animation:none}}'
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
      updateProgressText();
      // background full-thread fetch: starts on page load, resumes partials,
      // never waits for the user to open the panel (setting: autoFetch)
      if (settings.autoFetch && !hub.meta.complete && !currentRun) {
        currentRun = runFetch(false).catch(() => {}).then(() => { currentRun = null; });
      }
    })();
  }

  // UMD export of the pure functions for node:test (no DOM / GM usage in them).
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseReactionCount, filterLinks, sortPosts, estimateSize, partitionLinks, extractDomain, groupLinkItems, applyLinkFilters, boilerplateUrls };
})();
