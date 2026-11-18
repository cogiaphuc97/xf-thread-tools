// Headless net-throttle probe against the LOCAL fixture server.
//
//   node tests/thumbs-headless.mjs
//
// Proves the 0.22 thumb-queue changes on ONE build via the localhost hook
// window.__XFT_IMGNET_FOR_TESTS (read per pump):
//   run A (old throttle): { global: 2, perOrigin: 999 }  -> global-2 fill
//   run B (new default):  { global: 12, perOrigin: 4 }   -> per-origin fill
// 40 image cells split across BOTH fixture origins, each response delayed
// 120ms server-side. Server-side [start,end] timing log (/__tl) gives fill
// time, per-origin + global max concurrency, and pick order after a
// mid-fill scroll (visible-first). Requires Chrome (headless) + the BUILT
// bundle. Not part of npm test.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';

const CHROME = '/opt/google/chrome/chrome';
const N = 80;          // image cells (40 per origin, 20 rows — tall enough
                       // that head rows sit outside the urgency margin)
const DELAY = 120;     // ms server-side per image response
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : '  FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
}

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

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        }
      });
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
  });
}

async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 500));
  return r.result.value;
}

async function pageWs(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.url === 'about:blank') || list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* endpoint not up yet */ }
    await sleep(250);
  }
  throw new Error('chrome devtools endpoint never came up');
}

async function fetchTl(mainPort) {
  const r = await fetch('http://127.0.0.1:' + mainPort + '/__tl');
  return r.json();
}

// max overlapping intervals among records (per key when keyFn given)
function maxConcurrent(recs, keyFn) {
  const evs = [];
  for (const r of recs) { evs.push([r.s, 1, keyFn(r)]); evs.push([r.e || r.s + 1, -1, keyFn(r)]); }
  evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cur = {}; let max = 0;
  for (const [, d, k] of evs) { cur[k] = (cur[k] || 0) + d; if (cur[k] > max) max = cur[k]; }
  return max;
}

// one full browser run: fresh profile (cold thumb IDB), fixed hook config
async function runOnce(fx, tmp, port, hook, withScrollProbe) {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp + '/profile', { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate', '--window-size=1400,900',
    `--user-data-dir=${tmp}/profile`, '--remote-debugging-port=' + port,
    'about:blank'
  ], { stdio: 'ignore' });
  try {
    const cdp = await connect(await pageWs(port));
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: fx.url });
    await sleep(1500);
    await fx.reset();

    await ev(cdp, `localStorage.setItem('xft_xfThreadTools:settings', JSON.stringify({ autoFetch: 1, delayMs: 120, rowCap: 500, forceAnimations: 1, mediaGroup: 'flat' })); true`);
    // throttle hook + longtask observer BEFORE the panel opens (thumbs
    // enqueue the moment grid cells mount)
    await ev(cdp, `window.__XFT_IMGNET_FOR_TESTS = ${JSON.stringify(hook)}; true`);
    await ev(cdp, `window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); true`);
    const inject = STUB + '\n' + readFileSync(new URL('../xf-thread-tools.user.js', import.meta.url), 'utf8');
    writeFileSync(tmp + '/inject.js', inject);
    const inj = await cdp.send('Runtime.evaluate', { expression: inject });
    if (inj.exceptionDetails) console.log('INJECT EXCEPTION:', JSON.stringify((inj.exceptionDetails.exception || {}).description || '').slice(0, 600));
    await sleep(2500);

    await ev(cdp, `document.getElementById('xft-edge-btn').click(); true`);

    let scrollT = 0;
    let scrolled = false;
    let recs = [];
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      recs = (await fetchTl(fx.port)).filter((r) => r.e > 0);
      if (withScrollProbe && !scrolled && recs.length >= 6) {
        // mid-fill: every request so far belongs to head rows — jump to the
        // bottom and let the next picks prove visible-first ordering
        await ev(cdp, `document.querySelector('#xft-panel .xft-body').scrollTop = 1e9; true`);
        scrollT = Date.now();
        scrolled = true;
      }
      if (recs.length >= N) break;
      await sleep(200);
    }
    const longtasks = await ev(cdp, 'window.__lt');
    const gridCells = await ev(cdp, `document.querySelectorAll('#xft-panel .xft-cell').length`);
    chrome.kill('SIGKILL');
    return { recs, scrollT, scrolled, longtasks, gridCells };
  } finally {
    try { chrome.kill('SIGKILL'); } catch (e) { /* already dead */ }
  }
}

