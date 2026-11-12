// Unit tests for the layout module (src/layout.mjs). Regrouped to mirror the src/ split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaLayout, fmtEta, fmtSpeed, layoutMetrics, windowRange } from '../src/layout.mjs';

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
