// Headless ALBUMS probe against the LOCAL fixture server (0.26.0).
//
//   node tests/albums-headless.mjs
//
// US-001: an album whose expansion resolves to zero children VANISHES from
// the grid (no eternal "album…" tile) while a sibling album with children
// stays and expands. US-002: erome-shaped album pages expand into image +
// video children. US-003: gofile-shaped /d/ SPA albums expand via the
// content API when the host is listed in settings.albumHosts. Requires
// Chrome (headless) + the BUILT bundle. Not part of npm test.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { startFixtureServer, GOFIX_SALT } from './fixture-server.mjs';

const CHROME = '/opt/google/chrome/chrome';
const TMP = '/tmp/xf-albums-' + process.pid;
const PORT = 9431;
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

async function cellUrls(cdp) {
  return ev(cdp, `[...document.querySelectorAll('.xft-cell')].map((c) => c.dataset.xftUrl || '')`);
}

async function main() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP + '/profile', { recursive: true });
  const fx = await startFixtureServer({
    pages: 1, perPage: 2,
    imgUrl: (n) => (n === 1 ? ['/img/1.png'] : n === 2 ? ['/img/2.png'] : null),
    richPosts: (n, albumOrigin) => (n === 1
      ? '<a href="' + albumOrigin + '/a/ab12">album a</a><a href="' + albumOrigin + '/a/empty1">album b</a><a href="' + albumOrigin + '/a/netfail1">album c</a><a href="' + albumOrigin + '/a/bunk1">bunkr album</a>'
      : n === 2
        ? '<a href="' + albumOrigin + '/a/erome1">erome album</a><a href="' + albumOrigin + '/d/gf1">gofile album</a><a href="' + albumOrigin + '/a/cyb1">cyberdrop album</a>'
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
    await cdp.send('Page.navigate', { url: fx.url });
    await sleep(1500);

    await ev(cdp, `localStorage.setItem('xft_xfThreadTools:settings', JSON.stringify({ autoFetch: 0, delayMs: 120, rowCap: 500, chunkSize: 50, albumHosts: ['127.0.0.1'], gofileSalt: ${JSON.stringify(GOFIX_SALT)} })); true`);
    // gofile API origin override: localhost cannot host api.<domain> — the
    // runtime test hook stands in for the derived api.<registrable-domain>
    await ev(cdp, `window.__XFT_GOFILE_API_FOR_TESTS = 'http://127.0.0.1:${fx.albumPort}'; true`);
    const inject = STUB + '\n' + readFileSync(new URL('../xf-thread-tools.user.js', import.meta.url), 'utf8');
    writeFileSync(TMP + '/inject.js', inject);
    const inj = await cdp.send('Runtime.evaluate', { expression: inject });
    if (inj.exceptionDetails) console.log('INJECT EXCEPTION:', JSON.stringify((inj.exceptionDetails.exception || {}).description || '').slice(0, 600));
    await sleep(1500);

    // album anchors ride the fixture (richPosts) — extraction classifies
    // them at boot like real post links
    await ev(cdp, `document.getElementById('xft-edge-btn').click(); true`);
    await sleep(600);

    // ---- US-001: empty album vanishes, sibling stays + expands ----
    // localhost expansions resolve faster than any "before" DOM snapshot
    // could land, so the pre-state is asserted via the CLASSIFICATION
    // record instead: dual-listing keeps a Links row for every album
    // anchor, empty or not
    // switch to the Links tab for the classification assert, then back
    await ev(cdp, `[...document.querySelectorAll('.xft-tab')].find((b) => b.textContent === 'Links').click(); true`);
    await sleep(400);
    const linkRows = await ev(cdp, `[...document.querySelectorAll('.xft-lrow a')].map((a) => a.getAttribute('href') || '').filter((h) => /\\/a\\/ab12$|\\/a\\/empty1$/.test(h))`);
    check('US-001 both album anchors classified (Links rows kept)', linkRows.length >= 2, JSON.stringify(linkRows));
    await ev(cdp, `[...document.querySelectorAll('.xft-tab')].find((b) => b.textContent === 'Media').click(); true`);
    await sleep(400);
    // wait for the empty one to disappear
    let urls = await cellUrls(cdp);
    let gone = false, stayed = false;
    for (let i = 0; i < 60; i++) {
      urls = await cellUrls(cdp);
      gone = !urls.some((u) => /\/a\/empty1$/.test(u));
      stayed = urls.some((u) => /\/a\/ab12$/.test(u));
      if (gone && stayed) break;
      await sleep(400);
    }
    check('US-001 empty album tile removed from grid', gone, JSON.stringify(urls));
    check('US-001 sibling album tile stays', stayed, JSON.stringify(urls));
    // 0.26.1 regression: a NETWORK-level API failure (socket destroyed) is a
    // cooldown failure, not a resolved-empty album — the tile must SURVIVE
    let nfGone = true;
    for (let i = 0; i < 30; i++) {
      urls = await cellUrls(cdp);
      nfGone = !urls.some((u) => /\/a\/netfail1$/.test(u));
      if (!nfGone) break; // tile still there = pass; also give it a beat to (wrongly) drop
      await sleep(300);
    }
    check('US-001 network-failed album tile SURVIVES (cooldown, not empty)', !nfGone, JSON.stringify(urls));
    // the sibling expands: children cells (3 files) appear
    let nKids = 0;
    for (let i = 0; i < 60; i++) {
      urls = await cellUrls(cdp);
      nKids = urls.filter((u) => /\/f\/slug90[123]$/.test(u)).length;
      if (nKids === 3) break;
      await sleep(400);
    }
    check('US-001 sibling album expands to 3 children', nKids === 3, 'kids=' + nKids + ' ' + JSON.stringify(urls));

    // ---- US-002: bunkr albumFiles children render as poster tiles ----
    // 2 media children (mp4 + jpg; the zip is skipped) whose urls are /f/
    // LANDING PAGES with no album-page thumbs: styled tile + og:image poster
    // from the file page — never an <img>/<video> whose src is the page url
    let bKids = 0;
    for (let i = 0; i < 60; i++) {
      urls = await cellUrls(cdp);
      bKids = urls.filter((u) => /\/f\/slug91[12]$/.test(u)).length;
      if (bKids === 2) break;
      await sleep(400);
    }
    check('US-002 bunkr albumFiles album expands to 2 media children', bKids === 2, 'kids=' + bKids + ' ' + JSON.stringify(urls));
    const badSrc = await ev(cdp, `[...document.querySelectorAll('.xft-cell img, .xft-cell video')].filter((e) => /\\/f\\/slug/.test(e.currentSrc || e.src || '')).length`);
    check('US-002 no cell media element uses the /f/ page url as src', badSrc === 0, 'bad=' + badSrc);
    const broken = await ev(cdp, `document.querySelectorAll('.xft-cell.xft-broken, .xft-cell.xft-stalled').length`);
    check('US-002 page-shaped children never enter the broken/stalled path', broken === 0, 'broken=' + broken);
    // posters land async (2-concurrent poster queue + 350ms gaps) — poll
    let posters = 0;
    for (let i = 0; i < 40; i++) {
      posters = await ev(cdp, `[...document.querySelectorAll('.xft-cell')].filter((c) => /\\/f\\/slug91[12]$/.test(c.dataset.xftUrl || '') && c.querySelectorAll('.xft-vtile img').length).length`);
      if (posters === 2) break;
      await sleep(400);
    }
    check('US-002 child tiles show og:image posters', posters === 2, 'posters=' + posters);
    {
      let p911 = 0, p912 = 0;
      for (let i = 0; i < 40; i++) {
        const st = await fx.stats();
        p911 = st['/f/slug911'] || 0;
        p912 = st['/f/slug912'] || 0;
        if (p911 >= 1 && p912 >= 1) break;
        await sleep(400);
      }
      check('US-002 poster page fetched exactly once per child', p911 === 1 && p912 === 1, JSON.stringify({ p911: p911, p912: p912 }));
    }

    // ---- US-003 (0.27): cyberdrop anchors -> per-file info walk ----
    let cImgs = 0, cVid = 0;
    for (let i = 0; i < 60; i++) {
      urls = await cellUrls(cdp);
      cImgs = urls.filter((u) => /\/img\/c[12]\.png$/.test(u)).length;
      cVid = urls.filter((u) => /\/dl\/c3\.mp4/.test(u)).length;
      if (cImgs === 2 && cVid === 1) break;
      await sleep(400);
    }
    check('US-003 cyberdrop album expands to 2 image + 1 video direct children', cImgs === 2 && cVid === 1, 'imgs=' + cImgs + ' vid=' + cVid + ' ' + JSON.stringify(urls));
    // kinds: the images land on the Image sub-tab, the video on Video
    await ev(cdp, `[...document.querySelectorAll('.xft-subtab')].find((b) => /^Image/.test(b.textContent)).click(); true`);
    await sleep(400);
    const imgTabUrls = await cellUrls(cdp);
    const imgOk = imgTabUrls.filter((u) => /\/img\/c[12]\.png$/.test(u)).length === 2;
    await ev(cdp, `[...document.querySelectorAll('.xft-subtab')].find((b) => /^Video/.test(b.textContent)).click(); true`);
    await sleep(400);
    const vidTabUrls = await cellUrls(cdp);
    const vidOk = vidTabUrls.some((u) => /\/dl\/c3\.mp4/.test(u));
    await ev(cdp, `[...document.querySelectorAll('.xft-subtab')].find((b) => /^All/.test(b.textContent)).click(); true`);
    await sleep(400);
    check('US-003 children carry correct kinds (Image tab has both imgs, Video tab the clip)', imgOk && vidOk, 'imgOk=' + imgOk + ' vidOk=' + vidOk);
    {
      let ok3 = false, ladder = false, auth1 = false;
      for (let i = 0; i < 30; i++) {
        const st = await fx.stats();
        ok3 = ['c1', 'c2', 'c3'].every((id) => (st['infook|' + id] || 0) === 1);
        ladder = ['c1', 'c2', 'c3'].every((id) => (st['info403|' + id] || 0) >= 1);
        auth1 = ['c1', 'c2', 'c3'].every((id) => (st['auth|' + id] || 0) === 1);
        if (ok3 && ladder && auth1) break;
        await sleep(400);
      }
      check('US-003 referer ladder: info 403 (forum ref) then 200 (album ref), auth once each', ok3 && ladder && auth1, JSON.stringify(await fx.stats()));
    }

    // ---- US-002: erome-shaped album expands (2 images + highest-res video) ----
    let eImgs = 0, eVid = 0;
    for (let i = 0; i < 60; i++) {
      urls = await cellUrls(cdp);
      eImgs = urls.filter((u) => /\/img\/e[12]\.png$/.test(u)).length;
      eVid = urls.filter((u) => /\/vz\/e1_720p\.mp4$/.test(u)).length;
      if (eImgs === 2 && eVid === 1) break;
      await sleep(400);
    }
    check('US-002 erome album children: 2 images + 1 top-res video', eImgs === 2 && eVid === 1, 'imgs=' + eImgs + ' vid=' + eVid + ' ' + JSON.stringify(urls));
    const lowRes = urls.filter((u) => /e1_360p/.test(u)).length;
    check('US-002 low-res source not listed', lowRes === 0, JSON.stringify(urls));
    // Album sub-tab shows the children grouped (children-only filter)
    await ev(cdp, `[...document.querySelectorAll('.xft-subtab')].find((b) => /^Album/.test(b.textContent)).click(); true`);
    await sleep(500);
    const albumTabUrls = await cellUrls(cdp);
    const onAlbumTab = albumTabUrls.filter((u) => /\/img\/e[12]\.png$/.test(u) || /\/vz\/e1_720p\.mp4$/.test(u) || /\/f\/slug(90[123]|91[12])$/.test(u)).length;
    check('US-002 children visible on the Album sub-tab', onAlbumTab === 8, JSON.stringify(albumTabUrls));
    // 0.26.3: the Album badge counts ALBUMS (distinct containers), not
    // child items — 6 albums here (ab12, erome1, gf1, bunk1, cyb1 + the
    // unexpanded netfail tile) with 14 children. Poll BOTH (cyberdrop's
    // sequential walk may still be mid-flight), then re-snapshot the tab.
    let badge = '';
    let albumTabTotal = 0;
    for (let i = 0; i < 40; i++) {
      badge = await ev(cdp, `[...document.querySelectorAll('.xft-subtab')].find((b) => /^Album/.test(b.textContent)).textContent`);
      albumTabTotal = (await cellUrls(cdp)).length;
      if (badge === 'Album 6' && albumTabTotal === 14) break;
      await sleep(400);
    }
    check('0.26.3 Album badge = album count, not item count', /^Album 6$/.test(badge) && albumTabTotal === 14, 'badge=' + JSON.stringify(badge) + ' items=' + albumTabTotal);
    await ev(cdp, `[...document.querySelectorAll('.xft-subtab')].find((b) => /^All/.test(b.textContent)).click(); true`);
    await sleep(400);

    // ---- US-003: gofile SPA album expands via the content API ----
    let gImgs = 0, gVid = 0, gTile = false;
    for (let i = 0; i < 60; i++) {
      urls = await cellUrls(cdp);
      gImgs = urls.filter((u) => /\/img\/g[12]\.png$/.test(u)).length;
      gVid = urls.filter((u) => /\/vz\/gv\.mp4$/.test(u)).length;
      gTile = urls.some((u) => /\/d\/gf1$/.test(u));
      if (gImgs === 2 && gVid === 1 && gTile) break;
      await sleep(400);
    }
    check('US-003 gofile album expands: tile + 2 image children + 1 video child', gImgs === 2 && gVid === 1 && gTile, 'imgs=' + gImgs + ' vid=' + gVid + ' tile=' + gTile + ' ' + JSON.stringify(urls));
    const stats = await fx.stats();
    check('US-003 guest token POSTed once (session cache)', (stats['POST /accounts'] || 0) === 1, JSON.stringify(stats));
    check('US-003 contents fetched with the token', (stats['/contents/gf1'] || 0) >= 1, JSON.stringify(stats));
    check('US-003 contents call carries Bearer + X-Website-Token hash (0.29 header auth)', (stats['contents-hdr-ok'] || 0) >= 1 && !(stats['contents-hdr-bad'] > 0), JSON.stringify({ ok: stats['contents-hdr-ok'] || 0, bad: stats['contents-hdr-bad'] || 0 }));

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
