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

function postHtml(n, imgs) {
  // image URLs embed as bbImage <img>; page-like URLs (video file-pages,
  // album links) must be plain <a> links — extraction classifies those into
  // videos/albums, while an <img> tag would force image classification
  const inner = imgs.map((u) => /\.(png|gif|bmp|jpe?g|webp|avif)([?#]|$)/i.test(u)
    ? `<a href="${u}" class="js-lbImage"><img src="${u}" class="bbImage" data-url="${u}" alt=""/></a>`
    : `<a href="${u}">${u}</a>`).join('');
  // deterministic per-post reaction counts for the order probe: zero every
  // 4th post, else (n*7)%13 — tests/order-headless.mjs mirrors this
  // formula to know the expected sequences without shipping a fixture file
  const rc = n % 4 === 0 ? 0 : (n * 7) % 13;
  const bar = rc > 0
    ? `<div class="reactionsBar js-reactionsList is-active"><a class="reactionsBar-link">${rc === 1 ? 'u1' : rc === 2 ? 'u1, u2' : 'u1, u2 and ' + (rc - 2) + ' others'}</a></div>`
    : '<div class="reactionsBar js-reactionsList"></div>';
  return `<article class="message message--post" data-content="post-${n}">
    <div class="message-inner"><div class="message-cell">
      <header><a class="username message-name">u${n % 17}</a></header>
      <div class="message-body"><div class="bbWrapper">${inner}</div></div>
      <footer>${bar}</footer>
    </div></div>
  </article>`;
}

export function threadHtml(pages, perPage, imgUrl) {
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
      if (u) out.push(postHtml(n, Array.isArray(u) ? u : [u]));
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

export function startFixtureServer({ pages = 30, perPage = 50, port = 0, imgUrl = null } = {}) {
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
    // og:video absolute URL is what parseVideoPage reads as the carrier
    if (/^\/f\/slug\d+$/.test(u.pathname)) {
      const m = u.pathname.match(/slug(\d+)$/);
      ACAO(res); res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><head><meta property="og:video" content="http://127.0.0.1:' + albumPort + '/dl/' + (m ? m[1] : '1') + '.jpg?b=2000"></head><body>file page</body></html>');
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
    res.statusCode = 404; res.end('nope');
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
    const pm = u.pathname.match(/^\/threads\/777\/(?:page-(\d+))?\/?$/);
    if (pm) {
      ACAO(res); res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(page(Math.min(pages, parseInt(pm[1] || '1', 10))));
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
    page = threadHtml(pages, perPage, (n, p) => (imgUrl || mixImg)(n, p, 'http://127.0.0.1:' + albumPort));
    return {
      port: mp,
      albumPort: ap,
      url: `http://127.0.0.1:${mp}/threads/777/`,
      stats: async () => { try { return await (await fetch(`http://127.0.0.1:${mp}/__stats`)).json(); } catch (e) { return {}; } },
      reset: () => fetch(`http://127.0.0.1:${mp}/__reset`).then(() => {}),
      close: () => Promise.all([new Promise((r) => server.close(r)), new Promise((r) => albumHost.close(r))])
    };
  });
}
