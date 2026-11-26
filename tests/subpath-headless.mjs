// Headless SUBPATH-INSTALL probe against the LOCAL fixture server (0.27).
//
//   node tests/subpath-headless.mjs
//
// Covers the subpath-install triple: the thread route mounted under
// /phpBB2/threads/… must (1) boot the panel at all, (2) walk pages at the
// SUBPATH URL (auto-detected basePath — root-built URLs 404), and (3) collect
// XF2 attachment anchors whose file URLs live under /data/video/ (no
// "attachments" substring — the a.file-preview shape). Requires Chrome
// (headless) + the BUILT bundle. Not part of npm test.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';

const CHROME = '/opt/google/chrome/chrome';
const TMP = '/tmp/xf-subpath-' + process.pid;
const PORT = 9436;
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
    ws.addEventListener('message', (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
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

// XF2 attachmentList shape (subpath-install variant): file anchors under
// /data/video/ carry NO "attachments" substring — only a.file-preview
// identifies them; thumbs under /data/attachments/ are never scanned.
const att = (i) => '<ul class="attachmentList"><li class="file file--linked">' +
  '<a class="u-anchorTarget" id="attachment-91' + i + '"></a>' +
  '<a class="file-preview" href="/phpBB2/data/video/77/7' + i + '-b84d214d262c0f8823b079b2afd89d40.mp4?hash=h' + i + '" target="_blank">' +
  '<img src="/phpBB2/data/attachments/77/7' + i + '-b84d214d262c0f8823b079b2afd89d40.jpg" width="150" height="225"></a>' +
  '<div class="file-content"><div class="file-info"><span class="file-name" title="clip ' + i + '.mp4">clip ' + i + '.mp4</span>' +
  '<div class="file-meta">1.2 MB</div></div></div></li></ul>';

async function main() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP + '/profile', { recursive: true });
  const fx = await startFixtureServer({
    pages: 2, perPage: 1,
    imgUrl: (n) => ['/img/' + n + '.png'],
    attachPosts: (n) => (n === 1 ? att(1) + att(2) : n === 2 ? att(3) : null),
    // 0.28.1: inline attachment <video> (bbMediaWrapper shape) — no anchor, no
    // wrapped thumb, no unfurl card; the poster must be DERIVED from the
    // /data/video/ url as the /data/attachments/ sibling
    richPosts: (n) => (n === 1
      ? '<div class="bbMediaWrapper"><div class="bbMediaWrapper-inner"><video controls="" data-xf-init="video-init"><source src="/phpBB2/data/video/78/781-cafecafecafef0sd.mp4?hash=xY12"></video></div></div>'
      : null)
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
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${fx.port}/phpBB2/threads/777/` });
    await sleep(1500);

    await ev(cdp, `localStorage.setItem('xft_xfThreadTools:settings', JSON.stringify({ autoFetch: 1, delayMs: 50, rowCap: 500, chunkSize: 50 })); true`);
    const inject = STUB + '\n' + readFileSync(new URL('../xf-thread-tools.user.js', import.meta.url), 'utf8');
    writeFileSync(TMP + '/inject.js', inject);
    const inj = await cdp.send('Runtime.evaluate', { expression: inject });
    if (inj.exceptionDetails) console.log('INJECT EXCEPTION:', JSON.stringify((inj.exceptionDetails.exception || {}).description || '').slice(0, 600));
    await sleep(1200);

    // (1) boot: the edge button exists on the subpath-mounted route
    const booted = await ev(cdp, `!!document.getElementById('xft-edge-btn')`);
    check('subpath route boots the script', booted === true, booted ? 'edge btn present' : 'no edge btn');

    // open the panel; the autoFetch background walk (boot kick) fetches the
    // remaining pages — panel-open ensure(false) alone would stop at the
    // live-page partial by design
    await ev(cdp, `document.getElementById('xft-edge-btn').click(); true`);
    await sleep(600);

    // (2) page-walk fetches the SUBPATH page URL (root-built would 404)
    let page2 = 0;
    for (let i = 0; i < 40; i++) {
      const st = await fx.stats();
      page2 = st['/phpBB2/threads/777/page-2'] || 0;
      if (page2 > 0) break;
      await sleep(400);
    }
    check('page-walk hits the subpath page-2 URL (auto basePath)', page2 > 0, 'hits=' + page2);

    // (3) file-preview video attachments collected (post 1 live + post 2 walked)
    let urls = [];
    let vids = 0;
    for (let i = 0; i < 40; i++) {
      urls = await ev(cdp, `[...document.querySelectorAll('.xft-cell')].map((c) => c.dataset.xftUrl || '')`);
      vids = urls.filter((u) => /\/phpBB2\/data\/video\/77\/7[123]-/.test(u)).length;
      if (vids === 3) break;
      await sleep(400);
    }
    check('file-preview video attachments collected (3 of 3)', vids === 3, JSON.stringify(urls.filter((u) => u.indexOf('data/video') >= 0)));
    // 0.27.1: file-preview anchors WRAP a thumb img — video tiles must show
    // it as the poster (.xft-vtile img), no landing-page fetch involved
    let pv = 0;
    for (let i = 0; i < 30; i++) {
      pv = await ev(cdp, `[...document.querySelectorAll('.xft-cell')].filter((c) => /\\/phpBB2\\/data\\/video\\/77\\/7[123]-/.test(c.dataset.xftUrl || '') && c.querySelectorAll('.xft-vtile img').length).length`);
      if (pv === 3) break;
      await sleep(400);
    }
    check('file-preview video tiles carry the wrapped thumb as poster', pv === 3, 'posters=' + pv);
    // 0.28.1: the INLINE attachment video (no record poster) derives its
    // /data/attachments/ sibling and shows it
    let iv = 0;
    for (let i = 0; i < 30; i++) {
      iv = await ev(cdp, `[...document.querySelectorAll('.xft-cell')].filter((c) => /\\/phpBB2\\/data\\/video\\/78\\/781-/.test(c.dataset.xftUrl || '') && c.querySelectorAll('.xft-vtile img').length).length`);
      if (iv === 1) break;
      await sleep(400);
    }
    check('inline video tile shows the derived sibling poster', iv === 1, 'posters=' + iv);
    // no regression: plain bbWrapper images still collected
    check('bbWrapper images still collected', urls.some((u) => /\/img\/[12]\.png$/.test(u)), JSON.stringify(urls.filter((u) => u.indexOf('/img/') >= 0)));
  } finally {
    try { chrome.kill('SIGKILL'); } catch (e) {} finally { rmSync(TMP, { recursive: true, force: true }); await fx.close(); }
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log(bad ? `\n${bad} FAIL` : '\nALL PASS');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
