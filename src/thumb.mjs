// thumb: Pure preview-thumb cache math: identity key, LRU prune plan (hits-then-ts), downscale target (never upscale, aspect kept), gif detection, byte caps. No DOM, no GM_*. (split-era module for the 0.20.0 preview lifecycle; see scripts/modules.json)
export const THUMB_MAX_SIDE = 512;                    // px, longest side of a cached cell thumb
export const THUMB_STORE_CAP = 512 * 1024 * 1024;     // IDB bytes cap (LRU-pruned)
export const THUMB_MEM_CAP = 128 * 1024 * 1024;       // in-memory objectURL layer cap
export const GIF_MEM_CAP = 64 * 1024 * 1024;          // animated-original layer cap (hover/viewer)
export const GIF_RE = /\.gif([?#]|$)/i;

// Cache identity: the URL minus its fragment (video #t=0.1 hashes must not
// split one media into two keys), query KEPT verbatim (signed URLs die when
// reordered). data:/blob: inputs never key a fetch (caller guards).
export function thumbKey(url) {
  const s = String(url || '');
  if (!s) return '';
  const h = s.indexOf('#');
  return h === -1 ? s : s.slice(0, h);
}

// Best-effort animated detection by URL; the runtime also sniffs the blob's
// MIME (CDNs serve gifs under extensionless URLs).
export function isGifUrl(url) {
  return GIF_RE.test(String(url || ''));
}

// Downscale target for a nw x nh bitmap: longest side capped at maxSide,
// aspect preserved, never an upscale. null = already within the cap — the
// caller keeps the original bytes (no needless re-encode).
export function downscaleTarget(nw, nh, maxSide) {
  const w = Math.max(0, nw | 0), h = Math.max(0, nh | 0);
  if (!w || !h) return null;
  if (w <= maxSide && h <= maxSide) return null;
  const scale = maxSide / Math.max(w, h);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

// LRU prune plan: which entries to drop so bytesTotal comes back under cap.
// Order = least-valuable first: fewer hits, then older ts. Entries are
// {key, bytes, hits, ts}. Returns the keys to delete (possibly empty).
export function prunePlan(bytesTotal, cap, entries) {
  if (!(bytesTotal > cap)) return [];
  const sorted = (entries || []).slice().sort((a, b) => (a.hits - b.hits) || (a.ts - b.ts));
  let total = bytesTotal;
  const drop = [];
  for (const e of sorted) {
    if (!(total > cap)) break;
    drop.push(e.key);
    total -= e.bytes;
  }
  return drop;
}
