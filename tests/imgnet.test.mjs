// Unit tests for the net-queue picker (src/imgnet.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netPick } from '../src/imgnet.mjs';

// tier: 0 user (no el) / 1 visible / 2 attached / 3 detached; rank = visual
// position for tiers 1-2, enqueue time for tier 3
const job = (origin, at, tier, rank) => ({ origin: origin, at: at, tier: tier, rank: rank });

test('netPick: -1 when the global cap is reached, regardless of queue contents', () => {
  const q = [job('a.test', 0, 0), job('b.test', 1, 1, 0)];
  assert.equal(netPick(q, 12, {}, {}), -1); // active >= default global 12
  assert.equal(netPick(q, 2, {}, { global: 2 }), -1); // explicit cap
});

test('netPick: skips a saturated origin and starts a later job from another origin', () => {
  const q = [job('a.test', 0, 2, 100), job('a.test', 1, 2, 200), job('b.test', 2, 2, 300)];
  // origin a has all 4 slots busy; the b job still starts
  assert.equal(netPick(q, 2, { 'a.test': 4 }, {}), 2);
  // nothing eligible when every represented origin is saturated
  assert.equal(netPick(q, 2, { 'a.test': 4, 'b.test': 4 }, {}), -1);
});

test('netPick: tier order user(0) > visible(1) > attached(2) > detached(3)', () => {
  const q = [
    job('a.test', 30, 3, 30),  // detached, oldest
    job('a.test', 20, 2, 500), // attached, low on screen
    job('a.test', 10, 1, 900), // visible but visually LOWEST
    job('a.test', 0, 0, 0)     // user-initiated
  ];
  assert.equal(netPick(q, 0, {}, {}), 3); // tier 0 wins despite being queued last
});

test('netPick: visible cells load top-left first (rank = top*1e5 + left)', () => {
  const q = [
    job('a.test', 0, 1, 400 * 1e5 + 300),  // visible, lower row
    job('a.test', 1, 1, 400 * 1e5 + 100),  // same row, left cell
    job('a.test', 2, 1, 100 * 1e5 + 900),  // top row, right cell
    job('a.test', 3, 1, 100 * 1e5 + 100)   // top row, left cell — smallest rank
  ];
  assert.equal(netPick(q, 0, {}, {}), 3);
  q.splice(3, 1);
  assert.equal(netPick(q, 0, {}, {}), 2); // next: top row right
  q.splice(2, 1);
  assert.equal(netPick(q, 0, {}, {}), 1); // then lower row left-to-right
});

test('netPick: off-screen attached cells follow layout order (tier 2), not enqueue order', () => {
  // the bottom-to-top report: enqueue order is REVERSED display order;
  // tier-2 rank must still load top rows first
  const q = [
    job('a.test', 0, 2, 900 * 1e5 + 400), // bottom row (enqueued first under latest sort)
    job('a.test', 1, 2, 500 * 1e5 + 400),
    job('a.test', 2, 2, 100 * 1e5 + 400)  // top row
  ];
  assert.equal(netPick(q, 0, {}, {}), 2);
});

test('netPick: detached jobs FIFO by age once nothing else is startable', () => {
  const q = [job('a.test', 50, 3, 50), job('a.test', 10, 3, 10)];
  assert.equal(netPick(q, 0, {}, {}), 1); // earlier at first
});

test('netPick: jobs missing tier/rank default to detached-FIFO (legacy shape)', () => {
  const q = [{ origin: 'a.test', at: 5 }, job('a.test', 9, 1, 0)];
  assert.equal(netPick(q, 0, {}, {}), 1); // explicit visible beats legacy default
});

test('netPick: originCaps override shrinks a saturated origin', () => {
  const q = [job('a.test', 0, 1, 0), job('b.test', 1, 2, 0)];
  // a capped at 2 with 2 in flight -> b starts despite lower priority
  assert.equal(netPick(q, 2, { 'a.test': 2 }, { originCaps: { 'a.test': 2 } }), 1);
});
