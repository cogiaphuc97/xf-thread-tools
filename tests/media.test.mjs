// Unit tests for the media module (src/media.mjs). Regrouped to mirror the src/ split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boilerplateUrls, hqCandidates, imagePageHref, isAlbumPageUrl, isSmilieUrl, parseAlbumApiResponse, parseAlbumPage, parseImageApiResponse, parseImagePage } from '../src/media.mjs';


// ---- boilerplateUrls (signature / "sent via app" footer fingerprint) ----
test('boilerplateUrls: URL across >=3 distinct authors is flagged, fewer is not', () => {
  const recs = [
    { author: 'a', links: ['https://app.example/id1'], images: [] },
    { author: 'b', links: ['https://app.example/id1'], images: [] },
    { author: 'c', links: ['https://app.example/id1'], images: [] },
    { author: 'a', links: ['https://app.example/id1'], images: [] }, // same author again: still 3 distinct
    { author: 'a', links: ['https://shared.example/2au'], images: [] },
    { author: 'b', links: ['https://shared.example/2au'], images: [] } // only 2 distinct -> keep
  ];
  const out = boilerplateUrls(recs, 3);
  assert.equal(out.has('https://app.example/id1'), true);
  assert.equal(out.has('https://shared.example/2au'), false);
});

test('boilerplateUrls: images count too; data:/blob: URLs are ignored', () => {
  const recs = [
    { author: 'a', links: [], images: ['https://img.example/banner.png'] },
    { author: 'b', links: [], images: ['https://img.example/banner.png'] },
    { author: 'c', links: [], images: ['https://img.example/banner.png', 'data:image/gif;base64,R0lGOD'] },
    { author: 'd', links: [], images: ['data:image/gif;base64,R0lGOD'] },
    { author: 'e', links: [], images: ['data:image/gif;base64,R0lGOD'] },
    { author: 'f', links: [], images: ['data:image/gif;base64,R0lGOD'] }
  ];
  const out = boilerplateUrls(recs, 3);
  assert.equal(out.has('https://img.example/banner.png'), true);
  assert.equal(out.has('data:image/gif;base64,R0lGOD'), false);
  assert.equal(out.size, 1);
});

// ---- isSmilieUrl (raw + percent-encoded proxy forms) ----
test('isSmilieUrl: matches raw, proxy-encoded, and legacy paths; spares real media', () => {
  assert.equal(isSmilieUrl('https://forums.example/images/smilies/Off/lmao.gif'), true);
  assert.equal(isSmilieUrl('https://cdn.example/styles/xenforo/smilies/popo/frown.png'), true);
  // image-proxy wrapped: /smilies/ only exists percent-encoded
  assert.equal(isSmilieUrl('https://forum.example/proxy.php?image=https%3A%2F%2Fcdn.example%2Fstyles%2Fsmilies%2Fpopo%2Ffrown.png&hash=ab'), true);
  assert.equal(isSmilieUrl('https://live.staticflickr.com/65535/49550633708_h.jpg'), false);
  assert.equal(isSmilieUrl('https://forum.example/attachments/photo-jpeg.12345/'), false);
  assert.equal(isSmilieUrl(''), false);
  assert.equal(isSmilieUrl(null), false);
  // malformed percent escape: must not throw; falls back to raw-only test
  assert.equal(isSmilieUrl('https://x.example/a%zz%2Fsmilies%2F'), false);
});

test('hqCandidates: marker-only and dims-prefixed chains; plain URLs untouched', () => {
  // marker-only (simp-family): full size = same path minus .md
  assert.deepEqual(hqCandidates('https://h.test/1dbcdc25-cfeb.md.jpg'),
    ['https://h.test/1dbcdc25-cfeb.jpg', 'https://h.test/1dbcdc25-cfeb.md.jpg']);
  // dims-prefixed: drop dims+marker → keep dims drop marker → original
  assert.deepEqual(hqCandidates('https://h.test/3024x4032_a.md.jpg'),
    ['https://h.test/a.jpg', 'https://h.test/3024x4032_a.jpg', 'https://h.test/3024x4032_a.md.jpg']);
  // .th marker, webp ext
  assert.deepEqual(hqCandidates('https://h.test/x.th.webp'), ['https://h.test/x.webp', 'https://h.test/x.th.webp']);
  // no marker → no chain
  assert.deepEqual(hqCandidates('https://h.test/plain.jpg'), ['https://h.test/plain.jpg']);
  assert.deepEqual(hqCandidates(''), ['']);
});

