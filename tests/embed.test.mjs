// Unit tests for the embed module (src/embed.mjs). Regrouped to mirror the src/ split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedSignUrl, embedViewApiUrl, isFileDPageUrl, isVideoPageUrl, parseEmbedPoster, parseSignResponse, parseSignToken, parseVideoPage, parseViewApiResponse } from '../src/embed.mjs';


// ---- parseEmbedPoster (embed-page og:image / data-poster extraction) ----
test('parseEmbedPoster: og:image, reversed attr order, data-poster, poster attr', () => {
  const og = '<meta property="og:image" content="https://static.example/uuid/thumbs/abc.jpg">';
  assert.equal(parseEmbedPoster(og), 'https://static.example/uuid/thumbs/abc.jpg');
  // attribute order flipped by the host's renderer
  const ogRev = '<meta content="https://static.example/uuid/thumbs/abc.jpg" property="og:image">';
  assert.equal(parseEmbedPoster(ogRev), 'https://static.example/uuid/thumbs/abc.jpg');
  // plyr-style data-poster on the video element
  assert.equal(parseEmbedPoster('<video data-poster="https://cdn.example/p.jpg">'), 'https://cdn.example/p.jpg');
  // plain poster attribute, entity-encoded ampersand in the URL
  assert.equal(parseEmbedPoster('<video poster="https://cdn.example/p?a=1&amp;b=2">'), 'https://cdn.example/p?a=1&b=2');
  // secure_url variant wins over plain og:image
  assert.equal(parseEmbedPoster('<meta property="og:image" content="http://a.example/x.jpg">'
    + '<meta property="og:image:secure_url" content="https://a.example/x.jpg">'), 'https://a.example/x.jpg');
});

test('parseEmbedPoster: no poster, non-http values, garbage input', () => {
  assert.equal(parseEmbedPoster('<html><body>no meta here</body></html>'), '');
  // data: URIs are not usable as cell thumbs
  assert.equal(parseEmbedPoster('<meta property="og:image" content="data:image/png;base64,AAAA">'), '');
  assert.equal(parseEmbedPoster(''), '');
  assert.equal(parseEmbedPoster(null), '');
  assert.equal(parseEmbedPoster(undefined), '');
});

// ---- embedSignUrl / parseSignResponse (direct-stream adapter) ----
test('embedSignUrl: /embed/ID shape -> origin api/sign; everything else empty', () => {
  assert.equal(embedSignUrl('https://embed.example.com/embed/abc123'),
    'https://embed.example.com/api/sign?v=abc123');
  assert.equal(embedSignUrl('https://embed.example.com/embed/abc123?x=1'),
    'https://embed.example.com/api/sign?v=abc123');
  // ID is encoded, not pasted raw
  assert.equal(embedSignUrl('https://h.example/embed/a/b'), 'https://h.example/api/sign?v=a');
  assert.equal(embedSignUrl('https://example.com/watch/abc'), '');
  assert.equal(embedSignUrl(''), '');
  assert.equal(embedSignUrl(null), '');
});

test('parseSignResponse: success shape, \\u0026 unescaping, exp capture, rejects', () => {
  const hit = parseSignResponse('{"success":true,"url":"https://cdn.example/d/f.mp4?exp=1793347834\\u0026token=abc"}');
  assert.equal(hit.url, 'https://cdn.example/d/f.mp4?exp=1793347834&token=abc');
  assert.equal(hit.exp, 1793347834);
  // no exp param -> 0, caller applies a short default
  const noExp = parseSignResponse('{"success":true,"url":"https://cdn.example/d/f.mp4"}');
  assert.equal(noExp.url, 'https://cdn.example/d/f.mp4');
  assert.equal(noExp.exp, 0);
  // failures
  assert.equal(parseSignResponse('{"success":false}'), null);
  assert.equal(parseSignResponse('<html>challenge</html>'), null);
  assert.equal(parseSignResponse(''), null);
  assert.equal(parseSignResponse(null), null);
});

// ---- parseSignToken / parseVideoPage / isVideoPageUrl (file-page route) ----
test('parseSignToken: bunkr-style {token, ex}; rejects other shapes', () => {
  const hit = parseSignToken('{"ex":1793358356,"token":"083587a093769d9fe3e91d1d3013aa9fb089bfaa"}');
  assert.equal(hit.token, '083587a093769d9fe3e91d1d3013aa9fb089bfaa');
  assert.equal(hit.exp, 1793358356);
  assert.equal(parseSignToken('{"success":true,"url":"https://x/f.mp4"}'), null);
  assert.equal(parseSignToken('{}'), null);
  assert.equal(parseSignToken(''), null);
  assert.equal(parseSignToken(null), null);
});

test('parseVideoPage: jsCDN+signUrl carrier (escaped slashes), og:video, source tag', () => {
  // bunkr-style inline vars — values come JSON-escaped in the page
  const bunkr = 'var jsCDN = "https:\\/\\/c4ta-b.cdn.cr\\/storage\\/media\\/a.mp4";'
    + 'var signUrl = "https:\\/\\/glb-apisign.cdn.cr\\/sign";';
  const hit = parseVideoPage(bunkr);
  assert.equal(hit.src, 'https://c4ta-b.cdn.cr/storage/media/a.mp4');
  assert.equal(hit.sign, 'https://glb-apisign.cdn.cr/sign');
  // jsCDN without signUrl: unsigned carrier
  assert.deepEqual(parseVideoPage('var jsCDN = "https:\\/\\/cdn.example\\/a.mp4";'), { src: 'https://cdn.example/a.mp4' });
  // og:video meta
  assert.deepEqual(parseVideoPage('<meta property="og:video" content="https://cdn.example/v.mp4">'), { src: 'https://cdn.example/v.mp4' });
  // <source> tag
  assert.deepEqual(parseVideoPage('<video><source src="https://cdn.example/s.mp4" type="video/mp4"></video>'), { src: 'https://cdn.example/s.mp4' });
  // nothing
  assert.equal(parseVideoPage('<html>plain page</html>'), null);
  assert.equal(parseVideoPage(''), null);
  assert.equal(parseVideoPage(null), null);
});

