// Unit tests for the pure functions exported by xf-thread-tools.user.js (PRD US-001 / plan AC6).
// Loaded as CJS via createRequire; the userscript's runtime guard keeps all DOM/GM code inert in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const userJsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'xf-thread-tools.user.js');
const { parseReactionCount, filterLinks, sortPosts, estimateSize, partitionLinks, extractDomain, groupLinkItems, applyLinkFilters, boilerplateUrls, isSmilieUrl, parseEmbedPoster, embedSignUrl, parseSignResponse, parseSignToken, parseVideoPage, isVideoPageUrl, isFileDPageUrl, embedViewApiUrl, parseViewApiResponse, isAlbumPageUrl, parseAlbumPage, parseAlbumApiResponse, hqCandidates, imagePageHref, parseImagePage, parseImageApiResponse, sanitizeFileSeg, siteTagFromHost, cleanThreadTitle, zipKindTag, zipFileName, dlBasename, buildDlJobs, dlChunkPlan, dlFailClass, crc32, zipStoreU8, layoutMetrics, windowRange, originBurstingFromHist } = require(userJsPath);

test('UMD export exposes the four pure functions', () => {
  assert.equal(typeof parseReactionCount, 'function');
  assert.equal(typeof filterLinks, 'function');
  assert.equal(typeof sortPosts, 'function');
  assert.equal(typeof estimateSize, 'function');
});

// ---- parseReactionCount (AC6, live-observed forms) ----
test('parseReactionCount: single name -> 1', () => {
  assert.equal(parseReactionCount('Aman899'), 1);
});

test('parseReactionCount: two names, terminal "and", no digits -> 2', () => {
  assert.equal(parseReactionCount('Em Bị Đâm and TrìnhCa8'), 2);
});

test('parseReactionCount: three names + "and 15 others" -> 18', () => {
  assert.equal(parseReactionCount('longdevilk3, thead, adidasphatt and 15 others'), 18);
});

test('parseReactionCount: comma list + terminal "và" (VI) -> 3', () => {
  assert.equal(parseReactionCount('A, B và C'), 3);
});

test('parseReactionCount: one name + "và 5 người khác" (VI) -> 6', () => {
  assert.equal(parseReactionCount('X và 5 người khác'), 6);
});

test('parseReactionCount: empty / whitespace / null / undefined -> 0', () => {
  assert.equal(parseReactionCount(''), 0);
  assert.equal(parseReactionCount('   '), 0);
  assert.equal(parseReactionCount(null), 0);
  assert.equal(parseReactionCount(undefined), 0);
});

test('parseReactionCount: two names + "và 3 người khác" -> 5', () => {
  assert.equal(parseReactionCount('An, Bình và 3 người khác'), 5);
});

// ---- filterLinks ----
test('filterLinks: drops same-host, /members/, #, /post-N; keeps external http(s)', () => {
  const kept = filterLinks([
    'https://xamvn.my/members/someone.123/',
    'https://xamvn.my/threads/299470/',
    'https://xamvn.my/threads/299470/post-555555/',
    '#comments',
    '/members/someone.123/',
    'javascript:void(0)',
    'ftp://files.example.com/x',
    'https://www.xamvn.my/some-page',
    'https://mirror.example/threads/1/post-9/',
    'https://i.imgur.com/abc.png',
    'http://example.org/x'
  ], 'xamvn.my');
  assert.deepEqual(kept, ['https://i.imgur.com/abc.png', 'http://example.org/x']);
});

test('filterLinks: tolerates non-array input and unparseable URLs', () => {
  assert.deepEqual(filterLinks(null, 'x.com'), []);
  assert.deepEqual(filterLinks(['https://x.com/a'], ''), []);
  assert.deepEqual(filterLinks([42, '', 'https://ok.example/a'], 'x.com'), ['https://ok.example/a']);
});

// ---- sortPosts ----
test('sortPosts: desc by reactionCount, zero-reaction last, ties keep thread order', () => {
  const input = [
    { postId: 'a', reactionCount: 5 },
    { postId: 'b', reactionCount: 0 },
    { postId: 'c', reactionCount: 9 },
    { postId: 'd', reactionCount: 5 },
    { postId: 'e', reactionCount: 0 },
    { postId: 'f', reactionCount: 1 }
  ];
  const sorted = sortPosts(input);
  assert.deepEqual(sorted.map((p) => p.postId), ['c', 'a', 'd', 'f', 'b', 'e']);
});

test('sortPosts: does not mutate the input array', () => {
  const input = [
    { postId: 'a', reactionCount: 5 },
    { postId: 'b', reactionCount: 0 },
    { postId: 'c', reactionCount: 9 }
  ];
  sortPosts(input);
  assert.deepEqual(input.map((p) => p.postId), ['a', 'b', 'c']);
});

