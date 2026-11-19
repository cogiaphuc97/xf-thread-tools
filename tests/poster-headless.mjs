// Headless POSTER probe against the LOCAL fixture server (0.25.2).
//
//   node tests/poster-headless.mjs
//
// Hosts that embed a bare <video> tag + an XF unfurl card (card image =
// the poster frame; the video file has no og:image) previously rendered
// posterless tiles — ensureEmbedPoster fetched the video bytes and found
// nothing. Extraction now pairs the card image with its video; the grid
// tile and the viewer use it directly. Requires Chrome (headless) + the
// BUILT bundle. Not part of npm test.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';

const CHROME = '/opt/google/chrome/chrome';
const TMP = '/tmp/xf-poster-' + process.pid;
const PORT = 9427;
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
  // post 2 carries the zpic SHAPE (generic hosts, .example TLD): an unfurl
  // card (bbCodeBlockUnfurl-image) directly followed by a bare <video> with
  // a cross-host webm source. Poster bytes come from the fixture /img/.
  const ZPIC = `
  <div class="bbCodeBlock bbCodeBlock--unfurl js-unfurl fauxBlockLink" data-url="https://zpic.example/view/ABC123#" data-host="zpic.example">
    <div class="contentRow"><div class="contentRow-figure">
      <img src="/img/501.png" loading="lazy" class="bbCodeBlockUnfurl-image" data-onerror="hide-parent">
    </div><div class="contentRow-main"><h3><a href="https://zpic.example/view/ABC123#">clip</a></h3></div></div>
  </div>
  <video class="videotag" controls=""><source src="https://cdn.example/s11/clip1.webm" type="video/webm"></video>`;
  const fx = await startFixtureServer({
    pages: 1, perPage: 3,
    imgUrl: (n) => '/img/' + n + '.png',
    richPosts: (n) => (n === 2 ? ZPIC : null)
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

    await ev(cdp, `localStorage.setItem('xft_xfThreadTools:settings', JSON.stringify({ autoFetch: 0, delayMs: 120, rowCap: 500, chunkSize: 50 })); true`);
    const inject = STUB + '\n' + readFileSync(new URL('../xf-thread-tools.user.js', import.meta.url), 'utf8');
    writeFileSync(TMP + '/inject.js', inject);
    const inj = await cdp.send('Runtime.evaluate', { expression: inject });
    if (inj.exceptionDetails) console.log('INJECT EXCEPTION:', JSON.stringify((inj.exceptionDetails.exception || {}).description || '').slice(0, 600));
    await sleep(1500);

    // reset hit counters AFTER the native page-<img> loads (the unfurl img
    // sits in the live DOM) and BEFORE the panel opens — the only remaining
    // /img/501.png hit must be the thumb-cache GM fetch
    await fetch(`http://127.0.0.1:${fx.port}/__reset`);

    // open the panel and land on the All tab
    await ev(cdp, `document.getElementById('xft-edge-btn').click(); true`);
    await sleep(700);

    // the webm is a Videos item; the unfurl image is NOT an image item
    const cells = await ev(cdp, `[...document.querySelectorAll('.xft-cell')].map((c) => c.dataset.xftUrl)`);
    check('webm collected as a video cell', cells.some((u) => /clip1\.webm$/.test(u)), JSON.stringify(cells));
    check('unfurl image NOT collected as media', !cells.some((u) => /501\.png$/.test(u)), JSON.stringify(cells));

    // the video tile shows the paired poster (thumb-cache img reaches .xft-ok)
    let tile = null;
    for (let i = 0; i < 60; i++) {
      tile = await ev(cdp, `(() => { const c = [...document.querySelectorAll('.xft-cell')].find((x) => /clip1\\.webm$/.test(x.dataset.xftUrl || '')); if (!c) return null; const im = c.querySelector('.xft-vtile img'); return im ? { ok: im.classList.contains('xft-ok'), src: im.getAttribute('src') || '', w: im.naturalWidth } : null; })()`);
      if (tile && tile.ok) break;
      await sleep(300);
    }
    check('video tile poster loads (unfurl image, via thumb cache)', !!tile && tile.ok && tile.w > 1 && /^blob:|^https?:/.test(tile.src), JSON.stringify(tile));

    // fixture poster bytes were fetched exactly once (thumb-cache one-fetch)
    const posterHits = (await fx.stats())['/img/501.png'] || 0;
    check('poster fetched once through the thumb cache', posterHits === 1, 'hits=' + posterHits);

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
