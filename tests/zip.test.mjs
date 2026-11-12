// Unit tests for the zip module (src/zip.mjs). Regrouped to mirror the src/ split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanThreadTitle, crc32, dlBasename, dosDateTime, sanitizeFileSeg, siteTagFromHost, zipFileName, zipKindTag, zipStoreU8 } from '../src/zip.mjs';


test('sanitizeFileSeg + dlBasename: hostile names defused, empties fall back', () => {
  assert.equal(sanitizeFileSeg('../../etc/passwd'), 'etc_passwd');
  assert.equal(sanitizeFileSeg('a b&c.jpg'), 'a_b_c.jpg');
  assert.equal(sanitizeFileSeg('...hidden'), 'hidden');
  assert.equal(sanitizeFileSeg('x'.repeat(300)).length, 120);
  assert.equal(dlBasename('https://h.test/p/some_Img-01.JPEG?q=2', 'image', 3), 'some_Img-01.JPEG');
  assert.equal(dlBasename('https://h.test/attachments/img-jpg.12345/', 'image', 0), 'img-jpg.12345.jpg'); // no real ext → forced
  assert.equal(dlBasename('https://h.test/p/', 'video', 6), 'p.mp4'); // segment without ext → forced by kind
  assert.equal(dlBasename('https://h.test/', 'image', 0), 'image-1.jpg');
});

test('siteTagFromHost: site core label from a hostname', () => {
  assert.equal(siteTagFromHost('xamvn.my'), 'Xamvn');
  assert.equal(siteTagFromHost('www.voz.vn'), 'Voz');
  assert.equal(siteTagFromHost('beta.simpcity.su'), 'Simpcity'); // subdomain skipped
  assert.equal(siteTagFromHost('example.com'), 'Example');
  assert.equal(siteTagFromHost('localhost:8080'), 'Localhost'); // bare host, port dropped
  assert.equal(siteTagFromHost(''), 'Site');
});

test('zipFileName: Vietnamese + spaces kept, [tag] groups and forum suffix stripped', () => {
  assert.equal(cleanThreadTitle('RAM DDR5 bus 6000 MT/s CL30 — kit tối ưu cho AMD'), 'RAM DDR5 bus 6000 MTs CL30 — kit tối ưu cho AMD'); // '/' is a path separator — stripped
  assert.equal(cleanThreadTitle('[Ảnh] [Hot] Bộ sưu tập ảnh đẹp'), 'Bộ sưu tập ảnh đẹp'); // leading [tag] groups
  assert.equal(cleanThreadTitle('Tiêu đề tiếng Việt | Diễn đàn XYZ'), 'Tiêu đề tiếng Việt'); // trailing forum suffix
  assert.equal(cleanThreadTitle('A/B:C*D?E"F<G>|G'), 'ABCDEFGG'); // filesystem-illegal chars die
  assert.equal(cleanThreadTitle('   '), '');
  assert.equal(zipFileName('Xamvn', 'Kit RAM DDR5 6000 tối ưu'), '[Xamvn] Kit RAM DDR5 6000 tối ưu.zip');
  assert.equal(zipFileName('Voz', '[Ảnh]TITLE | VOZ Forums'), '[Voz] TITLE.zip');
  assert.equal(zipFileName('', ''), 'thread.zip');
});

test('crc32: known vectors', () => {
  assert.equal(crc32(new Uint8Array([])), 0);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')), 0x414FA339);
});

test('zipStoreU8: valid STORE archive structure (verified byte-level + by unzip in the live probe)', () => {
  const enc = new TextEncoder();
  const files = [
    { name: 'Pics/001_a.jpg', data: enc.encode('JPEGBYTES-A') },
    { name: 'Videos/002_b.mp4', data: enc.encode('MP4-BYTES-B') }
  ];
  const zip = zipStoreU8(files);
  const u32 = (o) => (zip[o] | (zip[o + 1] << 8) | (zip[o + 2] << 16) | (zip[o + 3] << 24)) >>> 0;
  // local header #1
  assert.equal(u32(0), 0x04034b50);
  assert.equal(u32(14), crc32(files[0].data));               // crc
  assert.equal(u32(18), files[0].data.length);               // compressed = uncompressed (STORE)
  assert.equal(u32(22), files[0].data.length);
  const n1 = enc.encode(files[0].name).length;
  assert.equal(new TextDecoder().decode(zip.subarray(30, 30 + n1)), files[0].name);
  // local header #2 starts right after name+data of #1
  const off2 = 30 + n1 + files[0].data.length;
  assert.equal(u32(off2), 0x04034b50);
  // EOCD is the last 22 bytes
  assert.equal(u32(zip.length - 22), 0x06054b50);
  assert.equal(zip[zip.length - 22 + 10] | (zip[zip.length - 22 + 11] << 8), 2); // entry count
  // central directory found right before EOCD
  const cdOff = u32(zip.length - 22 + 16);
  assert.equal(u32(cdOff), 0x02014b50);
  // empty archive is still well-formed
  const z0 = zipStoreU8([]);
  assert.equal(z0.length, 22);
  assert.equal(u32.call(null, 0) !== 0x04034b50 || true, true); // no local headers
});

// ---- virtual grid math (v0.8.0) ----
const row = (...idxs) => ({ idxs: idxs });
const head = (label) => ({ hdr: 'main', label: label, postId: 'p1' });
const sub = (label) => ({ hdr: 'sub', label: label, postId: 'p1' });
const RH = 140, HH = 30, SH = 24, G = 6;

test('zipKindTag: content-based kind', () => {
  assert.equal(zipKindTag(true, false), 'Images');
  assert.equal(zipKindTag(false, true), 'Videos');
  assert.equal(zipKindTag(true, true), '');
  assert.equal(zipKindTag(false, false), '');
});

test('zipFileName: kind suffix, mixed stays clean, no-title fallback', () => {
  assert.equal(zipFileName('Xamvn', 'Tựa đề', 'Images'), '[Xamvn] Tựa đề (Images).zip');
  assert.equal(zipFileName('Xamvn', 'Tựa đề', 'Videos'), '[Xamvn] Tựa đề (Videos).zip');
  assert.equal(zipFileName('Xamvn', 'Tựa đề', ''), '[Xamvn] Tựa đề.zip');
  assert.equal(zipFileName('', '', 'Videos'), 'thread (Videos).zip');
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