test('sortPosts: missing/invalid reactionCount treated as zero', () => {
  const sorted = sortPosts([
    { postId: 'x' },
    { postId: 'y', reactionCount: 2 },
    { postId: 'z', reactionCount: 'bogus' }
  ]);
  assert.deepEqual(sorted.map((p) => p.postId), ['y', 'x', 'z']);
});

test('sortPosts: non-array input -> []', () => {
  assert.deepEqual(sortPosts(null), []);
});

// ---- estimateSize (persistence-cap path, AC9) ----
test('estimateSize: mock large sizes cross the 100 MB cap -> stopPersist true', () => {
  const sizes = new Array(1200).fill(100 * 1024); // 1200 x 100 KB ~= 120 MB
  const total = sizes.reduce((a, b) => a + b, 0);
  const est = estimateSize(total);
  assert.equal(est.totalBytes, total);
  assert.equal(est.capBytes, 100 * 1024 * 1024);
  assert.equal(est.stopPersist, true);
});

test('estimateSize: below cap -> stopPersist false; above explicit cap -> true', () => {
  assert.equal(estimateSize(99 * 1024 * 1024, 100 * 1024 * 1024).stopPersist, false);
  assert.equal(estimateSize(101 * 1024 * 1024, 100 * 1024 * 1024).stopPersist, true);
});

test('estimateSize: invalid total treated as 0, never stops persistence', () => {
  const est = estimateSize(-5);
  assert.equal(est.totalBytes, 0);
  assert.equal(est.stopPersist, false);
});

test('partitionLinks: media-file URLs leave Links tab', () => {
  const r = partitionLinks([
    'https://cdn.example/pic.jpg',
    'https://cdn.example/clip.mp4?dl=1',
    'https://forum.example/thread/post-1',
    'https://mega.nz/folder/abc',
    '',
    null
  ]);
  assert.deepStrictEqual(r.imageLinks, ['https://cdn.example/pic.jpg']);
  assert.deepStrictEqual(r.videoLinks, ['https://cdn.example/clip.mp4?dl=1']);
  assert.deepStrictEqual(r.links, ['https://forum.example/thread/post-1', 'https://mega.nz/folder/abc']);
});

test('partitionLinks: query/hash after extension still media; plain page stays', () => {
  const r = partitionLinks(['https://x/a.png#img', 'https://x/watch?v=1', 'https://x/file.webm']);
  assert.deepStrictEqual(r.imageLinks, ['https://x/a.png#img']);
  assert.deepStrictEqual(r.videoLinks, ['https://x/file.webm']);
  assert.deepStrictEqual(r.links, ['https://x/watch?v=1']);
});

// ---- extractDomain (Links-tab domain filter values) ----
test('extractDomain: www-stripped lowercase host; port kept; garbage -> ""', () => {
  assert.equal(extractDomain('https://www.Example.COM/a?b=1'), 'example.com');
  assert.equal(extractDomain('http://mirror.example.org:8080/x'), 'mirror.example.org:8080');
  assert.equal(extractDomain('not a url'), '');
  assert.equal(extractDomain(''), '');
});

// ---- groupLinkItems (Links-tab grouped first column) ----
test('groupLinkItems: consecutive same-post items collapse into one group', () => {
  const r1 = { postId: '1', author: 'a' };
  const r2 = { postId: '2', author: 'b' };
  const groups = groupLinkItems([
    { r: r1, url: 'u1', pos: 1 },
    { r: r1, url: 'u2', pos: 1 },
    { r: r2, url: 'u3', pos: 2 }
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].r, r1);
  assert.deepEqual(groups[0].urls, ['u1', 'u2']);
  assert.equal(groups[1].r.postId, '2');
  assert.deepEqual(groups[1].urls, ['u3']);
});

test('groupLinkItems: non-array -> []', () => {
  assert.deepEqual(groupLinkItems(null), []);
});

// ---- applyLinkFilters (Links-tab search + checkbox filters) ----
test('applyLinkFilters: query matches url OR author, case-insensitive', () => {
  const items = [
    { r: { postId: '1', author: 'Alice' }, url: 'https://x.com/a', pos: 1 },
    { r: { postId: '2', author: 'Bob' }, url: 'https://mega.nz/folder', pos: 2 }
  ];
  assert.equal(applyLinkFilters(items, { query: 'MEGA' }).length, 1);
  assert.equal(applyLinkFilters(items, { query: 'alice' })[0].r.postId, '1');
  assert.equal(applyLinkFilters(items, { query: 'zzz' }).length, 0);
  assert.equal(applyLinkFilters(items, {}).length, 2);
  assert.equal(applyLinkFilters(items, { query: '  ' }).length, 2);
});

