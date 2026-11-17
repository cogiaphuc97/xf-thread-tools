// thumb: pure cache math — key identity, prune order, downscale, gif detect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THUMB_MAX_SIDE, THUMB_STORE_CAP, THUMB_MEM_CAP, GIF_MEM_CAP,
  thumbKey, isGifUrl, downscaleTarget, prunePlan
} from '../src/thumb.mjs';

test('thumbKey: stable identity, hash stripped, query kept', () => {
  assert.equal(thumbKey('https://a/b.jpg#t=0.1'), 'https://a/b.jpg');
  assert.equal(thumbKey('https://a/b.jpg'), 'https://a/b.jpg');
  assert.equal(thumbKey('https://a/img?sig=Z%3D%2F&w=2'), 'https://a/img?sig=Z%3D%2F&w=2');
  assert.equal(thumbKey('https://a/b.jpg#x'), thumbKey('https://a/b.jpg#y'));
  assert.equal(thumbKey(''), '');
  assert.equal(thumbKey(null), '');
});

test('isGifUrl: extension incl. query/hash, misses extensionless', () => {
  assert.equal(isGifUrl('https://a/x.gif'), true);
  assert.equal(isGifUrl('https://a/x.gif?sig=1'), true);
  assert.equal(isGifUrl('https://a/x.gif#t=0.1'), true);
  assert.equal(isGifUrl('https://a/x.GIF'), true);
  assert.equal(isGifUrl('https://a/x.jpg'), false);
  assert.equal(isGifUrl('https://a/xgift.png'), false); // needs the extension boundary
  assert.equal(isGifUrl('https://a/anim'), false); // mime sniff covers this at runtime
});

test('downscaleTarget: caps longest side, keeps aspect, never upscales', () => {
  assert.deepEqual(downscaleTarget(4000, 3000, 512), { w: 512, h: 384 });
  assert.deepEqual(downscaleTarget(3000, 4000, 512), { w: 384, h: 512 });
  assert.deepEqual(downscaleTarget(1024, 512, 512), { w: 512, h: 256 });
  assert.equal(downscaleTarget(512, 384, 512), null); // already within cap
  assert.equal(downscaleTarget(100, 100, 512), null); // small stays small
  assert.equal(downscaleTarget(0, 0, 512), null);
  assert.equal(downscaleTarget(-3, 100, 512), null);
  assert.deepEqual(downscaleTarget(513, 1, 512), { w: 512, h: 1 }); // extreme aspect: min 1px
});

test('prunePlan: least hits first, then oldest; stops at cap', () => {
  const e = [
    { key: 'a', bytes: 60, hits: 3, ts: 30 },
    { key: 'b', bytes: 40, hits: 1, ts: 20 },  // fewest hits → first out
    { key: 'c', bytes: 30, hits: 1, ts: 10 },  // same hits, older → before b
    { key: 'd', bytes: 10, hits: 2, ts: 99 }
  ];
  // over by 40: drop c(30) then b(40)? c alone brings 140 → 110+30=... build exact:
  // total 140, cap 100 → need -40 → drop c (30) still 110 > 100 → drop b (40) → 70
  assert.deepEqual(prunePlan(140, 100, e), ['c', 'b']);
  assert.deepEqual(prunePlan(100, 100, e), []);   // at cap: keep everything
  assert.deepEqual(prunePlan(50, 100, e), []);    // under cap
  assert.deepEqual(prunePlan(140, 100, []), []);  // nothing to drop: caller's problem
});

test('prunePlan: boundary math exact', () => {
  const e = [
    { key: 'x', bytes: 100, hits: 0, ts: 1 },
    { key: 'y', bytes: 100, hits: 1, ts: 2 }
  ];
  // total 200, cap 199 → drop x only → 100 ≤ 199
  assert.deepEqual(prunePlan(200, 199, e), ['x']);
  // cap 100 → drop x → 100, not > 100 → stop
  assert.deepEqual(prunePlan(200, 100, e), ['x']);
  // cap 99 → drop x and y
  assert.deepEqual(prunePlan(200, 99, e), ['x', 'y']);
});

test('caps are the spec values', () => {
  assert.equal(THUMB_MAX_SIDE, 512);
  assert.equal(THUMB_STORE_CAP, 512 * 1024 * 1024);
  assert.equal(THUMB_MEM_CAP, 128 * 1024 * 1024);
  assert.equal(GIF_MEM_CAP, 64 * 1024 * 1024);
});