async function main() {
  const fx = await startFixtureServer({
    pages: 1, perPage: N,
    imgUrl: (n, pageNo, albumOrigin) =>
      (n % 2 ? albumOrigin + '/ximg/' + n + '.png' : '/img/' + n + '.png') + '?d=' + DELAY
  });
  const tmp = '/tmp/xf-thumbs-' + process.pid;

  const A = await runOnce(fx, tmp, 9415, { global: 2, perOrigin: 999, gap: 10 }, true); // same scroll so tail rows mount in BOTH runs
  const B = await runOnce(fx, tmp, 9416, { global: 12, perOrigin: 4, gap: 10 }, true);

  const fill = (recs) => {
    const ss = recs.map((r) => r.s), es = recs.map((r) => r.e);
    return { first: Math.min(...ss), last: Math.max(...es), ms: Math.max(...es) - Math.min(...ss) };
  };
  const fA = fill(A.recs), fB = fill(B.recs);

  check('run A: all ' + N + ' thumb requests served', A.recs.length === N, 'served=' + A.recs.length + ' cells=' + A.gridCells);
  check('run B: all ' + N + ' thumb requests served', B.recs.length === N, 'served=' + B.recs.length + ' cells=' + B.gridCells);

  check('AC-P1: new throttle fills faster (B < A*0.8)', fB.ms < fA.ms * 0.8, 'A=' + fA.ms + 'ms B=' + fB.ms + 'ms');

  const perOriginB = maxConcurrent(B.recs, (r) => r.o);
  const globalB = maxConcurrent(B.recs, () => 'g');
  check('AC-P2: per-origin in-flight never exceeds 4 (run B)', perOriginB <= 4, 'max=' + perOriginB);
  check('AC-P2: global in-flight never exceeds 12 (run B)', globalB <= 12, 'max=' + globalB);

  // AC-P3: requests STARTED after the scroll skew toward visible bottom
  // rows. 20 rows x ~135px, viewport ~640 + 300px margin -> only rows ~13+
  // (n >= 49) are urgent after a jump-to-bottom; the FIFO head is n ~11+.
  // Priority working = post-scroll starts land in the tail band; a stale
  // FIFO pick would start n < 20.
  const postScroll = B.recs.filter((r) => r.s > B.scrollT).sort((a, b) => a.s - b.s);
  const first5 = postScroll.slice(0, 5);
  const nums = first5.map((r) => { const m = /\/(?:x)?img\/(\d+)\.png$/.exec(r.p); return m ? parseInt(m[1], 10) : 0; });
  const bottom = nums.filter((n2) => n2 >= N - 31); // n >= 49: the urgent band
  check('AC-P3: post-scroll starts favor visible bottom rows', B.scrolled && postScroll.length >= 5 && bottom.length >= 3 && Math.min(...nums) >= N - 39,
    'first5=' + JSON.stringify(first5.map((r) => r.p)) + ' nums=' + JSON.stringify(nums) + ' scrollT=' + B.scrollT);

  check('AC-P4: zero longtasks > 50ms during run B fill', (B.longtasks || []).length === 0, JSON.stringify(B.longtasks || []));

  await fx.close();
  const fails = results.filter((r) => !r.ok);
  console.log(fails.length ? '\n' + fails.length + ' FAILURES' : '\nALL PASS');
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
