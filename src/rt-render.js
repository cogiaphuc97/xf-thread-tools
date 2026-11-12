// rt-render: Panel data pipeline: render signature, panelData/collectMediaItems (dedup, album children, badges), renderPanelBody (all tabs, virtualized grid mount, links rows, scroll memory).
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    let lastPanelSignature = '';

    // ---------- media grouping (v0.7.31) ----------
    // layout = ordered render entries for the virtualizer: full-width group
    // headers ({hdr:'main'|'sub', label}) and media rows ({idxs:[item
    // indices]}). 'post' groups by post; 'page'/'user' add a '#pos - author'
    // sub-header per post inside each group. flat = media rows only.
    // Groups are built from the FILTERED item list, so sub-tab switches
    // (All/Image/Video) keep the grouping but drop empty groups.
    // shared preamble for the render pass AND bulk download: ordered records
    // (fetch-frontier filtered), post positions, boilerplate set. The
    // download list must match the grid exactly — one source of truth.
    function panelData() {
      const ordered = orderedRecords();
      // while a fetch runs, media renders strictly page 1 → last: the live
      // page is seeded instantly but must NOT appear until every earlier
      // page has landed (jump to page 20 → grid fills 1,2,3… in order)
      let orderedShown = ordered;
      if (hub.fetchRunning) {
        let f = 0;
        while (hub.pagesDone.has(f + 1)) f += 1;
        orderedShown = ordered.filter((r) => r.pageN <= f);
      }
      const posMap = new Map(ordered.map((r, i) => [r.postId, i + 1]));
      // signature/"sent via app" boilerplate: URLs recurring across >=3
      // distinct authors — filtered at render so stale caches heal without Refresh
      const boiler = boilerplateUrls(ordered, 3);
      return { ordered: ordered, orderedShown: orderedShown, posMap: posMap, boiler: boiler };
    }
    // media items for the active sub-tab + per-kind counts
    function collectMediaItems(d) {
      const all = [];
      // stale caches (pre-0.7.9) hold 1×1 data-URI placeholders alongside
      // their real URLs — dropped here so cached threads heal without a
      // Refresh; smilies and signature/footer boilerplate are filtered the
      // same way (all inside keep()).
      // ord = position in the RAW unfiltered stream (kept for diagnostics;
      // rows pack sequentially and reconcile by URL, so nothing keys on it).
      let raw = 0;
      const keep = (u) => {
        const s2 = String(u || '');
        return !!s2 && !/^(data|blob):/i.test(s2) && !isSmilieUrl(s2) && !d.boiler.has(s2)
          && !tinyMediaUrls.has(s2) && !brokenMediaUrls.has(s2);
      };
      for (const r of d.orderedShown) {
        const push = (list, kind) => {
          for (const url of (list || [])) {
            if (keep(url)) all.push({ r: r, url: String(url || ''), pos: d.posMap.get(r.postId) || 0, kind: kind, ord: raw });
            raw++;
          }
        };
        push(r.images, 'image');
        push(r.videos, 'video');
        push(r.embeds, 'embed');
        // album links surface as their own tile (All tab); children join the
        // grid as normal items tagged with their album once expanded
        for (const a of (r.albums || [])) {
          if (keep(a)) all.push({ r: r, url: String(a || ''), pos: d.posMap.get(r.postId) || 0, kind: 'album', ord: raw });
          raw++;
        }
      }
      // expanded album children — appended AFTER the direct pass so a child
      // can be deduped against a direct link from ANY record, not just
      // earlier ones. Children carry the album's record (group + jump work)
      // and the album marker for the badge.
      const directUrls = new Set();
      const pageIds = new Set(); // item-page ids of embedded images (/img/<id> wrappers)
      for (const r of d.orderedShown) {
        for (const url of (r.images || []).concat(r.videos || []).concat(r.embeds || [])) directUrls.add(String(url || ''));
        for (const p of Object.values(r.imgPages || {})) {
          const m = String(p || '').match(/\/([A-Za-z0-9_-]{3,64})$/);
          if (m) pageIds.add(m[1]);
        }
      }
      const childSeen = new Set();
      for (const r of d.orderedShown) {
        for (const a of (r.albums || [])) {
          const kids = albumChildren.get(a);
          if (!kids) continue;
          for (const c of kids) {
            if (!c || !keep(c.url) || directUrls.has(c.url) || childSeen.has(c.url)) continue;
            // an embedded medium copy of the same image already holds this
            // slot (its landing page id matches the child's pageId) — the
            // existing item's HQ chain upgrades it to the original
            if (c.pageId && pageIds.has(c.pageId)) continue;
            childSeen.add(c.url);
            all.push({ r: r, url: String(c.url || ''), pos: d.posMap.get(r.postId) || 0, kind: c.kind === 'video' ? 'video' : 'image', album: String(a || ''), thumb: c.thumb || '', ord: raw });
            raw++;
          }
        }
      }
      // embeds are videos hosted elsewhere — they count under the Video tab
      const mediaCounts = { all: all.length, image: 0, video: 0 };
      for (const it of all) { if (it.kind === 'album') continue; mediaCounts[it.kind === 'embed' ? 'video' : it.kind] += 1; }
      const items = panelSubTab === 'all' ? all : all.filter((it) => it.kind === panelSubTab || (panelSubTab === 'video' && it.kind === 'embed'));
      return { all: all, items: items, mediaCounts: mediaCounts };
    }

    function renderPanelBody() {
      if (!panelIsOpen() || !panelBodyEl) return;
      if (panelTab === 'ai') { renderAiTab(); return; }
      const pd = panelData();
      const boiler = pd.boiler;
      let items = [];
      let filtered = [];
      let mediaCounts = null;
      if (panelTab === 'media') {
        const m = collectMediaItems(pd);
        mediaCounts = m.mediaCounts;
        updateSubTabCounts(mediaCounts);
        items = m.items;
        // album tiles open the host page in a tab, not the viewer — the
        // viewer walks media only; children are ordinary viewer items
        viewerItems = items.filter((it) => it.kind !== 'album').map((it) => ({ kind: it.kind, url: it.url, postId: it.r.postId, pos: it.pos, author: it.r.author, page: (it.r.imgPages || {})[it.url] || '', album: it.album || '', thumb: it.thumb || '' }));
      } else {
        for (const r of pd.orderedShown) {
          for (const url of r.links) if (!boiler.has(url)) items.push({ r: r, url: url, pos: pd.posMap.get(r.postId) || 0, kind: 'link' });
        }
        filtered = applyLinkFilters(items, {
          query: linkSearchEl ? linkSearchEl.value : '',
          users: linkUserSel,
          domains: linkDomainSel
        });
      }
      // skip rebuild when nothing changed — background fetch progress ticks
      // must not churn the grid or reset the user's scroll position
      // (sub-tab + search + filter selections are part of the signature; so
      // is the note line — a stop/complete transition must re-render it even
      // when the data signature itself did not change)
      const noteSig = hub.partialNotice ? 'p:' + hub.partialWhy
        : (!hub.fetchRunning && !hub.meta.complete && hub.records.size > 0) ? 'i:' + hub.pagesDone.size + '/' + hub.meta.pageCount : 'c';
      const sig = panelTab + ':' + panelSubTab + ':' + settings.mediaGroup + ':' + rowLimit + ':' + noteSig + ':' + JSON.stringify([
        linkSearchEl ? linkSearchEl.value : '',
        linkUserSel ? Array.from(linkUserSel).sort() : null,
        linkDomainSel ? Array.from(linkDomainSel).sort() : null,
        items.length,
        panelTab === 'media' ? 0 : items.length ? items[items.length - 1].r.postId : 0
      ]);
      if (sig === lastPanelSignature) { updateCountOnly(items.length); return; }
      lastPanelSignature = sig;
      // clearVRows stashed the pre-collapse position — prefer it over the
      // now-clamped live scrollTop. A VIEW switch (tab/sub-tab/group) instead
      // restores the position the user left the NEW view at — each list owns
      // its own scroll; it must not inherit the outgoing view's offset.
      const keepScroll = vScrollKeep !== null ? vScrollKeep : panelBodyEl.scrollTop;
      vScrollKeep = null;
      const viewChanged = viewKey() !== lastRenderedView;
      lastRenderedView = viewKey();
      let scrollTarget = viewChanged ? (scrollMemory[viewKey()] || 0) : keepScroll;
      // removal rebuilds (retirement waves) drop entries above the viewport
      // and re-chunk everything under them — anchor the first VISIBLE entry
      // by CONTENT (row: first cell URL; header: sig) plus its pixel offset
      // from the viewport top. Content survives re-chunking and pooling;
      // elements do not.
      let anchorInfo = null;
      let pendingMount = null;
      if (!viewChanged && panelTab === 'media' && vMetrics && vLayout.length) {
        const st0 = panelBodyEl.scrollTop;
        const f0 = windowRange(vMetrics.top, vMetrics.h, st0, st0 + (panelBodyEl.clientHeight || 1))[0];
        const en0 = vLayout[f0];
        if (en0) {
          const rel = st0 - vMetrics.top[f0];
          if (en0.idxs) {
            const it0 = gridItems[en0.idxs[0]];
            anchorInfo = { url: it0 && it0.url, rel: rel, prevTotal: vMetrics.total, st: st0 };
          } else {
            anchorInfo = { headSig: en0.sig, rel: rel, prevTotal: vMetrics.total, st: st0 };
          }
        }
      }
      panelCountEl.textContent = panelTab === 'links' && filtered.length !== items.length
        ? filtered.length + '/' + items.length + ' items'
        : items.length + ' items';
      // build the new body OFF to the side — the old content must stay
      // mounted while building: wiping first (`textContent=''`) collapses the
      // height to 0 for a frame, the browser clamps scrollTop, and the
      // restore then fights the user's active scrolling. replaceChildren
      // swaps in ONE mutation and the scroll survives natively.
      const frag = document.createDocumentFragment();
      // stash the live media window into the pool BEFORE any body swap —
      // replaceChildren discards (and GCs) the attached rows and their
      // decoded imgs; pooled, the next mount re-attaches them as-is
      if (vAttached.length) {
        for (const a of vAttached) poolPut(a.sig, a.el);
        vAttached = [];
        vRange = { first: -1, last: -1, version: -1 };
      }
      if (panelTab === 'media') {
        gridItems = items;
        const vrows = document.createElement('div');
        vrows.className = 'xft-vrows';
        frag.appendChild(vrows);
        // the mount runs AFTER replaceChildren — the spacer must be in the
        // live DOM to probe real row/header heights (one synchronous pass)
        if (items.length) pendingMount = { vrows: vrows, layout: buildMediaLayout(items, settings.mediaGroup) };
      } else {
        // grouped rows: the post label ([#pos] author) renders once per post
        // in a fixed-width first column; the post's links stack beneath it
        const groups = groupLinkItems(filtered);
        const max = Math.min(filtered.length, rowLimit);
        let n = 0;
        for (const g of groups) {
          if (n >= max) break;
          for (let i = 0; i < g.urls.length && n < max; i++, n++) {
            const row = document.createElement('div');
            row.className = 'xft-lrow' + (i === 0 ? ' xft-lrow-first' : '');
            const c1 = document.createElement('div');
            if (i === 0) {
              c1.className = 'xft-lcell-label';
              c1.textContent = '[#' + g.pos + '] ' + (g.r.author || '?');
              c1.title = c1.textContent + ' — ' + g.urls.length + ' link(s) — jump to post';
              c1.addEventListener('click', () => jumpTo(g.r.postId));
            }
            const c2 = document.createElement('div');
            c2.className = 'xft-lcell-link';
            const a = document.createElement('a');
            a.href = g.urls[i];
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = g.urls[i];
            a.title = g.urls[i];
            c2.appendChild(a);
            row.append(c1, c2);
            frag.appendChild(row);
          }
        }
        if (!filtered.length && items.length) {
          const none = document.createElement('div');
          none.className = 'xft-empty';
          none.textContent = 'No links match your search/filters.';
          frag.appendChild(none);
        }
      }
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'xft-empty';
        empty.textContent = hub.fetchRunning
          ? 'Fetching…'
          : (mediaCounts && mediaCounts.all > 0 ? 'No ' + panelSubTab + 's in this thread.' : 'Nothing found yet.');
        frag.appendChild(empty);
      }
      panelBodyEl.replaceChildren(frag);
      if (pendingMount) {
        // spacer height is EXACT (computed from probed uniform heights), so
        // one direct scrollTop set restores the anchor / view target — no
        // estimate settling, no clamp fights
        mountVirtualGrid(pendingMount.vrows, pendingMount.layout, anchorInfo, scrollTarget);
      } else {
        vRowsEl = null;
        if (panelTab !== 'media' && scrollTarget) {
          programmaticScrollAt = performance.now();
          panelBodyEl.scrollTop = Math.min(scrollTarget, panelBodyEl.scrollHeight - panelBodyEl.clientHeight);
        }
      }
      // auto-load replaces the old Show-more button: a sentinel at the list
      // end extends rowLimit when scrolled into view (media grid renders
      // everything up front — capping is Links-only)
      if (linksObserver) linksObserver.disconnect();
      if (panelTab === 'links' && filtered.length > rowLimit) {
        if (!linksObserver) {
          linksObserver = new IntersectionObserver(() => {
            rowLimit += settings.rowCap;
            renderPanelBody();
          }, { root: panelBodyEl, rootMargin: '600px' });
        }
        if (!linksSentinel || !linksSentinel.isConnected) {
          linksSentinel = document.createElement('div');
          linksSentinel.className = 'xft-sentinel';
        }
        panelBodyEl.appendChild(linksSentinel);
        linksObserver.observe(linksSentinel);
      }
      const notes = [];
      if (hub.capNotice || cache.stopPersist) notes.push('Cache cap reached — new data kept in memory only (not persisted).');
      if (hub.partialNotice) notes.push('Fetch stopped early — list is partial' + (hub.partialWhy ? ' (' + hub.partialWhy + ')' : '') + '. Press ▶ Resume to continue from where it stopped.');
      // partialNotice is runtime-only; a REVISITED thread (cached partial from
      // an earlier session) must not look complete — meta.complete is
      // persisted, so derive the notice from it. Covers boot-with-cache (no
      // auto-refetch by design) and autoFetch-off browsing.
      else if (!hub.fetchRunning && !hub.meta.complete && hub.records.size > 0) {
        const have = hub.pagesDone.size || (hub.meta.pagesDone || []).length;
        notes.push('List is partial (' + have + '/' + hub.meta.pageCount + ' pages cached). Press ▶ Resume to fetch the rest.');
      }
      noteEl.hidden = !notes.length;
      noteEl.textContent = notes.join(' ');
    }


