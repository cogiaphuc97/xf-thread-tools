// dlplan: Pure download planning: job list from media items (dedup, seq-prefixed names, kind routing), chunk plans for Range parts, failure classification, per-origin burst verdict from rolling history. (split from the single-file userscript; see scripts/modules.json)
import { hqCandidates, imagePageHref } from './media.mjs';
import { dlBasename } from './zip.mjs';

// Turn the current media list into download jobs. Images walk the same HQ
// candidate chain as the grid (full-size first, marker variant fallback) so
// a download run grabs never-rendered cells at full size too; embed player
// tiles are JOBS like any other — resolved to a direct stream at fetch time
// (sign endpoint / file-page parse; failures count as failed, not skipped).
// Duplicate URLs are dropped. Names are seq-prefixed so two posts sharing a
// basename cannot clobber each other inside the zip.
export function buildDlJobs(items) {
  const seen = new Set();
  const jobs = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    if (it.kind === 'album') continue; // the album PAGE is navigation, not a downloadable file
    const isVid = it.kind === 'video' || it.kind === 'embed';
    const base = isVid ? String(it.url || '').replace(/#.*$/, '') : String(it.url || '');
    if (!base || seen.has(base)) continue;
    seen.add(base);
    const cands = it.kind === 'image' ? hqCandidates(base) : [base];
    // landing-page HQ: when the URL carries no static marker chain (no
    // .md/.th), the only full-quality source is the image's own page
    const page = it.kind === 'image' && cands.length === 1
      ? imagePageHref((it.r && it.r.imgPages && it.r.imgPages[base]) || '')
      : '';
    jobs.push({
      cands: cands,
      kind: it.kind,
      page: page,
      name: String(jobs.length + 1).padStart(3, '0') + '_' + dlBasename(cands[0], isVid ? 'video' : it.kind, jobs.length)
    });
  }
  return { jobs: jobs, skip: 0 };
}
// Chunk plan for ranged (split) downloads: cut total bytes into at most
// maxParts evenly sized [start, end] INCLUSIVE ranges that concatenate to
// exactly the original bytes. A small total (≤ 2×minPart) or maxParts ≤ 1
// means one part — no point parallelizing a few MB.
export function dlChunkPlan(total, maxParts, minPart) {
  const MIN = minPart || 4 * 1048576;
  const t = Math.max(0, Math.floor(total || 0));
  if (!t) return [];
  if (t <= MIN * 2 || !(maxParts > 1)) return [[0, t - 1]];
  const n = Math.max(2, Math.min(maxParts, Math.floor(t / MIN)));
  const size = Math.ceil(t / n);
  const out = [];
  for (let i = 0; i * size < t; i++) {
    const s = i * size;
    out.push([s, Math.min(s + size, t) - 1]);
  }
  return out;
}
// Failure policy for the download engine: 'trans' = retry the same URL
// (network error, timeout, 408/429, 5xx); 'perm' = burn the URL and walk
// to the next candidate (auth/gone/not-found and any unknown 4xx — a
// retry cannot fix a URL the server rejects on merits).
export function dlFailClass(status) {
  const s = status | 0;
  if (s === 0 || s === 408 || s === 429 || s >= 500) return 'trans';
  return 'perm';
}

// Burst verdict for the failure policy: an origin whose recent results
// (last 8, min 3 samples) are ≥50% failures is treated as CDN-choked —
// those RECOVER, so its items hold their slots and recheck in the
// background. An isolated failure on a healthy origin is a dead FILE —
// retire it fast and let the grid fill.
export function originBurstingFromHist(hist) {
  if (!hist || hist.length < 3) return false;
  let bad = 0;
  const n = Math.min(hist.length, 8);
  for (let i = hist.length - n; i < hist.length; i++) if (!hist[i]) bad++;
  return bad / n >= 0.5;
}