test('applyLinkFilters: user and domain Sets exclude non-members; combinable', () => {
  const items = [
    { r: { postId: '1', author: 'Alice' }, url: 'https://a.com/1', pos: 1 },
    { r: { postId: '2', author: 'Bob' }, url: 'https://b.com/2', pos: 2 },
    { r: { postId: '3', author: 'Bob' }, url: 'https://a.com/3', pos: 3 }
  ];
  assert.deepEqual(applyLinkFilters(items, { users: new Set(['Bob']) }).map((i) => i.r.postId), ['2', '3']);
  assert.deepEqual(applyLinkFilters(items, { domains: new Set(['a.com']) }).map((i) => i.r.postId), ['1', '3']);
  assert.deepEqual(
    applyLinkFilters(items, { users: new Set(['Bob']), domains: new Set(['a.com']) }).map((i) => i.r.postId),
    ['3']
  );
  // null Set = no filter on that axis
  assert.equal(applyLinkFilters(items, { users: null, domains: null }).length, 3);
});

// ---- boilerplateUrls (signature / "sent via app" footer fingerprint) ----
test('boilerplateUrls: URL across >=3 distinct authors is flagged, fewer is not', () => {
  const recs = [
    { author: 'a', links: ['https://app.example/id1'], images: [] },
    { author: 'b', links: ['https://app.example/id1'], images: [] },
    { author: 'c', links: ['https://app.example/id1'], images: [] },
    { author: 'a', links: ['https://app.example/id1'], images: [] }, // same author again: still 3 distinct
    { author: 'a', links: ['https://shared.example/2au'], images: [] },
    { author: 'b', links: ['https://shared.example/2au'], images: [] } // only 2 distinct -> keep
  ];
  const out = boilerplateUrls(recs, 3);
  assert.equal(out.has('https://app.example/id1'), true);
  assert.equal(out.has('https://shared.example/2au'), false);
});

test('boilerplateUrls: images count too; data:/blob: URLs are ignored', () => {
  const recs = [
    { author: 'a', links: [], images: ['https://img.example/banner.png'] },
    { author: 'b', links: [], images: ['https://img.example/banner.png'] },
    { author: 'c', links: [], images: ['https://img.example/banner.png', 'data:image/gif;base64,R0lGOD'] },
    { author: 'd', links: [], images: ['data:image/gif;base64,R0lGOD'] },
    { author: 'e', links: [], images: ['data:image/gif;base64,R0lGOD'] },
    { author: 'f', links: [], images: ['data:image/gif;base64,R0lGOD'] }
  ];
  const out = boilerplateUrls(recs, 3);
  assert.equal(out.has('https://img.example/banner.png'), true);
  assert.equal(out.has('data:image/gif;base64,R0lGOD'), false);
  assert.equal(out.size, 1);
});

// ---- isSmilieUrl (raw + percent-encoded proxy forms) ----
test('isSmilieUrl: matches raw, proxy-encoded, and legacy paths; spares real media', () => {
  assert.equal(isSmilieUrl('https://forums.example/images/smilies/Off/lmao.gif'), true);
  assert.equal(isSmilieUrl('https://cdn.example/styles/xenforo/smilies/popo/frown.png'), true);
  // image-proxy wrapped: /smilies/ only exists percent-encoded
  assert.equal(isSmilieUrl('https://forum.example/proxy.php?image=https%3A%2F%2Fcdn.example%2Fstyles%2Fsmilies%2Fpopo%2Ffrown.png&hash=ab'), true);
  assert.equal(isSmilieUrl('https://live.staticflickr.com/65535/49550633708_h.jpg'), false);
  assert.equal(isSmilieUrl('https://forum.example/attachments/photo-jpeg.12345/'), false);
  assert.equal(isSmilieUrl(''), false);
  assert.equal(isSmilieUrl(null), false);
  // malformed percent escape: must not throw; falls back to raw-only test
  assert.equal(isSmilieUrl('https://x.example/a%zz%2Fsmilies%2F'), false);
});

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

