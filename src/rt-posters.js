// rt-posters: Embed poster cache (GM storage), queued poster fetch net (2/350ms, backoff, cooldown), ensureEmbedPoster.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // Embed posters: thumbnail URL per embed URL, parsed from the embed page's
    // og:image/data-poster. GM_xmlhttpRequest is required for hosts that send
    // no CORS headers (page fetch() is blocked); a failed look-up caches ''
    // so a tile is never re-fetched. Persisted, pruned to keep storage flat.
    const EMBED_POSTERS_KEY = 'xfThreadTools:embedPosters';
    const embedPosters = readStore(EMBED_POSTERS_KEY, {}) || {};
    const embedPosterInflight = new Map();
    const failedEmbedPosters = new Set();
    // a capped failure is not permanent within the session: the tile retries
    // on its next rebuild (scroll back / tab switch / refresh) once cooled
    const posterCooldown = new Map();
    function saveEmbedPosters() {
      const keys = Object.keys(embedPosters);
      if (keys.length > 300) {
        for (const k of keys.slice(0, keys.length - 300)) delete embedPosters[k];
      }
      writeStore(EMBED_POSTERS_KEY, embedPosters);
    }
    // Poster look-ups run through a serialized queue: firing every visible
    // tile's request at once (a dense Video tab = 8-16 parallel GETs, cookie
    // -less) trips the host's CDN challenges — the first few come back 200,
    // the rest 403 and stayed blank for the whole session. Two concurrent
    // max, 350ms between starts, and each URL retries with backoff before
    // its session cap kicks in.
    const posterNetQueue = [];
    let posterNetActive = 0;
    let posterNetLast = 0;
    const POSTER_NET_MAX = 2;
    const POSTER_NET_GAP = 350;
    function runPosterNet(job) {
      posterNetQueue.push(job);
      pumpPosterNet();
    }
    function pumpPosterNet() {
      if (posterNetActive >= POSTER_NET_MAX || !posterNetQueue.length) return;
      const job = posterNetQueue.shift();
      posterNetActive++; // reserve the slot at SCHEDULE time — the delayed
      // start still counts, or parallel 350ms waits expire together and
      // start several jobs in the same tick (burst is exactly what breaks)
      const now = Date.now();
      const wait = Math.max(0, posterNetLast + POSTER_NET_GAP - now);
      posterNetLast = now + wait; // chain the NEXT start off this reserved
      // time — both slots must not compute from the same stale timestamp
      setTimeout(() => {
        job(() => { posterNetActive--; pumpPosterNet(); });
      }, wait);
    }
    function fetchEmbedPoster(url, cb) {
      if (embedPosterInflight.has(url)) { embedPosterInflight.get(url).push(cb); return; }
      const queue = [cb];
      embedPosterInflight.set(url, queue);
      let attempts = 0;
      const finish = (poster) => {
        if (poster) {
          embedPosters[url] = poster;
          saveEmbedPosters();
        } else {
          // exhausted — not persisted (a transient failure would blank the
          // tile on every future visit); retried on the next page load, and
          // within THIS session after a cool-down (initial-view bursts that
          // later succeed must not leave the first tiles blank forever)
          failedEmbedPosters.add(url);
          posterCooldown.set(url, Date.now() + 30000);
        }
        for (const fn of queue) fn(poster || '');
        embedPosterInflight.delete(url);
      };
      const attempt = () => {
        attempts++;
        // non-200 / network error / challenge page: retry with backoff, then cap
        const retryable = () => {
          if (attempts >= 3) finish('');
          else setTimeout(attempt, 1200 * attempts);
        };
        const ok = (text) => {
          const poster = parseEmbedPoster(text);
          if (poster) finish(poster);
          else retryable(); // 200 but no poster — may be an interstitial
        };
        if (typeof GM_xmlhttpRequest === 'function') {
          runPosterNet((done) => {
            try {
              GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 10000,
                onload: (r) => { done(); if (r && r.status && r.status !== 200) retryable(); else ok(r ? r.responseText : ''); },
                onerror: () => { done(); retryable(); },
                ontimeout: () => { done(); retryable(); }
              });
            } catch (e) { done(); retryable(); }
          });
          return;
        }
        runPosterNet((done) => {
          fetch(url, { credentials: 'omit' })
            .then((r) => r.text())
            .then((t) => { done(); ok(t); })
            .catch(() => { done(); retryable(); });
        });
      };
      attempt();
    }
    function ensureEmbedPoster(url, cb) {
      if (Object.prototype.hasOwnProperty.call(embedPosters, url)) { cb(embedPosters[url]); return; }
      if (failedEmbedPosters.has(url)) {
        if (Date.now() < (posterCooldown.get(url) || 0)) { cb(''); return; }
        failedEmbedPosters.delete(url); // cooled down — try again on this rebuild
      }
      fetchEmbedPoster(url, cb);
    }

