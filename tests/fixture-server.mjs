// Local fixture server for the headless perf/cells probes — zero npm deps.
// Serves XF-shaped thread pages (/threads/777/, /threads/777/page-N) with a
// configurable media mix, plus deterministic preview images:
//   /img/<n>.png    tiny 64x48 PNG (shared bytes, unique URLs)
//   /big/<n>.bmp    4000x3000 BMP (36 MB, shared bytes — decode-cost fixture)
//   /anim.gif       8x8 4-frame animated GIF (hand-rolled GIF89a)
// half the /img/ URLs carry Cache-Control: no-store — the thumb cache must
// make CDN cache policy irrelevant.
// Counters: every image request bumps per-URL counts; GET /__stats returns
// them, GET /__reset zeroes them. Structure-only — no real site involved.
import http from 'node:http';

// every response carries ACAO *: the probe's GM shim implements GM fetches
// with plain fetch (real Tampermonkey bypasses CORS), so cross-origin fixture
// hosts (the album server) must allow it
const ACAO = (res) => res.setHeader('access-control-allow-origin', '*');
import zlib from 'node:zlib';
import { crc32 } from '../src/zip.mjs';
import { gofileWebsiteToken } from '../src/media.mjs';

// shared salt for the 0.29 gofile X-Website-Token check: the probe injects
// it as settings.gofileSalt, this server verifies against it
export const GOFIX_SALT = 'xft-fix-salt-029';

