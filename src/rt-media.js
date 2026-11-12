// rt-media: Media element builders: tile poster attach (event-time cell resolve), loadSwapImg (referer policy + cache-bust retry), buildMediaEl (loading gate, HQ swap, album thumbs).
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // Build the <img>/<video> element for a grid cell, viewer, or filmstrip
    // thumb. An <img> that fails to load is retried once as <video> —
    // extension-based classification cannot know a URL's real bytes (video
    // links without .mp4 extensions exist); if the video also fails, the
    // element is marked .xft-broken.
    // Fill a video-tile div with a poster <img> once the poster URL is
    // known (from a landing page's og:image). Shared by embed tiles and
    // page-backed video tiles. No isConnected gate: the row may be scrolled
    // out of the window (pooled, detached) when the poster arrives — filling
    // a detached tile is fine, the image loads and shows on re-insert.
    function attachTilePoster(tile, poster) {
      // resolve the cell at EVENT time, not call time: album-child tiles are
      // filled BEFORE cell.append() — a call-time closest() captures null and
      // the load handler then never clears .xft-loading (eternal shimmer on a
      // fully loaded image)
      const cellOf = () => tile.closest('.xft-cell');
      if (!poster) { const c = cellOf(); if (c) c.classList.remove('xft-loading'); return; }
      if (tile.querySelector('img')) return;
      const im = document.createElement('img');
      im.alt = '';
      im.addEventListener('error', () => { im.remove(); const c = cellOf(); if (c) c.classList.remove('xft-loading'); }, { once: true });
      im.addEventListener('load', () => { im.classList.add('xft-ok'); const c = cellOf(); if (c) c.classList.remove('xft-loading'); }, { once: true });
      im.src = poster;
      tile.appendChild(im);
    }

    // Swap-image loader with an error-driven referer fallback. Referer rules
    // are CDN-specific and unknowable up front: the 2026-11 cuckcapital
    // hotlink wall serves originals ONLY with the forum referer (403
    // no-referer — verified live), while the older scdn-family CDNs 403
    // foreign referers and serve no-referer. Page-default policy (this page
    // IS the forum) goes first; one no-referrer retry on error or on a
    // loaded ≤1px block pixel; then cb(null). onload(el, noRef) reports the
    // policy that worked so the final src swap can copy it.
    function loadSwapImg(src, onload, onfail) {
      const el = new Image();
      el.decoding = 'async';
      let usedNoRef = false;
      let done = false;
      let tryUrl = src;
      // listeners must survive the block-pixel attempt: a `load` of a ≤1px
      // hotlink pixel is a FAILURE that retries with no-referrer — the
      // retry's real load then fires this same listener. The retry ALSO
      // cache-busts: the image cache is keyed by URL only, so re-requesting
      // the same src under a new referer policy replays the poisoned entry
      // without a network fetch
      const fail = () => {
        if (done) return;
        if (usedNoRef) { done = true; onfail(null); return; }
        usedNoRef = true;
        tryUrl = src + (src.indexOf('?') === -1 ? '?' : '&') + 'xftref=1';
        el.referrerPolicy = 'no-referrer';
        el.src = tryUrl;
      };
      el.addEventListener('load', () => {
        if (done) return;
        if (el.naturalWidth > 1) { done = true; onload(el, usedNoRef); return; }
        fail(); // hotlink block pixels "load" as ≤1px — treat as failure
      });
      el.addEventListener('error', fail);
      el.src = tryUrl;
      return el;
    }

    function buildMediaEl(kind, url, thumb, pageUrl) {
      if (kind === 'embed') {
        // Embed thumbs: base no-fetch tile (hosts rate-limit, some embeds
        // autostart); the poster — parsed from the embed page's og:image —
        // fills it in async when it arrives. The viewer mounts the live
        // iframe on click.
        if (thumb) {
          const tile = document.createElement('div');
          tile.className = 'xft-vtile';
          // deferred a tick: the cached path resolves synchronously, before
          // renderRange has inserted the row into the document
          ensureEmbedPoster(url, (p) => setTimeout(() => attachTilePoster(tile, p), 0));
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
          // Video thumbs: a styled tile + the cell's ▶ badge is instant and
          // safe (media hosts rate-limit; a video-heavy thread = hundreds of
          // queued metadata requests stuck LOADING). PAGE-BACKED videos get
          // one landing-page GET through the shared poster queue — its
          // og:image is the preview (bunkr /f/ pages, filester /d/ pages,
          // moved-CDN directs). Same-host files never hit this.
          const tile = document.createElement('div');
          tile.className = 'xft-vtile';
          if (isVideoPageUrl(url) || (VID_EXT_RE.test(url) && extractDomain(url) !== hostKey(location.host))) {
            ensureEmbedPoster(url, (p) => setTimeout(() => attachTilePoster(tile, p), 0));
          }
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
        v.addEventListener('error', function onErr() {
          // a direct CDN file that 301'd to an HTML page (bunkr cdn -> /f/)
          // errors on first load — resolve through the page carrier once,
          // then give up as broken. xftMoved doubles as the PENDING flag: the
          // resolve walk (fetch + sign) can outlast the dead-probe below,
          // which must not retire a slot that is about to play.
          if (!v.dataset.xftMoved) {
            v.dataset.xftMoved = '1';
            resolveEmbedStream(url, (src) => {
              v.dataset.xftMoved = '';
              if (src) {
                // undo any dead-probe misfire, then swap — load clears the rest
                brokenMediaUrls.delete(url);
                const host = v.closest('.xft-cell, .xft-vslot');
                if (host) host.classList.remove('xft-broken');
                v.referrerPolicy = 'no-referrer';
                v.src = src;
                return;
              }
              markMediaBroken(v, url);
            });
            return;
          }
          markMediaBroken(v, url);
        });
        v.addEventListener('loadeddata', () => markMediaLoaded(v), { once: true });
        // cached failures never fire events — probe after a moment; NEVER
        // while a moved-page resolve is pending (the real-host walk takes
        // longer than this timer)
        setTimeout(() => {
          if (v.readyState === 0 && v.networkState === 3 && !v.dataset.xftMoved) markMediaBroken(v, url); // NETWORK_NO_SOURCE
        }, 800);
        return v;
      }
      const im = document.createElement('img');
      // ALL images lazy + async: the grid keeps every row in the DOM, so
      // the browser's viewport distance decides when bytes move — that IS
      // the CDN-burst throttle the old HQ queue provided, without a queue
      // that offscreen rows would wedge for minutes.
      im.loading = 'lazy';
      im.decoding = 'async';
      const cands = hqCandidates(url);
      let ci = Math.min(hqStage.get(url) || 0, cands.length - 1);
      const isHqStage = (i) => cands.length > 1 && i < cands.length - 1;
      const setStage = (i) => {
        ci = i;
        hqStage.set(url, i);
        im.src = cands[i];
      };
      im.addEventListener('error', function onErr() {
        noteOriginResult(cands[ci], false);
        // HQ candidates first. The one delayed retry is for RATE-LIMIT
        // BURSTS (bursting origin): the gate keeps a src-less/failed img
        // invisible, so the retry hides inside the shimmer. On a HEALTHY
        // origin an isolated failure is a dead file — skip the wait and
        // walk straight down the chain. Only the post URL itself failing
        // starts the video retry.
        if (isHqStage(ci)) {
          if (ci === 0 && !hqTriedRetry.has(url) && originBursting(cands[ci])) {
            hqTriedRetry.add(url);
            im.removeAttribute('src');
            setTimeout(() => { if (ci === 0) setStage(0); }, 1500);
            return;
          }
          setStage(ci + 1);
          return;
        }
        im.removeEventListener('error', onErr);
        // moved-page resolve (bunkr-style): a direct IMAGE url can 301 to an
        // HTML landing page just like the video kind — resolve through the
        // page carrier once, swap the src; only a real failure falls through
        if (!im.dataset.xftMoved) {
          im.dataset.xftMoved = '1';
          resolveEmbedStream(url, (src) => {
            im.dataset.xftMoved = '';
            if (src) {
              brokenMediaUrls.delete(url);
              const host = im.closest('.xft-cell, .xft-vslot, .xft-vthumb');
              if (host) host.classList.remove('xft-broken');
              im.referrerPolicy = 'no-referrer';
              im.src = src;
              return;
            }
            markMediaBroken(im, url);
          });
          return;
        }
        // burst-failing origin: the file may be fine, the CDN is choking —
        // HOLD the slot and recheck in the background (no hole, no reflow)
        if (originBursting(url)) { enterStall(im, url); return; }
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        v.src = url;
        v.addEventListener('error', () => markMediaBroken(v, url));
        v.addEventListener('loadedmetadata', () => { if (im.parentNode) im.replaceWith(v); markMediaLoaded(v); });
        v.load();
        // some 404s stall as networkState=LOADING forever (no error event,
        // no metadata) — a stalled cell must still retire, or it shimmers
        // for the rest of the session
        setTimeout(() => { if (v.readyState === 0) markMediaBroken(v, url); }, 6000);
      });
      setStage(ci);
      // full-quality upgrade for CELLS and the VIEWER: the embedded copy
      // renders instantly, then swaps to the original once the landing page
      // resolves. The browser keeps the old pixels until the new image
      // decodes, so the swap is seamless. Must run AFTER setStage — a cache
      // hit fires synchronously and setStage's src write would overwrite it.
      // Skipped when a static marker chain exists (.md/.th win, cheaper).
      if (pageUrl && cands.length === 1) {
        // the VIEWER (thumb=false) forces past any failure cooldown — a
        // user-initiated single is worth a fresh attempt. Grid cells wait
        // the cooldown out (they are many, and bursts are what trip the
        // host in the first place), but a failed cell gets ONE delayed
        // retry landing right as the cooldown expires — attached cells
        // must not stay at embedded quality forever.
        let retriedHq = false;
        const wantHq = (force2) => resolveImagePage(pageUrl, url, (full) => {
          if (!full) {
            // retry FORCED: any later failure (a download's resolve, another
            // cell) can have REFRESHED the cooldown past this retry — one
            // fresh single request 31s out is burst-safe
            if (!retriedHq && im.isConnected) { retriedHq = true; setTimeout(() => wantHq(true), 31000); }
            return;
          }
          if (im.src === full) return;
          // load the original through the referer-fallback loader (forum
          // referer first, no-referrer once) and crossfade it in — the
          // loaded probe element IS the swap layer, so the frame is already
          // decoded when it lands (no progressive paint-through)
          loadSwapImg(full, (top, noRef) => {
            const host = im.parentNode;
            const src2 = top.src; // the URL that actually loaded (cache-busted on the fallback path)
            if (!host || im.src === src2) return;
            top.alt = '';
            top.className = 'xft-hq-top xft-ok'; // reveal gate passes at once — frame is decoded
            if (noRef) im.referrerPolicy = 'no-referrer'; // the final swap must reuse the policy that worked
            host.appendChild(top);
            requestAnimationFrame(() => top.classList.add('xft-hq-on'));
            setTimeout(() => { im.src = src2; top.remove(); }, 450); // swap beneath, then drop the layer
          }, () => { /* both policies failed — embedded copy stays */ });
        }, force2 || !thumb);
        wantHq();
      }
      // A failure cached by Chrome replays instantly with NO error event, and
      // 1×1 placeholders (svg data-URIs, hotlink-block pixels) "load" as a
      // single stretched pixel = a blank cell. nw<=1 + complete = dead either
      // way — probe for both, or the cell renders blank forever. A src-LESS
      // img (waiting in the HQ queue, or mid-retry) is complete with nw=0
      // but NOT dead — probing it retired whole ranges of healthy cells.
      // xftMoved = a moved-page resolve is IN FLIGHT for this element — the
      // error/complete/nw<=1 state it sees is the OLD url's, not a verdict
      const checkDead = () => { if (!im.dataset.xftMoved && im.getAttribute('src') && im.complete && im.naturalWidth <= 1 && !stallState.has(url)) markMediaBroken(im, url); };
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

