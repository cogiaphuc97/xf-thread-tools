// Unit tests for the media module (src/media.mjs). Regrouped to mirror the src/ split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { albumDisplayName, albumHostMatches, boilerplateUrls, derivedVideoPoster, gofileAccountsUrl, gofileApiOrigin, gofileContentsUrl, hqCandidates, imagePageHref, isAlbumPageUrl, isSmilieUrl, pairUnfurlPosters, parseAlbumApiResponse, parseAlbumPage, parseAlbumTitle, parseCyberdropAuth, parseCyberdropFileAnchors, parseCyberdropFileinfo, parseGofileAccounts, parseGofileContents, parseImageApiResponse, parseImagePage, unwrapExitLink } from '../src/media.mjs';


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
  assert.equal(isAlbumPageUrl('https://goonbox.cr/a/some-model-album-pics.3tkY1'), true); // 0.27: XF-style dotted slug (real-world miss)
  assert.equal(isAlbumPageUrl('https://x.invalid/a/abc-123_xyz'), true);
  assert.equal(isAlbumPageUrl('https://x.invalid/a/ab'), false);           // id < 3
  assert.equal(isAlbumPageUrl('https://x.invalid/a/a.mp4'), true);         // 0.27: dot legal — indistinguishable from a dotted slug; /a/ is the album path family
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

test('parseAlbumPage: bunkr window.albumFiles array -> /f/<slug> children (0.27)', () => {
  const html = [
    '<!doctype html><html><head><title>Some Album | BUNKR</title></head><body><div id="app"></div>',
    '<script>',
    'window.albumFiles = [{\n',
    "  id: 1, name: \"b3f0c9d2.mp4\",\n",
    "  original: 'model - clip \\'01\\'.mp4',\n",
    "  slug: 'slugV1', size: 1048576 ,\n",
    '  timestamp: "12:00:00 01/01/2026"\n',
    '},\n',
    '{\n',
    "  id: 2, name: \"aa11bb22.jpg\",\n",
    "  original: 'photo 02.jpg',\n",
    "  slug: 'slugI2', size: 2048 ,\n",
    '  timestamp: "12:00:01 01/01/2026"\n',
    '},\n',
    '{\n',
    "  id: 3, name: \"cc33.zip\",\n",
    "  original: 'bundle.zip',\n",
    "  slug: 'slugZ3', size: 4096 ,\n",
    '  timestamp: "12:00:02 01/01/2026"\n',
    '}];',
    '</script>',
    // stray markup that the OLD branches would match — must be IGNORED
    // when albumFiles carries media (authoritative list)
    '<div class="relative group/item theItem" title="stray.mp4">',
    '  <img class="grid-images_box-img" src="https://static.scdn.st/u1/thumbs/stray.png">',
    '  <a href="/f/STRAY"></a>',
    '</div>',
    '</body></html>'
  ].join('');
  const kids = parseAlbumPage(html, 'https://host.invalid/a/alb.dot1');
  assert.equal(kids.length, 2); // zip skipped
  assert.deepEqual(kids[0], { url: 'https://host.invalid/f/slugV1', kind: 'video', thumb: '', name: "model - clip '01'.mp4" }); // \\' unescaped
  assert.deepEqual(kids[1], { url: 'https://host.invalid/f/slugI2', kind: 'image', thumb: '', name: 'photo 02.jpg' });
  assert.ok(!kids.some((k) => /STRAY/.test(k.url))); // authoritative: stray theItem skipped
});

test('parseAlbumPage: albumFiles WITHOUT media falls through to the older branches', () => {
  const html = [
    '<script>window.albumFiles = [];</script>',
    '<div class="relative group/item theItem" title="only.mp4">',
    '  <img src="https://static.scdn.st/u1/thumbs/only.png">',
    '  <a href="/f/ONLY1"></a>',
    '</div>'
  ].join('');
  const kids = parseAlbumPage(html, 'https://host.invalid/a/x1');
  assert.equal(kids.length, 1);
  assert.equal(kids[0].url, 'https://host.invalid/f/ONLY1');
});

