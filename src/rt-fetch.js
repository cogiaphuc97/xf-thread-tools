// rt-fetch: Sequential page fetch engine with retries/leash, partial resume set, ensure/ensureForSort paths.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    async function runFetch(force) {
      hub.fetchRunning = true;
      hub.abortRef = { aborted: false };
      hub.partialNotice = false;
      hub.partialWhy = '';
      let warned = false;
      const warnOnce = (msg) => {
        if (warned) return;
        warned = true;
        hub.partialNotice = true;
        hub.partialWhy = msg.replace(/^fetch stopped: /, '');
        console.warn('[xf-thread-tools] ' + msg + ' — keeping partial data.');
      };
      try {
        if (force) {
          // refresh deletes old records first
          await cache.clearThread(threadKey);
          hub.records.clear();
          hub.pagesDone.clear();
          recordsVersion += 1;
          seededPage = -1;
          clearVRows(); // rebuilt records -> cached rows are stale
        }
        seedLivePage(); // current page comes free from the live DOM
        if (seededPage > 0) hub.pagesDone.add(seededPage);
        const total = hub.meta.pageCount;
        hub.progress = { done: 0, total: total };
        notify();
        for (let n = 1; n <= total; n++) {
          if (hub.abortRef.aborted) break;
          if (n === seededPage) { hub.progress.done = n; notify(); continue; }
          if (!force && hub.pagesDone.has(n)) { hub.progress.done = n; notify(); continue; } // resume: page already cached
          let html = null;
          // transient challenges (403/429/5xx, network blips) mid-run used
          // to end the fetch PARTIAL ("Fetch stopped early") — retry with
          // backoff before declaring partial. 404/410 are permanent, no
          // retry. Abort still wins instantly.
          let partialWhy = '';
          for (let attempts = 0; html === null; attempts++) {
            if (hub.abortRef.aborted) break;
            let why = '';
            try {
              const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
              const leash = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 15000) : 0;
              const res = await fetch(threadUrl('/page-' + n), { credentials: 'include', signal: ctl ? ctl.signal : undefined });
              clearTimeout(leash);
              if (res.ok) { html = await res.text(); break; }
              why = 'HTTP ' + res.status;
              if (res.status !== 403 && res.status !== 429 && res.status < 500) { partialWhy = why; break; } // permanent, no retry
            } catch (err) { why = 'network error (' + ((err && err.message) || err) + ')'; }
            if (attempts >= 2) { partialWhy = why; break; }
            await sleep(attempts === 0 ? 3000 : 8000); // challenges clear in seconds
          }
          if (hub.abortRef.aborted) break;
          if (html === null) { warnOnce('fetch stopped: ' + (partialWhy || 'aborted') + ' on page ' + n); break; }
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const recs = extractPostsFromDoc(doc, n);
          for (const r of recs) hub.records.set(r.postId, r);
          recordsVersion += 1;
          cachePutPosts(recs);
          hub.pagesDone.add(n);
          hub.progress.done = n;
          notify();
          if (n < total && !hub.abortRef.aborted && settings.delayMs > 0) await sleep(settings.delayMs);
        }
        const complete =
          (!hub.abortRef.aborted && !warned && !cache.stopPersist) ||
          (hub.meta.pageCount === 1 && seededPage === 1);
        hub.meta.complete = complete;
        if (complete) { hub.partialNotice = false; hub.partialWhy = ''; } // a finished run clears the stale stop notice
        hub.meta.fetchedAt = Date.now();
        hub.meta.postIds = orderedRecords().map((r) => r.postId);
        hub.meta.pagesDone = Array.from(hub.pagesDone);
        cache.putThreadMeta(hub.meta).catch(() => {});
      } finally {
        hub.fetchRunning = false;
        hub.abortRef = null;
        notify();
      }
    }

    function ensure(force) {
      if (currentRun) return currentRun;
      // Partial data is usable as-is for the PANEL: never auto-refetch after a
      // cancel or mid-run failure. Explicit refresh (force=true) is the only
      // refetch path. (The SORTER uses ensureForSort — it must not sort a
      // subset silently.)
      if (!force && (hub.meta.complete || hub.records.size > 0)) {
        if (!hub.progress || (!hub.progress.total && hub.meta.pageCount)) {
          hub.progress = { done: hub.meta.complete ? hub.meta.pageCount : hub.pagesDone.size, total: hub.meta.pageCount };
        }
        notify();
        return Promise.resolve();
      }
      currentRun = runFetch(force).catch(() => {}).then(() => { currentRun = null; });
      return currentRun;
    }

    // Continue an incomplete fetch WITHOUT clearing anything: pagesDone pages
    // skip, the live page re-seeds, and each unfetched page gets a fresh
    // retry budget. This is the ▶ Resume path — the affordance for "Fetch
    // stopped early" (challenge blip, network drop) and for resuming a
    // user-stopped run on huge threads.
    function resumeFetch() {
      if (hub.fetchRunning || currentRun) return;
      currentRun = runFetch(false).catch(() => {}).then(() => { currentRun = null; });
      return currentRun;
    }

    // Sort path: complete data or RESUME the fetch of missing pages (pagesDone
    // skips already-cached pages, so a canceled run never restarts from page 1).
    function ensureForSort() {
      if (hub.meta.complete) return Promise.resolve();
      if (currentRun) return currentRun;
      currentRun = runFetch(false).catch(() => {}).then(() => { currentRun = null; });
      return currentRun;
    }

