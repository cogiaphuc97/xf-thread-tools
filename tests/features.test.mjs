// Unit tests for the remaining pure feature helpers (v0.9.1 export pass):
// hostKey / cleanThreadTitle / dosDateTime (previously only covered
// indirectly), fmtSpeed / fmtEta (dashboard formatting), buildMediaLayout
// (media grouping + dense 4-packing). Same load path as parse.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const userJsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'xf-thread-tools.user.js');
const { hostKey, cleanThreadTitle, dosDateTime, fmtSpeed, fmtEta, buildMediaLayout } = require(userJsPath);

// ---- hostKey (same-host detection core for filterLinks) ----
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

// ---- cleanThreadTitle (zip outer name source) ----
test('cleanThreadTitle: leading [tag] groups and trailing " | Forum" suffix stripped', () => {
  assert.equal(cleanThreadTitle('[NSFW] [4K] Real Title'), 'Real Title');
  assert.equal(cleanThreadTitle('My Thread | Some Forum'), 'My Thread');
  assert.equal(cleanThreadTitle('[Only]'), '');
});
test('cleanThreadTitle: Windows-illegal chars removed, control chars collapsed, Unicode kept', () => {
  assert.equal(cleanThreadTitle('What: A *Question?'), 'What A Question');
  assert.equal(cleanThreadTitle('a\x01\x02b'), 'a b');
  assert.equal(cleanThreadTitle('Tiêu Đề Đẹp 4K'), 'Tiêu Đề Đẹp 4K');
  assert.equal(cleanThreadTitle(null), '');
  assert.equal(cleanThreadTitle('   '), '');
});

// ---- dosDateTime (zip local/central header timestamps, DOS format) ----
test('dosDateTime: exact DOS bit-packing for a known date', () => {
  // 2026-11-09 20:46:30 local
  assert.deepEqual(dosDateTime(new Date(2026, 10, 9, 20, 46, 30)), { time: (20 << 11) | (46 << 5) | (30 >> 1), date: (46 << 9) | (11 << 5) | 9 });
  // seconds floor to 2s resolution (>> 1)
  assert.deepEqual(dosDateTime(new Date(2020, 0, 1, 0, 0, 59)).time, 29);
});
test('dosDateTime: pre-1980 dates clamp to the DOS epoch 1980-01-01', () => {
  assert.deepEqual(dosDateTime(new Date(1970, 0, 1, 0, 0, 0)), { time: 0, date: 33 }); // (0<<9)|(1<<5)|1
});

// ---- fmtSpeed (dashboard speed column) ----
test('fmtSpeed: B/s / KB/s / MB/s boundaries', () => {
  assert.equal(fmtSpeed(0), '0 B/s');
  assert.equal(fmtSpeed(999), '999 B/s');
  assert.equal(fmtSpeed(1024), '1 KB/s');
  assert.equal(fmtSpeed(1536), '2 KB/s'); // toFixed(0) rounds
  assert.equal(fmtSpeed(1048575), '1024 KB/s'); // just under the MB line stays KB
  assert.equal(fmtSpeed(1048576), '1.0 MB/s');
  assert.equal(fmtSpeed(2.5 * 1048576), '2.5 MB/s');
});

// ---- fmtEta (dashboard ETA column) ----
test('fmtEta: hidden under 2s, seconds below 90s', () => {
  assert.equal(fmtEta(0), '');
  assert.equal(fmtEta(null), '');
  assert.equal(fmtEta(undefined), '');
  assert.equal(fmtEta(1.9), '');
  assert.equal(fmtEta(2), '≈ 2s');
  assert.equal(fmtEta(44.4), '≈ 44s');
});
test('fmtEta: minutes from 90s, saturates at 90m+', () => {
  assert.equal(fmtEta(90), '≈ 2m'); // 90s lands in the minute branch, rounds up
  assert.equal(fmtEta(3600), '≈ 60m');
  assert.equal(fmtEta(5399), '≈ 90m'); // last value under the cap still rounds to 90m
  assert.equal(fmtEta(5400), '≈ 90m+');
});