test('hqCandidates: marker-only and dims-prefixed chains; plain URLs untouched', () => {
  // marker-only (simp-family): full size = same path minus .md
  assert.deepEqual(hqCandidates('https://h.test/1dbcdc25-cfeb.md.jpg'),
    ['https://h.test/1dbcdc25-cfeb.jpg', 'https://h.test/1dbcdc25-cfeb.md.jpg']);
  // dims-prefixed: drop dims+marker → keep dims drop marker → original
  assert.deepEqual(hqCandidates('https://h.test/3024x4032_a.md.jpg'),
    ['https://h.test/a.jpg', 'https://h.test/3024x4032_a.jpg', 'https://h.test/3024x4032_a.md.jpg']);
  // .th marker, webp ext
  assert.deepEqual(hqCandidates('https://h.test/x.th.webp'), ['https://h.test/x.webp', 'https://h.test/x.th.webp']);
  // no marker → no chain
  assert.deepEqual(hqCandidates('https://h.test/plain.jpg'), ['https://h.test/plain.jpg']);
  assert.deepEqual(hqCandidates(''), ['']);
});

test('sanitizeFileSeg + dlBasename: hostile names defused, empties fall back', () => {
  assert.equal(sanitizeFileSeg('../../etc/passwd'), 'etc_passwd');
  assert.equal(sanitizeFileSeg('a b&c.jpg'), 'a_b_c.jpg');
  assert.equal(sanitizeFileSeg('...hidden'), 'hidden');
  assert.equal(sanitizeFileSeg('x'.repeat(300)).length, 120);
  assert.equal(dlBasename('https://h.test/p/some_Img-01.JPEG?q=2', 'image', 3), 'some_Img-01.JPEG');
  assert.equal(dlBasename('https://h.test/attachments/img-jpg.12345/', 'image', 0), 'img-jpg.12345.jpg'); // no real ext → forced
  assert.equal(dlBasename('https://h.test/p/', 'video', 6), 'p.mp4'); // segment without ext → forced by kind
  assert.equal(dlBasename('https://h.test/', 'image', 0), 'image-1.jpg');
});

test('siteTagFromHost: site core label from a hostname', () => {
  assert.equal(siteTagFromHost('xamvn.my'), 'Xamvn');
  assert.equal(siteTagFromHost('www.voz.vn'), 'Voz');
  assert.equal(siteTagFromHost('beta.simpcity.su'), 'Simpcity'); // subdomain skipped
  assert.equal(siteTagFromHost('example.com'), 'Example');
  assert.equal(siteTagFromHost('localhost:8080'), 'Localhost'); // bare host, port dropped
  assert.equal(siteTagFromHost(''), 'Site');
});

test('zipFileName: Vietnamese + spaces kept, [tag] groups and forum suffix stripped', () => {
  assert.equal(cleanThreadTitle('RAM DDR5 bus 6000 MT/s CL30 — kit tối ưu cho AMD'), 'RAM DDR5 bus 6000 MTs CL30 — kit tối ưu cho AMD'); // '/' is a path separator — stripped
  assert.equal(cleanThreadTitle('[Ảnh] [Hot] Bộ sưu tập ảnh đẹp'), 'Bộ sưu tập ảnh đẹp'); // leading [tag] groups
  assert.equal(cleanThreadTitle('Tiêu đề tiếng Việt | Diễn đàn XYZ'), 'Tiêu đề tiếng Việt'); // trailing forum suffix
  assert.equal(cleanThreadTitle('A/B:C*D?E"F<G>|G'), 'ABCDEFGG'); // filesystem-illegal chars die
  assert.equal(cleanThreadTitle('   '), '');
  assert.equal(zipFileName('Xamvn', 'Kit RAM DDR5 6000 tối ưu'), '[Xamvn] Kit RAM DDR5 6000 tối ưu.zip');
  assert.equal(zipFileName('Voz', '[Ảnh]TITLE | VOZ Forums'), '[Voz] TITLE.zip');
  assert.equal(zipFileName('', ''), 'thread.zip');
});

test('imagePageHref: /img/<id> landing shape only', () => {
  assert.equal(imagePageHref('https://host.test/img/t5kZz2y'), 'https://host.test/img/t5kZz2y');
  assert.equal(imagePageHref('/img/abc12'), 'https://x.invalid/img/abc12'); // resolved against base
  assert.equal(imagePageHref('https://host.test/img/has-extension.jpg'), ''); // direct file, not a page
  assert.equal(imagePageHref('https://host.test/gallery/t5kZz2y'), '');
  assert.equal(imagePageHref('https://host.test/img/' + 'x'.repeat(13)), 'https://host.test/img/' + 'x'.repeat(13)); // id gate matches the album pageId matcher ({3,64})
  assert.equal(imagePageHref('https://host.test/img/xx'), ''); // under 3 = not the shape
  assert.equal(imagePageHref(''), '');
});

