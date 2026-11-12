// Unit tests for the dlplan module (src/dlplan.mjs). Regrouped to mirror the src/ split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDlJobs, dlChunkPlan, dlFailClass, originBurstingFromHist } from '../src/dlplan.mjs';


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

test('buildDlJobs skips album tiles', () => {
  const items = [
    { kind: 'album', url: 'https://host.invalid/a/alb1' },
    { kind: 'image', url: 'https://cdn.invalid/x.jpg' }
  ];
  const jobs = buildDlJobs(items).jobs;
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0].cands[0].includes('x.jpg'));
});