test('parseAlbumTitle: <title> extraction, entity unescape, whitespace collapse', () => {
  assert.equal(parseAlbumTitle('<html><head><title>My Album 2026</title></head><body></body></html>'), 'My Album 2026');
  assert.equal(parseAlbumTitle('<title>  spaced   out &amp;  tidy &quot;x&quot; </title>'), 'spaced out & tidy "x"');
  assert.equal(parseAlbumTitle("<title>it&#39;s here</title>"), "it's here");
  assert.equal(parseAlbumTitle('<TITLE>case insensitive</TITLE>'), 'case insensitive');
  assert.equal(parseAlbumTitle('<!doctype html><div id="app"></div>'), ''); // SPA shell: no title
  assert.equal(parseAlbumTitle(''), '');
});

test('albumDisplayName: parsed title wins, /a/<slug> fallback, garbage url last resort', () => {
  assert.equal(albumDisplayName('https://h.invalid/a/ab12', 'Parsed Name'), 'Parsed Name');
  assert.equal(albumDisplayName('https://h.invalid/a/ab12', ''), 'ab12'); // slug fallback
  assert.equal(albumDisplayName('https://h.invalid/a/ab12', undefined), 'ab12');
  assert.equal(albumDisplayName('https://h.invalid/a/ab12', '   '), 'ab12'); // blank name -> slug
  assert.equal(albumDisplayName('https://h.invalid/a/pics-gallery.7Qk2x', ''), 'pics-gallery.7Qk2x'); // 0.27: dotted slug
  assert.equal(albumDisplayName('https://h.invalid/other', ''), 'https://h.invalid/other'); // no slug shape
  assert.equal(albumDisplayName('', ''), '?');
});

