// Unit tests for the pure functions exported by xf-thread-tools.user.js (PRD US-001 / plan AC6).
// Loaded as CJS via createRequire; the userscript's runtime guard keeps all DOM/GM code inert in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const userJsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'xf-thread-tools.user.js');
const { parseReactionCount, filterLinks, sortPosts, estimateSize, partitionLinks, extractDomain, groupLinkItems, applyLinkFilters, boilerplateUrls, isSmilieUrl, parseEmbedPoster, embedSignUrl, parseSignResponse } = require(userJsPath);

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