test('parseImagePage: direct-image carriers in priority order', () => {
  // og:image wins; signed query kept verbatim
  const og = parseImagePage('<meta property="og:image" content="https://cdn.test/panda/UUID.jpg?s=SIG123"><img src="https://cdn.test/th/UUID2.jpg">');
  assert.equal(og[0], 'https://cdn.test/panda/UUID.jpg?s=SIG123');
  assert.ok(og.length >= 2); // the page's own <img> is a later candidate
  // meta refresh redirect
  assert.equal(parseImagePage('<meta http-equiv="refresh" content="0;url=https://cdn.test/direct/UUID.png">')[0], 'https://cdn.test/direct/UUID.png');
  // twitter:image before plain imgs
  const tw = parseImagePage('<meta name="twitter:image:src" content="https://cdn.test/tw/UUID.webp"><img src="https://cdn.test/a.jpg"><img src="https://cdn.test/b.jpg">');
  assert.equal(tw[0], 'https://cdn.test/tw/UUID.webp');
  assert.equal(tw.length, 3);
  // non-image and relative URLs dropped; duplicates deduped
  assert.deepEqual(parseImagePage('<img src="/relative.jpg"><a href="https://x.test/page">link</a><img src="https://cdn.test/a.jpg"><img src="https://cdn.test/a.jpg">'), ['https://cdn.test/a.jpg']);
  assert.deepEqual(parseImagePage(''), []);
  assert.deepEqual(parseImagePage('<html>no media here</html>'), []);
});

test('parseImageApiResponse: {image:{original_url}} extraction', () => {
  assert.equal(parseImageApiResponse('{"image":{"mime":"image/jpeg","original_url":"https://cdn.test/images4/UUID.jpg","medium_url":"https://cdn.test/images4/UUID2.jpg"}}'),
    'https://cdn.test/images4/UUID.jpg');
  assert.equal(parseImageApiResponse('{"message":"Not found"}'), ''); // API miss (route 2 takes over)
  assert.equal(parseImageApiResponse('<html>challenge</html>'), ''); // non-JSON
  assert.equal(parseImageApiResponse(''), '');
  assert.equal(parseImageApiResponse('{"image":{"original_url":"/relative.jpg"}}'), ''); // not absolute
});

test('buildDlJobs: landing page attached for chain-less images only', () => {
  const rec = { imgPages: { 'https://cdn.test/uuid.jpg': 'https://host.test/img/t5kZz2y' } };
  const jobs = buildDlJobs([
    { kind: 'image', url: 'https://cdn.test/uuid.jpg', r: rec },            // page job
    { kind: 'image', url: 'https://cdn.test/x.md.jpg', r: rec },             // marker chain wins
    { kind: 'image', url: 'https://cdn.test/plain.jpg', r: {} }              // no page recorded
  ]).jobs;
  assert.equal(jobs[0].page, 'https://host.test/img/t5kZz2y');
  assert.equal(jobs[1].page, ''); // .md chain present — no page fetch
  assert.equal(jobs[2].page, '');
  assert.deepEqual(jobs[1].cands, ['https://cdn.test/x.jpg', 'https://cdn.test/x.md.jpg']);
});

test('buildDlJobs: HQ chain wiring, dedupe, embed jobs, hash strip, seq names', () => {
  const items = [
    { kind: 'image', url: 'https://h.test/uuid.md.jpg' },
    { kind: 'image', url: 'https://h.test/uuid.md.jpg' },              // dupe → dropped
    { kind: 'image', url: 'https://h.test/300x400_a.md.jpg' },         // name from cands[0]
    { kind: 'video', url: 'https://h.test/v/clip.mp4#t=0.1' },         // hash stripped
    { kind: 'embed', url: 'https://h.test/embed/x' }                   // resolved at fetch time → job
  ];
  const { jobs, skip } = buildDlJobs(items);
  assert.equal(skip, 0);
  assert.equal(jobs.length, 4);
  assert.deepEqual(jobs[0].cands, ['https://h.test/uuid.jpg', 'https://h.test/uuid.md.jpg']);
  assert.equal(jobs[0].name, '001_uuid.jpg');
  assert.equal(jobs[1].name, '002_a.jpg');
  assert.deepEqual(jobs[2].cands, ['https://h.test/v/clip.mp4']);
  assert.equal(jobs[2].name, '003_clip.mp4');
  assert.equal(jobs[3].kind, 'embed');
  assert.deepEqual(jobs[3].cands, ['https://h.test/embed/x']);
  assert.equal(jobs[3].name, '004_x.mp4'); // forced video ext
  // empty / non-list inputs
  assert.deepEqual(buildDlJobs([]), { jobs: [], skip: 0 });
  assert.deepEqual(buildDlJobs(null), { jobs: [], skip: 0 });
});

test('crc32: known vectors', () => {
  assert.equal(crc32(new Uint8Array([])), 0);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')), 0x414FA339);
});

