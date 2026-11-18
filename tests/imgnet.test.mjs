// Unit tests for the net-queue picker (src/imgnet.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netPick } from '../src/imgnet.mjs';

const job = (origin, at, urgent) => ({ origin: origin, at: at, urgent: !!urgent });

test('netPick: -1 when the global cap is reached, regardless of queue contents', () => {
  const q = [job('a.test', 0, true), job('b.test', 1, true)];
  assert.equal(netPick(q, 6, {}, {}, 20000), -1); // active >= default global 6
  assert.equal(netPick(q, 2, {}, { global: 2 }, 20000), -1); // explicit cap
});

test('netPick: skips a saturated origin and starts a later job from another origin', () => {
  const q = [job('a.test', 0), job('a.test', 1), job('b.test', 2)];
  // origin a has both slots busy; the earliest b job still starts
  assert.equal(netPick(q, 2, { 'a.test': 2 }, {}, 100), 2);
  // nothing eligible when every represented origin is saturated
  assert.equal(netPick(q, 2, { 'a.test': 2, 'b.test': 2 }, {}, 100), -1);
});

test('netPick: urgent job behind an earlier non-urgent job wins (visible-first)', () => {
  const q = [job('a.test', 0), job('a.test', 1), job('a.test', 2, true)];
  assert.equal(netPick(q, 0, {}, {}, 100), 2);
});

test('netPick: aged jobs promote to urgent (starvation bound)', () => {
  const q = [job('a.test', 0), job('b.test', 1000)];
  // at=0 aged past ageMs 500 -> urgent even though the later job is FIFO-first
  assert.equal(netPick(q, 0, {}, { ageMs: 500 }, 1000), 0);
  // nothing aged, nothing urgent -> FIFO
  assert.equal(netPick(q, 0, {}, { ageMs: 500 }, 1200), 0);
});

test('netPick: FIFO fallback when no job is urgent; defaults apply for 0/undefined opts', () => {
  const q = [job('a.test', 30), job('b.test', 10), job('a.test', 20)];
  // earliest eligible job by QUEUE order (index 0), not by timestamp
  assert.equal(netPick(q, 0, {}, {}, 100), 0);
  assert.equal(netPick(q, 5, {}, {}, 100), 0); // active below default global 6
  // perOrigin 0 -> default 2: a saturated, only the b job is startable
  assert.equal(netPick(q, 2, { 'a.test': 2 }, { perOrigin: 0 }, 100), 1);
});

test('netPick: mixed field exercise — caps, urgency, aging, FIFO together', () => {
  const q = [
    job('cdn1.test', 0),        // 0: non-urgent, origin saturated
    job('cdn1.test', 100),      // 1: non-urgent, origin saturated
    job('cdn2.test', 200),      // 2: non-urgent, eligible
    job('cdn3.test', 300, true) // 3: urgent, eligible
  ];
  // urgent cdn3 beats eligible cdn2 even though cdn2 is earlier
  assert.equal(netPick(q, 1, { 'cdn1.test': 2 }, {}, 1000), 3);
  // late `now`: cdn1 jobs aged but still origin-blocked; cdn2 aged too ->
  // first AGED eligible is cdn2 (index 2), still ahead of plain fallback
  assert.equal(netPick(q, 1, { 'cdn1.test': 2 }, {}, 10400), 2);
});