test('parseAlbumApiResponse: name/title field surfaces as album display name', () => {
  const mk = (extra) => parseAlbumApiResponse(JSON.stringify(Object.assign({
    images: [{ encoded_id: 'i1', mime: 'image/jpeg', original_url: 'https://cdn.invalid/a.jpg', thumb_url: '' }],
    pagination: { last_page: 1 }
  }, extra)));
  assert.equal(mk({ name: 'Album Name' }).name, 'Album Name');
  assert.equal(mk({ title: 'Album Title' }).name, 'Album Title'); // secondary field
  assert.equal(mk({}).name, ''); // absent -> '' (slug fallback at read)
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
// ---- pairUnfurlPosters (unfurl-card poster pairing, 0.25.2) ----
test('pairUnfurlPosters: card directly before its video pairs', () => {
  const out = pairUnfurlPosters(['u', 'https://cdn.example/fr.jpeg', 'v', 'https://cdn.example/clip.webm']);
  assert.deepEqual(out, { 'https://cdn.example/clip.webm': 'https://cdn.example/fr.jpeg' });
});
test('pairUnfurlPosters: interleaved cards pair 1:1 in document order', () => {
  const out = pairUnfurlPosters([
    'u', 'https://c/a.fr.jpeg', 'v', 'https://c/a.webm',
    'u', 'https://c/b.fr.jpeg', 'v', 'https://c/b.webm'
  ]);
  assert.equal(out['https://c/a.webm'], 'https://c/a.fr.jpeg');
  assert.equal(out['https://c/b.webm'], 'https://c/b.fr.jpeg');
});
test('pairUnfurlPosters: card with no following video is ignored; posterless video stays bare', () => {
  const out = pairUnfurlPosters(['u', 'https://c/img.fr.jpeg', 'u', 'https://c/v.fr.jpeg', 'v', 'https://c/v.webm']);
  assert.deepEqual(Object.keys(out), ['https://c/v.webm']);
  assert.equal(out['https://c/v.webm'], 'https://c/v.fr.jpeg');
  const out2 = pairUnfurlPosters(['v', 'https://c/x.webm']);
  assert.deepEqual(out2, {});
});
test('pairUnfurlPosters: one card never feeds two videos (consumed on use)', () => {
  const out = pairUnfurlPosters(['u', 'https://c/one.fr.jpeg', 'v', 'https://c/one.webm', 'v', 'https://c/two.webm']);
  assert.deepEqual(Object.keys(out), ['https://c/one.webm']);
});

// ---- parseAlbumPage: erome shapes (0.26 US-002) ----
test('parseAlbumPage: erome images (div.img data-src = original, reused as thumb)', () => {
  const html = `<div class="media-group" id="1">
    <div class="img" data-src="https://s20.example.com/9551/abc/tMr1.jpg?v=1"><div class="img-box"><img class="img-front" src="https://s20.example.com/9551/abc/tMr1.jpg?v=1"></div></div>
  </div>
  <div class="media-group" id="2">
    <div class="img" data-src="https://s20.example.com/9551/abc/l7U2.png"><div class="img-box"><img class="img-back" src="https://s20.example.com/9551/abc/l7U2.png"></div></div>
  </div>`;
  const kids = parseAlbumPage(html, 'https://www.example.org/a/abc');
  assert.equal(kids.length, 2);
  assert.deepEqual(kids[0], { url: 'https://s20.example.com/9551/abc/tMr1.jpg?v=1', kind: 'image', thumb: 'https://s20.example.com/9551/abc/tMr1.jpg?v=1' });
  assert.equal(kids[1].kind, 'image');
});
test('parseAlbumPage: erome videos pick highest-res source, poster as thumb, dedupe player copies', () => {
  const html = `<div class="media-group" id="1">
    <div class="img" data-html="#video1"></div>
    <div class="video-lg" id="video1"><video poster="https://s93.example.com/9551/abc/v1.jpg"><source src="https://v60.example.com/9551/abc/v1_720p.mp4" type='video/mp4' label='HD' res='720'><source src="https://v60.example.com/9551/abc/v1_360p.mp4" type='video/mp4' label='SD' res='360'></video></div>
    <div class="video"><video poster="https://s93.example.com/9551/abc/v1.jpg"><source src="https://v60.example.com/9551/abc/v1_720p.mp4" type='video/mp4' label='HD' res='720'></video></div>
  </div>
  <div class="media-group" id="2">
    <div class="img" data-html="#video2"></div>
    <div class="video"><video poster="https://s93.example.com/9551/abc/v2.jpg"><source src="https://v60.example.com/9551/abc/v2.webm" type='video/webm'></video></div>
  </div>`;
  const kids = parseAlbumPage(html, 'https://www.example.org/a/abc');
  assert.equal(kids.length, 2);
  assert.deepEqual(kids[0], { url: 'https://v60.example.com/9551/abc/v1_720p.mp4', kind: 'video', thumb: 'https://s93.example.com/9551/abc/v1.jpg' });
  assert.deepEqual(kids[1], { url: 'https://v60.example.com/9551/abc/v2.webm', kind: 'video', thumb: 'https://s93.example.com/9551/abc/v2.jpg' });
});
test('parseAlbumPage: video-ref div.img (data-html) yields nothing; theItem path unaffected', () => {
  const onlyRef = '<div class="img" data-html="#video9"></div>';
  assert.deepEqual(parseAlbumPage(onlyRef, 'https://www.example.org/a/x'), []);
  const item = '<div class="theItem"><a title="a.jpg" href="/f/slug1"><img src="https://x.example/t.png"></a></div>';
  const kids = parseAlbumPage(item, 'https://www.example.org/a/x');
  assert.equal(kids.length, 1);
  assert.equal(kids[0].url, 'https://www.example.org/f/slug1');
});

// ---- gofile-shaped albums (0.26 US-003) ----
test('albumHostMatches: exact, subdomain, wildcard-ish, non-match, garbage', () => {
  assert.equal(albumHostMatches('https://app.example.io/d/abc', ['example.io']), true);
  assert.equal(albumHostMatches('https://example.io/d/abc', ['example.io']), true);
  assert.equal(albumHostMatches('https://www.example.io/d/abc', ['*.example.io']), true);
  assert.equal(albumHostMatches('https://notexample.io/d/abc', ['example.io']), false);
  assert.equal(albumHostMatches('https://example.io/d/abc', []), false);
  assert.equal(albumHostMatches('https://example.io/d/abc', ['', '  ', 'x']), false);
  assert.equal(albumHostMatches('not a url', ['example.io']), false);
  assert.equal(albumHostMatches('https://example.io/d/abc', 'example.io'), false); // non-array tolerated
});
test('gofileApiOrigin: drops the first DNS label on 3+ label hosts, keeps ports out', () => {
  assert.equal(gofileApiOrigin('https://app.example.io/d/abc'), 'https://api.example.io');
  assert.equal(gofileApiOrigin('https://example.io/d/abc'), 'https://api.example.io');
  assert.equal(gofileApiOrigin('https://example.io:8443/d/abc'), 'https://api.example.io');
  assert.equal(gofileApiOrigin(''), '');
});
test('gofile URL builders', () => {
  assert.equal(gofileAccountsUrl('https://api.example.io/'), 'https://api.example.io/accounts');
  assert.equal(gofileContentsUrl('https://api.example.io', 'aBc/12', 'T K'), 'https://api.example.io/contents/aBc%2F12?wt=T%20K');
});
test('parseGofileAccounts / parseGofileContents', () => {
  assert.equal(parseGofileAccounts('{"status":"ok","data":{"token":"tok123"}}'), 'tok123');
  assert.equal(parseGofileAccounts('{"status":"error"}'), '');
  assert.equal(parseGofileAccounts('not json'), '');
  const j = JSON.stringify({ status: 'ok', data: { id: 'f1', name: 'folder name', type: 'folder', children: {
    a: { id: 'a', name: 'pic1.jpg', type: 'file', mimetype: 'image/jpeg', link: 'https://store.example.io/dl/pic1.jpg' },
    b: { id: 'b', name: 'clip.mp4', type: 'file', mimeType: 'video/mp4', link: 'https://store.example.io/dl/clip.mp4' },
    c: { id: 'c', name: 'weird.bin', type: 'file', link: 'https://store.example.io/dl/weird.bin' },   // no kind -> skipped
    d: { id: 'd', name: 'sub', type: 'folder', link: 'https://app.example.io/d/sub' },               // folder -> skipped
    e: { id: 'e', name: 'noext.gif', type: 'file', link: 'rel/x.gif' }                                // relative -> skipped
  } } });
  const p = parseGofileContents(j);
  assert.deepEqual(p.children, [
    { url: 'https://store.example.io/dl/pic1.jpg', kind: 'image', thumb: '' },
    { url: 'https://store.example.io/dl/clip.mp4', kind: 'video', thumb: '' }
  ]);
  assert.equal(p.name, 'folder name');
  assert.equal(parseGofileContents('not json'), null);
  assert.equal(parseGofileContents('{"status":"ok","data":{}}'), null); // data without children keys later? data exists, children missing -> {children:[],name:''}
  const empty = parseGofileContents('{"status":"ok","data":{"children":{}}}');
  assert.deepEqual(empty, { children: [], name: '' }); // resolved-empty album
});

// ---- unwrapExitLink (forum external-link gates, 0.28) ----
test('unwrapExitLink: anchor TEXT is the target (XF autolink shape)', () => {
  assert.equal(unwrapExitLink('/phpBB2/external-link-exit/?t=v1.whatever.sig', 'https://gofile.io/d/3jrpC7', 'https://forum.example'), 'https://gofile.io/d/3jrpC7');
  assert.equal(unwrapExitLink('/exit/', '  https://ext.example/x  ', 'https://forum.example'), 'https://ext.example/x'); // whitespace-trimmed
});
test('unwrapExitLink: t=v1 base64url token (caption text, no URL)', () => {
  const tok = Buffer.from('https://gofile.io/d/3jrpC7').toString('base64url');
  assert.equal(unwrapExitLink('https://forum.example/external-link-exit/?t=v1.' + tok + '.9c24794ea3a02900', 'download here', 'https://forum.example'), 'https://gofile.io/d/3jrpC7');
  assert.equal(unwrapExitLink('https://forum.example/exit/?t=v1.####.x', 'download here', 'https://forum.example'), ''); // malformed token
});
test('unwrapExitLink: generic url=-style gate params', () => {
  assert.equal(unwrapExitLink('/redirect/?url=' + encodeURIComponent('https://ext.example/r'), 'r', 'https://forum.example'), 'https://ext.example/r');
  assert.equal(unwrapExitLink('/away/?to=https%3A%2F%2Fext.example%2Ft', 't', 'https://forum.example'), 'https://ext.example/t');
});
test('unwrapExitLink: keeps plain / same-host / non-gate anchors', () => {
  assert.equal(unwrapExitLink('https://ext.example/page', 'https://ext.example/page', 'https://forum.example'), ''); // href already external: not a gate
  assert.equal(unwrapExitLink('/threads/777/', 'https://forum.example/threads/777/', 'https://forum.example'), ''); // text same host
  assert.equal(unwrapExitLink('/attachments/a-b.jpg', 'pic.jpg', 'https://forum.example'), ''); // no URL text, no token
  assert.equal(unwrapExitLink('not a url', 'nope', 'https://forum.example'), ''); // unparseable href
});

// ---- derivedVideoPoster (inline attachment videos, 0.28.1) ----
test('derivedVideoPoster: /data/video sibling thumb under /data/attachments', () => {
  assert.equal(derivedVideoPoster('https://forum.example/phpBB2/data/video/5093/5093796-29057c1afaf660a9168e933a1de934aa.mp4?hash=_Fe1QbExkW'), 'https://forum.example/phpBB2/data/attachments/5093/5093796-29057c1afaf660a9168e933a1de934aa.jpg');
  assert.equal(derivedVideoPoster('https://forum.example/data/video/12/ab-cd_123.mp4'), 'https://forum.example/data/attachments/12/ab-cd_123.jpg'); // root install
});
test('derivedVideoPoster: non-matching shapes stay empty', () => {
  assert.equal(derivedVideoPoster('https://cdn.example/vz/e1_720p.mp4'), '');            // no /data/video/ family
  assert.equal(derivedVideoPoster('https://forum.example/phpBB2/data/video/5093/x.jpg'), ''); // not mp4
  assert.equal(derivedVideoPoster('https://forum.example/phpBB2/data/video/abc/x.mp4'), '');  // dir not digits
  assert.equal(derivedVideoPoster('/phpBB2/data/video/5093/x.mp4'), '');               // relative (callers pass absolute)
  assert.equal(derivedVideoPoster(''), '');
});

// ---- cyberdrop-shaped albums (0.27) ----
test('parseCyberdropFileAnchors: id="file" /f/ anchors, attribute order + dedupe', () => {
  const html = [
    '<a id="file" href="/f/abc123">one</a>',
    '<a href="/f/def456" id="file" class="x">two</a>',
    '<a id="file" href="/f/abc123">dup of one</a>',
    '<a id="other" href="/f/zzz">not a file anchor</a>',
    '<a id="file" href="/v/nope">wrong path family</a>',
    '<a id="file" href="/f/ghi.789">dotted id</a>'
  ].join('');
  assert.deepEqual(parseCyberdropFileAnchors(html), ['abc123', 'def456', 'ghi.789']);
  assert.deepEqual(parseCyberdropFileAnchors(''), []);
  assert.deepEqual(parseCyberdropFileAnchors('<div>no anchors</div>'), []);
});

test('parseCyberdropFileinfo: filename|name tolerance + auth_url requirement', () => {
  assert.deepEqual(parseCyberdropFileinfo('{"filename":"pic-12.jpg","auth_url":"https://api.example.io/auth/12"}'), { name: 'pic-12.jpg', authUrl: 'https://api.example.io/auth/12' });
  assert.deepEqual(parseCyberdropFileinfo('{"name":"clip.mp4","auth_url":"https://api.example.io/auth/13"}'), { name: 'clip.mp4', authUrl: 'https://api.example.io/auth/13' });
  assert.equal(parseCyberdropFileinfo('{"name":"x.jpg"}'), null);            // no auth_url
  assert.equal(parseCyberdropFileinfo('{"name":"x.jpg","auth_url":"rel"}'), null); // relative auth
  assert.equal(parseCyberdropFileinfo('{"auth_url":"https://ok/"}'), null);  // no name
  assert.equal(parseCyberdropFileinfo('not json'), null);
});

test('parseCyberdropAuth: direct url from the auth hop', () => {
  assert.equal(parseCyberdropAuth('{"url":"https://serve.example.io/f/pic-12.jpg"}'), 'https://serve.example.io/f/pic-12.jpg');
  assert.equal(parseCyberdropAuth('{"url":"/relative"}'), '');
  assert.equal(parseCyberdropAuth('{}'), '');
  assert.equal(parseCyberdropAuth('not json'), '');
});
