// Headless SORTER probe against the LOCAL fixture server.
//
//   node tests/sorter-headless.mjs
//
// Drives the real thread-page sort button end to end: click ⚡ →
// ensureForSort fetch → sorter.start → renderChunk → moved originals +
// clones. Post 1 gets a 1010-count bar rendered in the LIVE shape that
// broke 0.23.3 ("u1, u2 and 1,007 others", XF thousands separator) — the
// sorted view must put it FIRST. Zero-react posts stay last in thread
// order. Second click restores the untouched page order. Requires Chrome
// (headless) + the BUILT bundle. Not part of npm test.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';

const CHROME = '/opt/google/chrome/chrome';
const TMP = '/tmp/xf-sorter-' + process.pid;
const PORT = 9419;
const N = 12; // posts 1..12 across 3 pages
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
}

// fixture contract (tests/fixture-server.mjs postHtml): zero every 4th
// post, else (n*7)%13; post 1 overridden to 1010 via the live 1000+ shape
const reactOf = (n) => (n === 1 ? 1010 : n % 4 === 0 ? 0 : (n * 7) % 13);
const EXPECTED = Array.from({ length: N }, (_, i) => i + 1)
  .sort((a, b) => {
    const ra = reactOf(a), rb = reactOf(b);
    if (ra > 0 && rb > 0 && ra !== rb) return rb - ra;
    if (ra > 0 && rb <= 0) return -1;
    if (rb > 0 && ra <= 0) return 1;
    return a - b;
  });

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
  const fx = await startFixtureServer({
    pages: 3, perPage: 4,
    imgUrl: (n) => '/img/' + n + '.png',
    reactCounts: (n) => (n === 1 ? 1010 : null)
  });

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

    await ev(cdp, `localStorage.setItem('xft_xfThreadTools:settings', JSON.stringify({ autoFetch: 1, delayMs: 120, rowCap: 500, chunkSize: 50, forceAnimations: 1 })); true`);
    const inject = STUB + '\n' + readFileSync(new URL('../xf-thread-tools.user.js', import.meta.url), 'utf8');
    writeFileSync(TMP + '/inject.js', inject);
    const inj = await cdp.send('Runtime.evaluate', { expression: inject });
    if (inj.exceptionDetails) console.log('INJECT EXCEPTION:', JSON.stringify((inj.exceptionDetails.exception || {}).description || '').slice(0, 600));
    await sleep(1500);

    // the sort button exists on the page toolbar
    const hasBtn = await ev(cdp, `!!document.getElementById('xft-sort-btn')`);
    check('sort button injected in toolbar', hasBtn);

    // click ⚡ → fetch completes → sorter renders. Poll the label flip.
    await ev(cdp, `document.getElementById('xft-sort-btn').click(); true`);
    let label = '';
    for (let i = 0; i < 60; i++) {
      label = await ev(cdp, `(document.getElementById('xft-sort-btn')||{textContent:''}).textContent`);
      if (label.indexOf('Chronological') !== -1) break;
      await sleep(500);
    }
    check('sorter activates (label flips to Chronological)', label.indexOf('Chronological') !== -1, 'label=' + JSON.stringify(label));
    await sleep(600); // chunk render settle

    // visible article order: originals carry data-content="post-N", clones
    // carry data-post-id="N" — read both in DOM order
    const order = await ev(cdp, `[...document.querySelectorAll('article.message--post')].map((a) => { const dc = a.getAttribute('data-content') || ''; return dc.indexOf('post-') === 0 ? dc.slice(5) : (a.getAttribute('data-post-id') || '?'); }).map(Number)`);
    check('sorted order = reaction DESC, zero-react last, post 1 (1010 via "and 1,007 others") FIRST', JSON.stringify(order) === JSON.stringify(EXPECTED), 'got=' + JSON.stringify(order) + ' want=' + JSON.stringify(EXPECTED));

    // post 1 is ON page 1 — its ORIGINAL article must have been MOVED (not
    // cloned): xft-placed + data-content intact
    const p1 = await ev(cdp, `(() => { const a = [...document.querySelectorAll('article.message--post')].find((x) => (x.getAttribute('data-content')||'') === 'post-1' || x.getAttribute('data-post-id') === '1'); return a ? { placed: a.classList.contains('xft-placed'), dc: a.getAttribute('data-content'), first: a === document.querySelector('article.message--post') } : null; })()`);
    check('post 1 = moved original, first in view', !!p1 && p1.placed && p1.dc === 'post-1' && p1.first, JSON.stringify(p1));

    // restore: second click → exact original page order, clones gone
    await ev(cdp, `document.getElementById('xft-sort-btn').click(); true`);
    await sleep(700);
    const restLabel = await ev(cdp, `(document.getElementById('xft-sort-btn')||{textContent:''}).textContent`);
    const restOrder = await ev(cdp, `[...document.querySelectorAll('article.message--post')].map((a) => a.getAttribute('data-content') || '').join(',')`);
    const clonesLeft = await ev(cdp, `document.querySelectorAll('article.xf-fetched').length`);
    check('second click restores chronological view + label', restLabel.indexOf('Sort by reactions') !== -1 && restOrder === 'post-1,post-2,post-3,post-4' && clonesLeft === 0, 'label=' + JSON.stringify(restLabel) + ' order=' + restOrder + ' clones=' + clonesLeft);

    const fails = results.filter((r) => !r.ok).length;
    console.log(fails ? '\n' + fails + ' FAIL' : '\nALL PASS');
    process.exitCode = fails ? 1 : 0;
  } finally {
    try { chrome.kill('SIGKILL'); } catch (e) {}
    rmSync(TMP, { recursive: true, force: true });
    await fx.close();
  }
}

main().catch((e) => { console.error('PROBE ERROR:', e); process.exit(1); });