// ---- buildMediaLayout (media grouping + dense 4-packing) ----
const mk = (postId, author, pageN, pos) => ({ r: { postId: postId, author: author, pageN: pageN }, url: 'https://x.test/' + postId + '-' + Math.random().toString(36).slice(2, 7), pos: pos, kind: 'image' });

test('buildMediaLayout: flat mode = pure sequential 4-packs, no headers, ragged tail', () => {
  const items = Array.from({ length: 9 }, (_, i) => mk('p' + (i % 3), 'a' + (i % 3), 1, i));
  const lay = buildMediaLayout(items, 'flat');
  assert.deepEqual(lay, [{ idxs: [0, 1, 2, 3] }, { idxs: [4, 5, 6, 7] }, { idxs: [8] }]);
  assert.equal(buildMediaLayout([], 'flat').length, 0);
});
test('buildMediaLayout: unknown mode string falls back to flat packing', () => {
  const items = Array.from({ length: 4 }, (_, i) => mk('p', 'a', 1, i));
  assert.deepEqual(buildMediaLayout(items, 'weird'), [{ idxs: [0, 1, 2, 3] }]);
});
test('buildMediaLayout: post mode regathers scattered posts, no sub-headers', () => {
  // items of p1 appear, then p2, then MORE p1 — grouping must reunite them
  const items = [mk('p1', 'Alice', 1, 3), mk('p1', 'Alice', 1, 3), mk('p2', 'Bob', 1, 4), mk('p1', 'Alice', 1, 3), mk('p1', 'Alice', 1, 3)];
  const lay = buildMediaLayout(items, 'post');
  assert.deepEqual(lay, [
    { hdr: 'main', label: '#3 - Alice', postId: 'p1' },
    { idxs: [0, 1, 3, 4] },
    { hdr: 'main', label: '#4 - Bob', postId: 'p2' },
    { idxs: [2] },
  ]);
});
test('buildMediaLayout: page mode groups by pageN with #pos - author sub-headers', () => {
  const items = [mk('b', 'Bob', 2, 5), mk('a', 'Alice', 1, 1), mk('b', 'Bob', 2, 5)];
  const lay = buildMediaLayout(items, 'page');
  assert.deepEqual(lay, [
    { hdr: 'main', label: 'Page 2', postId: 'b' },
    { hdr: 'sub', label: '#5 - Bob', postId: 'b' },
    { idxs: [0, 2] },
    { hdr: 'main', label: 'Page 1', postId: 'a' },
    { hdr: 'sub', label: '#1 - Alice', postId: 'a' },
    { idxs: [1] },
  ]);
});
test('buildMediaLayout: user mode labels groups by author, sub-header shows only #pos; missing author -> ?', () => {
  const items = [mk('a', 'Alice', 1, 7), mk('b', '', 2, 8), mk('a', 'Alice', 1, 7)];
  const lay = buildMediaLayout(items, 'user');
  assert.deepEqual(lay, [
    { hdr: 'main', label: 'Alice', postId: 'a' },
    { hdr: 'sub', label: '#7', postId: 'a' },
    { idxs: [0, 2] },
    { hdr: 'main', label: '?', postId: 'b' },
    { hdr: 'sub', label: '#8', postId: 'b' },
    { idxs: [1] },
  ]);
});
test('buildMediaLayout: grouped rows pack densely (5 items -> 4+1 inside the group)', () => {
  const items = Array.from({ length: 5 }, () => mk('p1', 'A', 1, 1));
  const lay = buildMediaLayout(items, 'post');
  assert.deepEqual(lay, [
    { hdr: 'main', label: '#1 - A', postId: 'p1' },
    { idxs: [0, 1, 2, 3] },
    { idxs: [4] },
  ]);
});
test('buildMediaLayout: missing pageN defaults to page 1', () => {
  const items = [mk('a', 'A', 0, 1)];
  const lay = buildMediaLayout(items, 'page');
  assert.equal(lay[0].label, 'Page 1');
});
