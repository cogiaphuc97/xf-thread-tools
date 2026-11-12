// rt-grid: Panel element handles, virtualizer (pool, sig rows, reconcile, renderSlice, mount, clearVRows), tiny/broken media state, pop suppress + broken-rerender debounce. NOTE: 'panel' here is the first `let panel` handle declaration; fragment spans through scheduleBrokenRerender.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // ---------- step 8: media panel ----------
    let panel = null;
    let progressEl = null;
    let panelBodyEl = null;
    let panelJumpsEl = null;
    let panelCountEl = null;
    let panelCancelBtn = null;
    let panelRefreshBtn = null;
    let panelResumeBtn = null;
    let noteEl = null;
    let tabFilesBtn = null;
    let tabLinksBtn = null;
    let tabAiBtn = null;
    // Links-tab auto-load: sentinel div observed at the end of the list —
    // reaching it extends rowLimit, so there is no "Show more" button
    let linksSentinel = null;
    let linksObserver = null;
    // ---------- virtualized media grid (v0.8.0) ----------
    // Windowed rendering: a spacer (.xft-vrows) of EXACT computed height
    // carries only the entries near the viewport, absolutely positioned at
    // their math-derived y (layoutMetrics/windowRange, pure). Window
    // membership is derived SYNCHRONOUSLY from scrollTop in the scroll
    // handler — there is NO IntersectionObserver on the correctness path
    // (the pre-0.7.45 virtualizer's IO refills missed rows during flings:
    // the missing/vanished-preview bug class). Rows recycle through a
    // CONTENT-keyed pool: sig = first-url + len, so a pool hit IS the right
    // content (position never implies content — the wrong-preview class),
    // and rows re-chunked by a retirement wave recycle by URL overlap +
    // reconcileRowCells so surviving imgs never refetch (0.7.47 fix kept).
    const vPool = new Map();      // sig -> detached row el (insertion order = LRU)
    const vUrlIndex = new Map();  // cell url -> pool sig (URL-overlap recycle)
    const VPOOL_MAX = 120;        // detached rows kept: bounded DOM + decoded memory
    const V_OVER_ABOVE = 900;     // px rendered above the viewport
    const V_OVER_BELOW = 1400;    // px rendered below (≈ the old IO margin)
    const V_GAP = 6;
    let vLayout = [];             // current entries, each stamped with .sig
    let vMetrics = null;          // layoutMetrics() of vLayout
    let vRowsEl = null;           // the spacer element (position:relative)
    let vAttached = [];           // [{sig, el}] — the rendered window, DOM order
    let vRange = { first: -1, last: -1, version: -1 };
    let vVersion = 0;             // bumped on every relayout
    let vRowH = 140;              // measured per mount (uniform for all rows)
    let vHeadH = 30, vSubH = 24;  // probed per mount (CSS-fixed)
    let gridItems = [];           // current render's item list
    let sliceQueued = false;
    function queueRenderSlice() {
      if (sliceQueued) return;
      sliceQueued = true;
      requestAnimationFrame(() => { sliceQueued = false; renderSlice(); });
    }
    function poolCleanUrls(sig, el) {
      if (!el.classList || !el.classList.contains('xft-vrow')) return;
      for (const c of el.children) {
        if (c.dataset && c.dataset.xftUrl && vUrlIndex.get(c.dataset.xftUrl) === sig) vUrlIndex.delete(c.dataset.xftUrl);
      }
    }
    function poolTake(sig) {
      const el = vPool.get(sig);
      if (!el) return null;
      vPool.delete(sig);
      poolCleanUrls(sig, el);
      return el;
    }
    function poolPut(sig, el) {
      vPool.delete(sig);
      vPool.set(sig, el); // (re)insert at the LRU end
      if (el.classList.contains('xft-vrow')) {
        for (const c of el.children) if (c.dataset && c.dataset.xftUrl) vUrlIndex.set(c.dataset.xftUrl, sig);
      }
      while (vPool.size > VPOOL_MAX) { // evict oldest
        const old = vPool.keys().next().value;
        const oldEl = vPool.get(old);
        poolCleanUrls(old, oldEl);
        oldEl.remove();
        vPool.delete(old);
      }
    }
    // one grid cell (media el + label + badge + click-to-view). Used by both
    // the lazy fill and the removal reconciler.
    function buildMediaCell(it) {
      const cell = document.createElement('div');
      cell.className = 'xft-cell';
      cell.dataset.xftUrl = it.url;
      cell.title = '[#' + it.pos + '] ' + (it.r.author || '?') + ' — open';
      // album tile: the link itself, not a viewer item — click opens the
      // album page; the count label fills in once expansion lands
      if (it.kind === 'album') {
        cell.classList.add('xft-album');
        const tile = document.createElement('div');
        tile.className = 'xft-vtile xft-album-tile';
        const cnt = document.createElement('span');
        cnt.className = 'xft-album-count';
        const kids = albumChildren.get(it.url);
        cnt.textContent = kids && kids.length ? kids.length + ' files' : 'album…';
        tile.appendChild(cnt);
        const label = document.createElement('span');
        label.className = 'xft-cell-label';
        label.textContent = '#' + it.pos + ' ' + (it.r.author || '?');
        cell.append(tile, label);
        const url0 = it.url;
        cell.addEventListener('click', () => { try { window.open(url0, '_blank'); } catch (e) {} });
        ensureAlbum(url0, (ch) => {
          if (ch && ch.length && cell.isConnected) cnt.textContent = ch.length + ' files';
        });
        return cell;
      }
      const isVideo = it.kind === 'video' || it.kind === 'embed';
      // album children with a known thumbnail display it directly — no per-
      // file page fetch for the tile (the album page already carried it)
      let thumb = null;
      if (it.album && it.thumb) {
        thumb = document.createElement('div');
        thumb.className = 'xft-vtile';
        attachTilePoster(thumb, it.thumb);
      } else {
        thumb = buildMediaEl(it.kind, it.url, true, (it.r.imgPages || {})[it.url] || '');
      }
      // shimmer while the media loads (cached-complete images come back
      // already ok'd — no flash for them)
      if ((it.kind === 'image' || it.kind === 'embed')
        && !(thumb.tagName === 'IMG' && thumb.classList.contains('xft-ok'))) cell.classList.add('xft-loading');
      // a URL under stall-recheck starts life stalled: no src (a fresh fetch
      // would just error again), the ladder probe owns its recovery
      if (it.kind === 'image' && stallState.has(it.url)) {
        cell.classList.remove('xft-loading');
        cell.classList.add('xft-stalled');
        if (thumb.tagName === 'IMG') thumb.removeAttribute('src');
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
      // album children carry an A marker so they read as album members, not
      // direct post media (top-LEFT — the ▶ badge owns top-right)
      if (it.album) {
        const ab = document.createElement('span');
        ab.className = 'xft-cell-badge xft-badge-album';
        ab.textContent = 'A';
        ab.title = 'from album';
        cell.appendChild(ab);
      }
      // resolve the index AT CLICK TIME: retirement waves shift indexes,
      // a fill-time closure would open the wrong item after a removal
      const url0 = it.url;
      cell.addEventListener('click', () => {
        const idx = viewerItems.findIndex((x) => x.url === url0);
        if (idx >= 0) openViewerAt(idx);
      });
      return cell;
    }
    // build a fresh entry element (pool miss + no URL-overlap recycle):
    // a media row with its real cells (uniform height via aspect-ratio
    // cells — no shells), or a group header.
    function buildRowElement(en) {
      if (en.idxs) {
        const rowEl = document.createElement('div');
        rowEl.className = 'xft-vrow';
        for (const i of en.idxs) {
          const it = gridItems[i];
          if (it) rowEl.appendChild(buildMediaCell(it));
        }
        // a removal wave just animated cells out — fresh rows must not pop
        if (performance.now() < popSuppressUntil) rowEl.classList.add('xft-nopop');
        return rowEl;
      }
      const hEl = document.createElement('div');
      hEl.className = 'xft-ghead' + (en.hdr === 'sub' ? ' xft-gsub' : '');
      const lab = document.createElement('span');
      lab.className = 'xft-glabel';
      lab.textContent = en.label;
      const line = document.createElement('span');
      line.className = 'xft-gline';
      hEl.append(lab, line);
      if (en.postId) {
        hEl.classList.add('xft-gjump');
        hEl.title = en.label + ' — jump to post';
        hEl.addEventListener('click', () => jumpTo(en.postId));
      }
      return hEl;
    }
    // removal waves re-chunk rows (items re-flow into new 4-packs), so a
    // row's identity cannot survive by index OR by first-url. Instead:
    // reconcile CELL-BY-CELL by URL — surviving cells keep their img
    // elements (never re-created, never re-fetched), removed cells drop,
    // newcomers are built on the spot. A retirement wave then costs a few
    // string compares per row instead of discarding the whole grid.
    function reconcileRowCells(rowEl, want) {
      const byUrl = new Map();
      for (const c of Array.from(rowEl.children)) {
        if (c.dataset && c.dataset.xftUrl && !c.dataset.xftReused) byUrl.set(c.dataset.xftUrl, c);
      }
      const kids = [];
      const taken = new Set();
      for (const it of want) {
        const c = byUrl.get(it.url);
        if (c && !taken.has(it.url)) { taken.add(it.url); c.dataset.xftReused = '1'; kids.push(c); }
        else kids.push(buildMediaCell(it));
      }
      rowEl.textContent = '';
      for (const c of kids) { delete c.dataset.xftReused; rowEl.appendChild(c); }
    }
    // THE window render: derive [first,last] from scrollTop, attach the
    // wanted entries (reuse → pool → URL-recycle → build), pool the rest.
    // Runs rAF-coalesced on scroll and synchronously after programmatic
    // scroll writes — a viewport row cannot be unrendered while visible.
    function renderSlice() {
      if (!vRowsEl || !vMetrics || !panelBodyEl || panelTab !== 'media') return;
      const vh = panelBodyEl.clientHeight;
      if (vh <= 0) return; // hidden panel: nothing to render (ensure() re-runs on open)
      const st = panelBodyEl.scrollTop;
      const wr = windowRange(vMetrics.top, vMetrics.h, st - V_OVER_ABOVE, st + vh + V_OVER_BELOW);
      const first = wr[0], last = wr[1];
      // no-op scroll: window unchanged on this layout version
      if (first === vRange.first && last === vRange.last && vRange.version === vVersion) return;
      vRange = { first: first, last: last, version: vVersion };
      const have = new Map();
      for (const a of vAttached) have.set(a.sig, a.el);
      const next = [];
      const want = new Set();
      for (let e = first; e <= last; e++) {
        const en = vLayout[e];
        if (!en) continue;
        want.add(en.sig);
        let el = have.get(en.sig) || poolTake(en.sig);
        if (!el && en.idxs) {
          // retirement re-chunk shifted membership: recycle any pool row
          // sharing a URL and reconcile cell-by-cell — survivors keep imgs
          for (const i of en.idxs) {
            const it = gridItems[i];
            const s2 = it && vUrlIndex.get(it.url);
            if (s2) { const cand = poolTake(s2); if (cand) { el = cand; break; } }
          }
          if (el) reconcileRowCells(el, en.idxs.map((i) => gridItems[i]).filter(Boolean));
        }
        if (!el) el = buildRowElement(en);
        next.push({ sig: en.sig, el: el });
      }
      for (const a of vAttached) if (!want.has(a.sig)) { poolPut(a.sig, a.el); a.el.remove(); }
      // incremental DOM sync: touch ONLY new/moved elements. Transforms are
      // ABSOLUTE offsets, so a sliding window leaves unchanged rows' CSS
      // untouched — re-parenting the whole window every frame would restyle
      // ~60 imgs per scroll tick (the tail-cost trap)
      let ref = null;
      for (let i = next.length - 1; i >= 0; i--) {
        const el = next[i].el;
        if (ref === null) {
          if (el.parentNode !== vRowsEl || el.nextSibling) vRowsEl.appendChild(el);
        } else if (el.parentNode !== vRowsEl || el.nextSibling !== ref) {
          vRowsEl.insertBefore(el, ref);
        }
        const y = 'translateY(' + vMetrics.top[first + i] + 'px)';
        if (el.style.transform !== y) el.style.transform = y;
        ref = el;
      }
      vAttached = next;
    }
    // (re)mount the grid: stamp entry sigs, probe the uniform heights in
    // place, compute metrics, set the EXACT spacer height, restore the
    // anchor/target scroll, render the first slice. One synchronous pass —
    // nothing paints mid-way.
    function mountVirtualGrid(vrows, entries, anchorInfo, scrollTarget) {
      vRowsEl = vrows;
      vLayout = entries;
      for (const en of entries) {
        // FULL membership in the sig: 'first-url:len' collides after a
        // retirement re-chunk (row keeps its first survivor + length while
        // membership changed) and a pooled row rides along stale cells —
        // the wrong-content bug class, caught by the hole probe
        en.sig = en.idxs
          ? 'r:' + en.idxs.map((i) => (gridItems[i] || {}).url || '').join('|')
          : 'h:' + en.hdr + ':' + en.label + ':' + (en.postId || '');
      }
      // probe: one real row (4 aspect-1:1 cells) + one header of each kind,
      // appended, measured, removed in the same tick — heights must match
      // the CSS truth (borders, rounding), never a formula guess.
      // A fresh spacer has no height → the body drops its vertical scrollbar
      // → the probe row measures ~8px too wide → every offset drifts ~2.5px
      // and the scroll range overshoots the real content bottom by hundreds
      // of px. Force the scrollbar FIRST, then measure.
      vrows.style.height = (panelBodyEl.clientHeight + 1) + 'px';
      const probe = document.createElement('div');
      probe.className = 'xft-vrow';
      for (let k = 0; k < 4; k++) {
        const c = document.createElement('div');
        c.className = 'xft-cell';
        probe.appendChild(c);
      }
      const ph = document.createElement('div');
      ph.className = 'xft-ghead';
      const ps = document.createElement('div');
      ps.className = 'xft-ghead xft-gsub';
      vrows.append(probe, ph, ps);
      vRowH = probe.getBoundingClientRect().height || 140;
      vHeadH = ph.getBoundingClientRect().height || 30;
      vSubH = ps.getBoundingClientRect().height || 24;
      probe.remove(); ph.remove(); ps.remove();
      vMetrics = layoutMetrics(entries, vRowH, vHeadH, vSubH, V_GAP);
      vVersion++;
      vrows.style.height = vMetrics.total + 'px';
      vrows.dataset.xftRows = String(entries.length); // probe breadcrumb
      // scroll restore: content anchor (survives re-chunk + pooling) > view
      // switch target (scrollMemory / vScrollKeep) > proportional fallback
      let target = null;
      if (anchorInfo) {
        let eIdx = -1;
        for (let e = 0; e < entries.length; e++) {
          const en = entries[e];
          if (anchorInfo.url) {
            if (en.idxs && en.idxs.some((i) => gridItems[i] && gridItems[i].url === anchorInfo.url)) { eIdx = e; break; }
          } else if (en.sig === anchorInfo.headSig) { eIdx = e; break; }
        }
        if (eIdx >= 0) target = vMetrics.top[eIdx] + anchorInfo.rel;
        else if (anchorInfo.prevTotal > 0) target = anchorInfo.st * vMetrics.total / anchorInfo.prevTotal;
      }
      if (target === null) target = scrollTarget;
      if (target !== null && isFinite(target)) {
        programmaticScrollAt = performance.now();
        panelBodyEl.scrollTop = Math.max(0, Math.min(target, panelBodyEl.scrollHeight - panelBodyEl.clientHeight));
      }
      renderSlice();
    }
    // full grid reset (Refresh / poison clear): pooled contents are stale by
    // definition — detach + drop everything, reset the window state, blank
    // the signature so the next render cannot early-return empty
    function clearVRows() {
      // stash the scroll BEFORE tearing down: collapsing content clamps
      // scrollTop to 0 and the rebuild would "keep" the zero position
      if (panelBodyEl && vScrollKeep === null) vScrollKeep = panelBodyEl.scrollTop;
      vAttached = [];
      for (const el of vPool.values()) el.remove();
      vPool.clear();
      vUrlIndex.clear();
      vRange = { first: -1, last: -1, version: -1 };
      vRowsEl = null;
      vLayout = [];
      vMetrics = null;
      lastPanelSignature = '';
    }
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
        // hold the removal wave only a beat while the user is mid-scroll —
        // the 0.8.0 relayout is windowed + content-anchored (cheap, steady),
        // so holes close fast instead of lingering through a scroll session
        if (performance.now() - lastUserScrollAt < 80) { scheduleBrokenRerender(); return; }
        // no teardown: reset the signature and let renderPanelBody rebuild —
        // sig-matching rows are reused as-is (imgs never reload), removed
        // items' rows rebuild, and the row anchor keeps the viewport steady
        lastPanelSignature = '';
        schedulePanelRender();
      }, 180);
    }
