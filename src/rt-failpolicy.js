// rt-failpolicy: Failure policy: origin stats/verdicts, stall state + ladder + recovery queue, retire, animate-out, mark loaded, viewer img slot sizing, HQ stage/retry memory.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // dead media URL: mark the containing cell/thumb (CSS shows the ⚠
    // placeholder), not just the <img> that may be replaced by the video retry
    function markMediaBroken(el, url) {
      if (url) noteOriginResult(url, false);
      const host = el.closest('.xft-cell, .xft-vthumb, .xft-vslot');
      (host || el).classList.add('xft-broken');
      if (url) {
        brokenMediaUrls.add(url);
        animateOutCells(url);
        scheduleBrokenRerender();
      }
    }
    // ---------- failure policy (v0.8.1) ----------
    // A hole costs a glance; a wrongly-killed item costs a Refresh. An
    // isolated failure on an origin whose other images load = the FILE is
    // gone → retire fast; the fill is cheap (windowed grid: only ~16 rows
    // re-render, survivors keep their imgs). An origin whose recent results
    // are mostly failures = CDN challenge/rate-limit → those RECOVER: hold
    // the slot (stalled visual, item stays in the list, ZERO reflow) and
    // recheck in the background; success rebuilds the SAME cell in place
    // (the probe warmed the browser cache). Ladder 4s/15s/40s, then retire.
    const originStats = new Map(); // origin -> [bool…] rolling (last 24)
    function originOf(u) { try { return new URL(u).origin; } catch (e) { return u; } }
    function noteOriginResult(u, ok) {
      const o = originOf(u);
      let h = originStats.get(o);
      if (!h) { h = []; originStats.set(o, h); }
      h.push(ok);
      if (h.length > 24) h.shift();
    }
    function originBursting(u) { return originBurstingFromHist(originStats.get(originOf(u)) || []); }
    const stallState = new Map(); // url -> {tries, timer}
    const STALL_LADDER = [4000, 15000, 40000];
    const STALL_PER_ORIGIN_MAX = 12; // wall-of-stalled guard: beyond this the origin is treated as dead
    function stalledCountFor(o) { let n = 0; for (const u of stallState.keys()) if (originOf(u) === o) n++; return n; }
    function enterStall(el, url) {
      const host = el.closest ? el.closest('.xft-cell, .xft-vthumb') : null;
      if (host) { host.classList.remove('xft-loading'); host.classList.add('xft-stalled'); }
      // strip the failed src: the 800ms cached-failure probe (checkDead)
      // would otherwise reap the stalled img as dead while the ladder runs
      if (el.tagName === 'IMG' && el.getAttribute('src')) el.removeAttribute('src');
      if (stallState.has(url)) return; // ladder already armed (rebuilt cell)
      if (stalledCountFor(originOf(url)) >= STALL_PER_ORIGIN_MAX) { retireUrl(url); return; }
      const st = { tries: 0, timer: 0 };
      stallState.set(url, st);
      const step = () => {
        st.tries++;
        const probe = new Image();
        probe.referrerPolicy = 'no-referrer';
        probe.onload = () => {
          noteOriginResult(url, true);
          stallState.delete(url);
          recoverInPlace(url);
        };
        probe.onerror = () => {
          noteOriginResult(url, false);
          if (st.tries >= STALL_LADDER.length) { stallState.delete(url); retireUrl(url); }
          else st.timer = setTimeout(step, STALL_LADDER[st.tries]);
        };
        probe.src = url;
      };
      st.timer = setTimeout(step, STALL_LADDER[0]);
    }
    // recovery with NO layout change: the item never left the list — rebuild
    // only its attached cells (windowed: a handful at most)
    let recoverTimer = 0;
    const recoverQueue = new Set();
    function recoverInPlace(url) {
      recoverQueue.add(url);
      clearTimeout(recoverTimer);
      recoverTimer = setTimeout(() => {
        const urls = Array.from(recoverQueue);
        recoverQueue.clear();
        for (const u of urls) {
          const sel = '.xft-cell[data-xft-url="' + (window.CSS && CSS.escape ? CSS.escape(u) : u) + '"]';
          for (const c of Array.from(document.querySelectorAll(sel))) {
            const it = gridItems.find((x) => x.url === u);
            if (it && c.isConnected) c.replaceWith(buildMediaCell(it));
            else c.classList.remove('xft-stalled');
          }
        }
      }, 250);
    }
    function retireUrl(url) {
      brokenMediaUrls.add(url);
      animateOutCells(url);
      scheduleBrokenRerender();
    }
    function clearStalls() {
      for (const st of stallState.values()) clearTimeout(st.timer);
      stallState.clear();
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
      if (el.tagName === 'IMG') noteOriginResult(el.src, true);
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