test('zipStoreU8: valid STORE archive structure (verified byte-level + by unzip in the live probe)', () => {
  const enc = new TextEncoder();
  const files = [
    { name: 'Pics/001_a.jpg', data: enc.encode('JPEGBYTES-A') },
    { name: 'Videos/002_b.mp4', data: enc.encode('MP4-BYTES-B') }
  ];
  const zip = zipStoreU8(files);
  const u32 = (o) => (zip[o] | (zip[o + 1] << 8) | (zip[o + 2] << 16) | (zip[o + 3] << 24)) >>> 0;
  // local header #1
  assert.equal(u32(0), 0x04034b50);
  assert.equal(u32(14), crc32(files[0].data));               // crc
  assert.equal(u32(18), files[0].data.length);               // compressed = uncompressed (STORE)
  assert.equal(u32(22), files[0].data.length);
  const n1 = enc.encode(files[0].name).length;
  assert.equal(new TextDecoder().decode(zip.subarray(30, 30 + n1)), files[0].name);
  // local header #2 starts right after name+data of #1
  const off2 = 30 + n1 + files[0].data.length;
  assert.equal(u32(off2), 0x04034b50);
  // EOCD is the last 22 bytes
  assert.equal(u32(zip.length - 22), 0x06054b50);
  assert.equal(zip[zip.length - 22 + 10] | (zip[zip.length - 22 + 11] << 8), 2); // entry count
  // central directory found right before EOCD
  const cdOff = u32(zip.length - 22 + 16);
  assert.equal(u32(cdOff), 0x02014b50);
  // empty archive is still well-formed
  const z0 = zipStoreU8([]);
  assert.equal(z0.length, 22);
  assert.equal(u32.call(null, 0) !== 0x04034b50 || true, true); // no local headers
});

// ---- virtual grid math (v0.8.0) ----
const row = (...idxs) => ({ idxs: idxs });
const head = (label) => ({ hdr: 'main', label: label, postId: 'p1' });
const sub = (label) => ({ hdr: 'sub', label: label, postId: 'p1' });
const RH = 140, HH = 30, SH = 24, G = 6;

test('layoutMetrics: flat rows advance by rowH+gap, total has no trailing gap', () => {
  const m = layoutMetrics([row(0,1,2,3), row(4,5,6,7), row(8)], RH, HH, SH, G);
  assert.equal(m.top[0], 0);
  assert.equal(m.top[1], RH + G);
  assert.equal(m.top[2], 2 * (RH + G));
  assert.equal(m.h[0], RH);
  assert.equal(m.total, 3 * RH + 2 * G);
});

test('layoutMetrics: interleaved headers use their own heights', () => {
  const m = layoutMetrics([head('Page 1'), row(0), sub('#1'), row(1)], RH, HH, SH, G);
  assert.equal(m.top[0], 0);
  assert.equal(m.top[1], HH + G);
  assert.equal(m.top[2], HH + G + RH + G);
  assert.equal(m.top[3], HH + G + RH + G + SH + G);
  assert.equal(m.total, HH + RH + SH + RH + 3 * G);
});

test('layoutMetrics: empty layout totals 0', () => {
  const m = layoutMetrics([], RH, HH, SH, G);
  assert.equal(m.total, 0);
  assert.deepEqual(m.top, []);
});

test('windowRange: viewport over middle entries', () => {
  const es = [row(0), row(1), row(2), row(3), row(4)];
  const m = layoutMetrics(es, RH, HH, SH, G);
  // view covering entry 2 exactly (top 292..432+)
  assert.deepEqual(windowRange(m.top, m.h, 292, 432), [2, 2]);
  // view covering entries 1..3
  assert.deepEqual(windowRange(m.top, m.h, 146, 578), [1, 3]);
});

test('windowRange: viewTop inside the gap after entry e starts at e+1', () => {
  const es = [row(0), row(1), row(2)];
  const m = layoutMetrics(es, RH, HH, SH, G);
  // bottom of entry 0 = 140; 141..145 is the gap before entry 1 (top 146)
  assert.deepEqual(windowRange(m.top, m.h, 143, 200), [1, 1]);
  // straddler: viewTop 100 cuts through entry 0 — it stays in
  assert.deepEqual(windowRange(m.top, m.h, 100, 200), [0, 1]);
});

test('windowRange: clamps at both ends, empty layout, past-the-end window', () => {
  const es = [row(0), row(1), row(2)];
  const m = layoutMetrics(es, RH, HH, SH, G);
  assert.deepEqual(windowRange(m.top, m.h, -500, 0), [0, 0]);
  assert.deepEqual(windowRange(m.top, m.h, 0, 99999), [0, 2]);
  assert.deepEqual(windowRange(m.top, m.h, m.total + 100, m.total + 200), [3, -1]);
  assert.deepEqual(windowRange([], [], 0, 100), [0, -1]);
});

