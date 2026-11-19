// Unit tests for the parse module (src/parse.mjs). Regrouped to mirror the src/ split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLinkFilters, estimateSize, extractDomain, filterLinks, groupLinkItems, hostKey, orderItems, parseReactionCount, partitionLinks, sortPosts } from '../src/parse.mjs';


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

// ---- parseReactionCount thousands separators (0.23.3, live-observed) ----
// XF number-formats the others count: EN comma, VI dot. Live element:
// "1ofones, joedyhoeman, FelixLengyel12 and 1,007 others"
test('parseReactionCount: "and 1,007 others" (EN comma) -> names + 1007', () => {
  assert.equal(parseReactionCount('A, B, C and 1,007 others'), 1010);
});

test('parseReactionCount: "và 1.007 người khác" (VI dot) -> names + 1007', () => {
  assert.equal(parseReactionCount('A, B và 1.007 người khác'), 1009);
});

test('parseReactionCount: separator count in badge/bare shapes too', () => {
  assert.equal(parseReactionCount('1,007'), 1007);
  assert.equal(parseReactionCount('UserA +1,007'), 1008);
});

// ---- parseReactionCount truncated-list / badge shapes (0.23.2) ----
// the MOST-reacted post is the only one whose name list gets truncated;
// custom styles badge the tail instead of the stock "and N others" phrase
test('parseReactionCount: "+N" badge tail -> names + N', () => {
  assert.equal(parseReactionCount('UserA, UserB +247'), 249);
});

test('parseReactionCount: ellipsis + "+N" tail -> ellipsis not a name', () => {
  assert.equal(parseReactionCount('UserA, UserB, … +247'), 249);
  assert.equal(parseReactionCount('UserA, UserB... +247'), 249);
});

test('parseReactionCount: bare count badge (no letters) -> that count', () => {
  assert.equal(parseReactionCount('247'), 247);
  assert.equal(parseReactionCount('❤ 247'), 247);
});

test('parseReactionCount: icon-only text -> 0; stock "and N others" unchanged', () => {
  assert.equal(parseReactionCount('❤ ❤'), 0);
  assert.equal(parseReactionCount('longdevilk3, thead, adidasphatt and 15 others'), 18);
  assert.equal(parseReactionCount('Aman899'), 1); // letters present -> still a name list
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
test('hostKey: lowercases and strips ONLY the leading www.', () => {
  assert.equal(hostKey('www.Example.COM'), 'example.com');
  assert.equal(hostKey('www.forum.example.org'), 'forum.example.org');
  assert.equal(hostKey('a.b.example.org'), 'a.b.example.org');
});

test('hostKey: port kept, garbage coerced to empty string', () => {
  assert.equal(hostKey('example.com:8443'), 'example.com:8443');
  assert.equal(hostKey(''), '');
  assert.equal(hostKey(null), '');
  assert.equal(hostKey(undefined), '');
  assert.equal(hostKey('www.'), '');
});
// orderItems (0.23.0) — item shape { r, url, pos, kind, ord }
const oit = (pageN, reactionCount, pos, ord) => ({ r: { pageN: pageN, reactionCount: reactionCount }, url: 'u' + pos + '_' + ord, pos: pos, kind: 'image', ord: ord });

test('orderItems: default/unknown/legacy-page modes return the SAME reference, input never mutated', () => {
  const items = [oit(2, 5, 3, 0), oit(1, 0, 1, 1)];
  assert.equal(orderItems(items, 'default'), items);
  assert.equal(orderItems(items, undefined), items);
  assert.equal(orderItems(items, 'bogus'), items);
  assert.equal(orderItems(items, 'page'), items); // legacy 0.23.2–0.23.3 value, coerced at load
  const copy = items.slice();
  const sorted = orderItems(items, 'react');
  assert.deepEqual(items, copy); // input array untouched by the sort
  assert.notEqual(sorted, items);
});

test('orderItems: latest mode sorts pageN DESC (missing pageN = 1), ties by pos DESC then ord DESC', () => {
  const items = [oit(3, 99, 7, 0), oit(1, 0, 2, 1), oit(undefined, 0, 1, 2), oit(1, 5, 2, 3), oit(2, 0, 4, 4)];
  const urls = orderItems(items, 'latest').map((it) => it.url);
  // exact reverse of the default walk: page 3 first, then page 2, then
  // page-1 items with the LATER post first (pos 2 ord 3 before pos 2 ord 1,
  // then the missing-pageN pos-1 item last)
  assert.deepEqual(urls, ['u7_0', 'u4_4', 'u2_3', 'u2_1', 'u1_2']);
});

test('orderItems: react mode sorts reactionCount DESC (missing = 0), ties by pos then ord', () => {
  const items = [oit(1, 0, 1, 0), oit(2, 7, 5, 1), oit(1, undefined, 2, 2), oit(1, 7, 3, 3), oit(1, 12, 4, 4)];
  const urls = orderItems(items, 'react').map((it) => it.url);
  // 12 first; the two 7s tie-break by pos (3 < 5); zero/missing react last by pos
  assert.deepEqual(urls, ['u4_4', 'u3_3', 'u5_1', 'u1_0', 'u2_2']);
});
