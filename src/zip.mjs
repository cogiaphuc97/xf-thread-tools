// zip: Pure zip writer (STORE method, hand-rolled, CRC32, LE helpers, headers, EOCD) + naming: segment sanitize, site tag, thread title cleaning, kind tag, outer/entry file names. (split from the single-file userscript; see scripts/modules.json)
// ---------- bulk download: pure helpers ----------
// Filenames are embedded in a zip this script writes itself (STORE — media
// is already compressed, so re-compressing gains nothing). Every segment is
// sanitized (no traversal, no control chars) and capped at 120 chars.
export function sanitizeFileSeg(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._-]+/, '').replace(/\.{2,}/g, '.').slice(0, 120);
}
// Outer zip FILE name — deliberately unlike sanitizeFileSeg: the anchor
// download attribute takes Unicode + spaces, so the Vietnamese title stays
// readable. Only filesystem-illegal characters die. (Zip ENTRY names keep
// using sanitizeFileSeg — those live inside the zip we write by hand.)
export function siteTagFromHost(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split(':')[0].split('.').filter(Boolean);
  const core = parts.length >= 2 ? parts[parts.length - 2] : (parts[0] || 'site');
  return core.charAt(0).toUpperCase() + core.slice(1);
}
export function cleanThreadTitle(raw) {
  let t = String(raw || '').replace(/[\x00-\x1f]+/g, ' ').trim();
  t = t.replace(/^(?:\s*\[[^\]]{0,40}\]\s*)+/, ''); // leading [tag] groups
  const bar = t.indexOf(' | ');
  if (bar > 0) t = t.slice(0, bar); // trailing " | Forum" suffix
  return t.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}
// Single-kind zips (an images-only or videos-only download) drop the
// inner Pics//Videos/ folders and say so in the zip name instead.
export function zipKindTag(hasImg, hasVid) {
  if (hasImg && !hasVid) return 'Images';
  if (hasVid && !hasImg) return 'Videos';
  return '';
}
export function zipFileName(tag, title, kind) {
  const t = cleanThreadTitle(title);
  const k = kind ? ' (' + kind + ')' : '';
  if (!t) return (tag || 'thread') + k + '.zip';
  return '[' + (tag || 'Site') + '] ' + t + k + '.zip';
}
export function dlBasename(url, kind, idx) {
  let b = '';
  try { b = new URL(url).pathname.split('/').filter(Boolean).pop() || ''; } catch (e) { /* keep '' */ }
  b = sanitizeFileSeg(b);
  // attachment URLs end without a real extension (`/attachments/name-jpg.12345/`)
  // — a `.12345` ext is unopenable. Force a kind-based one when missing.
  const extOk = /\.(jpe?g|png|gif|webp|avif|jfif|bmp|mp4|webm|mov|mkv|m4v)$/i.test(b);
  const dflt = kind === 'video' ? '.mp4' : '.jpg';
  if (!b) b = (kind === 'video' ? 'video-' : 'image-') + (idx + 1) + dflt;
  else if (!extOk) b = b.replace(/\.+$/, '') + dflt;
  return b;
}

// Minimal zip (method 0 / STORE) writer — no dependencies. Layout per
// PKWARE APPNOTE: per-file local header + bytes, then the central
// directory, then the end-of-central-directory record. UTF-8 names via the
// general-purpose flag 0x0800. Offsets/sizes are 32-bit; the caller caps
// the run well under 4 GB.
export const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
export function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const date = (((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  return { time: time, date: date };
}
export function u16le(v) { return new Uint8Array([v & 255, (v >>> 8) & 255]); }
export function u32le(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
export function concatU8(list) {
  let n = 0;
  for (const a of list) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}
export function zipLocalHeader(nameU8, crc, size, dt) {
  return concatU8([u32le(0x04034b50), u16le(20), u16le(0x0800), u16le(0), u16le(dt.time), u16le(dt.date),
    u32le(crc), u32le(size), u32le(size), u16le(nameU8.length), u16le(0), nameU8]);
}
export function zipCentralEntry(nameU8, crc, size, dt, offset) {
  return concatU8([u32le(0x02014b50), u16le(20), u16le(20), u16le(0x0800), u16le(0), u16le(dt.time), u16le(dt.date),
    u32le(crc), u32le(size), u32le(size), u16le(nameU8.length), u16le(0), u16le(0), u16le(0), u16le(0),
    u32le(0), u32le(offset), nameU8]);
}
export function zipEocd(count, cdSize, cdOffset) {
  return concatU8([u32le(0x06054b50), u16le(0), u16le(0), u16le(count), u16le(count), u32le(cdSize), u32le(cdOffset), u16le(0)]);
}
// files: [{ name, data: Uint8Array }] -> Uint8Array of the whole zip.
export function zipStoreU8(files) {
  const enc = new TextEncoder();
  const dt = dosDateTime(new Date());
  const parts = [];
  const cds = [];
  let off = 0;
  for (const f of files) {
    const nameU8 = enc.encode(f.name);
    const crc = crc32(f.data);
    const lh = zipLocalHeader(nameU8, crc, f.data.length, dt);
    parts.push(lh, f.data);
    cds.push(zipCentralEntry(nameU8, crc, f.data.length, dt, off));
    off += lh.length + f.data.length;
  }
  const cd = concatU8(cds);
  return concatU8(parts.concat([cd, zipEocd(files.length, cd.length, off)]));
}