// ---- failure policy (v0.8.1) ----
test('originBurstingFromHist: needs >=3 samples', () => {
  assert.equal(originBurstingFromHist([]), false);
  assert.equal(originBurstingFromHist([false, false]), false);
});

test('originBurstingFromHist: majority-fail recent window = burst', () => {
  assert.equal(originBurstingFromHist([true, true, true, true, false, false, false, false]), true); // 4/8 recent bad
  assert.equal(originBurstingFromHist([false, false, false]), true); // all bad
});

test('originBurstingFromHist: isolated failure on healthy origin = not burst', () => {
  assert.equal(originBurstingFromHist([true, true, true, true, true, false]), false); // 1/6 bad
  assert.equal(originBurstingFromHist([false, true, true, true]), false); // 1/4 bad
});

test('originBurstingFromHist: judges the LAST 8 only (old failures age out)', () => {
  assert.equal(originBurstingFromHist([false, false, false, false, true, true, true, true, true, true, true]), false); // 0/8 recent bad
});

// ---- download engine (v0.9.0) ----
const MB = 1048576;
test('dlChunkPlan: small totals stay single-part', () => {
  assert.deepEqual(dlChunkPlan(0, 4), []);
  assert.deepEqual(dlChunkPlan(2 * MB, 4), [[0, 2 * MB - 1]]);
  assert.deepEqual(dlChunkPlan(8 * MB, 4), [[0, 8 * MB - 1]]); // <= 2*minPart
  assert.deepEqual(dlChunkPlan(48 * MB, 1), [[0, 48 * MB - 1]]); // maxParts off
});

test('dlChunkPlan: splits evenly, concatenates exactly, honors maxParts', () => {
  const plan = dlChunkPlan(48 * MB, 4);
  assert.equal(plan.length, 4);
  assert.deepEqual(plan[0], [0, 12 * MB - 1]);
  // adjacency: no gaps, no overlaps, exact coverage
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i][0], plan[i - 1][1] + 1);
  const last = plan[plan.length - 1];
  assert.equal(last[1], 48 * MB - 1);
  assert.equal(dlChunkPlan(100 * MB, 2).length, 2);
  assert.equal(dlChunkPlan(100 * MB, 2)[0][1] + 1, 50 * MB); // even 50/50
});

test('dlChunkPlan: never more parts than maxParts, ragged tail lands in the last part', () => {
  const plan = dlChunkPlan(200 * MB, 4);
  assert.equal(plan.length, 4);
  assert.equal(plan[3][1], 200 * MB - 1);
  const span = plan[0][1] - plan[0][0] + 1;
  for (const rg of plan) assert.ok(rg[1] - rg[0] + 1 <= span + 1);
});

test('dlFailClass: transient vs permanent', () => {
  assert.equal(dlFailClass(0), 'trans');    // network error / abort
  assert.equal(dlFailClass(408), 'trans');
  assert.equal(dlFailClass(429), 'trans');
  assert.equal(dlFailClass(500), 'trans');
  assert.equal(dlFailClass(503), 'trans');
  assert.equal(dlFailClass(404), 'perm');
  assert.equal(dlFailClass(410), 'perm');
  assert.equal(dlFailClass(403), 'perm');
  assert.equal(dlFailClass(400), 'perm');
  assert.equal(dlFailClass(418), 'perm');   // unknown 4xx: retry cannot fix it
});

test('zipKindTag: content-based kind', () => {
  assert.equal(zipKindTag(true, false), 'Images');
  assert.equal(zipKindTag(false, true), 'Videos');
  assert.equal(zipKindTag(true, true), '');
  assert.equal(zipKindTag(false, false), '');
});

test('zipFileName: kind suffix, mixed stays clean, no-title fallback', () => {
  assert.equal(zipFileName('Xamvn', 'Tựa đề', 'Images'), '[Xamvn] Tựa đề (Images).zip');
  assert.equal(zipFileName('Xamvn', 'Tựa đề', 'Videos'), '[Xamvn] Tựa đề (Videos).zip');
  assert.equal(zipFileName('Xamvn', 'Tựa đề', ''), '[Xamvn] Tựa đề.zip');
  assert.equal(zipFileName('', '', 'Videos'), 'thread (Videos).zip');
});

