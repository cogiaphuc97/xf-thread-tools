// Headless perf/cells probe against the LOCAL fixture server (no real site).
//
//   node tests/perf-headless.mjs [--phase cells|perf|all]
//
// cells: warm the thumb cache over the full grid, then a ≥200-row
//   round-trip must issue ZERO preview network requests; cell imgs are
//   blob-backed; nothing in a cell decodes >512px; gifs freeze in the cell
//   and animate on hover.
// perf: after warm, scripted wheel fling records zero >50ms longtasks;
//   rebuild churn counters (US-003 gate) reported.
// Requires Chrome (headless) + the BUILT bundle. Not part of npm test.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';

const CHROME = '/opt/google/chrome/chrome';
const PHASE = process.argv.includes('--phase') ? process.argv[process.argv.indexOf('--phase') + 1] : 'all';
const TMP = '/tmp/xf-perf-' + process.pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
}

// ---- GM stub (same surface the /tmp/xf-serve stub.js provided) ------------
const STUB = `
window.GM_getValue = function (k, d) {
  const v = localStorage.getItem('xft_' + k);
  return v === null ? d : JSON.parse(v);
};
window.GM_setValue = function (k, v) { localStorage.setItem('xft_' + k, JSON.stringify(v)); };
window.GM_deleteValue = function (k) { localStorage.removeItem('xft_' + k); };
window.GM_xmlhttpRequest = function (o) {
  const ctl = new AbortController();
  const t = o.timeout ? setTimeout(() => { try { ctl.abort(); } catch (e) {} if (o.ontimeout) o.ontimeout(); }, o.timeout) : 0;
  const hs = Object.assign({}, o.headers || {});
  const ref = hs.Referer; delete hs.Referer;
  fetch(o.url, { method: o.method || 'GET', signal: ctl.signal, headers: hs, referrer: ref, credentials: 'omit' })
    .then(async (r) => {
      clearTimeout(t);
      const res = { status: r.status, responseHeaders: [...r.headers.entries()].map(([k2, v2]) => k2 + ': ' + v2).join('\\r\\n') };
      if (o.responseType === 'blob') res.response = await r.blob();
      else res.responseText = await r.text();
      if (o.onload) o.onload(res);
    })
    .catch(() => { clearTimeout(t); if (o.onerror) o.onerror(); });
  return { abort: () => { try { ctl.abort(); } catch (e) {} } };
};
`;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-features=Translate', '--window-size=1400,900',
  `--user-data-dir=${TMP}/profile`, '--remote-debugging-port=9411',
  'about:blank'
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch (e) {} };
process.on('exit', cleanup);

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        close: () => ws.close()
      });
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else if (msg.method) events.push(msg);
    });
  });
}

async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 500));
  return r.result.value;
}

async function pageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9411/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.url === 'about:blank') || list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* endpoint not up yet */ }
    await sleep(250);
  }
  throw new Error('chrome devtools endpoint never came up');
}

async function scrollSweep(cdp, steps, settleMs) {
  const sh = await ev(cdp, `document.querySelector('#xft-panel .xft-body').scrollHeight`);
  for (let i = 1; i <= steps; i++) {
    await ev(cdp, `document.querySelector('#xft-panel .xft-body').scrollTop = Math.round(${sh} * ${i} / ${steps}); true`);
    await sleep(settleMs);
  }
}

