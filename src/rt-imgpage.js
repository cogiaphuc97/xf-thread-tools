// rt-imgpage: Image landing-page HQ resolution: session cache, cooldown, queued net (per-origin 4 / global 12 / 60ms gap, visible-first pick, adaptive per-origin penalty), inflight dedup, force path for viewer/downloads.
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
    const imgPageNet = { active: 0, perOrigin: {}, queue: [], last: 0, originLast: {} };
    // Adaptive per-origin penalty (0.22.3): some CDN families (the scdn
    // poster infra documented 0.7.18) challenge cookie-less bursts above 2
    // concurrent — first few 200, then 403 for the whole session. Raising
    // the per-origin cap to 4 for speed tripped them. Instead of capping
    // everyone, a FAILED fetch (challenge page, block pixel, dead ladder)
    // punishes just that origin back to the proven poster-net profile —
    // 2 concurrent + 350ms between starts — for an escalating window
    // (60s x trips, max 5min). Healthy origins keep the fast 4/60 profile.
    // Session-only, behavior-based: no hostnames anywhere.
    const imgNetPenalty = new Map(); // origin -> { trips, until }
    const IMG_NET_PENALTY_CAP = 2;
    const IMG_NET_PENALTY_GAP = 350;
    function imgNetPunish(url) {
      let origin = '';
      try { origin = new URL(String(url || '')).origin; } catch (e) { return; }
      if (!origin) return;
      const p = imgNetPenalty.get(origin) || { trips: 0, until: 0 };
      p.trips++;
      p.until = Date.now() + Math.min(60000 * p.trips, 300000);
      imgNetPenalty.set(origin, p);
    }
    function imgNetPenalized(origin) {
      const p = imgNetPenalty.get(origin);
      return !!(p && Date.now() < p.until);
    }
    // localhost test hook (IMG_PAGE_GAP convention): __XFT_IMGNET_FOR_TESTS
    // = { global, perOrigin, gap } read on EVERY pump so probes can flip
    // the throttle between runs inside one page.
    function imgNetOpts() {
      const h = (typeof window !== 'undefined' && window.__XFT_IMGNET_FOR_TESTS) || null;
      const penalize = new Set();
      if (h && Array.isArray(h.penalize)) for (const org of h.penalize) penalize.add(org);
      for (const [org, p] of imgNetPenalty) if (Date.now() < p.until) penalize.add(org);
      const originCaps = {};
      for (const org of penalize) originCaps[org] = IMG_NET_PENALTY_CAP;
      return {
        global: h && h.global > 0 ? h.global | 0 : IMG_NET_GLOBAL,
        perOrigin: h && h.perOrigin > 0 ? h.perOrigin | 0 : IMG_NET_PER_ORIGIN,
        gap: h && h.gap >= 0 ? h.gap | 0 : IMG_PAGE_GAP,
        ageMs: IMG_NET_AGE_MS,
        penalize: penalize,
        originCaps: originCaps
      };
    }
    // pick key for netPick (0.29.1): tier 0 user (no el), 1 visible, 2
    // attached-by-layout-position, 3 detached-FIFO. rank = visual position
    // (top*1e5 + left) so loading follows the CURRENT layout left-to-right,
    // top-to-bottom — a mid-session re-sort re-ranks on the next pump
    // because cells are pooled and their rects are re-read every pump
    function imgNetKey(el, at) {
      if (!el) return { tier: 0, rank: 0 };
      if (!el.isConnected) return { tier: 3, rank: at };
      const r = el.getBoundingClientRect();
      const vis = r.bottom > -300 && r.top < (innerHeight || 1e9) + 300;
      return { tier: vis ? 1 : 2, rank: Math.round(r.top) * 1e5 + Math.round(r.left) };
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
        for (const j of imgPageNet.queue) { const k = imgNetKey(j.el, j.at); j.tier = k.tier; j.rank = k.rank; }
        const i = netPick(imgPageNet.queue, imgPageNet.active, imgPageNet.perOrigin, o);
        if (i < 0) return;
        const job = imgPageNet.queue.splice(i, 1)[0];
        imgPageNet.active++; // slot reserved at schedule time
        imgPageNet.perOrigin[job.origin] = (imgPageNet.perOrigin[job.origin] || 0) + 1;
        // global start gap for every origin, PLUS a per-origin gap for
        // penalized ones (350ms spacing on top of the 2-concurrent cap —
        // the challenge trigger is the burst, not just the overlap)
        const orgGap = o.penalize.has(job.origin) ? IMG_NET_PENALTY_GAP : 0;
        const prevOrg = imgPageNet.originLast[job.origin] || 0;
        const wait = Math.max(0, imgPageNet.last + o.gap - Date.now(), prevOrg + orgGap - Date.now());
        imgPageNet.last = Date.now() + wait;
        imgPageNet.originLast[job.origin] = Date.now() + wait;
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
      runImgPageNet((done) => gmGetText(url, (t) => { onOk(t); done(); }, () => { onErr(); imgNetPunish(url); done(); }), url, null);
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