export function tinyPng() {
  // 200x150 (above the 140px sticker-retire gate), one 8-bit RGB row pattern; bytes are shared by every /img/<n>.png
  const W = 200, H = 150;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const o = row + 1 + x * 3;
      raw[o] = (x * 4) & 255; raw[o + 1] = (y * 5) & 255; raw[o + 2] = 120;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

export function bigBmp(w = 4000, h = 3000) {
  // 24-bit BMP, bottom-up rows, banded gradient — the decode-cost fixture
  const row = w * 3;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(54 + row * h, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) {
    const base = 54 + y * row;
    const band = Math.floor((y * 8) / h) * 32;
    for (let x = 0; x < w; x++) {
      const o = base + x * 3;
      buf[o] = (band + (x & 63)) & 255;         // B
      buf[o + 1] = (y & 255);                   // G
      buf[o + 2] = (band + 128) & 255;          // R
    }
  }
  return buf;
}

// verified animated GIF (48x48, 6 solid-color frames, 20ms, loop forever) —
// generated once with Pillow and embedded so the fixture stays zero-dep at runtime.
// Chrome animates it in an <img>; createImageBitmap yields frame 0 for stills.
const ANIM_GIF_B64 =
  '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';
export function animGif() { return Buffer.from(ANIM_GIF_B64, 'base64'); }

function postHtml(n, imgs, reactCounts = null, richHtml = null, attachHtml = null) {
  // image URLs embed as bbImage <img>; page-like URLs (video file-pages,
  // album links) must be plain <a> links — extraction classifies those into
  // videos/albums, while an <img> tag would force image classification
  const inner = imgs.map((u) => /\.(png|gif|bmp|jpe?g|webp|avif)([?#]|$)/i.test(u)
    ? `<a href="${u}" class="js-lbImage"><img src="${u}" class="bbImage" data-url="${u}" alt=""/></a>`
    : `<a href="${u}">${u}</a>`).join('');
  // deterministic per-post reaction counts for the order probe: zero every
  // 4th post, else (n*7)%13 — tests/order-headless.mjs mirrors this
  // formula to know the expected sequences without shipping a fixture file.
  // reactCounts(n) override (sorter probe): returns a count or null; big
  // counts render XF's thousands-separated others-phrase ("and 1,007
  // others") exactly like the live 1000+ posts that broke sorting
  const ov = reactCounts ? reactCounts(n) : null;
  const rc = ov === null || ov === undefined ? (n % 4 === 0 ? 0 : (n * 7) % 13) : ov;
  const fmt = (v) => v.toLocaleString('en-US');
  const bar = rc > 0
    ? `<div class="reactionsBar js-reactionsList is-active"><a class="reactionsBar-link">${rc === 1 ? 'u1' : rc === 2 ? 'u1, u2' : 'u1, u2 and ' + fmt(rc - 2) + ' others'}</a></div>`
    : '<div class="reactionsBar js-reactionsList"></div>';
  return `<article class="message message--post" data-content="post-${n}">
    <div class="message-inner"><div class="message-cell"><div class="message-main js-quickEditTarget">
      <header><a class="username message-name">u${n % 17}</a></header>
      <div class="message-body"><div class="bbWrapper">${inner}${richHtml || ''}</div>${attachHtml || ''}</div>
      <footer>${bar}</footer>
    </div></div></div>
  </article>`;
}

export function threadHtml(pages, perPage, imgUrl, reactCounts = null, richPosts = null, attachPosts = null) {
  let n = 1;
  const nav = Array.from({ length: pages }, (_, i) =>
    i === 0 ? `<span class="pageNav-page pageNav-page--current">1</span>`
      : `<a href="/threads/777/page-${i + 1}" class="pageNav-page">${i + 1}</a>`).join('');
  const navs = `<nav class="pageNav"><div class="pageNav-inner">${nav}</div></nav>`;
  const body = (pageNo) => {
    const out = [];
    for (let k = 0; k < perPage; k++, n++) {
      const u = imgUrl(n, pageNo);
      // array return = multi-anchor post (links-probe fixtures)
      if (u) out.push(postHtml(n, Array.isArray(u) ? u : [u], reactCounts, richPosts ? richPosts(n) : null, attachPosts ? attachPosts(n) : null));
    }
    return out.join('\n');
  };
  // page 1 renders first (with the mix items), remaining pages on demand
  const pagesHtml = [];
  for (let p = 1; p <= pages; p++) pagesHtml.push(body(p));
  return (pageNo) => `<!doctype html><html id="XF" data-template="thread_view" lang="en">
<head><meta charset="utf-8"><title>fixture thread</title></head>
<body><div class="p-body"><div class="p-body-inner">
<h1 class="p-title-value">fixture thread</h1>
<div class="pageContent">${navs}</div>
<div class="block">${pagesHtml[pageNo - 1]}</div>
</div></div></body></html>`;
}

// XF-shaped search result page for the replies lookup (0.25.0): rows carry
// the stock contentRow anatomy the parser and the cloned feature select on.
function searchHtml(k, ids) {
  const rows = ids.map((id2, i2) =>
    `<li class="block-row block-row--separated js-inlineModContainer" data-author="u${id2 % 17}">
      <div class="contentRow"><div class="contentRow-main">
        <h3 class="contentRow-title"><a href="/threads/777/post-${id2}/">fixture thread</a></h3>
        <div class="contentRow-minor"><time class="u-dt" datetime="2026-01-0${id2 % 9 + 1}T0${id2 % 9}:1${id2 % 9}:00+00:00" data-time-string="0${id2 % 9}:11" dir="auto">Jan ${id2 % 9 + 1}, 2026</time></div>
        <div class="contentRow-snippet">re: post-${k} &amp; agreed${i2 === 0 ? ' see https://example.net/x' : ''}</div>
      </div></div>
    </li>`).join('');
  return `<!doctype html><html lang="en"><head><title>Search</title></head><body>
  <div class="block"><div class="block-container"><ol class="block-body">${rows}</ol></div></div>
  </body></html>`;
}

export function startFixtureServer({ pages = 30, perPage = 50, port = 0, imgUrl = null, reactCounts = null, richPosts = null, attachPosts = null } = {}) {
  const png = tinyPng();
  const bmp = bigBmp();
  const gif = animGif();
  const hits = new Map(); // url -> count
  // thumb-traffic timing log (per-request wall clock, both origins) for the
  // net-throttle probe: { p: path, o: 'main'|'album', s: startMs, e: endMs }
  const tl = [];
  const logTl = (res, u, origin) => {
    const rec = { p: u.pathname, o: origin, s: Date.now(), e: 0 };
    tl.push(rec);
    res.on('finish', () => { rec.e = Date.now(); });
  };
  const sendDelayed = (res, d, bytes) => {
    if (d > 0) setTimeout(() => res.end(bytes), d);
    else res.end(bytes);
  };
  // second origin for the album host: album classification is CROSS-HOST
  // only (a forum's own /a/ routes must never expand), so the album page
  // needs its own port
  let mainPort = 0, albumPort = 0;
  const albumHost = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    // CORS preflight (0.26 US-003): probe GM stubs are plain fetch — a
    // cross-origin JSON POST (guest-account token) sends OPTIONS first
    if (req.method === 'OPTIONS') {
      ACAO(res);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-website-token,x-bl,referer');
      res.statusCode = 204;
      res.end();
      return;
    }
    // cross-host media anchor for the links probe: a real PNG on the OTHER
    // origin — ext-matched anchor dual-lists (Links row + Media item)
    if (u.pathname.startsWith('/ximg/')) {
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      logTl(res, u, 'album');
      ACAO(res); res.setHeader('content-type', 'image/png');
      sendDelayed(res, parseInt(u.searchParams.get('d') || '0', 10) || 0, png);
      return;
    }
    // direct bytes for album-child downloads (the /f/ page's og:video
    // carrier points here): padded PNG, deterministic size
    if (u.pathname.startsWith('/dl/')) {
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'image/png');
      const want = parseInt(u.searchParams.get('b') || '0', 10) || png.length;
      res.end(want > png.length ? Buffer.concat([png, Buffer.alloc(want - png.length)]) : png);
      return;
    }
    // album-child file pages (/f/<slug> resolved against the album origin):
    // og:video absolute URL is what parseVideoPage reads as the carrier;
    // og:image (0.27) is what the album-child poster tile reads (MAIN
    // origin — the album host serves /ximg/, not /img/)
    if (/^\/f\/slug\d+$/.test(u.pathname)) {
      const m = u.pathname.match(/slug(\d+)$/);
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><head><meta property="og:image" content="http://127.0.0.1:' + mainPort + '/img/' + (m ? m[1] : '901') + '.png"><meta property="og:video" content="http://127.0.0.1:' + albumPort + '/dl/' + (m ? m[1] : '1') + '.jpg?b=2000"></head><body>file page</body></html>');
      return;
    }
    // 0.27 US-002: bunkr-shaped album page — the .theItem grid is GONE, the
    // file list ships as a window.albumFiles JS array (2 media + 1 archive);
    // /f/<slug> children have no album-page thumbs (poster from the file
    // page's og:image)
    if (u.pathname === '/a/bunk1') {
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'text/html; charset=utf-8');
      const items = [
        "  id: 1, name: \"b3f0.mp4\",\n  original: 'clip \\'01\\'.mp4',\n  slug: 'slug911', size: 1048576 ,\n  timestamp: \"12:00:00 01/01/2026\"\n",
        "  id: 2, name: \"aa11.jpg\",\n  original: 'photo 02.jpg',\n  slug: 'slug912', size: 2048 ,\n  timestamp: \"12:00:01 01/01/2026\"\n",
        "  id: 3, name: \"cc33.zip\",\n  original: 'bundle.zip',\n  slug: 'slug913', size: 4096 ,\n  timestamp: \"12:00:02 01/01/2026\"\n"
      ];
      res.end('<!doctype html><html><head><title>bunkr album</title></head><body><div id="app"></div><script>window.albumFiles = [{' + items.join('},\n{') + '}];</script></body></html>');
      return;
    }
    // 0.27 US-003: cyberdrop-shaped album — server-rendered id="file" /f/
    // anchors; direct urls via the per-file info API (info -> auth hop).
    // The info endpoint is REFERER-WALLED: 403 unless the request carries
    // the ALBUM origin as referer (first GM attempt sends the forum page
    // referer -> 403 -> the ladder retries with the album origin -> 200).
    if (u.pathname === '/a/cyb1') {
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><head><title>cyb album</title></head><body>'
        + '<a id="file" href="/f/c1">f1</a><a href="/f/c2" id="file">f2</a><a id="file" href="/f/c3">f3</a>'
        + '</body></html>');
      return;
    }
    if (/^\/api\/file\/info\/c[123]$/.test(u.pathname)) {
      const id = u.pathname.split('/').pop();
      const ref = req.headers.referer || '';
      // cross-origin fetch DOWNGRADES an explicit referrer to origin-only
      // (strict-origin-when-cross-origin) — accept both forms
      const albumOk = ref === 'http://127.0.0.1:' + albumPort || ref.indexOf('http://127.0.0.1:' + albumPort + '/') === 0;
      hits.set((albumOk ? 'infook|' : 'info403|') + id, (hits.get((albumOk ? 'infook|' : 'info403|') + id) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'application/json');
      if (!albumOk) { res.statusCode = 403; res.end('{"error":"forbidden"}'); return; }
      const meta = {
        c1: { filename: 'pic-one.jpg', auth_url: 'http://127.0.0.1:' + albumPort + '/auth/c1' },
        c2: { filename: 'pic-two.jpg', auth_url: 'http://127.0.0.1:' + albumPort + '/auth/c2' },
        c3: { filename: 'clip.mp4', auth_url: 'http://127.0.0.1:' + albumPort + '/auth/c3' }
      }[id];
      res.end(JSON.stringify(meta));
      return;
    }
    if (/^\/auth\/c[123]$/.test(u.pathname)) {
      const id = u.pathname.split('/').pop();
      hits.set('auth|' + id, (hits.get('auth|' + id) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'application/json');
      const direct = {
        c1: 'http://127.0.0.1:' + mainPort + '/img/c1.png',
        c2: 'http://127.0.0.1:' + mainPort + '/img/c2.png',
        c3: 'http://127.0.0.1:' + albumPort + '/dl/c3.mp4?b=2500'
      }[id];
      res.end(JSON.stringify({ url: direct }));
      return;
    }
    if (u.pathname === '/a/ab12') {
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'text/html; charset=utf-8');
      const main = 'http://127.0.0.1:' + mainPort;
      // hrefs RELATIVE (/f/<slug> — the parser's carrier regex anchors on the
      // leading slash), thumbs ABSOLUTE (parser keeps absolute srcs only)
      const items = [901, 902, 903].map((i2) =>
        '<div class="theItem"><a title="img' + i2 + '.jpg" href="/f/slug' + i2 + '"><img src="' + main + '/img/' + i2 + '.png"></a></div>').join('');
      res.end('<!doctype html><html><head><title>album</title></head><body>' + items + '</body></html>');
      return;
    }
    // 0.26 US-001: an album page with NO item markers at all — expansion
    // resolves EMPTY and the tile must vanish (and its /api/albums/<id>
    // fallback 404s like a host without a JSON API)
    if (u.pathname === '/a/empty1') {
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><head><title>empty album</title></head><body><div class="media-group-none"></div></body></html>');
      return;
    }
    // 0.26.1 regression: network-level failure on the API walk (socket
    // destroyed mid-flight) must NOT resolve the album empty — the tile
    // stays on cooldown+retry
    if (u.pathname === '/a/netfail1') {
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><head><title>netfail album</title></head><body></body></html>');
      return;
    }
    if (u.pathname === '/api/albums/netfail1') {
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      try { res.destroy(); } catch (e) { try { res.socket.destroy(); } catch (e2) {} }
      return;
    }
    // 0.26 US-002: erome-shaped server-rendered album (lightboxes: div.img
    // data-src originals; videos with res-labelled sources + poster)
    if (u.pathname === '/a/erome1') {
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'text/html; charset=utf-8');
      const main = 'http://127.0.0.1:' + mainPort;
      const img = (f) => '<div class="media-group" id="i' + f + '"><div class="img" data-src="' + main + '/img/e' + f + '.png"><div class="img-box"><img class="img-front" src="' + main + '/img/e' + f + '.png"></div></div></div>';
      const vid = '<div class="media-group" id="v1"><div class="img" data-html="#video1"></div>' +
        '<div class="video-lg" id="video1"><video poster="' + main + '/img/e9.png"><source src="' + main + '/vz/e1_720p.mp4" type=\'video/mp4\' label=\'HD\' res=\'720\'><source src="' + main + '/vz/e1_360p.mp4" type=\'video/mp4\' label=\'SD\' res=\'360\'></video></div>' +
        '<div class="video"><video poster="' + main + '/img/e9.png"><source src="' + main + '/vz/e1_720p.mp4" type=\'video/mp4\' label=\'HD\' res=\'720\'></video></div></div>';
      res.end('<!doctype html><html><head><title>erome-shaped album</title></head><body>' + img(1) + img(2) + vid + '</body></html>');
      return;
    }
    // 0.26 US-003: gofile-shaped SPA album — empty shell page, guest-token
    // accounts endpoint, contents API with a children map (one folder child
    // the parser must skip)
    if (u.pathname === '/d/gf1') {
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><head><title>gf</title></head><body><div id="app"></div><script src="/assets/app.js"></script></body></html>');
      return;
    }
    if (u.pathname === '/accounts' && req.method === 'POST') {
      hits.set('POST /accounts', (hits.get('POST /accounts') || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'application/json');
      res.end('{"status":"ok","data":{"id":"acc1","tier":"guest","token":"fixture-token"}}');
      return;
    }
    if (u.pathname === '/contents/gf1') {
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'application/json');
      // 0.29 header auth: Bearer guest token + X-Website-Token hash of
      // UA::lang::token::4h-bucket::salt (bucket ±1 tolerated against clock
      // skew between page and server)
      const auth = req.headers.authorization || '';
      const xwt = req.headers['x-website-token'] || '';
      const xbl = req.headers['x-bl'] || 'en-US';
      const ua = req.headers['user-agent'] || '';
      const win = Math.floor(Date.now() / 1000 / 14400);
      const want = (w) => gofileWebsiteToken(ua, xbl, 'fixture-token', w * 14400, GOFIX_SALT);
      const authOk = auth === 'Bearer fixture-token' && (xwt === want(win) || xwt === want(win - 1) || xwt === want(win + 1));
      hits.set(authOk ? 'contents-hdr-ok' : 'contents-hdr-bad', (hits.get(authOk ? 'contents-hdr-ok' : 'contents-hdr-bad') || 0) + 1);
      if (!authOk) { res.statusCode = 401; res.end('{"status":"error-token","data":{}}'); return; }
      const main = 'http://127.0.0.1:' + mainPort;
      res.end(JSON.stringify({ status: 'ok', data: { id: 'gf1', name: 'gofile album', type: 'folder', children: {
        i1: { id: 'i1', name: 'g1.png', type: 'file', mimetype: 'image/png', link: main + '/img/g1.png' },
        i2: { id: 'i2', name: 'g2.png', type: 'file', mimetype: 'image/png', link: main + '/img/g2.png' },
        v1: { id: 'v1', name: 'gv.mp4', type: 'file', mimeType: 'video/mp4', link: main + '/vz/gv.mp4' },
        d1: { id: 'd1', name: 'sub', type: 'folder', link: 'https://app.example.io/d/sub' }
      } } }));
      return;
    }
    ACAO(res); res.statusCode = 404; res.end('nope'); // ACAO: cross-origin 404 status must be readable (real GM XHR ignores CORS)
  });
  let id = 0;
  const mixImg = (n) => {
    const m = id++;
    if (m >= 60 && m < 64) return '/big/' + m + '.bmp';   // huge decodes on page 2 (past the live page's native imgs)
    if (m === 110 || m === 111) return '/anim.gif';       // two gif cells on page 3 (same URL: coalescing probe)
    if (m === 200) return '/v/clip1.mp4';                 // video file-PAGE: og:image poster tile
    if (m === 201) return 'http://127.0.0.1:' + albumPort + '/a/ab12'; // cross-host album: 3 thumb children
    return '/img/' + n + '.png';
  };
  let page = null; // built once both ports are known (album URLs are absolute)
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/__stats') {
      ACAO(res); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Object.fromEntries(hits)));
      return;
    }
    if (u.pathname === '/__reset') { hits.clear(); tl.length = 0; res.end('ok'); return; }
    if (u.pathname === '/__tl') {
      ACAO(res); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(tl));
      return;
    }
    // download-probe files: deterministic byte size (?b=) — real PNG bytes
    // then zero padding (decoders stop at IEND, downloads/sniff don't care).
    // Hit key is Range-tagged ('dl|' prefix): download attempts probe with
    // a Range header, cell thumb fetches do not — the probe counts policy
    // retries from download hits only.
    if (u.pathname.startsWith('/dl/') || u.pathname.startsWith('/dldead/')) {
      hits.set((req.headers.range ? 'dl|' : '') + u.pathname, (hits.get((req.headers.range ? 'dl|' : '') + u.pathname) || 0) + 1);
      ACAO(res);
      if (u.pathname.startsWith('/dldead/')) { res.statusCode = /500/.test(u.pathname) ? 500 : 404; res.end('dead'); return; }
      const want = parseInt(u.searchParams.get('b') || '0', 10) || png.length;
      res.setHeader('content-type', 'image/png');
      res.end(want > png.length ? Buffer.concat([png, Buffer.alloc(want - png.length)]) : png);
      return;
    }
    // 0.26.4 referer-wall: 403 ANY request carrying a Referer, serve the
    // bytes no-referer — the scdn-family shape. Downloads must retry
    // without the forum referer after the first 403.
    if (u.pathname.startsWith('/dlref/')) {
      const k = (req.headers.referer ? 'wall403|' : 'wallok|') + (req.headers.range ? 'dl|' : '') + u.pathname;
      hits.set(k, (hits.get(k) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'image/png');
      if (req.headers.referer) { res.statusCode = 403; res.end('referer wall'); return; }
      const want = parseInt(u.searchParams.get('b') || '0', 10) || png.length;
      res.end(want > png.length ? Buffer.concat([png, Buffer.alloc(want - png.length)]) : png);
      return;
    }
    // subpath-install attachment thumbs (/phpBB2/data/attachments/…): the
    // attachmentList <img> render 404s otherwise — png bytes, no hit counting
    // (the extractor never scans it)
    if (u.pathname.startsWith('/phpBB2/data/attachments/')) {
      ACAO(res); res.setHeader('content-type', 'image/png');
      res.end(png);
      return;
    }
    if (u.pathname.startsWith('/img/') || u.pathname.startsWith('/big/') || u.pathname === '/anim.gif') {
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      if (u.pathname.startsWith('/img/')) logTl(res, u, 'main'); // thumb-traffic timing only for /img/
      const noStore = /\/img\/\d*[13579]\.png$/.test(u.pathname); // odd-numbered tiny urls
      ACAO(res); res.setHeader('content-type', u.pathname.endsWith('.bmp') ? 'image/bmp' : u.pathname.endsWith('.gif') ? 'image/gif' : 'image/png');
      if (noStore) res.setHeader('cache-control', 'no-store');
      const d = parseInt(u.searchParams.get('d') || '0', 10) || 0;
      sendDelayed(res, d, u.pathname.startsWith('/big/') ? bmp : u.pathname === '/anim.gif' ? gif : png);
      return;
    }
    const pm = u.pathname.match(/^\/(?:phpBB2\/)?threads\/777\/(?:page-(\d+))?\/?$/);
    if (pm) {
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(page(Math.min(pages, parseInt(pm[1] || '1', 10))));
      return;
    }
    // replies lookup (0.25.0): XF search shape q=post-<id>&t=post&c[thread]
    // — deterministic answers: post K is quoted by K+1 and K+2 when they
    // exist; the K+1 row carries a URL in its snippet to exercise the
    // DOM-safe linkifier. No pager => single result page.
    if (u.pathname === '/search/1/') {
      const q = u.searchParams;
      const m2 = (q.get('q') || '').match(/^post-(\d+)$/);
      const k = m2 ? parseInt(m2[1], 10) : 0;
      const total = pages * perPage;
      const ids = k > 0 ? [k + 1, k + 2].filter((id2) => id2 <= total) : [];
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(searchHtml(k, ids));
      return;
    }
    // video file-page: og:image poster (absolute — parseEmbedPoster keeps only http(s) srcs)
    if (u.pathname === '/v/clip1.mp4') {
      hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
      ACAO(res); res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><head><meta property="og:image" content="http://' + req.headers.host + '/img/900.png"></head><body>video page</body></html>');
      return;
    }
    res.statusCode = 404; res.end('nope');
  });
  const listen = (srv, p) => new Promise((r) => srv.listen(p, '127.0.0.1', () => r(srv.address().port)));
  return Promise.all([listen(server, port), listen(albumHost, 0)]).then(([mp, ap]) => {
    mainPort = mp;
    albumPort = ap;
    page = threadHtml(pages, perPage, (n, p) => (imgUrl || mixImg)(n, p, 'http://127.0.0.1:' + albumPort), reactCounts, richPosts ? (n) => richPosts(n, 'http://127.0.0.1:' + albumPort) : null, attachPosts);
    return {
      port: mp,
      albumPort: ap,
      url: `http://127.0.0.1:${mp}/threads/777/`,
      searchHits: () => hits.get('/search/1/') || 0,
      stats: async () => { try { return await (await fetch(`http://127.0.0.1:${mp}/__stats`)).json(); } catch (e) { return {}; } },
      reset: () => fetch(`http://127.0.0.1:${mp}/__reset`).then(() => {}),
      close: () => Promise.all([new Promise((r) => server.close(r)), new Promise((r) => albumHost.close(r))])
    };
  });
}
