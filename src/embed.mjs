// embed: Pure video-host carriers: embed poster parse, sign-endpoint URL/response shapes, view-API parse, video file-page carrier parse, /v/ /f/ /d/ URL shapes. (split from the single-file userscript; see scripts/modules.json)
// Embed-page poster extractor: given the HTML of a video-host /embed/ page,
// pull a thumbnail URL. Hosts expose og:image / og:image:secure_url, plyr
// players carry data-poster, plain players a poster= attribute. Decodes the
// common HTML entities attribute values arrive with. '' when nothing found.
export function parseEmbedPoster(html) {
  const h = String(html || '');
  if (!h) return '';
  const dec = (s) => s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const pats = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /data-poster=["']([^"']+)["']/i,
    /<video[^>]+poster=["']([^"']+)["']/i
  ];
  for (const re of pats) {
    const m = h.match(re);
    if (m && /^https?:\/\//i.test(m[1])) return dec(m[1]);
  }
  return '';
}

// Sign-endpoint builder for embed URLs: hosts running the turbo-style
// player expose <origin>/api/sign?v=<ID> next to their /embed/<ID> pages,
// returning {success, url} where url is a time-limited direct mp4. ''
// when the URL is not that shape — caller keeps the iframe player.
export function embedSignUrl(u) {
  try {
    const url = new URL(String(u || ''), 'https://x.invalid');
    if (!/^https?:$/.test(url.protocol)) return '';
    const m = url.pathname.match(/\/embed\/([^/?#]+)/);
    if (!m) return '';
    return url.origin + '/api/sign?v=' + encodeURIComponent(m[1]);
  } catch (e) { return ''; }
}

// Sign-response parser: {url, exp} on success (exp parsed from the signed
// URL's ?exp= seconds), null on anything else.
export function parseSignResponse(text) {
  try {
    const j = JSON.parse(String(text || ''));
    if (j && j.success && typeof j.url === 'string' && /^https?:\/\//.test(j.url)) {
      const m = j.url.match(/[?&]exp=(\d+)/);
      return { url: j.url, exp: m ? parseInt(m[1], 10) : 0 };
    }
  } catch (e) { /* not JSON / error page */ }
  return null;
}

// Token-sign parser (bunkr-style sign endpoints answer {token, ex}, and the
// caller appends ?token=&ex= to the unsigned CDN url themselves).
export function parseSignToken(text) {
  try {
    const j = JSON.parse(String(text || ''));
    if (j && typeof j.token === 'string' && j.token && j.ex) {
      return { token: j.token, exp: parseInt(j.ex, 10) || 0 };
    }
  } catch (e) { /* not JSON / error page */ }
  return null;
}

// Public-view API builder for short-slug file pages: the page's own player
// script POSTs <origin>/v2/api/public/view {file_slug} and receives
// {success, server, file, token, expires_in} — a time-limited direct URL.
// ''-shaped null when the URL is not that shape.
export function embedViewApiUrl(u) {
  try {
    const url = new URL(String(u || ''), 'https://x.invalid');
    if (!/^https?:$/.test(url.protocol)) return null;
    if (!isFileDPageUrl(url.href)) return null;
    return { url: url.origin + '/v2/api/public/view', slug: url.pathname.split('/').pop() };
  } catch (e) { return null; }
}

// Public-view API response parser: builds the signed CDN stream url from
// {success, server, file, token, expires_in}. `file` is locked to a single
// path segment (no slashes) so a hostile page cannot aim the stream URL
// elsewhere on the CDN's origin. null on anything else.
export function parseViewApiResponse(text, now) {
  try {
    const j = JSON.parse(String(text || ''));
    if (j && j.success === true && typeof j.token === 'string' && j.token
      && typeof j.file === 'string' && /^\w[\w.-]*$/.test(j.file)
      && typeof j.server === 'string' && /^https?:\/\//.test(j.server)) {
      return { url: j.server + '/v2/' + j.file + '?token=' + encodeURIComponent(j.token), exp: (now | 0) + (parseInt(j.expires_in, 10) || 0) };
    }
  } catch (e) { /* not JSON / error page */ }
  return null;
}

// File-page carrier parser: given the HTML of a host's /v/ or /f/ page,
// find the direct media. Carriers, in trust order:
//   1. jsCDN + signUrl vars (bunkr family) — unsigned CDN url + a sign
//      endpoint that must be called with ?path=<pathname> first
//   2. og:video / og:video:secure_url meta
//   3. <video src> / <source src> absolute http
// Returns {src, sign} | {src} | null.
export function parseVideoPage(html) {
  const h = String(html || '');
  if (!h) return null;
  const unesc = (s) => s.replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  const cdn = h.match(/var\s+jsCDN\s*=\s*"([^"]+)"/);
  const sgn = h.match(/var\s+signUrl\s*=\s*"([^"]+)"/);
  if (cdn && /^https?:\/\//.test(unesc(cdn[1]))) {
    if (sgn && /^https?:\/\//.test(unesc(sgn[1]))) return { src: unesc(cdn[1]), sign: unesc(sgn[1]) };
    return { src: unesc(cdn[1]) };
  }
  const og = h.match(/<meta[^>]+property=["']og:video(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/i)
    || h.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::secure_url|:url)?["']/i);
  if (og && /^https?:\/\//i.test(og[1])) return { src: unesc(og[1]) };
  const st = h.match(/<source[^>]+src=["'](https?:\/\/[^"']+)["']/i)
    || h.match(/<video[^>]+src=["'](https?:\/\/[^"']+)["']/i);
  if (st) return { src: unesc(st[1]) };
  return null;
}

// Short-slug file pages (path /d/<slug>, no extension): hosts whose landing
// page ships a player script plus a JSON token endpoint instead of any
// carrier in the HTML. Slugs are 3-64 url-safe chars; a dot or a second
// path segment means a real file path, not this shape.
export function isFileDPageUrl(u) {
  const s = String(u || '');
  if (!/^https?:\/\//i.test(s)) return false;
  const path = s.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
  return /^\/d\/[A-Za-z0-9_-]{3,64}$/.test(path);
}

// Videos-tab URLs that are actually host file PAGES (the .mp4-looking path
// 403s or serves HTML as a direct <video> src) — these resolve through a
// sign endpoint or page parse before playback. /v/<name>.mp4 and
// /f/<something> are bunkr-style file pages, /d/<slug> the short-slug
// token-endpoint kind; extension-bearing URLs elsewhere are real direct files.
export function isVideoPageUrl(u) {
  const s = String(u || '');
  if (!/^https?:\/\//i.test(s)) return false;
  const path = s.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
  return /^\/v\/[^/]+\.(mp4|webm|mkv|mov|m4v)$/i.test(path) || /^\/f\/[^/]+$/i.test(path) || isFileDPageUrl(s);
}

