// rt-chrome: Panel chrome updates: progress text, render scheduling, tab/subtab switching + counts, viewer open/close, jumpTo.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    function updateProgressText() {
      const t = hub.progress.total ? (hub.progress.done + '/' + hub.progress.total) : '–';
      const busy = !!hub.fetchRunning;
      if (progressEl) {
        if (busy) progressEl.innerHTML = '<span class="xft-spinner" aria-hidden="true"></span>' + t;
        else progressEl.textContent = t;
      }
      // while a fetch is in flight the panel buttons lock: no re-Refresh
      // mid-run and no accidental Stop (fetch runs to completion)
      if (panelCancelBtn) panelCancelBtn.disabled = busy;
      if (panelRefreshBtn) panelRefreshBtn.disabled = busy;
      // Resume only exists for a stopped/incomplete run with data worth
      // keeping — hidden on a clean slate (Refresh covers that) and while busy
      if (panelResumeBtn) panelResumeBtn.hidden = busy || hub.meta.complete || hub.records.size === 0;
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
      saveViewScroll();
      panelTab = t;
      rowLimit = settings.rowCap;
      clearVRows(); // row indices no longer map to the same items
      if (tabFilesBtn) tabFilesBtn.classList.toggle('xft-tab-active', t === 'media');
      if (tabLinksBtn) tabLinksBtn.classList.toggle('xft-tab-active', t === 'links');
      if (tabAiBtn) tabAiBtn.classList.toggle('xft-tab-active', t === 'ai');
      if (subtabsEl) subtabsEl.hidden = t !== 'media';
      if (panelJumpsEl) panelJumpsEl.hidden = t === 'ai'; // AI chat keeps its own scroll
      if (linksBarEl) linksBarEl.hidden = t !== 'links';
      renderPanelBody();
    }

    function setSubTab(t) {
      saveViewScroll();
      panelSubTab = t;
      clearVRows(); // different kind filter -> different item list
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
    function closeViewer(instant) {
      const v = document.getElementById('xft-viewer');
      if (viewerKeyHandler) {
        document.removeEventListener('keydown', viewerKeyHandler);
        viewerKeyHandler = null;
      }
      if (!v) return;
      if (!instant) {
        v.classList.add('xft-vclose');
        setTimeout(() => v.remove(), 160);
      } else v.remove();
    }

    function openViewerAt(i) {
      const nav = !!document.getElementById('xft-viewer');
      if (i < 0 || i >= viewerItems.length) return;
      viewerIndex = i;
      const it = viewerItems[i];
      closeViewer(true); // navigation swaps instantly — no close animation
      const v = document.createElement('div');
      v.id = 'xft-viewer';
      if (!nav) v.classList.add('xft-vwin'); // animate only a fresh open
      const media = buildMediaEl(it.kind, it.url, false, it.page || '');
      // every viewer media sits in a FIXED-HEIGHT stage so paging next/prev
      // never shifts the bar/filmstrip; the slot inside is sized to the
      // image's own aspect once loaded (small images upscale to fill)
      let mediaBox = media;
      let stage = null;
      if (it.kind === 'image' || it.kind === 'video') {
        stage = document.createElement('div');
        stage.className = 'xft-vstage';
        mediaBox = document.createElement('div');
        // image slots shrink to the image's own aspect once loaded (no
        // black side gaps on vertical photos); video keeps the 16:9 box
        mediaBox.className = 'xft-vslot xft-loading' + (it.kind === 'image' ? ' xft-vimg' : '');
        mediaBox.appendChild(media);
        stage.appendChild(mediaBox);
      }
      const bar = document.createElement('div');
      bar.className = 'xft-viewer-bar';
      const info = document.createElement('span');
      info.textContent = (viewerIndex + 1) + '/' + viewerItems.length + ' · [#' + it.pos + '] ' + (it.author || '?');
      const prev = mkBtn('‹ Prev', () => openViewerAt(viewerIndex - 1));
      const next = mkBtn('Next ›', () => openViewerAt(viewerIndex + 1));
      prev.disabled = viewerIndex === 0;
      next.disabled = viewerIndex === viewerItems.length - 1;
      const go = mkBtn('Go to comment', () => { jumpTo(it.postId); }); // viewer stays open — user request
      const close = mkBtn('✕ Close', closeViewer);
      bar.append(info, prev, next, go, close);
      v.append(bar, stage || mediaBox);
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
      // close on any dead space: the backdrop AND the stage's letterbox — a
      // contain-upscaled image fills the whole stage and leaves no backdrop
      // to click. The image itself closes too; videos keep their native
      // controls (click = play/pause, not close).
      v.addEventListener('click', (e) => { if (e.target === v || e.target === stage) closeViewer(); });
      if (it.kind === 'image') media.addEventListener('click', () => closeViewer());
      document.body.appendChild(v);
      // cached-complete images never fire load — size their slot now
      if (it.kind === 'image' && media.complete && media.naturalWidth) {
        sizeVImgSlot(mediaBox, media);
        mediaBox.classList.remove('xft-loading');
      }
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

