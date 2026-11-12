// rt-panel: Panel shell: anim override, open/close, count-only updates, scroll/resize watches, filter controls, links bar, edge button, settings toggle, buildPanel.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // prefers-reduced-motion kills every animation + the drawer transition.
    // With forceAnimations the <html> gains .xft-anim-force and the
    // reduce-motion rules (scoped to html:not(.xft-anim-force)) stop applying.
    function applyAnimOverride() {
      document.documentElement.classList.toggle('xft-anim-force', settings.forceAnimations === 1);
    }

    function panelIsOpen() {
      return !!(panel && panel.classList.contains('xft-open'));
    }

    function updateCountOnly(n) {
      if (panelCountEl) panelCountEl.textContent = n + ' items';
    }

    // scrollbar drags / wheel / keyboard scrolling are all USER activity —
    // any scroll event not stamped as one of our own writes updates the
    // timestamp (holds removal rerenders while the user is mid-scroll).
    // The same listener drives the windowed grid (rAF-coalesced).
    function installScrollWatch() {
      panelBodyEl.addEventListener('scroll', () => {
        if (performance.now() - programmaticScrollAt > 40) lastUserScrollAt = performance.now();
        queueRenderSlice();
      }, { passive: true });
    }
    // drawer/window resizes change the row width → the uniform row height
    // changes → every offset changes. Debounced re-mount of the metrics
    // with a proportional scroll restore (rows resize under the viewport
    // anyway — sub-row precision is lost by design on resize).
    function installGridResizeWatch() {
      if (typeof ResizeObserver === 'undefined' || !panelBodyEl) return;
      let lastW = panelBodyEl.clientWidth;
      let t = 0;
      new ResizeObserver((ents) => {
        const w = Math.round(ents[0].contentRect.width);
        if (Math.abs(w - lastW) < 2) return; // our spacer writes never change the BODY width
        lastW = w;
        clearTimeout(t);
        t = setTimeout(() => {
          if (panelTab !== 'media' || !vRowsEl || !vRowsEl.isConnected || !vMetrics) return;
          const st = panelBodyEl.scrollTop;
          mountVirtualGrid(vRowsEl, vLayout, { prevTotal: vMetrics.total, st: st }, null);
        }, 150);
      }).observe(panelBodyEl);
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

    // column filter: button + popup checkbox list built from current table
    // values (distinct users / distinct link domains); click outside closes
    function buildFilterControl(label, getValues, getSel, setSel) {
      const wrap = document.createElement('div');
      wrap.className = 'xft-filter';
      let pop = null;
      const close = () => { if (pop) { pop.remove(); pop = null; } };
      const btn = mkBtn(label, () => {
        if (pop) { close(); return; }
        const vals = getValues();
        const sel = getSel(); // Set of allowed values, or null = everything
        pop = document.createElement('div');
        pop.className = 'xft-fpop';
        const applyState = () => {
          const boxes = Array.from(pop.querySelectorAll('input[type=checkbox]'));
          const checked = new Set(boxes.filter((b) => b.checked).map((b) => b.value));
          setSel(checked.size === vals.length ? null : checked);
          btn.classList.toggle('xft-filter-on', checked.size !== vals.length);
        };
        const head = document.createElement('div');
        head.className = 'xft-fpop-head';
        head.append(
          mkBtn('All', () => { pop.querySelectorAll('input[type=checkbox]').forEach((b) => { b.checked = true; }); applyState(); }),
          mkBtn('None', () => { pop.querySelectorAll('input[type=checkbox]').forEach((b) => { b.checked = false; }); applyState(); })
        );
        pop.appendChild(head);
        if (!vals.length) {
          const none = document.createElement('div');
          none.className = 'xft-empty';
          none.textContent = 'No values yet.';
          pop.appendChild(none);
        }
        for (const v of vals) {
          const lab = document.createElement('label');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = v;
          cb.checked = !sel || sel.has(v);
          cb.addEventListener('change', applyState);
          const sp = document.createElement('span');
          sp.textContent = v === '' ? '(no name)' : v;
          sp.title = v;
          lab.append(cb, sp);
          pop.appendChild(lab);
        }
        wrap.appendChild(pop);
      });
      document.addEventListener('click', (e) => { if (pop && !wrap.contains(e.target)) close(); });
      wrap.appendChild(btn);
      return wrap;
    }

    // Links-tab toolbar: search box (matches link URL or author) + the two
    // column filters. Sits below the tab row, always visible on Links.
    function buildLinksBar() {
      const bar = document.createElement('div');
      bar.className = 'xft-linksbar';
      linkSearchEl = document.createElement('input');
      linkSearchEl.type = 'search';
      linkSearchEl.placeholder = 'Search link or user…';
      let debounce = 0;
      linkSearchEl.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { rowLimit = settings.rowCap; clearVRows(); renderPanelBody(); }, 150);
      });
      bar.appendChild(linkSearchEl);
      // user column: one checkbox per author that has at least one link
      bar.appendChild(buildFilterControl('User ▾', () => {
        const seen = new Set();
        const vals = [];
        for (const r of orderedRecords()) {
          const a = r.author || '';
          if ((r.links || []).length && !seen.has(a)) { seen.add(a); vals.push(a); }
        }
        return vals;
      }, () => linkUserSel, (s) => { linkUserSel = s; renderPanelBody(); }));
      // link column: one checkbox per distinct link domain
      bar.appendChild(buildFilterControl('Domain ▾', () => {
        const seen = new Set();
        const vals = [];
        for (const r of orderedRecords()) {
          for (const u of (r.links || [])) {
            const d = extractDomain(u);
            if (d && !seen.has(d)) { seen.add(d); vals.push(d); }
          }
        }
        return vals;
      }, () => linkDomainSel, (s) => { linkDomainSel = s; renderPanelBody(); }));
      bar.hidden = true;
      return bar;
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

    // settings drawer: slide/drop in on open, fade out on close (the plain
    // hidden flip is instant and reads as a glitch)
    let settingsCloseTimer = null;
    function toggleSettings() {
      if (!settingsView) return;
      if (settingsCloseTimer) { clearTimeout(settingsCloseTimer); settingsCloseTimer = null; }
      if (settingsView.hidden) {
        settingsView.hidden = false;
        settingsView.classList.remove('xft-vclose');
        requestAnimationFrame(() => settingsView.classList.add('xft-vwin'));
      } else {
        settingsView.classList.remove('xft-vwin');
        settingsView.classList.add('xft-vclose');
        settingsCloseTimer = setTimeout(() => {
          settingsCloseTimer = null;
          settingsView.hidden = true;
          settingsView.classList.remove('xft-vclose');
        }, 160);
      }
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
      const refreshBtn = mkBtn('↻ Refresh', () => {
        // Refresh = re-check EVERYTHING. Session failure state (broken marks,
        // HQ stage memory, burned retries) is what made "reload the page" the
        // only cure for a poisoned grid — a Refresh must clear it too, or
        // items stay retired forever no matter how many times the data is
        // re-fetched. Rows rebuild so cells get fresh load attempts.
        brokenMediaUrls.clear();
        tinyMediaUrls.clear();
        hqStage.clear();
        hqTriedRetry.clear();
        clearStalls();
        clearVRows();
        ensure(true);
      });
      panelCancelBtn = cancelBtn;
      panelRefreshBtn = refreshBtn;
      const resumeBtn = mkBtn('▶ Resume', () => resumeFetch());
      panelResumeBtn = resumeBtn;
      const gearBtn = mkBtn('⚙', () => toggleSettings());
      const closeBtn = mkBtn('✕', () => setPanelOpen(false));
      head.append(title, progressEl, cancelBtn, refreshBtn, resumeBtn, gearBtn, closeBtn);

      const tabs = document.createElement('div');
      tabs.className = 'xft-tabs';
      tabFilesBtn = mkBtn('Media', () => setTab('media'), 'xft-btn xft-tab');
      tabLinksBtn = mkBtn('Links', () => setTab('links'), 'xft-btn xft-tab');
      tabAiBtn = mkBtn('AI', () => setTab('ai'), 'xft-btn xft-tab');
      panelCountEl = document.createElement('span');
      panelCountEl.className = 'xft-count';
      panelCountEl.textContent = '0 items';
      tabs.append(tabFilesBtn, tabLinksBtn, tabAiBtn, panelCountEl);

      // media sub-tabs (All / Image / Video), below the main tab row
      subtabsEl = document.createElement('div');
      subtabsEl.className = 'xft-subtabs';
      subtabsEl.hidden = true;
      subTabBtns.all = mkBtn('All', () => setSubTab('all'), 'xft-btn xft-subtab');
      subTabBtns.image = mkBtn('Image', () => setSubTab('image'), 'xft-btn xft-subtab');
      subTabBtns.video = mkBtn('Video', () => setSubTab('video'), 'xft-btn xft-subtab');
      subTabBtns.all.classList.add('xft-tab-active');
      // group-by picker lives in the sub-tab row: flat | post | page | user.
      // Persisted in settings, so switching All/Image/Video keeps the group.
      const groupSel = document.createElement('select');
      groupSel.className = 'xft-gsel';
      groupSel.title = 'Group media by';
      groupSel.setAttribute('aria-label', 'Group media by');
      for (const g of [['flat', 'Flat'], ['post', 'Post'], ['page', 'Page'], ['user', 'User']]) {
        const o = document.createElement('option');
        o.value = g[0];
        o.textContent = 'Group: ' + g[1];
        groupSel.appendChild(o);
      }
      groupSel.value = settings.mediaGroup;
      groupSel.addEventListener('change', () => {
        saveViewScroll();
        settings.mediaGroup = groupSel.value;
        saveSettings();
        clearVRows();
        renderPanelBody();
      });
      // bulk download: zips the current list (Pics/ + Videos/) as one file
      const dlBtn = mkBtn('Download', startBulkDownload, 'xft-btn xft-subtab xft-dlbtn');
      dlBtnEl = dlBtn;
      updateDlBtn();
      subtabsEl.append(subTabBtns.all, subTabBtns.image, subTabBtns.video, groupSel, dlBtn);

      // bulk download dashboard: header (name / speed / ETA / stop),
      // overall bar + counts, live rows for in-flight files (+ pinned fails)
      dlBarEl = document.createElement('div');
      dlBarEl.className = 'xft-dlbar';
      dlBarEl.hidden = true;
      dlNameEl = document.createElement('span');
      dlNameEl.className = 'xft-dlname';
      dlSpdEl = document.createElement('span');
      dlSpdEl.className = 'xft-dlspd';
      dlStopEl = mkBtn('Stop', () => { if (dlRun.running) startBulkDownload(); }, 'xft-btn xft-dlstop');
      dlCloseEl = mkBtn('✕', () => { dlBarEl.hidden = true; }, 'xft-btn xft-dlclose');
      dlCloseEl.hidden = true;
      const dlTop = document.createElement('div');
      dlTop.className = 'xft-dltop';
      dlTop.append(dlNameEl, dlSpdEl, dlStopEl, dlCloseEl);
      const dlProgRow = document.createElement('div');
      dlProgRow.className = 'xft-dlprogrow';
      const dlProg = document.createElement('div');
      dlProg.className = 'xft-dlprog';
      dlFillEl = document.createElement('i');
      dlProg.appendChild(dlFillEl);
      dlPctEl = document.createElement('span');
      dlPctEl.className = 'xft-dlpct';
      dlProgRow.append(dlProg, dlPctEl);
      dlStatsEl = document.createElement('div');
      dlStatsEl.className = 'xft-dlstats';
      dlListEl = document.createElement('div');
      dlListEl.className = 'xft-dlrows';
      dlListEl.hidden = true;
      dlBarEl.append(dlTop, dlProgRow, dlStatsEl, dlListEl);

      linksBarEl = buildLinksBar();

      settingsView = buildSettingsView();
      panelBodyEl = document.createElement('div');
      panelBodyEl.className = 'xft-body';
      // go-to-top / go-to-bottom shortcuts, floating over the list
      const jumps = document.createElement('div');
      jumps.className = 'xft-jumps';
      const jumpTop = mkBtn('⤒', () => jumpScroll(true), 'xft-btn xft-jumpbtn');
      const jumpBottom = mkBtn('⤓', () => jumpScroll(false), 'xft-btn xft-jumpbtn');
      jumpTop.title = 'Go to top';
      jumpBottom.title = 'Go to bottom';
      jumps.append(jumpTop, jumpBottom);
      panelJumpsEl = jumps;
      noteEl = document.createElement('div');
      noteEl.className = 'xft-note';
      noteEl.hidden = true;

      panel.append(head, tabs, subtabsEl, dlBarEl, linksBarEl, settingsView, panelBodyEl, jumps, noteEl);
      document.body.appendChild(panel);
      setTab('media');
      buildEdgeButton();
      installScrollWatch();
      installGridResizeWatch();
    }