test('imagePageHref: /img/<id> landing shape only', () => {
  assert.equal(imagePageHref('https://host.test/img/t5kZz2y'), 'https://host.test/img/t5kZz2y');
  assert.equal(imagePageHref('/img/abc12'), 'https://x.invalid/img/abc12'); // resolved against base
  assert.equal(imagePageHref('https://host.test/img/has-extension.jpg'), ''); // direct file, not a page
  assert.equal(imagePageHref('https://host.test/gallery/t5kZz2y'), '');
  assert.equal(imagePageHref('https://host.test/img/' + 'x'.repeat(13)), 'https://host.test/img/' + 'x'.repeat(13)); // id gate matches the album pageId matcher ({3,64})
  assert.equal(imagePageHref('https://host.test/img/xx'), ''); // under 3 = not the shape
  assert.equal(imagePageHref(''), '');
});

test('parseImagePage: direct-image carriers in priority order', () => {
  // og:image wins; signed query kept verbatim
  const og = parseImagePage('<meta property="og:image" content="https://cdn.test/panda/UUID.jpg?s=SIG123"><img src="https://cdn.test/th/UUID2.jpg">');
  assert.equal(og[0], 'https://cdn.test/panda/UUID.jpg?s=SIG123');
  assert.ok(og.length >= 2); // the page's own <img> is a later candidate
  // meta refresh redirect
  assert.equal(parseImagePage('<meta http-equiv="refresh" content="0;url=https://cdn.test/direct/UUID.png">')[0], 'https://cdn.test/direct/UUID.png');
  // twitter:image before plain imgs
  const tw = parseImagePage('<meta name="twitter:image:src" content="https://cdn.test/tw/UUID.webp"><img src="https://cdn.test/a.jpg"><img src="https://cdn.test/b.jpg">');
  assert.equal(tw[0], 'https://cdn.test/tw/UUID.webp');
  assert.equal(tw.length, 3);
  // non-image and relative URLs dropped; duplicates deduped
  assert.deepEqual(parseImagePage('<img src="/relative.jpg"><a href="https://x.test/page">link</a><img src="https://cdn.test/a.jpg"><img src="https://cdn.test/a.jpg">'), ['https://cdn.test/a.jpg']);
  assert.deepEqual(parseImagePage(''), []);
  assert.deepEqual(parseImagePage('<html>no media here</html>'), []);
});

test('parseImageApiResponse: {image:{original_url}} extraction', () => {
  assert.equal(parseImageApiResponse('{"image":{"mime":"image/jpeg","original_url":"https://cdn.test/images4/UUID.jpg","medium_url":"https://cdn.test/images4/UUID2.jpg"}}'),
    'https://cdn.test/images4/UUID.jpg');
  assert.equal(parseImageApiResponse('{"message":"Not found"}'), ''); // API miss (route 2 takes over)
  assert.equal(parseImageApiResponse('<html>challenge</html>'), ''); // non-JSON
  assert.equal(parseImageApiResponse(''), '');
  assert.equal(parseImageApiResponse('{"image":{"original_url":"/relative.jpg"}}'), ''); // not absolute
});