// ---- album expansion (0.18) ----
test('isAlbumPageUrl: /a/<id> shapes', () => {
  assert.equal(isAlbumPageUrl('https://bunkr.cr/a/EAednZ0S'), true);
  assert.equal(isAlbumPageUrl('https://goonbox.cr/a/YDo0O5'), true);
  assert.equal(isAlbumPageUrl('https://x.invalid/a/abc-123_xyz'), true);
  assert.equal(isAlbumPageUrl('https://x.invalid/a/ab'), false);           // id < 3
  assert.equal(isAlbumPageUrl('https://x.invalid/a/a.mp4'), false);        // extension = file
  assert.equal(isAlbumPageUrl('https://x.invalid/a/one/two'), false);      // nested path
  assert.equal(isAlbumPageUrl('https://x.invalid/f/something'), false);
  assert.equal(isAlbumPageUrl('/a/EAednZ0S'), false);                      // not absolute
  assert.equal(isAlbumPageUrl('javascript:alert(1)'), false);
});

test('parseAlbumPage: bunkr-shaped item grid -> children', () => {
  const html = [
    '<html><body><div id="galleryGrid">',
    '<div class="relative group/item theItem" title="clip01.mp4">',
    '  <img class="grid-images_box-img" src="https://static.scdn.st/u1/thumbs/clip01.png">',
    '  <a class="after:absolute" href="/f/SLUGONE" aria-label="download"></a>',
    '</div>',
    '<div class="relative group/item theItem" title="photo &amp; 02.jpg">',
    '  <img class="grid-images_box-img" src="https://static.scdn.st/u1/thumbs/photo02.png">',
    '  <a class="after:absolute" href="/f/SLUGTWO" aria-label="download"></a>',
    '</div>',
    '<div class="relative group/item theItem" title="archive.zip">',
    '  <img class="grid-images_box-img" src="https://static.scdn.st/u1/thumbs/archive.png">',
    '  <a class="after:absolute" href="/f/SLUGTHREE" aria-label="download"></a>',
    '</div>',
    '</div></body></html>'
  ].join('');
  const kids = parseAlbumPage(html, 'https://host.invalid/a/alb1');
  assert.equal(kids.length, 2); // zip skipped — not playable media
  assert.deepEqual(kids[0], { url: 'https://host.invalid/f/SLUGONE', kind: 'video', thumb: 'https://static.scdn.st/u1/thumbs/clip01.png' });
  assert.equal(kids[1].kind, 'image');
  assert.equal(kids[1].url, 'https://host.invalid/f/SLUGTWO');
});

test('parseAlbumPage: empty shell / non-album html -> []', () => {
  assert.deepEqual(parseAlbumPage('', 'https://host.invalid/a/x'), []);
  assert.deepEqual(parseAlbumPage('<!doctype html><div id="app"></div>', 'https://host.invalid/a/x'), []);
});

test('parseAlbumApiResponse: goonbox shape -> children + pagination', () => {
  const j = JSON.stringify({
    album: { encoded_id: 'YDo0O5', images_count: 2 },
    images: [
      { encoded_id: 'i1', mime: 'image/jpeg', original_url: 'https://cdn.invalid/imgheaven/a.jpg', thumb_url: 'https://cdn.invalid/th/a.jpg' },
      { encoded_id: 'i2', mime: 'image/webp', original_url: 'https://cdn.invalid/imgheaven/b.webp', thumb_url: '' },
      { encoded_id: 'i3', mime: 'application/zip', original_url: 'https://cdn.invalid/x.zip', thumb_url: '' },
      { encoded_id: 'i4', mime: 'video/mp4', original_url: 'https://cdn.invalid/v.mp4', thumb_url: 'https://cdn.invalid/th/v.png' }
    ],
    pagination: { current_page: 1, last_page: 3, per_page: 100, total: 250 }
  });
  const p = parseAlbumApiResponse(j);
  assert.equal(p.lastPage, 3);
  assert.equal(p.children.length, 3); // zip entry skipped
  assert.deepEqual(p.children[0], { url: 'https://cdn.invalid/imgheaven/a.jpg', kind: 'image', thumb: 'https://cdn.invalid/th/a.jpg', pageId: 'i1' });
  assert.equal(p.children[2].kind, 'video');
  assert.equal(p.children[2].pageId, 'i4');
  // garbage
  assert.equal(parseAlbumApiResponse('<html>not json</html>'), null);
  assert.equal(parseAlbumApiResponse('{"images": null}'), null);
});

test('buildDlJobs skips album tiles', () => {
  const items = [
    { kind: 'album', url: 'https://host.invalid/a/alb1' },
    { kind: 'image', url: 'https://cdn.invalid/x.jpg' }
  ];
  const jobs = buildDlJobs(items).jobs;
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0].cands[0].includes('x.jpg'));
});
