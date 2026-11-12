// rt-download: Download engine: run state, two-level net pools (files/connections), chunked transfers, retries/leashes/watchdog, zip assembly + save, dashboard UI, startBulkDownload.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // ---------- bulk download (media tab) ----------
    // Fetches every listed file (GM XHR — no CORS limits; fetch() fallback),
    // zips them STORE into ONE <thread title>.zip and saves it via a blob
    // anchor — no GM_download needed, no per-file download prompts. Player
    // embed tiles resolve to their direct stream. Balanced parallel profile
    // (user-approved 0.9.0): 6 files in flight, big files split into ≤4
    // ranged parts (GM path only — Range is CORS-unsafe on fetch), per-
    // origin caps stop one CDN monopolizing the pool, per-attempt retries
    // + layered leashes make every path settle; a second click stops.
    const dlRun = { running: false, cancel: false, phase: 'idle', total: 0, done: 0, fail: 0, bytes: 0, lastErr: '' };
    const dlNet = { active: 0, queue: [], last: 0, conns: 0 };
    const DL_NET_MAX = 6;
    const DL_NET_GAP = 200;
    const DL_PER_ORIGIN_FILES = 4;
    const DL_PER_ORIGIN_CONNS = 8;
    const DL_CONN_MAX = 12;           // global connections (files + chunk parts)
    const DL_CHUNK_MIN = 16 * 1048576; // split only files ≥ 16 MB
    const DL_CHUNK_PARTS = 4;
    const DL_RETRY_MAX = 2;           // retries per candidate URL (3 tries)
    const DL_TTFB = 30000;            // no first byte in 30s = dead attempt
    const DL_STALL = 45000;           // no bytes for 45s mid-stream = dead attempt
    const DL_READ = 180000;           // per-attempt read ceiling
    const DL_WATCHDOG = 480000;       // absolute per job, retries included
    const DL_BYTE_CAP = 3500 * 1024 * 1024; // zip offsets are 32-bit — stop well under 4 GB
    const dlOriginFiles = new Map(); // origin → jobs in flight
    const dlOriginConns = new Map(); // origin → open connections (files + parts)
    let dlConnWaiters = [];           // parked part-starters waiting on a connection
    let dlRunSeq = 0;                 // run identity — stale timers must not touch a new run
    let dlJobs = [];
    let dlBtnEl = null;
    let dlBarEl = null, dlNameEl = null, dlFillEl = null, dlStatsEl = null, dlStopEl = null, dlCloseEl = null;
    let dlSpdEl = null, dlPctEl = null, dlListEl = null;
    let dlFailPins = [];              // last ≤4 failed jobs, pinned as rows
    let dlSpeedWin = []; // [{t, b}] byte deltas — rolling 3s window for the speed readout
    let dlDashAt = 0;    // dash repaint throttle stamp
    let dlStartedAt = 0; // ETA warm-up gate
    function threadTitleRaw() {
      const h = document.querySelector('h1.p-title-value');
      let t = '';
      if (h) {
        // thread prefixes/tags ride INSIDE the h1 (XF renders them as label
        // links) — clone and drop them so the tag is not part of the name
        const c = h.cloneNode(true);
        c.querySelectorAll('a,[class*="label"],[class*="prefix"]').forEach((n) => n.remove());
        t = c.textContent || '';
      }
      if (!t.trim()) t = document.title || '';
      return t;
    }
    function zipName(kind) {
      return zipFileName(siteTagFromHost(location.hostname), threadTitleRaw(), kind);
    }
    function updateDlBtn() {
      if (!dlBtnEl) return;
      dlBtnEl.textContent = dlRun.running ? 'Stop' : 'Download';
      dlBtnEl.classList.toggle('xft-dl-run', !!dlRun.running);
      dlBtnEl.title = dlRun.running
        ? 'Stop the bulk download'
        : 'Download the ' + panelSubTab + ' list as one zip named after the thread. '
          + 'Mixed lists get Pics/ + Videos/ folders; single-type lists skip the folder '
          + 'and say (Images) or (Videos) in the zip name. Player embeds are resolved '
          + 'to their direct stream and included.';
    }
    function dlSpeed() {
      const now = performance.now();
      dlSpeedWin = dlSpeedWin.filter((e) => now - e.t < 3000);
      let s = 0;
      for (const e of dlSpeedWin) s += e.b;
      return s / 3;
    }
    // ETA from smoothed speed vs estimated remaining bytes: active jobs at
    // (total − loaded), queued jobs at the average size of finished files.
    // Zero until 3s of samples — a fake ETA in the first second is worse
    // than none.
    function dlEtaSecs() {
      const spd = dlSpeed();
      if (spd < 1024 || performance.now() - dlStartedAt < 3000) return 0;
      let remaining = 0;
      let queued = 0;
      for (const j of dlJobs) {
        if (j.state === 'run' && j.total > 0) remaining += Math.max(0, j.total - (j.loaded || 0));
        else if (j.state === 'queue') queued++;
      }
      const avg = dlRun.done ? dlRun.bytes / dlRun.done : 0;
      remaining += queued * avg;
      return remaining > 0 ? remaining / spd : 0;
    }
    function setStat(el, text) { if (el.textContent !== text) el.textContent = text; }
    // status dashboard: header (name/speed/ETA/stop), overall bar + counts,
    // and a live row per in-flight file plus pinned failures
    function updateDlDash() {
      if (!dlBarEl) return;
      const ph = dlRun.phase;
      dlBarEl.classList.toggle('xft-dlzip', ph === 'zip');
      const finished = dlRun.total ? dlRun.done + dlRun.fail : 0;
      if (ph === 'fetch') {
        const pct = dlRun.total ? Math.floor((finished / dlRun.total) * 100) : 0;
        dlFillEl.style.width = pct + '%';
        setStat(dlPctEl, pct + '%');
        while (dlStatsEl.children.length < 3) dlStatsEl.appendChild(document.createElement('span'));
        const c = dlStatsEl.children;
        setStat(c[0], finished + '/' + dlRun.total + ' files');
        setStat(c[1], dlRun.done ? '✓ ' + dlRun.done : '');
        c[1].className = dlRun.done ? 'xft-dl-ok' : '';
        setStat(c[2], dlRun.fail ? '✗ ' + dlRun.fail : '');
        c[2].className = dlRun.fail ? 'xft-dl-bad' : '';
        const eta = fmtEta(dlEtaSecs());
        const spd = fmtSpeed(dlSpeed()) + (eta ? ' · ' + eta : '');
        if (dlSpdEl.textContent !== spd) dlSpdEl.textContent = spd;
        dlListEl.hidden = false;
        renderDlRows();
      } else if (ph === 'zip') {
        dlFillEl.style.width = '100%';
        dlStatsEl.textContent = 'Zipping ' + dlRun.done + ' files · ' + (dlRun.bytes / 1048576).toFixed(1) + ' MB';
        dlSpdEl.textContent = '';
        dlListEl.hidden = true;
      } else if (ph === 'done' || ph === 'error') {
        dlFillEl.style.width = ph === 'done' ? '100%' : '0%';
        setStat(dlPctEl, ph === 'done' ? '100%' : '');
        dlStatsEl.textContent = ph === 'error'
          ? (dlRun.lastErr || 'zip error')
          : (dlRun.cancel ? 'Stopped — ' : '✓ Saved ')
            + dlRun.done + '/' + dlRun.total + ' files'
            + (dlRun.fail ? ' · ' + dlRun.fail + ' failed' : '')
            + ' · ' + (dlRun.bytes / 1048576).toFixed(1) + ' MB';
        dlSpdEl.textContent = '';
        dlListEl.hidden = true;
      }
      dlStopEl.hidden = ph !== 'fetch';
      dlCloseEl.hidden = ph === 'fetch' || ph === 'zip';
    }
    // One list row per job, created lazily and reconciled in place — rows
    // never churn DOM, only text/width. Name column flexes+ellipsizes so a
    // long filename can never shift the fixed bar/%/meta cluster.
    function dlRowEl(job) {
      if (!job._rowEl) {
        const r = document.createElement('div');
        r.className = 'xft-dlrow';
        const n = document.createElement('span');
        n.className = 'xft-dlrowname';
        const bar = document.createElement('i');
        bar.className = 'xft-dlrowbar';
        const fill = document.createElement('b');
        bar.appendChild(fill);
        const pct = document.createElement('span');
        pct.className = 'xft-dlrowpct';
        const meta = document.createElement('span');
        meta.className = 'xft-dlrowmeta';
        r.append(n, bar, pct, meta);
        job._rowEl = r;
        job._rowName = n; job._rowFill = fill; job._rowPct = pct; job._rowMeta = meta;
      }
      return job._rowEl;
    }
    function renderDlRows() {
      if (!dlListEl) return;
      const want = [];
      for (const j of dlJobs) if (j.state === 'run') want.push(j);
      for (const j of dlFailPins) if (want.indexOf(j) < 0) want.push(j);
      for (const el of Array.from(dlListEl.children)) {
        const j = el._job;
        if (!j || want.indexOf(j) < 0) {
          el.remove();
          if (j) j._rowEl = null;
        }
      }
      let ref = null;
      for (let i = want.length - 1; i >= 0; i--) {
        const el = dlRowEl(want[i]);
        el._job = want[i];
        if (el.parentNode !== dlListEl || el.nextSibling !== ref) dlListEl.insertBefore(el, ref);
        ref = el;
      }
      for (const j of want) {
        if (j.state === 'fail') {
          j._rowEl.classList.add('xft-dlrow-bad');
          j._rowFill.style.width = '100%';
          j._rowPct.textContent = '✗';
          j._rowMeta.textContent = j.errWhy || 'failed';
        } else {
          j._rowEl.classList.remove('xft-dlrow-bad');
          const p = j.total > 0 ? Math.min(100, Math.floor(((j.loaded || 0) / j.total) * 100)) : 0;
          j._rowFill.style.width = p + '%';
          j._rowPct.textContent = j.total > 0 ? p + '%' : '…';
          j._rowMeta.textContent = j.badge || fmtSpeed(j.spd || 0);
        }
        if (j._rowName.textContent !== j.name) {
          j._rowName.textContent = j.name;
          j._rowName.title = j.name;
        }
      }
    }
    function dlPinFail(job) {
      dlFailPins.push(job);
      if (dlFailPins.length > 4) dlFailPins.shift();
    }
    function dlDashTick() {
      if (dlRun.phase !== 'fetch') return;
      const now = performance.now();
      if (now - dlDashAt < 150) return;
      dlDashAt = now;
      updateDlDash();
    }
    function dlJobOrigin(job) {
      try { return new URL(job.cands[0]).origin; } catch (e) { return '*'; }
    }
    function dlURLOrigin(url) {
      try { return new URL(url).origin; } catch (e) { return '*'; }
    }
    function dlSlotRelease(job) {
      dlNet.active = Math.max(0, dlNet.active - 1);
      const o = dlJobOrigin(job);
      dlOriginFiles.set(o, Math.max(0, (dlOriginFiles.get(o) || 0) - 1));
      dlPump();
    }
    // ---- connection pool: files AND chunk parts draw from per-origin +
    // global connection budgets; a part that cannot start yet parks in
    // dlConnWaiters and drains as connections free ----
    function dlConnAcquire(ctx, origin, run) {
      if (ctx.released || ctx.killed) return;
      if (dlNet.conns < DL_CONN_MAX && (dlOriginConns.get(origin) || 0) < DL_PER_ORIGIN_CONNS) {
        dlNet.conns++;
        dlOriginConns.set(origin, (dlOriginConns.get(origin) || 0) + 1);
        run();
        return;
      }
      const w = { ctx: ctx, origin: origin, run: run };
      ctx.waits.push(w);
      dlConnWaiters.push(w);
    }
    function dlConnRelease(ctx, origin) {
      dlNet.conns = Math.max(0, dlNet.conns - 1);
      dlOriginConns.set(origin, Math.max(0, (dlOriginConns.get(origin) || 0) - 1));
      dlConnDrain();
    }
    function dlConnDrain() {
      for (let i = 0; i < dlConnWaiters.length; ) {
        const w = dlConnWaiters[i];
        if (w.ctx.released || w.ctx.killed) { dlConnWaiters.splice(i, 1); continue; }
        if (dlNet.conns >= DL_CONN_MAX || (dlOriginConns.get(w.origin) || 0) >= DL_PER_ORIGIN_CONNS) { i++; continue; }
        dlConnWaiters.splice(i, 1);
        const k = w.ctx.waits.indexOf(w);
        if (k >= 0) w.ctx.waits.splice(k, 1);
        dlNet.conns++;
        dlOriginConns.set(w.origin, (dlOriginConns.get(w.origin) || 0) + 1);
        w.run();
      }
    }
    function dlConnFetch(ctx, origin, url, opts, cb) {
      dlConnAcquire(ctx, origin, () => {
        if (ctx.released || ctx.killed || (opts.isDead && opts.isDead())) {
          dlConnRelease(ctx, origin);
          cb({ why: 'cancel', status: 0, cls: 'trans' });
          return;
        }
        let h = null;
        h = dlFetchX(url, opts, (r) => {
          dlConnRelease(ctx, origin);
          if (h) ctx.handles.delete(h);
          cb(r);
        });
        if (h) ctx.handles.add(h);
      });
    }
    function dlCtxAbort(ctx) {
      ctx.waits.length = 0;
      for (const h of Array.from(ctx.handles)) { try { h.abort(); } catch (e) {} }
      ctx.handles.clear();
    }
    function dlPump() {
      if (!dlRun.running) return;
      while (dlNet.queue.length) {
        if (dlNet.active >= DL_NET_MAX) return;
        let idx = -1;
        for (let i = 0; i < dlNet.queue.length; i++) {
          if ((dlOriginFiles.get(dlJobOrigin(dlNet.queue[i])) || 0) < DL_PER_ORIGIN_FILES) { idx = i; break; }
        }
        if (idx < 0) return; // every queued job's origin is saturated — releases re-pump
        const job = dlNet.queue.splice(idx, 1)[0];
        dlNet.active++;
        const origin = dlJobOrigin(job);
        dlOriginFiles.set(origin, (dlOriginFiles.get(origin) || 0) + 1);
        const now = Date.now();
        const wait = Math.max(0, dlNet.last + DL_NET_GAP - now);
        dlNet.last = now + wait;
        setTimeout(() => {
          if (!dlRun.running || job.state !== 'queue') { dlSlotRelease(job); return; }
          dlRunJob(job, origin);
        }, wait);
      }
      if (dlNet.active === 0) dlFinish();
    }
    function dlRunJob(job, origin) {
      job.state = 'run';
      job.loaded = 0; job.total = 0; job.spd = 0; job.badge = ''; job.errWhy = ''; job.noChunk = false; job._lastP = 0;
      updateDlDash();
      // per-job context: idempotent release, abortable handles, and an
      // ABSOLUTE watchdog — any path that never settles must fail the job
      // and free the slot (0.8.3 contract; retries run INSIDE the watch-
      // dog). ctx.runId: a stale watchdog from a stopped run must not
      // poison the next one.
      const ctx = { released: false, killed: false, runId: dlRunSeq, origin: origin, waits: [], handles: new Set() };
      job._ctx = ctx;
      const rel = () => {
        if (ctx.released) return;
        ctx.released = true;
        clearTimeout(wd);
        dlCtxAbort(ctx);
        dlSlotRelease(job);
      };
      const wd = setTimeout(() => {
        if (ctx.released || ctx.runId !== dlRunSeq) return;
        ctx.killed = true;
        job.state = 'fail';
        job.errWhy = 'watchdog';
        dlRun.fail++;
        dlPinFail(job);
        if (!dlRun.lastErr) dlRun.lastErr = 'stalled job (watchdog)';
        rel();
        updateDlDash();
      }, DL_WATCHDOG);
      dlAttempt(job, 0, 0, rel, ctx);
    }
    function dlAfter(release) {
      updateDlDash();
      release();
    }
    function dlByte(b) {
      dlSpeedWin.push({ t: performance.now(), b: b });
      dlDashTick();
    }
    // One file attempt: walk candidates, retry transients (≤ DL_RETRY_MAX,
    // backoff 2s→6s, Retry-After honored up to 30s), perm failures burn the
    // URL and walk to the next candidate.
    function dlAttempt(job, ci, tryN, release, ctx) {
      if (dlRun.cancel || ctx.killed || ctx.released) { release(); return; }
      job.loaded = 0; job.total = 0; job._lastP = 0;
      const failWith = (why, status, retryAfter, clsOverride) => {
        if (dlRun.cancel || ctx.killed || ctx.released) { release(); return; }
        const cls = clsOverride || dlFailClass(status);
        if (cls === 'trans' && tryN < DL_RETRY_MAX) {
          const wait = retryAfter > 0 ? Math.min(30000, retryAfter * 1000) : (tryN === 0 ? 2000 : 6000);
          job.badge = '↻ ' + (tryN + 1) + '/' + DL_RETRY_MAX;
          job.errWhy = why;
          updateDlDash();
          setTimeout(() => {
            if (dlRun.cancel || ctx.killed || ctx.released) { release(); return; }
            job.badge = '';
            dlAttempt(job, ci, tryN + 1, release, ctx);
          }, wait);
          return;
        }
        if (ci + 1 < job.cands.length) {
          job.badge = '';
          job.noChunk = false;
          dlAttempt(job, ci + 1, 0, release, ctx);
          return;
        }
        job.state = 'fail';
        job.badge = '';
        job.errWhy = why;
        dlRun.fail++;
        dlPinFail(job);
        dlAfter(release);
      };
      const stream = (url) => {
        dlStream(job, ctx, url, (r) => {
          if (dlRun.cancel || ctx.killed || ctx.released) { release(); return; }
          if (r.blob) {
            // a "file" that is really an HTML page (direct URL 301'd to a
            // landing page, e.g. bunkr cdn -> /f/): re-resolve through the
            // page carrier ONCE instead of zipping HTML as media
            dlSniffHtml(r.blob).then((isHtml) => {
              if (dlRun.cancel || ctx.killed || ctx.released) { release(); return; }
              if (isHtml && !job.movedPage) {
                job.movedPage = true;
                job.badge = '…';
                resolveEmbedStream(job.cands[ci], (src) => {
                  job.badge = '';
                  if (dlRun.cancel || ctx.killed || ctx.released) { release(); return; }
                  if (!src) { failWith('moved page unresolved', 0, 0, 'trans'); return; }
                  stream(src);
                });
                return;
              }
              if (isHtml) { failWith('moved page unresolved', 0, 0, 'trans'); return; }
              job.state = 'done';
              job.badge = '';
              dlRun.done++;
              dlRun.bytes += r.blob.size;
              job.blob = r.blob;
              if (dlRun.bytes > DL_BYTE_CAP) { // stop scheduling; keep what's fetched
                dlRun.lastErr = 'size cap reached — zip truncated';
                dlNet.queue.length = 0;
              }
              dlAfter(release);
            });
            return;
          }
          failWith(r.why || 'failed', r.status | 0, r.retryAfter | 0, r.cls);
        });
      };
      if (job.page) {
        // landing-page HQ: resolve the original, fall back to the embedded
        job.badge = '…';
        resolveImagePage(job.page, job.cands[ci], (full) => {
          if (dlRun.cancel || ctx.killed || ctx.released) { release(); return; }
          job.badge = '';
          stream(full || job.cands[ci]);
        }, true); // user-initiated single — force past any failure cooldown
        return;
      }
      if (job.kind === 'embed' || isVideoPageUrl(job.cands[ci])) {
        // player tiles AND file-page URLs (sign endpoint, page carrier, or
        // POSTed token endpoint): resolve to the direct stream, then fetch
        // the bytes. Resolution shares the same job so the caps also throttle
        // sign hits. Raw page URLs would download landing-page HTML.
        job.badge = '…';
        resolveEmbedStream(job.cands[ci], (src) => {
          if (dlRun.cancel || ctx.killed || ctx.released) { release(); return; }
          job.badge = '';
          if (!src) { failWith('embed unresolved', 0, 0, 'trans'); return; }
          stream(src);
        });
        return;
      }
      stream(job.cands[ci]);
    }
    // HTML-page sniff for downloaded blobs: redirect-following fetches can
    // hand back a landing page where a media file was expected (moved CDNs).
    // Promise<boolean>; never throws.
    function dlSniffHtml(blob) {
      if (!blob || typeof blob.slice !== 'function' || blob.size === 0) return Promise.resolve(false);
      return blob.slice(0, 64).text().then((t) => /^\s*</.test(t)).catch(() => false);
    }

    // One file → bytes. GM path probes with a Range request: a 206 answer
    // with a Content-Range total ≥ DL_CHUNK_MIN switches to parallel ranged
    // parts (the probe body IS part 0); a 200 answer means the server
    // ignored Range and the response is already the whole file. The fetch
    // fallback never chunks — Range is CORS-unsafe there.
    function dlStream(job, ctx, url, cb) {
      const origin = dlURLOrigin(url);
      const canChunk = !job.noChunk && typeof GM_xmlhttpRequest === 'function';
      const mkProg = () => {
        let last = 0;
        return (loaded, total) => {
          if (total > 0 && !job.total) job.total = total;
          if (loaded > last) {
            const d = loaded - last;
            last = loaded;
            dlByte(d);
            job.loaded = (job.loaded || 0) + d;
            const t = performance.now();
            const dt = t - (job._lastP || t);
            job._lastP = t;
            if (dt > 0) job.spd = job.spd ? job.spd * 0.7 + ((d / dt) * 1000) * 0.3 : (d / dt) * 1000;
            dlDashTick();
          }
        };
      };
      dlConnFetch(ctx, origin, url, { range: canChunk ? [0, DL_CHUNK_MIN - 1] : null, onProg: mkProg() }, (r) => {
        if (ctx.killed || ctx.released || dlRun.cancel) { cb({ why: 'cancel', cls: 'trans' }); return; }
        if (!r.blob) { cb(r); return; }
        if (r.status === 206 && !r.total) {
          // 206 without Content-Range: the body may be partial — never save
          // it blind; restart this attempt single-stream
          job.noChunk = true;
          cb({ why: 'partial without size', status: 0, cls: 'trans' });
          return;
        }
        if (r.status !== 206 || r.total < DL_CHUNK_MIN) { cb({ blob: r.blob }); return; }
        if (r.blob.size !== DL_CHUNK_MIN) {
          job.noChunk = true;
          cb({ why: 'probe size mismatch', status: 0, cls: 'trans' });
          return;
        }
        const rest = dlChunkPlan(r.total - DL_CHUNK_MIN, DL_CHUNK_PARTS - 1);
        if (!rest.length) { cb({ blob: r.blob }); return; }
        const spans = rest.map((rg) => [rg[0] + DL_CHUNK_MIN, rg[1] + DL_CHUNK_MIN]);
        job.total = r.total;
        job.loaded = r.blob.size;
        job.badge = '↔ ' + (spans.length + 1);
        const blobs = [r.blob];
        let left = spans.length;
        let dead = false;
        const finishParts = (res) => {
          dead = true;
          job.badge = '';
          cb(res);
        };
        const killSiblings = () => {
          for (const h of Array.from(ctx.handles)) { try { h.abort(); } catch (e) {} }
        };
        const runPart = (i, tryN) => {
          if (dead || ctx.killed || ctx.released || dlRun.cancel) return;
          const s = spans[i][0];
          const e = spans[i][1];
          dlConnFetch(ctx, origin, url, {
            range: [s, e],
            onProg: mkProg(),
            isDead: () => dead
          }, (rr) => {
            if (dead) return;
            if (rr.blob) {
              if (rr.blob.size !== e - s + 1) {
                // server ignored Range mid-run (challenge page, HTML
                // error) — assembling would corrupt the file; restart
                // the attempt single-stream
                job.noChunk = true;
                killSiblings();
                finishParts({ why: 'part size mismatch', status: 0, cls: 'trans' });
                return;
              }
              blobs[i + 1] = rr.blob;
              if (--left === 0) finishParts({ blob: new Blob(blobs) });
              return;
            }
            if (dlFailClass(rr.status | 0) === 'trans' && tryN < DL_RETRY_MAX) {
              const wait = rr.retryAfter > 0 ? Math.min(30000, rr.retryAfter * 1000) : (tryN === 0 ? 2000 : 6000);
              setTimeout(() => runPart(i, tryN + 1), wait);
              return;
            }
            killSiblings();
            finishParts({ why: rr.why || 'part failed', status: rr.status | 0, retryAfter: rr.retryAfter | 0 });
          });
        };
        for (let i = 0; i < spans.length; i++) runPart(i, 0);
      });
    }
    // One HTTP GET (GM XHR preferred, fetch fallback) with the full leash
    // set: TTFB, mid-stream stall, read ceiling. Range is GM-only. cb gets
    // {blob, status, total} on success or {why, status, retryAfter, cls}.
    function dlFetchX(url, opts, cb) {
      let settled = false;
      let firstByte = false;
      let ttfbT = 0;
      let stallT = 0;
      let leash = 0;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(ttfbT);
        clearTimeout(stallT);
        clearTimeout(leash);
        cb(r);
      };
      const prog = (loaded, total) => {
        if (!firstByte) {
          firstByte = true;
          clearTimeout(ttfbT);
        }
        clearTimeout(stallT);
        stallT = setTimeout(() => finish({ why: 'stalled', status: 0, cls: 'trans' }), DL_STALL);
        if (opts.onProg) opts.onProg(loaded, total);
      };
      const retryAfterOf = (hs) => {
        const m = String(hs || '').match(/retry-after:\s*(\d+)/i);
        return m ? parseInt(m[1], 10) : 0;
      };
      // a stream that never opens must not hold a connection (GM's own
      // timeout only governs after the request is underway)
      ttfbT = setTimeout(() => { if (!firstByte) finish({ why: 'no first byte', status: 0, cls: 'trans' }); }, DL_TTFB);
      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          // cross-host media CDNs split on referers: the 2026-11 cuckcapital
          // wall 403s no-referer downloads of originals; every known family
          // accepts the FORUM referer — send it (GM may set Referer, fetch
          // cannot). Range rides the same header set.
          const dlHdrs = Object.assign({}, opts.range ? { Range: 'bytes=' + opts.range[0] + '-' + opts.range[1] } : null);
          if (extractDomain(url) !== hostKey(location.host)) dlHdrs.Referer = location.origin + '/';
          const gmRq = GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            responseType: 'blob',
            timeout: DL_READ,
            headers: Object.keys(dlHdrs).length ? dlHdrs : undefined,
            onprogress: (r) => { if (r && r.loaded) prog(r.loaded, (r && r.total) | 0); },
            onload: (r) => {
              const st = r ? (r.status | 0) : 0;
              if (r && (st === 200 || st === 206 || st === 0) && r.response) {
                let total = 0;
                if (st === 206) {
                  const m = String(r.responseHeaders || '').match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i);
                  total = m ? parseInt(m[1], 10) : 0;
                }
                finish({ blob: r.response, status: st, total: total, retryAfter: retryAfterOf(r.responseHeaders) });
                return;
              }
              finish({ why: 'HTTP ' + st, status: st, retryAfter: r ? retryAfterOf(r.responseHeaders) : 0 });
            },
            onerror: () => finish({ why: 'network', status: 0, cls: 'trans' }),
            ontimeout: () => finish({ why: 'read timeout', status: 0, cls: 'trans' })
          });
          return { abort: () => { try { if (gmRq && gmRq.abort) gmRq.abort(); } catch (e) {} } };
        } catch (e) {
          // TM throws SYNCHRONOUSLY on URLs it cannot parse (0.8.3) — fall
          // through to fetch, which fails cleanly instead of leaking the slot.
        }
      }
      const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      leash = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, DL_READ) : 0;
      // fetch cannot set the Referer header, but the spec-legal `referrer`
      // init option sends the forum origin — the policy cuckcapital requires
      fetch(url, { referrer: location.origin + '/', signal: ctl ? ctl.signal : undefined })
        .then(async (r) => {
          if (!r.ok) {
            const ra = parseInt(r.headers.get('retry-after') || '0', 10) || 0;
            finish({ why: 'HTTP ' + r.status, status: r.status, retryAfter: ra });
            return;
          }
          if (!r.body || !r.body.getReader) { finish({ blob: await r.blob(), status: r.status, total: 0 }); return; }
          const reader = r.body.getReader();
          const chunks = [];
          let loaded = 0;
          for (;;) {
            const st = await reader.read();
            if (st.done) break;
            chunks.push(st.value);
            loaded += st.value.length;
            prog(loaded, 0);
          }
          finish({ blob: new Blob(chunks), status: r.status, total: 0 });
        })
        .catch(() => finish({ why: 'fetch failed', status: 0, cls: 'trans' }));
      return { abort: () => { try { if (ctl) ctl.abort(); } catch (e) {} } };
    }
    async function buildZipBlob(files) { // files: [{ name, blob }]
      const enc = new TextEncoder();
      const dt = dosDateTime(new Date());
      const parts = [];
      const cds = [];
      let off = 0;
      for (const f of files) {
        const buf = new Uint8Array(await f.blob.arrayBuffer()); // one full read for the CRC
        const crc = crc32(buf);
        const nameU8 = enc.encode(f.name);
        const lh = zipLocalHeader(nameU8, crc, buf.length, dt);
        parts.push(lh, f.blob); // splice the original blob — bytes are not copied twice
        cds.push(zipCentralEntry(nameU8, crc, buf.length, dt, off));
        off += lh.length + buf.length;
      }
      const cd = concatU8(cds);
      return new Blob(parts.concat([cd, zipEocd(files.length, cd.length, off)]), { type: 'application/zip' });
    }
    function dlSaveZip(zip, kind) {
      const u = URL.createObjectURL(zip);
      const a = document.createElement('a');
      a.href = u;
      a.download = zipName(kind);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 60000);
    }
    function dlFinish() {
      dlRun.running = false;
      updateDlBtn();
      if (dlRun.cancel || !dlRun.done) {
        dlRun.phase = 'done';
        updateDlDash();
        return;
      }
      // Single-kind runs (user ask 0.9.0): drop the inner folder and tag
      // the zip name. Decided from what actually DOWNLOADED, not the list.
      const keep = dlJobs.filter((j) => j.blob);
      let hImg = false;
      let hVid = false;
      for (const j of keep) {
        if (j.kind === 'video' || j.kind === 'embed') hVid = true;
        else hImg = true;
      }
      const kind = zipKindTag(hImg, hVid);
      // zip assembly needs the main thread free for arrayBuffer reads — defer
      // a tick so the final stats paint first
      dlRun.phase = 'zip';
      updateDlDash();
      setTimeout(() => {
        buildZipBlob(keep.map((j) => ({
          name: kind ? j.name : (j.kind === 'video' || j.kind === 'embed' ? 'Videos/' : 'Pics/') + j.name,
          blob: j.blob
        })))
          .then((z) => { dlSaveZip(z, kind); dlRun.phase = 'done'; updateDlDash(); })
          .catch((e) => {
            dlRun.lastErr = 'zip failed: ' + (e && e.message ? e.message : e);
            dlRun.phase = 'error';
            updateDlDash();
          });
      }, 30);
    }
    function startBulkDownload() {
      if (dlRun.running) { // second click = stop affordance
        dlRun.cancel = true;
        dlRun.running = false;
        dlNet.queue.length = 0;
        dlRunSeq++; // stale watchdogs/timers from this run must not touch the next
        for (const j of dlJobs) {
          if (j._ctx && !j._ctx.released) {
            j._ctx.killed = true;
            j._ctx.runId = -1;
            dlCtxAbort(j._ctx);
          }
        }
        dlConnWaiters.length = 0;
        dlNet.conns = 0;
        dlNet.active = 0;
        dlOriginFiles.clear();
        dlOriginConns.clear();
        dlFinish();
        return;
      }
      const pd = panelData();
      const res = buildDlJobs(collectMediaItems(pd).items);
      dlJobs = res.jobs;
      for (const j of dlJobs) j.state = 'queue';
      dlRunSeq++;
      dlRun.running = true;
      dlRun.cancel = false;
      dlRun.total = dlJobs.length;
      dlRun.done = 0;
      dlRun.fail = 0;
      dlRun.bytes = 0;
      dlRun.lastErr = '';
      dlSpeedWin = [];
      dlFailPins = [];
      dlConnWaiters = [];
      dlNet.active = 0;
      dlNet.conns = 0;
      dlOriginFiles.clear();
      dlOriginConns.clear();
      dlStartedAt = performance.now();
      if (!dlJobs.length) {
        dlRun.running = false;
        dlRun.phase = 'idle';
        updateDlBtn();
        if (dlBarEl) {
          dlBarEl.hidden = false;
          dlBarEl.classList.remove('xft-dlzip');
          dlFillEl.style.width = '0%';
          setStat(dlPctEl, '');
          dlListEl.hidden = true;
          dlStopEl.hidden = true;
          dlCloseEl.hidden = false;
          dlSpdEl.textContent = '';
          dlStatsEl.textContent = 'Nothing to download on this tab.';
          setTimeout(() => { if (dlRun.phase === 'idle') dlBarEl.hidden = true; }, 2500);
        }
        return;
      }
      dlNet.queue = dlJobs.slice();
      dlRun.phase = 'fetch';
      if (dlBarEl) {
        // header names the predicted kind (actual saved name is decided by
        // what downloads — a failed last video won't claim "(Videos)")
        let pImg = false;
        let pVid = false;
        for (const j of dlJobs) {
          if (j.kind === 'video' || j.kind === 'embed') pVid = true;
          else pImg = true;
        }
        const nm = zipName(zipKindTag(pImg, pVid));
        dlNameEl.textContent = nm;
        dlNameEl.title = nm;
        dlBarEl.hidden = false;
      }
      updateDlBtn();
      updateDlDash();
      dlPump();
    }

