// rt-thumbcache: Preview thumb cache: memory objectURL layer (LRU, revoke on evict) over IDB thumbs/thumbsMeta stores (LRU at cap), GM blob fetch with the referer ladder through the shared imgPageNet queue, createImageBitmap downscale to THUMB_MAX_SIDE webp, animated-gif split (still thumb + original-bytes memory LRU for hover/viewer). Cells fetch a preview exactly once; re-entry after pool eviction is a memory hit.
// Order-preserving fragment of main()'s body — shares main() scope; no imports. Pure math lives in src/thumb.mjs.
    const thumbMem = new Map();      // key -> {url: objectURL, bytes}
    const thumbGifMem = new Map();   // key -> {url: objectURL, bytes} animated originals
    const thumbInflight = new Map(); // key -> [cbs] (coalesced fetches)
    const thumbNeg = new Set();      // session negatives: never re-fetch, never persist
    const thumbIdbMeta = new Map();  // key -> {bytes, hits, ts} (mirror of thumbsMeta)
    let thumbMemTotal = 0;
    let thumbGifTotal = 0;
    let thumbIdbTotal = 0;
    let thumbIdbOk = true;           // false after quota/error -> memory-only thumbs
    let thumbScanned = false;
    let thumbScanP = null;
    let thumbPruneQueued = false;

    function thumbIdbStores() {
      const db = cache.db;
      if (!db || cache.mode !== 'idb' || !thumbIdbOk) return null;
      if (!db.objectStoreNames.contains('thumbs') || !db.objectStoreNames.contains('thumbsMeta')) return null;
      return db;
    }
    // one-time meta scan (totals + LRU table). Gets never wait on it — a
    // direct key get is correct regardless of scan state; a put landing
    // mid-scan double-counts its bytes in the total until the next prune
    // reconciles (bounded, self-correcting).
    function thumbScan() {
      if (thumbScanned || thumbScanP) return thumbScanP;
      const db = thumbIdbStores();
      if (!db) { thumbScanned = true; return Promise.resolve(); }
      thumbScanP = new Promise((resolve) => {
        let tx;
        try { tx = db.transaction('thumbsMeta', 'readonly'); } catch (e) { thumbScanned = true; resolve(); return; }
        const req = tx.objectStore('thumbsMeta').openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return;
          const v = cur.value;
          if (v && v.key) { thumbIdbMeta.set(v.key, v); thumbIdbTotal += v.bytes | 0; }
          cur.continue();
        };
        req.onerror = () => {};
        tx.oncomplete = () => { thumbScanned = true; resolve(); };
        tx.onerror = () => { thumbScanned = true; resolve(); };
        tx.onabort = () => { thumbScanned = true; resolve(); };
      });
      return thumbScanP;
    }
    function thumbDbPut(key, blob, bytes) {
      const db = thumbIdbStores();
      if (!db) return;
      const finish = () => {
        const prev = thumbIdbMeta.get(key);
        thumbIdbTotal += bytes - (prev ? prev.bytes : 0);
        thumbIdbMeta.set(key, { key: key, bytes: bytes, hits: prev ? prev.hits + 1 : 0, ts: Date.now() });
        if (thumbIdbTotal > THUMB_STORE_CAP && !thumbPruneQueued) {
          thumbPruneQueued = true;
          setTimeout(() => {
            thumbPruneQueued = false;
            thumbDbPrune();
          }, 2000);
        }
      };
      try {
        const tx = db.transaction(['thumbs', 'thumbsMeta'], 'readwrite');
        tx.objectStore('thumbs').put({ key: key, blob: blob });
        tx.objectStore('thumbsMeta').put({ key: key, bytes: bytes, hits: (thumbIdbMeta.get(key) || { hits: 0 }).hits, ts: Date.now() });
        tx.oncomplete = finish;
        tx.onerror = () => { if (tx.error && /quota/i.test(String(tx.error && tx.error.name))) thumbIdbOk = false; };
        tx.onabort = () => { if (tx.error && /quota/i.test(String(tx.error && tx.error.name))) thumbIdbOk = false; };
      } catch (e) { /* degraded mode — memory layer still serves */ }
    }
    function thumbDbPrune() {
      const db = thumbIdbStores();
      if (!db || !(thumbIdbTotal > THUMB_STORE_CAP)) return;
      const drop = prunePlan(thumbIdbTotal, THUMB_STORE_CAP, Array.from(thumbIdbMeta.values()));
      if (!drop.length) return;
      try {
        const tx = db.transaction(['thumbs', 'thumbsMeta'], 'readwrite');
        for (const k of drop) {
          tx.objectStore('thumbs').delete(k);
          tx.objectStore('thumbsMeta').delete(k);
        }
        tx.oncomplete = () => {
          for (const k of drop) {
            const m = thumbIdbMeta.get(k);
            if (m) { thumbIdbTotal -= m.bytes; thumbIdbMeta.delete(k); }
          }
        };
        tx.onerror = () => {};
      } catch (e) { /* keep serving; next put re-queues */ }
    }
    // ---- memory layers --------------------------------------------------
    function thumbMemPut(key, blob) {
      const url = URL.createObjectURL(blob);
      const bytes = blob.size || 0;
      const old = thumbMem.get(key);
      if (old) { thumbMemTotal -= old.bytes; URL.revokeObjectURL(old.url); }
      thumbMem.delete(key);
      thumbMem.set(key, { url: url, bytes: bytes });
      thumbMemTotal += bytes;
      if (thumbMemTotal > THUMB_MEM_CAP) {
        for (const k of prunePlan(thumbMemTotal, THUMB_MEM_CAP, Array.from(thumbMem.entries()).map(([k2, v]) => ({ key: k2, bytes: v.bytes, hits: 1, ts: 0 })))) {
          const e = thumbMem.get(k);
          if (e) { URL.revokeObjectURL(e.url); thumbMemTotal -= e.bytes; thumbMem.delete(k); }
        }
      }
      return url;
    }
    function gifMemPut(key, blob) {
      const bytes = blob.size || 0;
      if (bytes > GIF_MEM_CAP) return null; // one gif larger than the whole layer helps nobody
      const url = URL.createObjectURL(blob);
      const old = thumbGifMem.get(key);
      if (old) { thumbGifTotal -= old.bytes; URL.revokeObjectURL(old.url); }
      thumbGifMem.delete(key);
      thumbGifMem.set(key, { url: url, bytes: bytes });
      thumbGifTotal += bytes;
      while (thumbGifTotal > GIF_MEM_CAP && thumbGifMem.size > 1) {
        const [k, e] = thumbGifMem.entries().next().value; // insertion order = oldest use
        URL.revokeObjectURL(e.url);
        thumbGifTotal -= e.bytes;
        thumbGifMem.delete(k);
      }
      return url;
    }
    // ---- fetch + decode ---------------------------------------------------
    // GM blob GET with the 0.18.2 referer ladder: page-default policy is the
    // forum referer (GM may set it; the fetch fallback uses the spec-legal
    // referrer init), one no-referrer retry on transport/HTTP failure. No
    // cache-bust param needed: GM/fetch results never poison the byte cache
    // we build here — a ≤1px decode is discarded, not stored.
    function gmThumbBytes(url, noRef, cb) {
      const ok = (b) => cb(b || null);
      const fail = () => cb(null);
      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          const hdrs = {};
          if (!noRef && extractDomain(url) !== hostKey(location.host)) hdrs.Referer = location.origin + '/';
          GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            responseType: 'blob',
            timeout: 12000,
            headers: Object.keys(hdrs).length ? hdrs : undefined,
            onload: (r) => {
              const st = r ? (r.status | 0) : 0;
              if (r && r.response && (st === 200 || st === 0)) ok(r.response);
              else fail();
            },
            onerror: fail,
            ontimeout: fail
          });
          return;
        } catch (e) { /* fall through to fetch */ }
      }
      const opts = { credentials: 'omit' };
      if (!noRef && extractDomain(url) !== hostKey(location.host)) opts.referrer = location.origin + '/';
      else if (noRef) opts.referrerPolicy = 'no-referrer';
      // a hung fetch would hold an imgPageNet slot (2 max) and leak the
      // inflight entry forever — same leash lesson as gmGetText (0.18 era)
      const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      if (ctl) {
        opts.signal = ctl.signal;
        setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 12000);
      }
      fetch(url, opts).then((r) => (r.ok ? r.blob() : null)).then(ok, fail);
    }
    function thumbEncode(bmp, blob, forceStill) {
      // still-frame webp at the capped size; for already-small STATIC images
      // the original bytes are the thumb (no needless re-encode). Animated
      // sources always re-encode — the cell must hold frame 0, not the
      // animation, even when the source is already tiny.
      const t = downscaleTarget(bmp.width, bmp.height, THUMB_MAX_SIDE)
        || (forceStill ? { w: bmp.width, h: bmp.height } : null);
      if (!t) return Promise.resolve(blob);
      const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(t.w, t.h) : Object.assign(document.createElement('canvas'), { width: t.w, height: t.h });
      const ctx = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0, t.w, t.h);
      if (typeof cv.convertToBlob === 'function') return cv.convertToBlob({ type: 'image/webp', quality: 0.82 });
      return new Promise((res) => cv.toBlob((b) => res(b), 'image/webp', 0.82));
    }
    function thumbFetch(key, url, cbs) {
      const attempt = (noRef) => gmThumbBytes(url, noRef, (blob) => {
        if (blob === null) {
          if (!noRef) { attempt(true); return; }
          thumbNeg.add(key);
          for (const cb of cbs) cb(null);
          return;
        }
        createImageBitmap(blob).then((bmp) => {
          if (bmp.width <= 1 || bmp.height <= 1) { // hotlink block pixel: valid 1x1 bytes, dead preview
            bmp.close();
            if (!noRef) { attempt(true); return; }
            thumbNeg.add(key);
            for (const cb of cbs) cb(null);
            return;
          }
          const animated = blob.type === 'image/gif' || isGifUrl(url);
          thumbEncode(bmp, blob, animated).then((thumb) => {
            bmp.close();
            if (animated) gifMemPut(key, blob); // hover/viewer play the original bytes
            const memUrl = thumbMemPut(key, thumb);
            thumbDbPut(key, thumb, thumb.size | 0);
            for (const cb of cbs) cb(memUrl);
          }, () => { bmp.close(); for (const cb of cbs) cb(null); }); // the bitmap outlives a failed encode — close it (≈48MB at 4000px)
        }, () => {
          // undecodable bytes (HTML challenge page mid-queue): not worth a
          // no-referrer retry ladder round — the cell fallback handles it
          thumbNeg.add(key);
          for (const cb of cbs) cb(null);
        });
      });
      attempt(false);
    }
    // ---- public API --------------------------------------------------------
    // Sync return: the objectURL when the memory layer already holds the
    // thumb (cells set src before paint — no flash). Otherwise null; cb then
    // fires ASYNC exactly once with the objectURL (fetched/loaded) or null
    // (failed — caller falls back to the direct-URL img path and its failure
    // policy). data:/blob: URLs never enter the cache. `el` (optional, the
    // cell's img element) feeds the net's visible-first pick order: on-
    // screen cells' fetches start ahead of off-screen/buffer rows.
    function thumbFor(url, cb, el) {
      const s = String(url || '');
      if (!s || /^(data|blob):/i.test(s)) { if (cb) setTimeout(() => cb(null), 0); return null; }
      const key = thumbKey(s);
      const hit = thumbMem.get(key);
      if (hit) {
        thumbMem.delete(key); thumbMem.set(key, hit); // LRU touch
        return hit.url;
      }
      if (thumbNeg.has(key)) { if (cb) setTimeout(() => cb(null), 0); return null; }
      let cbs = thumbInflight.get(key);
      if (cbs) { if (cb) cbs.push(cb); return null; }
      cbs = cb ? [cb] : [];
      thumbInflight.set(key, cbs);
      const settle = (u) => {
        thumbInflight.delete(key);
        for (const fn of cbs) fn(u);
      };
      const db = thumbIdbStores();
      if (db) {
        try {
          const req = db.transaction('thumbs', 'readonly').objectStore('thumbs').get(key);
          req.onsuccess = () => {
            const rec = req.result;
            if (rec && rec.blob) {
              const m = thumbIdbMeta.get(key);
              if (m) { m.hits = (m.hits | 0) + 1; }
              settle(thumbMemPut(key, rec.blob));
            } else {
              runImgPageNet((done) => thumbFetch(key, url, [(u) => { settle(u); done(); }]), url, el);
            }
          };
          req.onerror = () => runImgPageNet((done) => thumbFetch(key, url, [(u) => { settle(u); done(); }]), url, el);
          return null;
        } catch (e) { /* fall through to fetch */ }
      }
      runImgPageNet((done) => thumbFetch(key, url, [(u) => { settle(u); done(); }]), url, el);
      return null;
    }
    // Animated-original accessor for hover-play / viewer: sync hit when the
    // original bytes are still in the gif LRU, else async fetch (rare: only
    // after LRU eviction or an IDB-hydrated still). null = give up on anim.
    function gifOriginalUrl(url, cb) {
      const key = thumbKey(String(url || ''));
      const hit = thumbGifMem.get(key);
      if (hit) { thumbGifMem.delete(key); thumbGifMem.set(key, hit); return hit.url; }
      gmThumbBytes(url, false, (blob) => {
        if (blob === null || (blob.type !== 'image/gif' && !isGifUrl(url))) { if (cb) cb(null); return; }
        if (cb) cb(gifMemPut(key, blob));
      });
      return null;
    }
    // cell hint: is this URL an animated original we can hover-play?
    function thumbIsGif(url) { return thumbGifMem.has(thumbKey(String(url || ''))); }
    // NOTE: thumbScan() runs from the boot IIFE right after cache.init() —
    // calling it at fragment-init time would run before the DB opens and
    // permanently mark the scan done against a null handle.
