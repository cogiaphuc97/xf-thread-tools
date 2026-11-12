// rt-embednet: Embed stream cache, gmGetText/gmPostJson (GM XHR + fetch fallback), resolveEmbedStream (sign endpoint / view API / file-page carriers).
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // Direct-stream resolver: for embed URLs whose host exposes a sign
    // endpoint, exchange the embed URL for a time-limited direct mp4 and
    // cache it until ~60s before its exp. Video clicks are single-shot, so
    // no queue — but a cached answer must never outlive its token.
    const EMBED_STREAMS_KEY = 'xfThreadTools:embedStreams';
    const embedStreams = readStore(EMBED_STREAMS_KEY, {}) || {};
    const embedStreamInflight = new Map();
    function saveEmbedStreams() {
      const keys = Object.keys(embedStreams);
      if (keys.length > 200) {
        for (const k of keys.slice(0, keys.length - 200)) delete embedStreams[k];
      }
      writeStore(EMBED_STREAMS_KEY, embedStreams);
    }
    // GM-or-fetch GET returning responseText; single-shot, no queue (stream
    // resolution is click-driven, one URL at a time)
    function gmGetText(url, onOk, onErr) {
      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            timeout: 10000,
            onload: (r) => onOk(r && r.responseText || ''),
            onerror: onErr,
            ontimeout: onErr
          });
          return;
        } catch (e) { /* fall through to fetch */ }
      }
      // the fetch fallback needs its own leash: a hung connection would hold
      // an imgPageNet slot forever and starve every queued resolve after it
      const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      if (ctl) setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 10000);
      fetch(url, { credentials: 'omit', signal: ctl ? ctl.signal : undefined })
        .then((r) => r.text())
        .then(onOk)
        .catch(onErr);
    }
    // GM-or-fetch POST with a JSON body, same single-shot shape as gmGetText;
    // used by token endpoints that only accept POSTed {file_slug}-style bodies
    function gmPostJson(url, body, onOk, onErr) {
      const data = JSON.stringify(body || {});
      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          GM_xmlhttpRequest({
            method: 'POST',
            url: url,
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' },
            data: data,
            onload: (r) => onOk(r && r.responseText || ''),
            onerror: onErr,
            ontimeout: onErr
          });
          return;
        } catch (e) { /* fall through to fetch */ }
      }
      const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      if (ctl) setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 10000);
      fetch(url, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: data, signal: ctl ? ctl.signal : undefined })
        .then((r) => r.text())
        .then(onOk)
        .catch(onErr);
    }
    function resolveEmbedStream(url, cb) {
      const now = Math.floor(Date.now() / 1000);
      const c = embedStreams[url];
      if (c && c.exp - now > 60) { cb(c.url); return; }
      const sign = embedSignUrl(url);
      const view = embedViewApiUrl(url);
      const directFile = VID_EXT_RE.test(url) || IMG_EXT_RE.test(url);
      if (!sign && !view && !isVideoPageUrl(url) && !directFile) { cb(''); return; }
      if (embedStreamInflight.has(url)) { embedStreamInflight.get(url).push(cb); return; }
      const queue = [cb];
      embedStreamInflight.set(url, queue);
      const finish = (hit) => {
        if (hit) {
          embedStreams[url] = { url: hit.url, exp: hit.exp || (now + 600) };
          saveEmbedStreams();
          for (const fn of queue) fn(hit.url);
        } else {
          for (const fn of queue) fn('');
        }
        embedStreamInflight.delete(url);
      };
      // carrier -> direct stream: sign when the page says so (bunkr-style
      // {token, ex} appended by the caller), plain src otherwise
      const finishCarrier = (carrier) => {
        if (!carrier) { finish(null); return; }
        if (!carrier.sign) { finish({ url: carrier.src, exp: 0 }); return; }
        let path = '';
        try { path = new URL(carrier.src).pathname; } catch (e) { finish(null); return; }
        gmGetText(carrier.sign + '?path=' + encodeURIComponent(path), (st) => {
          const tok = parseSignToken(st);
          if (!tok) { finish(null); return; }
          finish({ url: carrier.src + (carrier.src.indexOf('?') === -1 ? '?' : '&')
            + 'token=' + encodeURIComponent(tok.token) + '&ex=' + tok.exp, exp: tok.exp });
        }, () => finish(null));
      };
      // route 2: file-page hosts (bunkr-style /v/ or /f/ pages) — fetch the
      // page, extract the carrier, sign it if the page says so
      const resolveViaPage = () => {
        gmGetText(url, (text) => finishCarrier(parseVideoPage(text)), () => finish(null));
      };
      const ok = (text) => finish(parseSignResponse(text));
      if (sign) {
        gmGetText(sign, ok, () => finish(null));
      } else if (view) {
        // route 1b: short-slug file pages whose token endpoint wants a POSTed
        // {file_slug} (filester-style) — the answer already IS the signed
        // stream URL, no page fetch needed
        gmPostJson(view.url, { file_slug: view.slug },
          (t) => finish(parseViewApiResponse(t, now)), () => finish(null));
      } else if (directFile) {
        // route 3: DIRECT file URLs (video OR image) that 301 to an HTML page
        // (bunkr-family cdn/<file> -> /f/<file>): the media element gets HTML
        // and dies. Fetch, and if the answer parses as a file page, resolve
        // through it
        gmGetText(url, (text) => finishCarrier(parseVideoPage(text)), () => finish(null));
      } else {
        resolveViaPage();
      }
    }
