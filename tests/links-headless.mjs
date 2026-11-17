// Headless links dual-listing probe against the LOCAL fixture server.
//
//   node tests/links-headless.mjs
//
// One post carries: a cross-host album link (repeated twice — dedup), a
// cross-host /d/ file page, a cross-host image anchor, an ordinary external
// link, plus anchors that must stay dropped (same-host, /members/, external
// post- permalink, non-http). Proves AC-LK-1..4: re-routed media anchors
// keep Links rows, drop rules survive, rows carry the author label, no URL
// appears twice. Requires Chrome (headless) + the BUILT bundle. Not part of
// npm test.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';
import { extractDomain } from '../src/parse.mjs';
import { safeOuterName, sanitizeFileSeg, siteTagFromHost, zipFileName } from '../src/zip.mjs';

const CHROME = '/opt/google/chrome/chrome';
const TMP = '/tmp/xf-links-' + process.pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
}

// Same GM surface as the perf probe
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
      const list = await (await fetch('http://127.0.0.1:9413/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.url === 'about:blank') || list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* endpoint not up yet */ }
    await sleep(250);
  }
  throw new Error('chrome devtools endpoint never came up');
}

async function main() {
  mkdirSync(TMP, { recursive: true });
  const fx = await startFixtureServer({
    pages: 1, perPage: 1,
    imgUrl: (n, pageNo, albumOrigin) => n === 1 ? [
      albumOrigin + '/a/ab12',              // cross-host album -> Media + Links row
      albumOrigin + '/a/ab12',              // duplicate URL -> deduped to one row
      albumOrigin + '/d/xyz',               // cross-host /d/ file page -> Videos + Links row
      albumOrigin + '/ximg/1.png',          // ext-matched cross-host anchor -> Images + Links row
      'https://ext.example/page',           // ordinary external link -> Links row only
      '/img/3.png',                         // same-host media anchor -> Images only, NO row
      'https://ext.example/post-5/',        // external post- permalink -> no row
      'ftp://files.example/f',              // non-http -> no row
      '/members/somebody'                   // members profile -> no row
    ] : null
  });

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate', '--window-size=1400,900',
    `--user-data-dir=${TMP}/profile`, '--remote-debugging-port=9413',
    'about:blank'
  ], { stdio: 'ignore' });
  process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch (e) {} });

  const cdp = await connect(await pageWs());
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: fx.url });
  await sleep(1500);

  await ev(cdp, `localStorage.setItem('xft_xfThreadTools:settings', JSON.stringify({ autoFetch: 1, delayMs: 120, rowCap: 500, forceAnimations: 1, mediaGroup: 'flat' })); true`);
  const inject = STUB + '\n' + readFileSync(new URL('../xf-thread-tools.user.js', import.meta.url), 'utf8');
  writeFileSync(TMP + '/inject.js', inject);
  const inj = await cdp.send('Runtime.evaluate', { expression: inject });
  if (inj.exceptionDetails) console.log('INJECT EXCEPTION:', JSON.stringify((inj.exceptionDetails.exception || {}).description || '').slice(0, 600));
  await sleep(2500);

  await ev(cdp, `document.getElementById('xft-edge-btn').click(); true`);
  await sleep(1200); // album expansion is a queued GM fetch behind the page fetch

  // wait for the album children to land (2 imgs + 1 video + 3 children + album tile = 7)
  let items = -1;
  for (let i = 0; i < 30; i++) {
    items = await ev(cdp, `parseInt(((document.querySelector('#xft-panel .xft-count')||{textContent:''}).textContent.match(/(\\d+)/)||[0,'0'])[1], 10)`);
    if (items >= 7) break;
    await sleep(500);
  }
  check('media items collected (album expanded)', items >= 7, 'items=' + items);

  await ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-tab')].find((b) => b.textContent === 'Links').click(); true`);
  await sleep(600);

  const rows = await ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-lrow .xft-lcell-link a')].map((a) => a.textContent)`);
  const label = await ev(cdp, `((document.querySelector('#xft-panel .xft-lcell-label')||{textContent:''}).textContent)`);
  const counts = new Map();
  for (const r of rows) counts.set(r, (counts.get(r) || 0) + 1);
  const want = (pat) => rows.filter((r) => pat.test(r));
  const albumRows = want(/\/a\/ab12$/);
  const dRows = want(/\/d\/xyz$/);
  const ximgRows = want(/\/ximg\/1\.png$/);
  const pageRows = want(/^https:\/\/ext\.example\/page$/);

  check('AC-LK-1: album link keeps a Links row', albumRows.length === 1, JSON.stringify(rows));
  check('AC-LK-1: /d/ file page keeps a Links row', dRows.length === 1, '');
  check('AC-LK-1: ext-matched media anchor keeps a Links row', ximgRows.length === 1, '');
  check('AC-LK-1: ordinary external link row', pageRows.length === 1, '');

  const bad = rows.filter((r) => /127\.0\.0\.1:\d+\/img\/3\.png$|\/post-5\/$|^ftp:|\/members\//.test(r));
  check('AC-LK-2: same-host / members / post- permalink / non-http stay dropped', bad.length === 0, JSON.stringify(bad));

  check('AC-LK-3: rows carry the author label', /u1/.test(String(label)), JSON.stringify(label));

  const dupes = [...counts.entries()].filter(([, c]) => c > 1);
  check('AC-LK-4: no URL appears twice', dupes.length === 0, JSON.stringify(dupes));

  // ---- Album sub-tab (AC-AB-1/2) ---------------------------------------
  await ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-tab')].find((b) => b.textContent === 'Media').click(); true`);
  await sleep(300);
  await ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-subtab')].find((b) => /^Album/.test(b.textContent)).click(); true`);
  await sleep(1200); // children render + name parsed from the album page <title>
  const albumBtn = await ev(cdp, `(([...document.querySelectorAll('#xft-panel .xft-subtab')].find((b) => /^Album/.test(b.textContent))||{textContent:''}).textContent)`);
  check('AC-AB-1: Album sub-tab shows the child count', /^Album 3/.test(albumBtn), JSON.stringify(albumBtn));
  const heads = await ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-ghead:not(.xft-gsub) .xft-glabel')].map((e) => e.textContent)`);
  const wantHead = '[127.0.0.1:' + fx.albumPort + '] - album  ·  3'; // fixture album page <title>album</title>
  check('AC-AB-2: group header = [host] - [name] + count', heads.length === 1 && heads[0] === wantHead, JSON.stringify(heads) + ' want=' + JSON.stringify(wantHead));
  const albumCells = await ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-cell')].map((c) => c.dataset.xftUrl || '')`);
  const onlyAlbum = albumCells.length === 3 && albumCells.every((u) => /\/f\/slug9\d\d$/.test(u));
  check('AC-AB-2: Album tab lists album children only', onlyAlbum, JSON.stringify(albumCells));

  // ---- album downloads (AC-AB-3/4/5) -----------------------------------
  // capture saves: snapshot blob bytes at click time + in-page zip parser
  await ev(cdp, `(() => {
    window.__xftSaves = [];
    window.__xftSaveParts = [];
    window.__xftZipNames = (ab) => {
      const u = new Uint8Array(ab);
      const dv = new DataView(ab);
      let eocd = -1;
      for (let i = u.length - 22; i >= Math.max(0, u.length - 66000); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error('no EOCD');
      const count = dv.getUint16(eocd + 10, true);
      let off = dv.getUint32(eocd + 16, true);
      const dec = new TextDecoder();
      const names = [];
      for (let i2 = 0; i2 < count; i2++) {
        if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('bad CD sig');
        const nlen = dv.getUint16(off + 28, true);
        const elen = dv.getUint16(off + 30, true);
        const clen = dv.getUint16(off + 32, true);
        names.push(dec.decode(u.subarray(off + 46, off + 46 + nlen)));
        off += 46 + nlen + elen + clen;
      }
      return names;
    };
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download) return;
      const nm = this.download;
      window.__xftSaves.push({ name: nm, url: this.href });
      fetch(this.href).then((r) => r.arrayBuffer()).then((ab) => {
        window.__xftSaveParts.push({ name: nm, ab: ab });
      }).catch(() => {});
    };
    return true;
  })()`);
  const waitRun = async () => {
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      const t = await ev(cdp, `(document.querySelector('#xft-panel .xft-dlstats')||{textContent:''}).textContent`);
      if (/Saved|Stopped|error/.test(t)) return t;
    }
    return 'TIMEOUT';
  };
  const partsOf = async () => {
    let parts = [];
    for (let i = 0; i < 30 && parts.length < (await ev(cdp, `window.__xftSaves.length`)); i++) {
      await sleep(200);
      parts = await ev(cdp, `window.__xftSaveParts.map((p) => ({ name: p.name, entries: window.__xftZipNames(p.ab) }))`);
    }
    return parts;
  };

  // AC-AB-3: per-album header button -> that album only, Pics/+Videos/ inside
  await ev(cdp, `document.querySelector('#xft-panel .xft-dlhead').click(); true`);
  const t3 = await waitRun();
  const albumUrl = 'http://127.0.0.1:' + fx.albumPort + '/a/ab12';
  const wantAlbumZip = safeOuterName('[127.0.0.1:' + fx.albumPort + '] - album') + '.zip';
  const p3 = await partsOf();
  check('AC-AB-3: per-album zip named from the [host] - [name] label',
    p3.length === 1 && p3[0].name === wantAlbumZip, JSON.stringify((p3[0] || {}).name) + ' want=' + JSON.stringify(wantAlbumZip));
  check('AC-AB-3: per-album zip holds exactly that album under Pics/',
    p3.length === 1 && JSON.stringify(p3[0].entries) === JSON.stringify(['Pics/001_slug901.jpg', 'Pics/002_slug902.jpg', 'Pics/003_slug903.jpg']),
    JSON.stringify((p3[0] || {}).entries) + ' stats=' + JSON.stringify(t3));

  // AC-AB-4: main Download on the Album tab -> one archive, folder per album
  await ev(cdp, `document.querySelector('.xft-dlbtn').click(); true`);
  const t4 = await waitRun();
  const wantMainZip = zipFileName(siteTagFromHost('127.0.0.1'), 'fixture thread', '');
  const dirSeg = sanitizeFileSeg(extractDomain(albumUrl) + ' - album');
  const p4 = await partsOf();
  const wantEntries = [1, 2, 3].map((i) => dirSeg + '/Pics/00' + i + '_slug90' + i + '.jpg');
  check('AC-AB-4: Album-tab main download = one zip, per-album folder + Pics/',
    p4.length === 2 && p4[1].name === wantMainZip && JSON.stringify(p4[1].entries) === JSON.stringify(wantEntries),
    JSON.stringify(p4.map((p) => p.name)) + ' want=' + JSON.stringify(wantMainZip) + ' entries=' + JSON.stringify((p4[1] || {}).entries) + ' stats=' + JSON.stringify(t4));

  // AC-AB-5 spot check lives in dl-split-headless (under-cap run = exact
  // 0.20.0 name/structure for All/Image/Video downloads).

  await ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-tab')].find((b) => b.textContent === 'Links').click(); true`);
  await sleep(300);
  const subHidden = await ev(cdp, `document.querySelector('#xft-panel .xft-subtabs').hidden`);
  check('AC-AB-1: sub-tab row hidden off the media tab', subHidden === true, 'hidden=' + subHidden);

  const fails = results.filter((r) => !r.ok).length;
  console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS');
  await fx.close();
  try { chrome.kill('SIGKILL'); } catch (e) {}
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
