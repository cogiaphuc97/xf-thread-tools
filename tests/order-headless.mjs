// Headless item-order probe against the LOCAL fixture server.
//
//   node tests/order-headless.mjs
//
// Proves the 0.23.0 sort control (.xft-ordsel in the tab row, right of the
// item count): one control orders BOTH tabs. Fixture posts carry
// deterministic reaction counts (zero every 4th post, else (n*7)%13 —
// mirrored here to compute the expected sequences). 3 pages x 4 posts, one
// same-host image each => 12 items, grid fully mounted (no virtualization
// window to scroll). Requires Chrome (headless) + the BUILT bundle. Not
// part of npm test.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';

const CHROME = '/opt/google/chrome/chrome';
const TMP = '/tmp/xf-order-' + process.pid;
const PORT = 9418;
const N = 12; // posts 1..12
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
}

// fixture contract (tests/fixture-server.mjs postHtml)
const reactOf = (n) => (n % 4 === 0 ? 0 : (n * 7) % 13);
const REACT_ORDER = Array.from({ length: N }, (_, i) => i + 1)
  .sort((a, b) => (reactOf(b) - reactOf(a)) || (a - b));
const PAGE_ORDER = Array.from({ length: N }, (_, i) => i + 1);

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

async function pageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.url === 'about:blank') || list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* endpoint not up yet */ }
    await sleep(250);
  }
  throw new Error('chrome devtools endpoint never came up');
}

async function main() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP + '/profile', { recursive: true });
  const fx = await startFixtureServer({ pages: 3, perPage: 4, imgUrl: (n) => ['/img/' + n + '.png', 'https://ext.example/p' + n] });

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate', '--window-size=1400,900',
    `--user-data-dir=${TMP}/profile`, '--remote-debugging-port=' + PORT,
    'about:blank'
  ], { stdio: 'ignore' });
  process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch (e) {} });
  try {
    const cdp = await connect(await pageWs());
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: fx.url });
    await sleep(1500);

    await ev(cdp, `localStorage.setItem('xft_xfThreadTools:settings', JSON.stringify({ autoFetch: 1, delayMs: 120, rowCap: 500, forceAnimations: 1, mediaGroup: 'flat', mediaOrder: 'default' })); true`);
    const inject = STUB + '\n' + readFileSync(new URL('../xf-thread-tools.user.js', import.meta.url), 'utf8');
    writeFileSync(TMP + '/inject.js', inject);
    const inj = await cdp.send('Runtime.evaluate', { expression: inject });
    if (inj.exceptionDetails) console.log('INJECT EXCEPTION:', JSON.stringify((inj.exceptionDetails.exception || {}).description || '').slice(0, 600));
    await sleep(2500);

    await ev(cdp, `document.getElementById('xft-edge-btn').click(); true`);

    // wait for the full 3-page fetch to land (12 items)
    let items = -1;
    for (let i = 0; i < 40; i++) {
      items = await ev(cdp, `parseInt(((document.querySelector('#xft-panel .xft-count')||{textContent:''}).textContent.match(/(\\d+)/)||[0,'0'])[1], 10)`);
      if (items >= N) break;
      await sleep(500);
    }
    check('all ' + N + ' items collected across 3 pages', items === N, 'items=' + items);

    // the control exists in the TAB row, after the count
    const afterCount = await ev(cdp, `(() => { const t = [...document.querySelectorAll('#xft-panel .xft-tabs > *')]; const i = t.findIndex((e) => e.classList.contains('xft-count')); const s = t[i + 1]; return { i: i, next: s ? s.className : '', tag: s ? s.tagName : '' }; })()`);
    check('sort select sits in the tab row right of the item count', afterCount.i === 3 && afterCount.tag === 'SELECT' && /xft-ordsel/.test(afterCount.next), JSON.stringify(afterCount));

    // 0.23.2: legacy stored 'default' coerces to 'page' — the select must
    // never hold a value that no longer exists as an option
    const ordVal = await ev(cdp, `(document.querySelector('#xft-panel .xft-ordsel')||{value:''}).value`);
    check("legacy stored mediaOrder='default' migrates to 'page'", ordVal === 'page', ordVal);
    const optCount = await ev(cdp, `document.querySelectorAll('#xft-panel .xft-ordsel option').length`);
    check('order select offers exactly Page + Reactions (no Default)', optCount === 2, 'options=' + optCount);

    const cellNs = () => ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-cell')].map((c) => parseInt((c.dataset.xftUrl.match(/\\/img\\/(\\d+)\\.png$/)||[0,0])[1], 10))`);
    const setOrder = async (mode) => {
      await ev(cdp, `(() => { const s = document.querySelector('#xft-panel .xft-ordsel'); s.value = ${JSON.stringify(mode)}; s.dispatchEvent(new Event('change')); return true; })()`);
      await sleep(700); // clearVRows + full remount
    };

    // (a) boot default (page, migrated from seeded legacy 'default') = extraction order
    let ns = await cellNs();
    check('AC-a: boot order (page) = extraction sequence', JSON.stringify(ns) === JSON.stringify(PAGE_ORDER), JSON.stringify(ns));

    // (b) react order — also proves a mounted grid re-renders on select change
    await setOrder('react');
    ns = await cellNs();
    check('AC-b: react order = reaction count descending (re-rendered in place)', JSON.stringify(ns) === JSON.stringify(REACT_ORDER), 'got=' + JSON.stringify(ns) + ' want=' + JSON.stringify(REACT_ORDER));

    // (c) page order
    await setOrder('page');
    ns = await cellNs();
    check('AC-c: page order = page ascending', JSON.stringify(ns) === JSON.stringify(PAGE_ORDER), JSON.stringify(ns));

    // (d) persisted
    const saved = await ev(cdp, `JSON.parse(localStorage.getItem('xft_xfThreadTools:settings') || '{}').mediaOrder`);
    check('selection persists to settings', saved === 'page', JSON.stringify(saved));

    // (e) Links tab follows the same control (set react while on Links)
    await ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-tab')].find((b) => b.textContent === 'Links').click(); true`);
    await sleep(400);
    await setOrder('react');
    const rows = await ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-lrow .xft-lcell-link a')].map((a) => parseInt((a.textContent.match(/\\/p(\\d+)$/)||[0,0])[1], 10))`);
    check('AC-e: Links rows follow the same react order', JSON.stringify(rows) === JSON.stringify(REACT_ORDER), 'got=' + JSON.stringify(rows));

    // (f) Group 'post' + react: groups ordered by first appearance in the
    // sorted stream — the highest-react post's group leads
    await ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-tab')].find((b) => b.textContent === 'Media').click(); true`);
    await sleep(400);
    await ev(cdp, `(() => { const s = document.querySelector('#xft-panel .xft-gsel'); s.value = 'post'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(700);
    const heads = await ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-ghead:not(.xft-gsub) .xft-glabel')].map((e) => e.textContent)`);
    const wantHeads = REACT_ORDER.map((n) => '#' + n + ' - u' + (n % 17));
    check('AC-f: group headers follow first-appearance order of the sorted stream', JSON.stringify(heads) === JSON.stringify(wantHeads), 'got=' + JSON.stringify(heads.slice(0, 4)) + '… want=' + JSON.stringify(wantHeads.slice(0, 4)) + '…');

    await fx.close();
    const fails = results.filter((r) => !r.ok);
    console.log(fails.length ? '\n' + fails.length + ' FAILURES' : '\nALL PASS');
    process.exit(fails.length ? 1 : 0);
  } finally {
    try { chrome.kill('SIGKILL'); } catch (e) { /* already dead */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
