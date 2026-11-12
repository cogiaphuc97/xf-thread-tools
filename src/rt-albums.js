// rt-albums: Album expansion runtime: GM-storage store (TTL, prune), HTML/API walk, albumDone rerender, ensureAlbum lazy trigger.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // ---------- album expansion (0.18) ----------
    // /a/<id> album links expand into per-file grid children. Server-rendered
    // hosts answer the page HTML itself (item grid inline); SPA hosts answer
    // an empty shell and serve the list from <origin>/api/albums/<id>. One
    // expansion per album per session (6h GM-storage cache, failures cool
    // down 60s — never cached as empty). Fetches ride the shared 2-concurrent
    // /350ms landing-page queue: a thread with dozens of albums must not
    // burst the host the way the poster queue once did.
    const ALBUMS_KEY = 'xfThreadTools:albumExpansions';
    const albumStore = readStore(ALBUMS_KEY, {}) || {};
    const albumChildren = new Map();  // albumUrl -> children[] (runtime mirror of the store)
    const albumInflight = new Map();
    const albumCooldown = new Map();
    const ALBUM_TTL_MS = 6 * 3600 * 1000;
    const ALBUM_MAX_PAGES = 10;
    function saveAlbumStore() {
      const keys = Object.keys(albumStore);
      if (keys.length > 40) {
        keys.sort((a, b) => ((albumStore[a] && albumStore[a].at) || 0) - ((albumStore[b] && albumStore[b].at) || 0));
        for (const k of keys.slice(0, keys.length - 40)) delete albumStore[k];
      }
      writeStore(ALBUMS_KEY, albumStore);
    }
    function albumDone(url, children, persist) {
      if (children && children.length) {
        albumChildren.set(url, children);
        // partial walks (a mid-walk page error) populate the SESSION view
        // but never persist — a transient page-2 failure must not pin a
        // truncated album for the whole 6h TTL
        if (persist !== false) {
          albumStore[url] = { children: children, at: Date.now() };
          saveAlbumStore();
        }
      } else {
        albumCooldown.set(url, Date.now() + 60000);
      }
      const q = albumInflight.get(url) || [];
      albumInflight.delete(url);
      // children arriving changes the grid item list — re-render the media
      // tab once (signature reset forces it even when counts alone collide)
      if (panelIsOpen() && panelTab === 'media') { lastPanelSignature = ''; renderPanelBody(); }
      for (const fn of q) fn(children && children.length ? children : null);
    }
    function fetchAlbumApiPage(url, page, onOk, onErr) {
      let origin = '';
      let id = '';
      try {
        const u = new URL(url);
        origin = u.origin;
        id = u.pathname.split('/').pop() || '';
      } catch (e) { onErr(); return; }
      if (!id) { onErr(); return; }
      imgPageGet(origin + '/api/albums/' + encodeURIComponent(id) + '?per_page=100&page=' + page, onOk, onErr);
    }
    function expandAlbum(url) {
      // HTML first: server-rendered hosts answer the full item grid in the
      // page (one request, children + thumbs together). An SPA shell (no
      // item grid) or a fetch error falls through to the JSON album API.
      imgPageGet(url, (text) => {
        const kids = parseAlbumPage(text, url);
        if (kids.length) { albumDone(url, kids, true); return; }
        const acc = [];
        const seen = new Set();
        const step = (page) => {
          if (page > ALBUM_MAX_PAGES) { albumDone(url, acc, true); return; }
          fetchAlbumApiPage(url, page, (t) => {
            const p = parseAlbumApiResponse(t);
            if (p) for (const c of p.children) { if (!seen.has(c.url)) { seen.add(c.url); acc.push(c); } }
            if (p && page < p.lastPage) step(page + 1);
            else albumDone(url, acc, true); // walked to the last page
          }, () => albumDone(url, acc, false)); // mid-walk error: session-only
        };
        step(1);
      }, () => {
        // page GET failed outright — still try the API before giving up
        fetchAlbumApiPage(url, 1, (t) => {
          const p = parseAlbumApiResponse(t);
          albumDone(url, p ? p.children : null, true);
        }, () => albumDone(url, null, true));
      });
    }
    // warm-cache hits must also surface children: the first collect pass runs
    // BEFORE any tile exists, so a store hit has to schedule one deferred
    // re-render (deferred = never re-entrant with the render that is calling
    // buildMediaCell; coalesced = N cached albums cost one rebuild, not N)
    let albumPrimeQueued = false;
    function albumPrimeRender() {
      if (albumPrimeQueued) return;
      albumPrimeQueued = true;
      setTimeout(() => {
        albumPrimeQueued = false;
        if (panelIsOpen() && panelTab === 'media') { lastPanelSignature = ''; renderPanelBody(); }
      }, 0);
    }
    function ensureAlbum(url, cb) {
      if (albumChildren.has(url)) { cb(albumChildren.get(url)); return; }
      const st = albumStore[url];
      if (st && Array.isArray(st.children) && st.children.length && Date.now() - (st.at || 0) < ALBUM_TTL_MS) {
        albumChildren.set(url, st.children);
        cb(st.children);
        albumPrimeRender();
        return;
      }
      if (Date.now() < (albumCooldown.get(url) || 0)) { cb(null); return; }
      if (albumInflight.has(url)) { albumInflight.get(url).push(cb); return; }
      albumInflight.set(url, [cb]);
      expandAlbum(url);
    }
