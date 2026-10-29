// ==UserScript==
// @name         xf-thread-tools
// @namespace    xf-thread-tools
// @version      0.5.3
// @description  XenForo 2: sort thread posts by reaction count across all pages (cached) + floating media panel (images / external links).
// @author       xf-thread-tools
// @match        *://*/threads/*
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
    const threadId = (function () {
      const m = location.pathname.match(/\/threads\/([^/?#]+)/);
      if (!m) return null;
      const seg = decodeURIComponent(m[1]);
      const dot = seg.lastIndexOf('.');
      const tail = dot >= 0 ? seg.slice(dot + 1) : seg;
      return /^\d+$/.test(tail) ? tail : seg;
    })();
    if (!threadId) return; // non-standard thread route: stay silent

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
      const body = art.querySelector(SEL.postBody);

      let reactionCount = 0;
      const bar = art.querySelector(SEL.reactionsBar);
      if (bar && bar.classList.contains('is-active')) {
        const link = bar.querySelector(SEL.reactionsLink);
        if (link) reactionCount = parseReactionCount(link.textContent);
      }

      const rawLinks = [];
      const images = [];
      const videos = [];
      if (body) {
        body.querySelectorAll('a[href]').forEach((a) => rawLinks.push(a.getAttribute('href') || ''));
        body.querySelectorAll(SEL.image).forEach((im) => {
          const s = im.getAttribute('src') || im.getAttribute('data-src') || '';
          if (s) images.push(absolutize(s));
        });
        body.querySelectorAll(SEL.attachment).forEach((a) => {
          const h = a.getAttribute('href') || '';
          if (h) images.push(absolutize(h));
        });
        // HTML5 videos: <video class="videotag"><source src> (site media threads)
        body.querySelectorAll('video').forEach((v) => {
          const srcEl = v.querySelector('source');
          const s = (srcEl && srcEl.getAttribute('src')) || v.getAttribute('src') || '';
          if (s) videos.push(absolutize(s));
        });
      }

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
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('posts')) {
              db.createObjectStore('posts', { keyPath: 'postId' }).createIndex('threadKey', 'threadKey');
            }
            if (!db.objectStoreNames.contains('threads')) {
              db.createObjectStore('threads', { keyPath: 'threadKey' });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
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
      return location.origin + settings.basePath + '/threads/' + threadId + suffix;
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
      // Partial data is usable as-is: never auto-refetch after a cancel or
      // mid-run failure. Explicit refresh (force=true) is the only refetch path.
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
        setSortBtn('⚡ …', true);
        updateProgressText();
        const p = ensure(false);
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
        setSortBtn('↕ Chronological', false);
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
    let showMoreBtn = null;
    let settingsView = null;
    let panelTab = 'files';
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

    function shortenUrl(u) {
      let s = String(u).replace(/^https?:\/\//i, '');
      return s.length > 70 ? s.slice(0, 67) + '…' : s;
    }

    function updateProgressText() {
      const t = hub.progress.total ? (hub.progress.done + '/' + hub.progress.total) : '–';
      if (progressEl) progressEl.textContent = t;
      if (sorterPending) setSortBtn('⚡ ' + t + '…', true);
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
      if (tabFilesBtn) tabFilesBtn.classList.toggle('xft-tab-active', t === 'media');
      if (tabLinksBtn) tabLinksBtn.classList.toggle('xft-tab-active', t === 'links');
      renderPanelBody();
    }

    // fullscreen media viewer with jump-to-comment
    function closeViewer() {
      const v = document.getElementById('xft-viewer');
      if (v) v.remove();
    }

    function openViewer(kind, url, postId, pos, author) {
      closeViewer();
      const v = document.createElement('div');
      v.id = 'xft-viewer';
      const media = kind === 'video' ? document.createElement('video') : document.createElement('img');
      if (kind === 'video') { media.controls = true; media.autoplay = true; }
      media.src = url;
      const bar = document.createElement('div');
      bar.className = 'xft-viewer-bar';
      const info = document.createElement('span');
      info.textContent = '[#' + pos + '] ' + (author || '?');
      const go = mkBtn('Go to comment', () => { closeViewer(); jumpTo(postId); });
      const close = mkBtn('✕ Close', closeViewer);
      bar.append(info, go, close);
      v.append(bar, media);
      v.addEventListener('click', (e) => { if (e.target === v) closeViewer(); });
      document.body.appendChild(v);
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
      const items = [];
      if (panelTab === 'media') {
        for (const r of ordered) {
          for (const url of (r.images || [])) items.push({ r: r, url: url, pos: posMap.get(r.postId) || 0, kind: 'image' });
          for (const url of (r.videos || [])) items.push({ r: r, url: url, pos: posMap.get(r.postId) || 0, kind: 'video' });
        }
      } else {
        for (const r of ordered) {
          for (const url of r.links) items.push({ r: r, url: url, pos: posMap.get(r.postId) || 0, kind: 'link' });
        }
      }
      // skip rebuild when nothing changed — background fetch progress ticks
      // must not churn the grid or reset the user's scroll position
      const sig = panelTab + ':' + items.length + ':' + (panelTab === 'media' ? 0 : items.length ? items[items.length - 1].r.postId : 0);
      if (sig === lastPanelSignature) { updateCountOnly(items.length); return; }
      lastPanelSignature = sig;
      const keepScroll = panelBodyEl.scrollTop;
      panelCountEl.textContent = items.length + ' items';
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
        const totalRows = Math.ceil(items.length / cols);
        const cellW = (panelBodyEl.clientWidth - 20 - (cols - 1) * gap) / cols;
        let rowH = cellW + 2 + gap; // estimate; corrected by measurement below
        const renderRange = () => {
          const st = panelBodyEl.scrollTop;
          const vh = panelBodyEl.clientHeight || 600;
          const first = Math.max(0, Math.floor(st / rowH) - 1);
          const last = Math.min(totalRows, Math.ceil((st + vh) / rowH) + 1);
          vrows.textContent = '';
          for (let r = first; r < last; r++) {
            const rowEl = document.createElement('div');
            rowEl.className = 'xft-vrow';
            for (let c = 0; c < cols; c++) {
              const i = r * cols + c;
              if (i >= items.length) break;
              const it = items[i];
              const cell = document.createElement('div');
              cell.className = 'xft-cell';
              cell.title = '[#' + it.pos + '] ' + (it.r.author || '?') + ' — open';
              const isVideo = it.kind === 'video';
              let thumb;
              if (isVideo) {
                thumb = document.createElement('video');
                thumb.preload = 'metadata';
                thumb.muted = true;
                thumb.src = it.url + (it.url.indexOf('#') === -1 ? '#t=0.1' : '');
              } else {
                thumb = document.createElement('img');
                thumb.loading = 'lazy';
                thumb.src = it.url;
              }
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
              cell.addEventListener('click', () => openViewer(it.kind, it.url, it.r.postId, it.pos, it.r.author));
              rowEl.appendChild(cell);
            }
            vrows.appendChild(rowEl);
          }
          // measure the REAL row pitch and correct the estimate: a few px of
          // drift per row turns into thousands of px of scroll-anchor jumps
          // on huge virtualized lists
          if (vrows.firstElementChild) {
            const real = vrows.firstElementChild.getBoundingClientRect().height + gap;
            if (real > 0 && Math.abs(real - rowH) > 0.5) rowH = real;
          }
          topPad.style.height = (first * rowH) + 'px';
          bottomPad.style.height = (Math.max(0, totalRows - last) * rowH) + 'px';
        };
        renderRange();
        panelBodyEl.onscroll = () => {
          if (vScrollRaf) return;
          vScrollRaf = requestAnimationFrame(() => { vScrollRaf = 0; renderRange(); });
        };
        if (vResizeObserver) vResizeObserver.disconnect();
        vResizeObserver = new ResizeObserver(() => renderRange());
        vResizeObserver.observe(panelBodyEl);
      } else {
        panelBodyEl.onscroll = null;
        if (vResizeObserver) { vResizeObserver.disconnect(); vResizeObserver = null; }
        const max = Math.min(items.length, rowLimit);
        for (let i = 0; i < max; i++) {
          const it = items[i];
          const row = document.createElement('div');
          row.className = 'xft-row';
          const label = document.createElement('span');
          label.className = 'xft-row-label';
          label.textContent = '[#' + it.pos + '] ' + (it.r.author || '?');
          label.title = 'Jump to post ' + it.r.postId;
          label.addEventListener('click', () => jumpTo(it.r.postId));
          const a = document.createElement('a');
          a.href = it.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = shortenUrl(it.url);
          row.append(label, a);
          frag.appendChild(row);
        }
      }
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'xft-empty';
        empty.textContent = hub.fetchRunning ? 'Fetching…' : 'Nothing found yet.';
        frag.appendChild(empty);
      }
      panelBodyEl.appendChild(frag);
      if (keepScroll) panelBodyEl.scrollTop = keepScroll;
      showMoreBtn.hidden = items.length <= rowLimit;
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

      settingsView = buildSettingsView();
      panelBodyEl = document.createElement('div');
      panelBodyEl.className = 'xft-body';
      showMoreBtn = mkBtn('Show more rows', () => { rowLimit += settings.rowCap; renderPanelBody(); });
      showMoreBtn.hidden = true;
      noteEl = document.createElement('div');
      noteEl.className = 'xft-note';
      noteEl.hidden = true;

      panel.append(head, tabs, settingsView, panelBodyEl, showMoreBtn, noteEl);
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
      const st = document.createElement('style');
      st.textContent = [
        '#xft-panel{position:fixed;top:0;right:0;bottom:0;width:560px;max-width:100vw;display:flex;flex-direction:column;background:#fff;color:#14171a;border-left:1px solid #cfd6de;box-shadow:-6px 0 24px rgba(0,0,0,.2);z-index:9999;font:12px/1.45 sans-serif;transform:translateX(100%);transition:transform .28s ease}',
        '#xft-panel.xft-open{transform:translateX(0)}',
        '#xft-edge-btn{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:9998;border:1px solid #cfd6de;border-right:none;border-radius:8px 0 0 8px;background:#fff;color:#14171a;padding:14px 8px;cursor:pointer;font:12px sans-serif;writing-mode:vertical-rl;box-shadow:-4px 0 14px rgba(0,0,0,.18);transition:opacity .2s}',
        '#xft-edge-btn:hover{background:#f0f3f7}',
        '#xft-edge-btn.xft-edge-hidden{opacity:0;pointer-events:none}',
        '.xft-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #e2e7ee;user-select:none}',
        '.xft-title{font-weight:700;margin-right:auto;white-space:nowrap}',
        '.xft-progress{font-variant-numeric:tabular-nums;opacity:.75;margin-right:4px}',
        '.xft-btn{border:1px solid #cfd6de;background:#f4f6f9;color:#14171a;border-radius:4px;padding:2px 8px;cursor:pointer;font:11px sans-serif}',
        '.xft-btn:hover{background:#e8ecf2}',
        '.xft-tabs{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #e2e7ee}',
        '.xft-tab-active{background:#0b6bcb;border-color:#0b6bcb;color:#fff;font-weight:700;box-shadow:0 1px 5px rgba(11,107,203,.45)}',
        '.xft-count{margin-left:auto;opacity:.7}',
        '.xft-body{overflow-y:auto;flex:1;padding:8px 10px;scrollbar-width:thin;overscroll-behavior:contain;overflow-anchor:none}',
        '.xft-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}',
        '.xft-vrows{display:flex;flex-direction:column;gap:6px}',
        '.xft-vrow{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}',
        '.xft-cell{position:relative;aspect-ratio:1;overflow:hidden;border:1px solid #e2e7ee;border-radius:6px;cursor:zoom-in;background:#f4f6f9;padding:0}',
        '.xft-cell img,.xft-cell video{width:100%;height:100%;object-fit:cover;display:block}',
        '.xft-cell-label{position:absolute;left:0;right:0;bottom:0;background:linear-gradient(transparent,rgba(0,0,0,.72));color:#fff;font:10px sans-serif;padding:12px 4px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}',
        '.xft-cell-badge{position:absolute;top:4px;right:4px;background:rgba(0,0,0,.65);color:#fff;border-radius:4px;font:11px sans-serif;padding:1px 6px;pointer-events:none}',
        '#xft-viewer{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}',
        '#xft-viewer img,#xft-viewer video{max-width:92vw;max-height:80vh;object-fit:contain}',
        '.xft-viewer-bar{display:flex;gap:10px;align-items:center;color:#fff;font:12px sans-serif}',
        '.xft-row{display:flex;gap:8px;align-items:baseline;padding:3px 0;border-bottom:1px solid #f0f2f5}',
        '.xft-row-label{white-space:nowrap;cursor:pointer;color:#0b6bcb;text-decoration:underline dotted;max-width:40%;overflow:hidden;text-overflow:ellipsis}',
        '.xft-row a{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit}',
        '.xft-empty{padding:10px 0;opacity:.6}',
        '.xft-note{padding:6px 8px;border-top:1px solid #e2e7ee;color:#8a5300;background:#fff7e0}',
        '.xft-note[hidden]{display:none}',
        '.xft-settings{padding:8px;border-bottom:1px solid #e2e7ee}',
        '.xft-settings[hidden]{display:none}',
        '.xft-set-row{display:flex;align-items:center;gap:8px;margin:4px 0;font:11px sans-serif}',
        '.xft-set-row span{flex:0 0 150px}',
        '.xft-set-row input{flex:1;border:1px solid #cfd6de;border-radius:4px;padding:2px 6px;font:11px sans-serif}',
        'article.xf-fetched{border:1px solid rgba(128,128,128,.35);border-radius:6px;margin:8px 0;padding:8px 12px}',
        '.xft-clone-head{font:11px sans-serif;opacity:.7;margin-bottom:6px}',
        '.xft-show-more{display:block;margin:8px auto}',
        '.xft-sort-marker{display:none}',
        '.xft-pulse{outline:3px solid transparent;animation:xftpulse 1.6s ease-out 2}',
        '@keyframes xftpulse{0%{outline-color:#ffb700}100%{outline-color:transparent}}',
        '#xft-sort-btn{margin-left:4px;cursor:pointer}',
        '@media (prefers-color-scheme:dark){',
        '#xft-panel{background:#1c2027;color:#e6e9ee;border-color:#3a4250}',
        '.xft-head,.xft-tabs{border-color:#3a4250}',
        '.xft-btn{background:#262c36;border-color:#3a4250;color:#e6e9ee}',
        '#xft-edge-btn{background:#1c2027;border-color:#3a4250;color:#e6e9ee}',
        '.xft-tab-active{background:#3b82f6;border-color:#3b82f6;color:#fff}',
        '.xft-cell{border-color:#3a4250;background:#262c36}',
        '.xft-row{border-color:#2a303a}',
        '.xft-note{background:#3a2f14;color:#ffd479;border-color:#3a4250}',
        '}'
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
        if (!hub.meta.complete) {
          seedLivePage(); // refresh live-page data even on partial cache
          if (seededPage > 0) hub.pagesDone.add(seededPage);
        }
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
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseReactionCount, filterLinks, sortPosts, estimateSize, partitionLinks };
})();
