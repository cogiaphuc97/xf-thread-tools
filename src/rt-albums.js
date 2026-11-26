// rt-albums: Album expansion runtime: GM-storage store (TTL, prune), HTML/API walk, albumDone rerender, ensureAlbum lazy trigger.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // ---------- album expansion (0.18) ----------
    // /a/<id> album links expand into per-file grid children. Server-rendered
    // hosts answer the page HTML itself (item grid inline); SPA hosts answer
    // an empty shell and serve the list from <origin>/api/albums/<id>. One
    // expansion per album per session (6h GM-storage cache, failures cool
    // down 60s — never cached as empty). Page-HTML fetches ride the shared
    // 2-concurrent /350ms landing-page queue; the JSON API walk goes direct
    // (one sequential request per page) because it must read HTTP status —
    // 404/410 resolve the album, network errors retry.
    const ALBUMS_KEY = 'xfThreadTools:albumExpansions';
    const albumStore = readStore(ALBUMS_KEY, {}) || {};
    const albumChildren = new Map();  // albumUrl -> children[] (runtime mirror of the store)
    const albumMeta = new Map();      // albumUrl -> display name (page/API title; slug fallback at read)
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
    function albumDone(url, children, persist, name) {
      if (children && children.length) {
        albumChildren.set(url, children);
        if (name) albumMeta.set(url, name);
        // partial walks (a mid-walk page error) populate the SESSION view
        // but never persist — a transient page-2 failure must not pin a
        // truncated album for the whole 6h TTL
        if (persist !== false) {
          albumStore[url] = { children: children, at: Date.now(), name: albumMeta.get(url) || '' };
          saveAlbumStore();
        }
      } else if (children && !children.length) {
        // 0.26: a CONFIRMED-empty album (parse or full API walk ran, zero
        // children) resolves empty instead of retrying forever — the tile
        // drops from the grid for the TTL. Fetch FAILURES still cool down.
        albumChildren.set(url, []);
        if (name) albumMeta.set(url, name);
        if (persist !== false) {
          albumStore[url] = { children: [], at: Date.now(), name: albumMeta.get(url) || '', empty: true };
          saveAlbumStore();
        }
      } else {
        albumCooldown.set(url, Date.now() + 60000);
      }
      const q = albumInflight.get(url) || [];
      albumInflight.delete(url);
      // children arriving changes the grid item list — re-render the media
      // tab once (signature reset forces it even when counts alone collide),
      // behind the scroll-idle gate: an expansion landing mid-scroll must
      // not yank the grid under the user
      if (panelIsOpen() && panelTab === 'media') { lastPanelSignature = ''; deferGridRebuild(); }
      for (const fn of q) fn(children && children.length ? children : null);
    }
    // Album API page fetch with STATUS split (0.26.1): 404/410 = the host
    // has no such API (permanent — caller resolves the album, [] children
    // = resolved-empty); network error / 5xx / timeout = transient (caller
    // fails, cooldown + retry). Collapsing both into one onErr is what
    // made a page-1 network failure read as "confirmed empty album" —
    // and, inverted, made 404s read as transient. Direct GM/fetch (not
    // imgPageGet): the queue hides HTTP status, and the walk is one
    // sequential request per album page anyway.
    function fetchAlbumApiPage(url, page, onOk, onErr, onGone) {
      let origin = '';
      let id = '';
      try {
        const u = new URL(url);
        origin = u.origin;
        id = u.pathname.split('/').pop() || '';
      } catch (e) { onErr(); return; }
      if (!id) { onErr(); return; }
      const apiUrl = origin + '/api/albums/' + encodeURIComponent(id) + '?per_page=100&page=' + page;
      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          GM_xmlhttpRequest({
            method: 'GET', url: apiUrl, timeout: 10000,
            onload: (r) => {
              const st = r && r.status || 0;
              if (st === 404 || st === 410) onGone();
              else if (st >= 200 && st < 400) onOk(r && r.responseText || '');
              else onErr();
            },
            onerror: onErr, ontimeout: onErr
          });
          return;
        } catch (e) { /* fall through to fetch */ }
      }
      const ctl = new AbortController();
      let fired = false; // abort's catch must not double-fire after a timeout
      const err = () => { if (fired) return; fired = true; onErr(); };
      const t = setTimeout(() => { try { ctl.abort(); } catch (e) {} err(); }, 10000);
      fetch(apiUrl, { signal: ctl.signal, credentials: 'omit' })
        .then(async (r) => {
          clearTimeout(t);
          if (r.status === 404 || r.status === 410) { try { await r.text(); } catch (e) {} if (fired) return; fired = true; onGone(); }
          else if (r.status >= 200 && r.status < 400) onOk(await r.text());
          else err();
        })
        .catch(err);
    }
    // gofile-shaped SPA expansion (0.26 US-003): the /d/<id> page is an
    // empty shell; content lives at api.<registrable-domain> behind a
    // guest-account token (session-cached per API origin). Parsed failures
    // are FETCH failures (cooldown); a valid folder with zero media is a
    // resolved-empty album (US-001 semantics apply).
    const gofileTokens = new Map(); // apiOrigin -> guest token
    function expandGofileAlbum(url, onErr) {
      const api = (typeof window !== 'undefined' && window.__XFT_GOFILE_API_FOR_TESTS) || gofileApiOrigin(url);
      let id = '';
      try { id = new URL(url).pathname.split('/').pop() || ''; } catch (e) {}
      if (!api || !id) { onErr(); return; }
      const walk = (token) => {
        imgPageGet(gofileContentsUrl(api, id, token), (t) => {
          const p = parseGofileContents(t);
          if (!p) {
            // parse failure -> cooldown; the token may be stale/rotated —
            // drop it so the post-cooldown retry re-authenticates instead
            // of cooldown-looping all session
            gofileTokens.delete(api);
            albumDone(url, null, true, '');
          } else albumDone(url, p.children, true, p.name);
        }, onErr);
      };
      if (gofileTokens.has(api)) { walk(gofileTokens.get(api)); return; }
      gmPostJson(gofileAccountsUrl(api), {}, (t) => {
        const tok = parseGofileAccounts(t);
        if (!tok) { albumDone(url, null, true, ''); return; }
        gofileTokens.set(api, tok);
        walk(tok);
      }, onErr);
    }
    // one JSON GET with status split + the 403 referer ladder (0.27): hot-
    // link-walled API families 403 the FORUM referer a page-context fetch
    // sends by default; retry once with Referer <album origin>/ (same-origin
    // semantics — the SPA's own XHRs carry it) before the hop fails. Mirrors
    // the download ladder: one alternate-policy retry, then give up.
    function cyberJsonGet(url, albumOrigin, onOk, onFail, onGone) {
      const go = (withRef) => {
        if (typeof GM_xmlhttpRequest === 'function') {
          try {
            GM_xmlhttpRequest({
              method: 'GET', url: url, timeout: 10000,
              headers: withRef ? { Referer: albumOrigin + '/' } : undefined,
              onload: (r) => {
                const st = r && r.status || 0;
                if (st === 403 && !withRef) { go(true); return; }
                if (st === 404 || st === 410) onGone();
                else if (st >= 200 && st < 400) onOk(r && r.responseText || '');
                else onFail();
              },
              onerror: onFail, ontimeout: onFail
            });
            return;
          } catch (e) { /* fall through to fetch */ }
        }
        const ctl = new AbortController();
        let fired = false;
        const err = () => { if (fired) return; fired = true; onFail(); };
        const t = setTimeout(() => { try { ctl.abort(); } catch (e) {} err(); }, 10000);
        fetch(url, Object.assign(
          { signal: ctl.signal, credentials: 'omit' },
          withRef ? { referrer: albumOrigin + '/' } : null
        ))
          .then(async (r) => {
            clearTimeout(t);
            if (r.status === 403 && !withRef) { try { await r.text(); } catch (e) {} go(true); return; }
            if (r.status === 404 || r.status === 410) { try { await r.text(); } catch (e) {} if (fired) return; fired = true; onGone(); }
            else if (r.status >= 200 && r.status < 400) onOk(await r.text());
            else err();
          })
          .catch(err);
      };
      go(false);
    }
    // cyberdrop-shaped expansion (0.27): the page's id="file" /f/ anchors
    // resolve one-by-one through the public per-file info API (info ->
    // auth hop -> direct url). ALL anchors resolved persists for the TTL;
    // zero resolved is a fetch failure (cooldown, tile stays); a partial
    // set stays session-only — same truncation rule as the API walk.
    function expandCyberdropAlbum(url, ids, title) {
      const api = gofileApiOrigin(url);
      let origin = '';
      try { origin = new URL(url).origin; } catch (e) {}
      if (!api || !origin || !ids.length) { albumDone(url, null, true, ''); return; }
      const kids = [];
      const seen = new Set();
      let i = 0;
      const step = () => {
        if (i >= ids.length) {
          if (!kids.length) albumDone(url, null, true, '');
          else albumDone(url, kids, kids.length === ids.length, title || '');
          return;
        }
        const id = ids[i++];
        cyberJsonGet(api + '/api/file/info/' + encodeURIComponent(id), origin, (t) => {
          const info = parseCyberdropFileinfo(t);
          if (!info) { step(); return; }
          cyberJsonGet(info.authUrl, origin, (t2) => {
            const direct = parseCyberdropAuth(t2);
            if (direct && !seen.has(direct)) {
              seen.add(direct);
              const kind = VID_EXT_RE.test(info.name) ? 'video' : (IMG_EXT_RE.test(info.name) ? 'image' : '');
              if (kind) kids.push({ url: direct, kind: kind, thumb: '', name: info.name });
            }
            step();
          }, step, step);
        }, step, step);
      };
      step();
    }
    function expandAlbum(url) {
      // HTML first: server-rendered hosts answer the full item grid in the
      // page (one request, children + thumbs together). An SPA shell (no
      // item grid) or a fetch error falls through to the JSON album API.
      imgPageGet(url, (text) => {
        const kids = parseAlbumPage(text, url);
        if (kids.length) { albumDone(url, kids, true, parseAlbumTitle(text)); return; }
        // gofile-shaped SPA shell: content API walk, not the /api/albums one
        if (isFileDPageUrl(url) && albumHostMatches(url, settings.albumHosts)) {
          expandGofileAlbum(url, () => albumDone(url, null, true, ''));
          return;
        }
        // cyberdrop-shaped server-rendered anchors: per-file info walk (the
        // direct urls are not in the page, and these hosts have no
        // /api/albums — the generic walk below would just 404 the album
        // into a resolved-empty drop)
        const cfIds = parseCyberdropFileAnchors(text);
        if (cfIds.length) { expandCyberdropAlbum(url, cfIds, parseAlbumTitle(text)); return; }
        const acc = [];
        const seen = new Set();
        let nm = '';
        const step = (page) => {
          if (page > ALBUM_MAX_PAGES) { albumDone(url, acc, true, nm); return; }
          fetchAlbumApiPage(url, page, (t) => {
            const p = parseAlbumApiResponse(t);
            if (p) {
              for (const c of p.children) { if (!seen.has(c.url)) { seen.add(c.url); acc.push(c); } }
              if (page === 1 && p.name) nm = p.name;
            }
            if (p && page < p.lastPage) step(page + 1);
            else albumDone(url, acc, true, nm); // walked to the last page
          }, () => albumDone(url, acc.length ? acc : null, false, nm), // network error: an EMPTY acc is a FAILURE (cooldown + retry), a partial acc stays session-only
          () => albumDone(url, acc, true, nm)); // 404/410: no such API — [] resolves empty, a partial acc persists as the walk's end
        };
        step(1);
      }, () => {
        // page GET failed outright — gofile hosts still deserve the API try
        if (isFileDPageUrl(url) && albumHostMatches(url, settings.albumHosts)) {
          expandGofileAlbum(url, () => albumDone(url, null, true, ''));
          return;
        }
        fetchAlbumApiPage(url, 1, (t) => {
          const p = parseAlbumApiResponse(t);
          albumDone(url, p ? p.children : null, true, p ? p.name : '');
        }, () => albumDone(url, null, true, ''), () => albumDone(url, [], true, '')); // API also 404s -> resolved-empty
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
        if (panelIsOpen() && panelTab === 'media') { lastPanelSignature = ''; deferGridRebuild(); }
      }, 0);
    }
    function ensureAlbum(url, cb) {
      // cb is optional: the Album sub-tab render asks for expansion without
      // waiting on a callback (the rebuild lands via albumDone's rerender)
      const done = (c) => { if (cb) cb(c); };
      if (albumChildren.has(url)) { done(albumChildren.get(url)); return; }
      const st = albumStore[url];
      if (st && Array.isArray(st.children) && (st.children.length || st.empty) && Date.now() - (st.at || 0) < ALBUM_TTL_MS) {
        albumChildren.set(url, st.children);
        if (st.name) albumMeta.set(url, st.name);
        done(st.children);
        // warm-cache hit: one deferred re-render — full albums surface their
        // children, resolved-empty albums drop their tile
        albumPrimeRender();
        return;
      }
      if (Date.now() < (albumCooldown.get(url) || 0)) { done(null); return; }
      if (albumInflight.has(url)) { if (cb) albumInflight.get(url).push(cb); return; }
      albumInflight.set(url, cb ? [cb] : []);
      expandAlbum(url);
    }
    // '[host] - [name]' group label (user spec 0.21): name = parsed page/API
    // title, falling back to the /a/<slug> identifier from the URL
    function albumLabelFor(url) {
      const s = String(url || '');
      return '[' + (extractDomain(s) || '?') + '] - ' + albumDisplayName(s, albumMeta.get(s));
    }
    // 0.26: an album whose expansion RESOLVED to zero children (not a fetch
    // failure) is removed from the grid — collectMediaItems skips it.
    function albumEmpty(url) {
      const c = albumChildren.get(String(url || ''));
      return !!c && c.length === 0;
    }