async function main() {
  mkdirSync(TMP, { recursive: true });
  const fx = await startFixtureServer({ pages: 30, perPage: 50 });
  const cdp = await connect(await pageWs());
  await cdp.send('Page.enable');

  const navP = cdp.send('Page.navigate', { url: fx.url }).then(() => {});
  await navP;
  await sleep(1500);

  // settings first, then inject stub + bundle
  await ev(cdp, `localStorage.setItem('xft_xfThreadTools:settings', JSON.stringify({ autoFetch: 1, delayMs: 120, rowCap: 500, forceAnimations: 1, mediaGroup: 'flat' })); true`);
  const inject = STUB + '\n' + readFileSync(new URL('../xf-thread-tools.user.js', import.meta.url), 'utf8');
  writeFileSync(TMP + '/inject.js', inject);
  const inj = await cdp.send('Runtime.evaluate', { expression: inject });
  if (inj.exceptionDetails) console.log('INJECT EXCEPTION:', JSON.stringify((inj.exceptionDetails.exception || {}).description || '').slice(0, 600));
  await sleep(3500); // boot + cache.open + first render

  const boot = await ev(cdp, `({ panel: !!document.getElementById('xft-panel'), edge: !!document.getElementById('xft-edge-btn') })`);
  check('boot: panel + edge button', boot.panel && boot.edge);

  await ev(cdp, `document.getElementById('xft-edge-btn').click(); true`);
  await sleep(1000);

  // wait for the background fetch to complete: count stops growing and no spinner
  let items = -1, stable = 0;
  for (let i = 0; i < 90; i++) {
    const c = await ev(cdp, `parseInt(((document.querySelector('#xft-panel .xft-count')||{textContent:''}).textContent.match(/(\\d+)/)||[0,'0'])[1], 10)`);
    const busy = await ev(cdp, `!!document.querySelector('#xft-panel .xft-spinner')`);
    if (c === items && !busy) stable++; else stable = 0;
    items = c;
    if (stable >= 3 && c > 1400) break;
    await sleep(1000);
  }
  const countText = await ev(cdp, `(document.querySelector('#xft-panel .xft-count')||{textContent:''}).textContent`);
  check('background fetch completed (>=1400 items)', items > 1400, 'items=' + items + ' text=' + JSON.stringify(countText));

  // ---------- warm the thumb cache over the whole grid ----------
  // small steps: a step must stay under the overscan span (~2.3k px) or the
  // jump skips a band of rows that then never fetch until the round-trip
  const gridH = await ev(cdp, `document.querySelector('#xft-panel .xft-body').scrollHeight`);
  await scrollSweep(cdp, Math.ceil(gridH / 1000), 240);
  // wait until the server stops seeing new preview URLs for 3s
  let uniq = 0, stable2 = 0;
  for (let i = 0; i < 120; i++) {
    const s = await fx.stats();
    const n = Object.keys(s).length;
    if (n === uniq) stable2++; else { stable2 = 0; uniq = n; }
    if (stable2 >= 3 && uniq > 1400) break;
    await sleep(1000);
  }
  check('thumb cache warmed (server saw >1400 unique urls)', uniq > 1400, 'unique=' + uniq);

  // coalescing evidence: /anim.gif serves 2 cells but must be fetched once
  const animHits = (await fx.stats())['/anim.gif'] || 0;
  check('concurrent cells for one URL coalesce to a single fetch', animHits === 1, 'anim.gif requests=' + animHits);

  // ---------- cells-phase assertions ----------
  if (PHASE === 'cells' || PHASE === 'all') {
    const cellInfo = await ev(cdp, `(() => {
      const imgs = [...document.querySelectorAll('#xft-panel .xft-cell img')];
      return {
        total: imgs.length,
        blob: imgs.filter((i) => i.src.startsWith('blob:')).length,
        over512: imgs.filter((i) => i.complete && i.naturalWidth > 512).length,
        loaded: imgs.filter((i) => i.complete && i.naturalWidth > 1).length
      };
    })()`);
    check('cell imgs loaded and blob-backed', cellInfo.loaded >= Math.min(cellInfo.total, 40) && cellInfo.blob === cellInfo.total,
      JSON.stringify(cellInfo));
    check('no cell decodes beyond the 512px cap (AC-A2)', cellInfo.over512 === 0, 'over512=' + cellInfo.over512);

    // round-trip: reset counters, sweep down/up/down fast, expect ZERO image hits
    await fx.reset();
    await scrollSweep(cdp, 24, 260);
    await ev(cdp, `document.querySelector('#xft-panel .xft-body').scrollTop = 0; true`);
    await sleep(900);
    const s2 = await fx.stats();
    const imgHits = Object.entries(s2).filter(([u]) => u.startsWith('/img/') || u.startsWith('/big/') || u === '/anim.gif');
    check('round-trip past VPOOL_MAX: zero preview refetches (AC-A1)', imgHits.length === 0,
      imgHits.length ? 'refetched: ' + imgHits.slice(0, 5).map(([u, n]) => u + 'x' + n).join(' ') : '0 requests over ' + Object.keys(s2).length + ' total');

    // gif freeze + hover-play: the gif items live ~27 rows down — sweep
    // until the virtualizer materializes their cells
    for (let probe = 2000; probe <= 6000 && !(await ev(cdp, `!![...document.querySelectorAll('#xft-panel .xft-cell')].find((c) => (c.dataset.xftUrl||'').endsWith('/anim.gif'))`)); probe += 800) {
      await ev(cdp, 'document.querySelector(\'#xft-panel .xft-body\').scrollTop = ' + probe + '; true');
      await sleep(500);
    }
    const gifCell = await ev(cdp, `(() => {
      const cell = [...document.querySelectorAll('#xft-panel .xft-cell')].find((c) => (c.dataset.xftUrl||'').endsWith('/anim.gif'));
      if (!cell) return null;
      cell.scrollIntoView({ block: 'center' });
      const im = cell.querySelector('img');
      return { src: im ? im.src : '', nw: im ? im.naturalWidth : 0 };
    })()`);
    await sleep(700);
    check('gif cell present, still frame shown (AC-A3)', !!gifCell && gifCell.src.startsWith('blob:'), JSON.stringify(gifCell));
    const rafStill = await ev(cdp, `new Promise((res) => { let n = 0; const t0 = performance.now(); const c = () => { n++; if (performance.now() - t0 < 400) requestAnimationFrame(c); else res(n); }; requestAnimationFrame(c); })`);
    const imRect = await ev(cdp, `(() => { const cell = [...document.querySelectorAll('#xft-panel .xft-cell')].find((c) => (c.dataset.xftUrl||'').endsWith('/anim.gif')); const im = cell && cell.querySelector('img'); if (!im) return null; const r = im.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: imRect.x, y: imRect.y });
    await sleep(600);
    const rafAnim = await ev(cdp, `new Promise((res) => { let n = 0; const t0 = performance.now(); const c = () => { n++; if (performance.now() - t0 < 400) requestAnimationFrame(c); else res(n); }; requestAnimationFrame(c); })`);
    const hoverSrc = await ev(cdp, `(() => { const cell = [...document.querySelectorAll('#xft-panel .xft-cell')].find((c) => (c.dataset.xftUrl||'').endsWith('/anim.gif')); const im = cell && cell.querySelector('img'); return im ? im.src : ''; })()`);
    check('gif hover-play swaps to the animated original (AC-A3)', hoverSrc.startsWith('blob:') && hoverSrc !== gifCell.src,
      'still=' + String(gifCell.src).slice(0, 24) + ' hover=' + String(hoverSrc).slice(0, 24) + ' raf ' + rafStill + '->' + rafAnim);

    // album + video-poster tiles ride the thumb cache too (m=200/201 -> ~row 50;
    // album CHILDREN append at the END of the flat grid — collectMediaItems'
    // second pass — so scan both bands)
    for (let probe = 6000; probe <= 10500; probe += 600) {
      await ev(cdp, 'document.querySelector(\'#xft-panel .xft-body\').scrollTop = ' + probe + '; true');
      await sleep(450);
      if (await ev(cdp, `!![...document.querySelectorAll('#xft-panel .xft-cell')].find((c) => (c.dataset.xftUrl||'').endsWith('/v/clip1.mp4'))`)) break;
    }
    const tiles = await ev(cdp, `(() => {
      const cells = [...document.querySelectorAll('#xft-panel .xft-cell')];
      const vid = cells.find((c) => (c.dataset.xftUrl || '').endsWith('/v/clip1.mp4'));
      const albumTile = cells.find((c) => (c.dataset.xftUrl || '').endsWith('/a/ab12'));
      return {
        vidTile: vid ? (vid.querySelector('.xft-vtile img') || { src: '' }).src.startsWith('blob:') : null,
        albumCount: albumTile ? (albumTile.querySelector('.xft-album-count') || { textContent: '' }).textContent : null
      };
    })()`);
    check('video-poster tile blob-backed via thumb cache', tiles.vidTile === true, JSON.stringify(tiles));
    // children live at the bottom of the flat grid
    await ev(cdp, `document.querySelector('#xft-panel .xft-body').scrollTop = 1e9; true`);
    await sleep(900);
    const kidsInfo = await ev(cdp, `(() => {
      const kids = [...document.querySelectorAll('#xft-panel .xft-cell')].filter((c) => (c.dataset.xftUrl || '').includes('/f/slug'));
      return { n: kids.length, blob: kids.filter((c) => { const im = c.querySelector('img'); return im && im.src.startsWith('blob:') && im.classList.contains('xft-ok'); }).length };
    })()`);
    check('album tile expands; children blob-backed via thumb cache',
      tiles.albumCount === '3 files' && kidsInfo.n === 3 && kidsInfo.blob === 3,
      JSON.stringify(tiles) + ' kids=' + JSON.stringify(kidsInfo));

    // ---- AC-A4: seeded-IDB reload — previews hydrate from IDB, zero network ----
    // Same profile (IndexedDB persists), fresh page load: every preview must
    // arrive via the IDB-hit hydrate path (thumbDbGet -> memory layer) and
    // the server must see ZERO image requests. Counters reset AFTER the
    // reload's own native page-<img> loads settle — only post-open requests
    // count (a native load is not a thumb refetch).
    await cdp.send('Page.navigate', { url: fx.url });
    await sleep(1500);
    await ev(cdp, `localStorage.setItem('xft_xfThreadTools:settings', JSON.stringify({ autoFetch: 1, delayMs: 120, rowCap: 500, forceAnimations: 1, mediaGroup: 'flat' })); true`);
    const inj2 = await cdp.send('Runtime.evaluate', { expression: inject });
    if (inj2.exceptionDetails) console.log('REINJECT EXCEPTION:', JSON.stringify((inj2.exceptionDetails.exception || {}).description || '').slice(0, 400));
    await sleep(3500);
    await fx.reset(); // past the natives: from here any image hit is a refetch
    await ev(cdp, `document.getElementById('xft-edge-btn').click(); true`);
    await sleep(2500);
    const shReload = await ev(cdp, `document.querySelector('#xft-panel .xft-body').scrollHeight`);
    for (let p = 0; p <= Math.min(shReload, 12000); p += 1200) {
      await ev(cdp, 'document.querySelector(\'#xft-panel .xft-body\').scrollTop = ' + p + '; true');
      await sleep(350);
    }
    await sleep(2000);
    const sReload = await fx.stats();
    const reloadHits = Object.entries(sReload).filter(([u]) => u.startsWith('/img/') || u.startsWith('/big/') || u === '/anim.gif');
    const reloaded = await ev(cdp, `(() => { const imgs = [...document.querySelectorAll('#xft-panel .xft-cell img')]; return { n: imgs.length, blob: imgs.filter((i) => i.src.startsWith('blob:')).length, ok: imgs.filter((i) => i.classList.contains('xft-ok')).length }; })()`);
    check('reload with seeded IDB: previews hydrate, zero network (AC-A4)',
      reloadHits.length === 0 && reloaded.n > 0 && reloaded.blob === reloaded.n && reloaded.ok >= Math.min(reloaded.n, 20),
      'refetches=' + reloadHits.length + ' imgs=' + JSON.stringify(reloaded));
  }

  // ---------- perf-phase assertions ----------
  if (PHASE === 'cells' || PHASE === 'all' || PHASE === 'perf') {
    await ev(cdp, `document.querySelector('#xft-panel .xft-body').scrollTop = 0; true`);
    await sleep(600);
    // longtask observer + rebuild counter + gBCR counter
    await ev(cdp, `(() => {
      window.__lt = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });
      window.__rebuilds = 0;
      const body = document.querySelector('#xft-panel .xft-body');
      window.__mo = new MutationObserver(() => { if (body.querySelector('.xft-vrows') && body.querySelector('.xft-vrows') !== window.__lastVrows) { window.__lastVrows = body.querySelector('.xft-vrows'); window.__rebuilds++; } });
      window.__mo.observe(body, { childList: true });
      window.__gbcr = 0;
      window.__gbcrOrig = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () { window.__gbcr++; return window.__gbcrOrig.apply(this, arguments); };
      return true;
    })()`);

    // ---- AC-B2: a warm probe cache means remounts do ZERO forced reflows ----
    await ev(cdp, `window.__gbcr = 0; [...document.querySelectorAll('#xft-panel .xft-subtab:not(.xft-dlbtn)')].find((b) => /^Image /.test(b.textContent)).click(); true`);
    await sleep(700);
    await ev(cdp, `window.__gbcr = 0; [...document.querySelectorAll('#xft-panel .xft-subtab:not(.xft-dlbtn)')].find((b) => /^All /.test(b.textContent)).click(); true`);
    await sleep(700);
    const gbcrMount = await ev(cdp, `window.__gbcr`);
    check('warm remount: zero getBoundingClientRect in the mount path (AC-B2)', gbcrMount === 0, 'gbcr=' + gbcrMount);
    // width change invalidates the cache -> next mount re-probes (>=3 gBCR)
    await ev(cdp, `window.__gbcr = 0; true`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 900, deviceScaleFactor: 0, mobile: false });
    await sleep(900);
    const gbcrResize = await ev(cdp, `window.__gbcr`);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(400);
    check('resize invalidates probe cache -> re-probe (AC-B2)', gbcrResize >= 3, 'gbcr=' + gbcrResize);
    // back to a settled warm grid for the fling stages
    await ev(cdp, `document.querySelector('#xft-panel .xft-body').scrollTop = 0; true`);
    await sleep(600);
    await ev(cdp, `window.__lt = []; true`);

    // ---- AC-B3: refresh-refetch + continuous scroll = held rebuilds, live counts ----
    await ev(cdp, `[...document.querySelectorAll('#xft-panel button')].find((b) => b.textContent.trim() === '↻ Refresh').click(); true`);
    await sleep(400); // fetch starts; the fling must overlap it
    await ev(cdp, `window.__pw = 0; window.__pwLast = 0; document.querySelector('#xft-panel .xft-body').addEventListener('wheel', () => { window.__pw++; window.__pwLast = performance.now(); }, { passive: true }); true`);
    const heldSample = await ev(cdp, `(() => {
      window.__scrollSamples = [];
      window.__heldSampler = setInterval(() => {
        window.__scrollSamples.push({ r: window.__rebuilds, c: (document.querySelector('#xft-panel .xft-count') || { textContent: '' }).textContent, wAgo: performance.now() - window.__pwLast });
      }, 100);
      return { r0: window.__rebuilds };
    })()`);
    const rect = await ev(cdp, `(() => { const b = document.querySelector('#xft-panel .xft-body'); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 400) }; })()`);
    for (let i = 0; i < 26; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: 2600 });
      await sleep(80);
    }
    await sleep(400);
    const held = await ev(cdp, `(() => { clearInterval(window.__heldSampler); return { samples: window.__scrollSamples, pw: window.__pw }; })()`);
    const during = held.samples.filter((s, i) => s.r > (held.samples[i - 1] || heldSample).r && s.wAgo < 140);
    const countSeen = held.samples.map((s) => s.c);
    const countsMoved = new Set(countSeen).size > 1 || (countSeen[0] !== countSeen[countSeen.length - 1]);
    check('grid rebuilds HELD while user scrolls during a fetch (AC-B3)', during.length === 0,
      'rebuilds under ACTIVE wheel input: ' + during.length + '/' + held.samples.length + ' wheelsOnBody=' + held.pw + ' counts: ' + Array.from(new Set(countSeen)).slice(0, 4).join('|'));
    check('counts stay live during the hold (AC-B3)', countsMoved === true, 'samples=' + new Set(countSeen).size);
    await sleep(1800); // idle: pending rebuild applies within ~150ms + one frame
    const applied = await ev(cdp, `({ r: window.__rebuilds, c: (document.querySelector('#xft-panel .xft-count') || { textContent: '' }).textContent })`);
    check('held rebuild applies at scroll idle (AC-B3)', applied.r > heldSample.r0, 'rebuilds ' + heldSample.r0 + '->' + applied.r + ' count=' + applied.c);

    // ---- AC-B1: warm fling records zero >50ms longtasks ----
    const gridH2 = await ev(cdp, `document.querySelector('#xft-panel .xft-body').scrollHeight`);
    for (let p = 0; p <= gridH2; p += 1000) {
      await ev(cdp, 'document.querySelector(\'#xft-panel .xft-body\').scrollTop = ' + p + '; true');
      await sleep(200);
    }
    await sleep(1500);
    await ev(cdp, `window.__lt = []; true`);
    for (let i = 0; i < 40; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: 2200 });
      await sleep(90);
    }
    await sleep(1500);
    const perf = await ev(cdp, `window.__lt`);
    const longOver = (perf || []).filter((d) => d > 50).length;
    check('fling after warm: zero >50ms longtasks (AC-B1)', longOver === 0, 'longtasks=' + JSON.stringify(perf));
    // ---- AC-X2: the viewer keeps FULL-RES originals (thumbs never leak in) ----
    await ev(cdp, `document.querySelector('#xft-panel .xft-body').scrollTop = 0; true`);
    await sleep(700);
    const viewer = await ev(cdp, `(() => new Promise((res) => {
      const im0 = [...document.querySelectorAll('#xft-panel .xft-cell img')].find((i) => i.src.startsWith('blob:'));
      if (!im0) { res({ found: false, why: 'no blob cell img' }); return; }
      im0.closest('.xft-cell').click();
      setTimeout(() => {
        const im = document.querySelector('#xft-viewer .xft-vslot img');
        const out = { found: !!im, src: im ? String(im.src).slice(0, 60) : '' };
        out.remote = !!im && /^http/.test(im.src);
        const x = document.querySelector('#xft-viewer');
        if (x) { const c = [...(x.querySelectorAll('button, .xft-vclose, [title]') || [])]; (c[c.length - 1] || { click(){} }).click(); }
        res(out);
      }, 1400);
    }))()`);
    check('viewer opens the FULL-RES original (AC-X2)', viewer.found === true && viewer.remote === true, JSON.stringify(viewer));
    console.log('PERF-DATA ' + JSON.stringify({ longtasks: perf }));
  }

  cdp.close();
  await fx.close();
}

try {
  await main();
} catch (e) {
  check('harness completed without error', false, e.message);
} finally {
  cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'));
process.exit(failed.length === 0 ? 0 : 1);
