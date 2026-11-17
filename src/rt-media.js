// rt-media: Media element builders: tile poster attach (event-time cell resolve), loadSwapImg (referer policy + cache-bust retry), buildMediaEl (loading gate, HQ swap, album thumbs).
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // shared sticker-gate check for every media lane (thumb-cache cells,
    // direct fallback, viewer): 2..140px both axes = smilie/sticker (no URL
    // marker exists) — retire the item. Animate out first, then the
    // debounced rerender drops it in one batched pass.
    function checkTinyMedia(im, url) {
      if (im.naturalWidth > 1 && im.naturalWidth <= TINY_MEDIA_MAX
        && im.naturalHeight > 1 && im.naturalHeight <= TINY_MEDIA_MAX
        && !tinyMediaUrls.has(url)) {
        tinyMediaUrls.add(url);
        animateOutCells(url);
        scheduleBrokenRerender();
      }
    }

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
      im.decoding = 'async';
      im.addEventListener('error', () => { im.remove(); const c = cellOf(); if (c) c.classList.remove('xft-loading'); }, { once: true });
      im.addEventListener('load', () => { im.classList.add('xft-ok'); const c = cellOf(); if (c) c.classList.remove('xft-loading'); }, { once: true });
      // posters ride the thumb cache too (same one-fetch/byte-bounded rule);
      // a failed poster fetch falls back to the direct URL — the error
      // listener above then drops it exactly as before
      const hit = thumbFor(poster, (u) => { im.src = u || poster; });
      if (hit) im.src = hit; // sync hit: set before attach, no shimmer; miss keeps src empty until the cb
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
      // ---------- CELLS (thumb=true): cached capped thumbs only ----------
      // One fetch per URL through the byte cache, decode bounded at
      // THUMB_MAX_SIDE, instant re-entry after pool eviction (memory layer
      // hit fires synchronously — src set before the element is even
      // attached, no shimmer flash). The legacy direct-URL path below runs
      // ONLY as the failure fallback: a URL the thumb fetch cannot serve
      // keeps today's error policy (HQ chain, moved-page resolve, stall,
      // video retry) minus the in-cell landing-page HQ swap — cells never
      // pull full-res originals anymore; the viewer and downloads do.
      if (thumb) {
        const im = document.createElement('img');
        im.alt = '';
        im.loading = 'lazy';
        im.decoding = 'async';
        let still = null;            // the cached still's objectURL (hover restores it)
        let settled = false;         // thumb lane finished (either way)
        const wireFallback = () => {
          if (settled) return;
          settled = true;
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
            if (originBursting(url)) { enterStall(im, url); return; }
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.muted = true;
            v.src = url;
            v.addEventListener('error', () => markMediaBroken(v, url));
            v.addEventListener('loadedmetadata', () => { if (im.parentNode) im.replaceWith(v); markMediaLoaded(v); });
            v.load();
            setTimeout(() => { if (v.readyState === 0) markMediaBroken(v, url); }, 6000);
          });
          setStage(ci);
          const checkDead = () => { if (!im.dataset.xftMoved && im.getAttribute('src') && im.complete && im.naturalWidth <= 1 && !stallState.has(url)) markMediaBroken(im, url); };
          if (im.getAttribute('src') && im.complete) { checkDead(); checkTinyMedia(im, url); if (im.naturalWidth > 1) markMediaLoaded(im); }
          else {
            im.addEventListener('load', () => { checkDead(); checkTinyMedia(im, url); markMediaLoaded(im); });
            setTimeout(() => { checkDead(); checkTinyMedia(im, url); }, 800);
          }
        };
        const applyStill = (u, sync) => {
          if (settled || !u) return;
          settled = true;
          still = u;
          im.src = u;
          // reveal gate: sync hits pass it pre-attach (nothing painted yet);
          // async arrivals pass it on load, after decode
          if (sync) im.classList.add('xft-ok');
          im.addEventListener('load', () => { im.classList.add('xft-ok'); checkTinyMedia(im, url); markMediaLoaded(im); }, { once: true });
        };
        const hit = thumbFor(url, (u) => { if (u) applyStill(u, false); else wireFallback(); });
        if (hit) applyStill(hit, true);
        // animated gifs: the cell holds the still frame; hover swaps in the
        // original bytes (memory LRU), leaving restores the still
        if (isGifUrl(url) || thumbIsGif(url)) {
          const play = () => {
            const u = gifOriginalUrl(url, (u2) => { if (u2 && im.matches(':hover') && still) im.src = u2; });
            if (u && still) im.src = u;
          };
          const stop = () => { if (still && im.src !== still) im.src = still; };
          im.addEventListener('pointerenter', play);
          im.addEventListener('pointerleave', stop);
        }
        return im;
      }
      // ---------- VIEWER / filmstrip (thumb=false): full-res, unchanged ----------
      const im = document.createElement('img');
      im.loading = 'lazy';
      im.decoding = 'async';
      const cands = hqCandidates(url);
      let ci = Math.min(hqStage.get(url) || 0, cands.length - 1);
      const setStage = (i) => {
        ci = i;
        hqStage.set(url, i);
        im.src = cands[i];
      };
      im.addEventListener('error', function onErr() {
        noteOriginResult(cands[ci], false);
        if (cands.length > 1 && ci < cands.length - 1) { setStage(ci + 1); return; }
        im.removeEventListener('error', onErr);
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
        markMediaBroken(im, url);
      });
      setStage(ci);
      if (pageUrl && cands.length === 1) {
        let retriedHq = false;
        const wantHq = (force2) => resolveImagePage(pageUrl, url, (full) => {
          if (!full) {
            if (!retriedHq && im.isConnected) { retriedHq = true; setTimeout(() => wantHq(true), 31000); }
            return;
          }
          if (im.src === full) return;
          loadSwapImg(full, (top, noRef) => {
            const host = im.parentNode;
            const src2 = top.src;
            if (!host || im.src === src2) return;
            top.alt = '';
            top.className = 'xft-hq-top xft-ok';
            if (noRef) im.referrerPolicy = 'no-referrer';
            host.appendChild(top);
            requestAnimationFrame(() => top.classList.add('xft-hq-on'));
            setTimeout(() => { im.src = src2; top.remove(); }, 450);
          }, () => {});
        }, force2 || !thumb);
        wantHq();
      }
      const checkDeadV = () => { if (!im.dataset.xftMoved && im.getAttribute('src') && im.complete && im.naturalWidth <= 1 && !stallState.has(url)) markMediaBroken(im, url); };
      if (im.getAttribute('src') && im.complete) { checkDeadV(); checkTinyMedia(im, url); if (im.naturalWidth > 1) markMediaLoaded(im); }
      else {
        im.addEventListener('load', () => { checkDeadV(); checkTinyMedia(im, url); markMediaLoaded(im); });
        setTimeout(() => { checkDeadV(); checkTinyMedia(im, url); }, 800);
      }
      return im;
    }

