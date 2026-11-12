// rt-imgpage: Image landing-page HQ resolution: session cache, cooldown, queued net (2/350ms), inflight dedup, force path for viewer/downloads.
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
    // landing-page/API fetches run serialized (2 concurrent, 350ms apart) —
    // scrolling a dense grid resolves one page per cell and a burst would
    // trip the host's challenge, the same lesson the poster queue learned
    const imgPageNet = { active: 0, queue: [], last: 0 };
    function runImgPageNet(job) {
      imgPageNet.queue.push(job);
      pumpImgPageNet();
    }
    function pumpImgPageNet() {
      if (imgPageNet.active >= 2 || !imgPageNet.queue.length) return;
      const job = imgPageNet.queue.shift();
      imgPageNet.active++;
      const now = Date.now();
      const wait = Math.max(0, imgPageNet.last + 350 - now);
      imgPageNet.last = now + wait;
      setTimeout(() => job(() => { imgPageNet.active--; pumpImgPageNet(); }), wait);
    }
    function imgPageGet(url, onOk, onErr) {
      runImgPageNet((done) => gmGetText(url, (t) => { onOk(t); done(); }, () => { onErr(); done(); }));
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

