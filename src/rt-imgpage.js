// rt-imgpage: Image landing-page HQ resolution: session cache, cooldown, queued net (per-origin 2 / global 6 / 150ms gap, visible-first pick), inflight dedup, force path for viewer/downloads.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // Image landing pages (/img/<id>): the embed is a re-encoded copy (random
    // uuid / /th/ thumb) and the full-quality original — often a signed URL —
    // is only referenced by the page. Only SUCCESSES are cached — a failure
    // cools down for 30s instead (dense grids trip the host's challenge
    // mid-queue; the page is usually fine seconds later, and a permanent ''
    // poisoned whole grid tails to embedded quality for the session while
    // later-run downloads resolved fine — "zip max, view low").
    const imgPageCache = new Map();
    const imgPageCooldown = new Map(); // pageUrl -> retry-not-before timestamp
    const imgPageInflight = new Map();
    // landing-page/API fetches + thumb-byte fetches share one queued net.
    // Throttle (0.22.1): per-origin cap 4, global cap 12, 60ms between
    // starts — politeness is per HOST (the 2/350 lesson came from one
    // origin getting hammered into 403s), so threads whose media sit on
    // several image hosts fetch them in parallel without any host seeing
    // an unbounded burst. Real threads are often single-host: the
    // per-origin cap is the effective ceiling there, which is why it
    // leads the raise.
    // Pick order is visible-first (pure netPick in imgnet.mjs): jobs with
    // no element (landing pages, viewer, downloads — user-initiated) and
    // jobs whose cell is on screen start ahead of off-screen/buffer rows;
    // a 10s aging bound keeps the tail from starving. localhost (fixture
    // probes) keeps a 10ms gap: politeness exists for remote CDNs.
    const IMG_PAGE_GAP = /^(localhost|127\.)/.test(location.hostname) ? 10 : 60;
    const IMG_NET_GLOBAL = 12;
    const IMG_NET_PER_ORIGIN = 4;
    const IMG_NET_AGE_MS = 10000;
    const imgPageNet = { active: 0, perOrigin: {}, queue: [], last: 0 };
    // localhost test hook (IMG_PAGE_GAP convention): __XFT_IMGNET_FOR_TESTS
    // = { global, perOrigin, gap } read on EVERY pump so probes can flip
    // the throttle between runs inside one page.
    function imgNetOpts() {
      const h = (typeof window !== 'undefined' && window.__XFT_IMGNET_FOR_TESTS) || null;
      return {
        global: h && h.global > 0 ? h.global | 0 : IMG_NET_GLOBAL,
        perOrigin: h && h.perOrigin > 0 ? h.perOrigin | 0 : IMG_NET_PER_ORIGIN,
        gap: h && h.gap >= 0 ? h.gap | 0 : IMG_PAGE_GAP,
        ageMs: IMG_NET_AGE_MS
      };
    }
    function imgNetUrgent(el) {
      if (!el) return true; // no element = user-initiated fetch
      if (!el.isConnected) return false; // recycled cell — ages out, never jumps the queue
      const r = el.getBoundingClientRect();
      return r.bottom > -300 && r.top < (innerHeight || 1e9) + 300;
    }
    let imgNetPumpQueued = false;
    function runImgPageNet(job, url, el) {
      let origin = '';
      try { origin = new URL(String(url || '')).origin; } catch (e) { origin = ''; }
      imgPageNet.queue.push({ run: job, origin: origin, el: el || null, at: Date.now(), urgent: false });
      // enqueue defers the pump to a macrotask: cells enqueue their thumbs
      // BEFORE the row attaches (mid-mount), and a synchronous pump here
      // would read every queued cell as disconnected — off-screen — and
      // hand the slots to stale FIFO heads. One deferred pump also collapses
      // a whole mount burst (40 cells -> 1 urgency pass, no reflow storm).
      if (!imgNetPumpQueued) {
        imgNetPumpQueued = true;
        setTimeout(() => { imgNetPumpQueued = false; pumpImgPageNet(); }, 0);
      }
    }
    function pumpImgPageNet() {
      const o = imgNetOpts();
      for (;;) {
        if (!imgPageNet.queue.length) return;
        // pick-time truth, refreshed once per pump: nothing mutates the DOM
        // inside the burst loop, so one pass covers every start it makes
        for (const j of imgPageNet.queue) j.urgent = imgNetUrgent(j.el);
        const i = netPick(imgPageNet.queue, imgPageNet.active, imgPageNet.perOrigin, o, Date.now());
        if (i < 0) return;
        const job = imgPageNet.queue.splice(i, 1)[0];
        imgPageNet.active++; // slot reserved at schedule time
        imgPageNet.perOrigin[job.origin] = (imgPageNet.perOrigin[job.origin] || 0) + 1;
        const wait = Math.max(0, imgPageNet.last + o.gap - Date.now());
        imgPageNet.last = Date.now() + wait;
        setTimeout(() => {
          job.run(() => {
            imgPageNet.active--;
            if (imgPageNet.perOrigin[job.origin] > 1) imgPageNet.perOrigin[job.origin]--;
            else delete imgPageNet.perOrigin[job.origin];
            pumpImgPageNet();
          });
        }, wait);
      }
    }
    function imgPageGet(url, onOk, onErr) {
      runImgPageNet((done) => gmGetText(url, (t) => { onOk(t); done(); }, () => { onErr(); done(); }), url, null);
    }
    function resolveImagePage(pageUrl, embedded, cb, force) {
      const c = imgPageCache.get(pageUrl);
      if (c !== undefined) { cb(c && c !== embedded ? c : ''); return; }
      // recent failure: grid cells wait out the cooldown (they are many);
      // force (viewer / download — user-initiated singles) goes straight
      // through to a fresh attempt
      if (!force && Date.now() < (imgPageCooldown.get(pageUrl) || 0)) { cb(''); return; }
      if (imgPageInflight.has(pageUrl)) { imgPageInflight.get(pageUrl).push(cb); return; }
      const queue = [cb];
      imgPageInflight.set(pageUrl, queue);
      const finish = (hit) => {
        if (hit) imgPageCache.set(pageUrl, hit);
        else {
          if (imgPageCooldown.size > 400) imgPageCooldown.delete(imgPageCooldown.keys().next().value);
          imgPageCooldown.set(pageUrl, Date.now() + 30000);
        }
        imgPageInflight.delete(pageUrl);
        for (const fn of queue) fn(hit);
      };
      // route 1: the landing host's JSON data endpoint (<origin>/api/images/
      // <id>) — carries the direct original, no JS challenge to solve
      let api = '';
      try { const u = new URL(pageUrl); api = u.origin + '/api/images/' + u.pathname.split('/').pop(); } catch (e) { /* keep '' */ }
      // route 2: the landing page HTML itself (og:image / img / link carriers)
      const viaPage = () => imgPageGet(pageUrl, (text) => {
        const cands = parseImagePage(text);
        let hit = '';
        for (const u of cands) {
          if (u !== embedded) { hit = u; break; } // first candidate that is not the embedded copy
        }
        finish(hit);
      }, () => finish(''));
      if (api) {
        imgPageGet(api, (text) => {
          const hit = parseImageApiResponse(text);
          if (hit) finish(hit); else viaPage();
        }, viaPage);
      } else viaPage();
    }