test('isVideoPageUrl: /v/<name>.mp4 and /f/<x> are pages; direct files and forum URLs are not', () => {
  assert.equal(isVideoPageUrl('https://h.example/v/clip-Ab12.mp4'), true);
  assert.equal(isVideoPageUrl('https://h.example/v/clip-Ab12.mp4?x=1'), true);
  assert.equal(isVideoPageUrl('https://h.example/f/some-File9Z.mp4'), true);
  assert.equal(isVideoPageUrl('https://h.example/f/aB3xY9'), true);
  assert.equal(isVideoPageUrl('https://h.example/d/wyFagpq'), true);
  assert.equal(isVideoPageUrl('https://cdn.example/data/attachments/video.mp4'), false);
  assert.equal(isVideoPageUrl('https://h.example/embed/abc123'), false);
  assert.equal(isVideoPageUrl('https://voz.example/threads/some.3871/'), false);
  assert.equal(isVideoPageUrl(''), false);
  assert.equal(isVideoPageUrl(null), false);
});

// ---- isFileDPageUrl / embedViewApiUrl / parseViewApiResponse (short-slug token route) ----
test('isFileDPageUrl: /d/<slug> short-slug shape only', () => {
  // the real shapes (domain rotation gg/me covered by shape, not name)
  assert.equal(isFileDPageUrl('https://filester-shaped.example/d/wyFagpq'), true);
  assert.equal(isFileDPageUrl('https://filester-shaped.example/d/wyFagpq?ref=1'), true);
  assert.equal(isFileDPageUrl('https://filester-shaped.example/d/a_b-C9'), true);
  // not this shape: longer paths, dots, wrong prefix, non-http
  assert.equal(isFileDPageUrl('https://h.example/d/wyFagpq/extra'), false);
  assert.equal(isFileDPageUrl('https://h.example/d/file.mp4'), false);
  assert.equal(isFileDPageUrl('https://h.example/d/ab'), false); // 2-char slug
  assert.equal(isFileDPageUrl('https://h.example/download/wyFagpq'), false);
  assert.equal(isFileDPageUrl('ftp://h.example/d/wyFagpq'), false);
  assert.equal(isFileDPageUrl(''), false);
  assert.equal(isFileDPageUrl(null), false);
});

test('embedViewApiUrl: /d/<slug> -> origin /v2/api/public/view + slug; else null', () => {
  assert.deepEqual(embedViewApiUrl('https://h.example/d/wyFagpq'),
    { url: 'https://h.example/v2/api/public/view', slug: 'wyFagpq' });
  // query string is not part of the slug
  assert.equal(embedViewApiUrl('https://h.example/d/wyFagpq?x=1').slug, 'wyFagpq');
  // non-/d/ shapes never build an endpoint (no stray POSTs to other hosts)
  assert.equal(embedViewApiUrl('https://h.example/embed/abc123'), null);
  assert.equal(embedViewApiUrl('https://h.example/f/aB3xY9'), null);
  assert.equal(embedViewApiUrl('https://cdn.example/v/a.mp4'), null);
  assert.equal(embedViewApiUrl(''), null);
  assert.equal(embedViewApiUrl(null), null);
});

test('parseViewApiResponse: {success,server,file,token,expires_in} -> signed url + exp', () => {
  const j = { success: true, file: '15e21e87-8427-4394-9a5e-8fe19304208b.mp4',
    server: 'https://fsc3.cdn.example', token: 'deadbeef', expires_in: 1800 };
  const hit = parseViewApiResponse(JSON.stringify(j), 1000);
  assert.equal(hit.url, 'https://fsc3.cdn.example/v2/15e21e87-8427-4394-9a5e-8fe19304208b.mp4?token=deadbeef');
  assert.equal(hit.exp, 2800);
  // token url-encoded when it carries reserved chars
  const hit2 = parseViewApiResponse(JSON.stringify({ success: true, file: 'a.mp4', server: 'https://s.cdn', token: 'a+b&c', expires_in: 60 }), 0);
  assert.equal(hit2.url, 'https://s.cdn/v2/a.mp4?token=a%2Bb%26c');
  // expires_in missing -> exp = now (treated as immediately stale)
  assert.equal(parseViewApiResponse(JSON.stringify({ success: true, file: 'a.mp4', server: 'https://s.cdn', token: 't' }), 500).exp, 500);
  // rejects: not success, missing pieces, file with slashes, relative server
  assert.equal(parseViewApiResponse(JSON.stringify({ success: false, file: 'a.mp4', server: 'https://s.cdn', token: 't' }), 0), null);
  assert.equal(parseViewApiResponse(JSON.stringify({ success: true, server: 'https://s.cdn', token: 't' }), 0), null);
  assert.equal(parseViewApiResponse(JSON.stringify({ success: true, file: '../other/a.mp4', server: 'https://s.cdn', token: 't' }), 0), null);
  assert.equal(parseViewApiResponse(JSON.stringify({ success: true, file: 'a.mp4', server: 's.cdn', token: 't' }), 0), null);
  assert.equal(parseViewApiResponse('not json', 0), null);
  assert.equal(parseViewApiResponse('', 0), null);
  assert.equal(parseViewApiResponse(null, 0), null);
});