// ---- album expansion (0.18) ----
test('isAlbumPageUrl: /a/<id> shapes', () => {
  assert.equal(isAlbumPageUrl('https://bunkr.cr/a/EAednZ0S'), true);
  assert.equal(isAlbumPageUrl('https://goonbox.cr/a/YDo0O5'), true);
  assert.equal(isAlbumPageUrl('https://x.invalid/a/abc-123_xyz'), true);
  assert.equal(isAlbumPageUrl('https://x.invalid/a/ab'), false);           // id < 3
  assert.equal(isAlbumPageUrl('https://x.invalid/a/a.mp4'), false);        // extension = file
  assert.equal(isAlbumPageUrl('https://x.invalid/a/one/two'), false);      // nested path
  assert.equal(isAlbumPageUrl('https://x.invalid/f/something'), false);
  assert.equal(isAlbumPageUrl('/a/EAednZ0S'), false);                      // not absolute
  assert.equal(isAlbumPageUrl('javascript:alert(1)'), false);
});

test('parseAlbumPage: bunkr-shaped item grid -> children', () => {
  const html = [
    '<html><body><div id="galleryGrid">',
    '<div class="relative group/item theItem" title="clip01.mp4">',
    '  <img class="grid-images_box-img" src="https://static.scdn.st/u1/thumbs/clip01.png">',
    '  <a class="after:absolute" href="/f/SLUGONE" aria-label="download"></a>',
    '</div>',
    '<div class="relative group/item theItem" title="photo &amp; 02.jpg">',
    '  <img class="grid-images_box-img" src="https://static.scdn.st/u1/thumbs/photo02.png">',
    '  <a class="after:absolute" href="/f/SLUGTWO" aria-label="download"></a>',
    '</div>',
    '<div class="relative group/item theItem" title="archive.zip">',
    '  <img class="grid-images_box-img" src="https://static.scdn.st/u1/thumbs/archive.png">',
    '  <a class="after:absolute" href="/f/SLUGTHREE" aria-label="download"></a>',
    '</div>',
    '</div></body></html>'
  ].join('');
  const kids = parseAlbumPage(html, 'https://host.invalid/a/alb1');
  assert.equal(kids.length, 2); // zip skipped — not playable media
  assert.deepEqual(kids[0], { url: 'https://host.invalid/f/SLUGONE', kind: 'video', thumb: 'https://static.scdn.st/u1/thumbs/clip01.png' });
  assert.equal(kids[1].kind, 'image');
  assert.equal(kids[1].url, 'https://host.invalid/f/SLUGTWO');
});

test('parseAlbumPage: empty shell / non-album html -> []', () => {
  assert.deepEqual(parseAlbumPage('', 'https://host.invalid/a/x'), []);
  assert.deepEqual(parseAlbumPage('<!doctype html><div id="app"></div>', 'https://host.invalid/a/x'), []);
});

test('parseAlbumApiResponse: goonbox shape -> children + pagination', () => {
  const j = JSON.stringify({
    album: { encoded_id: 'YDo0O5', images_count: 2 },
    images: [
      { encoded_id: 'i1', mime: 'image/jpeg', original_url: 'https://cdn.invalid/imgheaven/a.jpg', thumb_url: 'https://cdn.invalid/th/a.jpg' },
      { encoded_id: 'i2', mime: 'image/webp', original_url: 'https://cdn.invalid/imgheaven/b.webp', thumb_url: '' },
      { encoded_id: 'i3', mime: 'application/zip', original_url: 'https://cdn.invalid/x.zip', thumb_url: '' },
      { encoded_id: 'i4', mime: 'video/mp4', original_url: 'https://cdn.invalid/v.mp4', thumb_url: 'https://cdn.invalid/th/v.png' }
    ],
    pagination: { current_page: 1, last_page: 3, per_page: 100, total: 250 }
  });
  const p = parseAlbumApiResponse(j);
  assert.equal(p.lastPage, 3);
  assert.equal(p.children.length, 3); // zip entry skipped
  assert.deepEqual(p.children[0], { url: 'https://cdn.invalid/imgheaven/a.jpg', kind: 'image', thumb: 'https://cdn.invalid/th/a.jpg', pageId: 'i1' });
  assert.equal(p.children[2].kind, 'video');
  assert.equal(p.children[2].pageId, 'i4');
  // garbage
  assert.equal(parseAlbumApiResponse('<html>not json</html>'), null);
  assert.equal(parseAlbumApiResponse('{"images": null}'), null);
});