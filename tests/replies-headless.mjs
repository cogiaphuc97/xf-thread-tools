// Headless REPLIES probe against the LOCAL fixture server (0.25.0).
//
//   node tests/replies-headless.mjs
//
// Drives the per-post replies feature end to end: every post on the page
// gets a "View replies" bar; clicking post 1's bar fetches the XF-shaped
// search page (q=post-1) and renders the Post # / Date / Reply table with
// linkified snippet; toggling hides/shows without refetching (session
// cache); the last post gets "No replies found." Requires Chrome
// (headless) + the BUILT bundle. Not part of npm test.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';

const CHROME = '/opt/google/chrome/chrome';
const TMP = '/tmp/xf-replies-' + process.pid;
const PORT = 9423;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
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
  // 1 page x 4 posts: replies(post K) = K+1, K+2 while they exist —
  // post 1 -> rows for 2 and 3; post 4 -> none
  const fx = await startFixtureServer({ pages: 1, perPage: 4, imgUrl: (n) => '/img/' + n + '.png' });

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

    await ev(cdp, `localStorage.setItem('xft_xfThreadTools:settings', JSON.stringify({ autoFetch: 0, delayMs: 120, rowCap: 500, chunkSize: 50 })); true`);
    const inject = STUB + '\n' + readFileSync(new URL('../xf-thread-tools.user.js', import.meta.url), 'utf8');
    writeFileSync(TMP + '/inject.js', inject);
    const inj = await cdp.send('Runtime.evaluate', { expression: inject });
    if (inj.exceptionDetails) console.log('INJECT EXCEPTION:', JSON.stringify((inj.exceptionDetails.exception || {}).description || '').slice(0, 600));
    await sleep(1500);

    // every post gets a bar inside .message-main (host selector shape)
    const nBtns = await ev(cdp, `document.querySelectorAll('.xft-rbtn').length`);
    const inHost = await ev(cdp, `[...document.querySelectorAll('.xft-rbtn')].every((b) => !!b.closest('.message-main'))`);
    check('view-replies bar under every post (4)', nBtns === 4 && inHost, 'btns=' + nBtns);

    // click post 1's bar -> fetch + table
    await ev(cdp, `[...document.querySelectorAll('.xft-rbtn')].find((b) => b.dataset.xftPid === '1').click(); true`);
    let rows = null;
    for (let i = 0; i < 40; i++) {
      rows = await ev(cdp, `(() => { const w = document.querySelector('.xft-rwrap[data-xft-pid="1"]'); if (!w || !w.querySelector('.xft-rtable')) return null; return [...w.querySelectorAll('.xft-rrow:not(.xft-rhead)')].map((r) => ({ num: r.querySelector('.xft-rnum a') ? r.querySelector('.xft-rnum a').getAttribute('href') : '', txt: r.querySelector('.xft-rnum a') ? r.querySelector('.xft-rnum a').textContent : '', link: r.querySelector('.xft-rsnip a') ? r.querySelector('.xft-rsnip a').getAttribute('href') : '' })); })()`);
      if (rows) break;
      await sleep(250);
    }
    check('post 1 table renders 2 reply rows (posts 2, 3)', !!rows && rows.length === 2, JSON.stringify(rows));
    const fxOrigin = new URL(fx.url).origin;
    check('row links absolutized to /threads/777/post-N/', !!rows && rows[0].num === fxOrigin + '/threads/777/post-2/' && rows[1].num.indexOf('/post-3/') !== -1 && rows[0].txt === '#2', JSON.stringify(rows));
    check('snippet URL linkified (DOM-safe)', !!rows && rows[0].link === 'https://example.net/x' && rows[1].link === '', JSON.stringify(rows));

    // exactly ONE search hit so far
    check('one search fetch', fx.searchHits() === 1, 'hits=' + fx.searchHits());

    // toggle: hide then show — label flips, no refetch
    const btn1 = `[...document.querySelectorAll('.xft-rbtn')].find((b) => b.dataset.xftPid === '1')`;
    await ev(cdp, btn1 + '.click(); true');
    const hiddenState = await ev(cdp, `(() => { const w = document.querySelector('.xft-rwrap[data-xft-pid="1"]'); return { h: w.hasAttribute('hidden'), lbl: (${btn1}).textContent }; })()`);
    await ev(cdp, btn1 + '.click(); true');
    await sleep(300);
    const shownState = await ev(cdp, `(() => { const w = document.querySelector('.xft-rwrap[data-xft-pid="1"]'); return { h: w.hasAttribute('hidden'), lbl: (${btn1}).textContent, rows: w.querySelectorAll('.xft-rrow:not(.xft-rhead)').length }; })()`);
    check('toggle hides/shows + flips label', hiddenState.h === true && /View replies/.test(hiddenState.lbl) && shownState.h === false && /Hide replies/.test(shownState.lbl) && shownState.rows === 2, JSON.stringify({ hiddenState, shownState }));
    check('cached reopen does not refetch', fx.searchHits() === 1, 'hits=' + fx.searchHits());

    // last post: no replies
    await ev(cdp, `[...document.querySelectorAll('.xft-rbtn')].find((b) => b.dataset.xftPid === '4').click(); true`);
    let empty = '';
    for (let i = 0; i < 40; i++) {
      empty = await ev(cdp, `(() => { const w = document.querySelector('.xft-rwrap[data-xft-pid="4"]'); return w ? w.textContent : ''; })()`);
      if (empty && empty.indexOf('Loading') === -1) break;
      await sleep(250);
    }
    check('post 4 shows "No replies found."', empty.indexOf('No replies found.') !== -1, JSON.stringify(empty));

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
