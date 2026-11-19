// Unit tests for the per-post replies lookup (src/replies.mjs, 0.25.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repliesSearchUrl, parseRepliesPage } from '../src/replies.mjs';

test('repliesSearchUrl builds the XF2 search shape', () => {
  assert.equal(
    repliesSearchUrl('https://example.forum', '14439085', '777'),
    'https://example.forum/search/1/?q=post-14439085&t=post&c[thread]=777&o=date'
  );
  // trailing slash on the origin is normalized away
  assert.equal(
    repliesSearchUrl('https://example.forum/', '5', '12'),
    'https://example.forum/search/1/?q=post-5&t=post&c[thread]=12&o=date'
  );
  // empty origin still yields the path shape (runtime always passes origin)
  assert.ok(repliesSearchUrl('', '5', '12').startsWith('/search/1/'));
});

test('parseRepliesPage reads stock XF search rows', () => {
  const html = `<!doctype html><html><body><div class="block-container"><ol class="block-body">
  <li class="block-row block-row--separated js-inlineModContainer" data-author="alice">
    <div class="contentRow"><div class="contentRow-main">
      <h3 class="contentRow-title"><a href="/threads/some-thread.12345/post-2146320/">some thread</a></h3>
      <div class="contentRow-minor"><a href="/members/alice.1/">alice</a> <time class="u-dt" datetime="2026-02-27T12:34:00+00:00" dir="auto">Feb 27, 2026</time></div>
      <div class="contentRow-snippet">re: your post &amp; see https://example.net/x</div>
    </div></div>
  </li>
  <li class="block-row block-row--separated js-inlineModContainer" data-author="bob">
    <div class="contentRow"><div class="contentRow-main">
      <h3 class="contentRow-title"><a href="/threads/some-thread.12345/post-2146500/">some thread</a></h3>
      <div class="contentRow-minor"><time class="u-dt" datetime="2026-02-26T01:02:03+00:00">Feb 26, 2026</time></div>
      <div class="contentRow-snippet">plain <b>snippet</b> text</div>
    </div></div>
  </li>
  </ol></div></body></html>`;
  const { rows, more } = parseRepliesPage(html);
  assert.equal(more, false);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    postId: '2146320',
    href: '/threads/some-thread.12345/post-2146320/',
    date: 'Feb 27, 2026',
    dateIso: '2026-02-27T12:34:00+00:00',
    snippet: 're: your post & see https://example.net/x'
  });
  // tags inside snippet collapse; time text decoded
  assert.equal(rows[1].snippet, 'plain snippet text');
  assert.equal(rows[1].postId, '2146500');
});

test('parseRepliesPage flags a pager and skips rows without post links', () => {
  const html = `<ol class="block-body">
  <li class="block-row block-row--separated js-inlineModContainer">
    <div class="contentRow-main"><h3><a href="/threads/t.1/no-post-here/">x</a></h3>
    <div class="contentRow-snippet">no post link</div></div>
  </li>
  <li class="block-row block-row--separated js-inlineModContainer">
    <div class="contentRow-main"><a href="/threads/t.1/post-9/">nine</a>
    <div class="contentRow-snippet">yes</div></div>
  </li>
  </ol><nav class="pageNav"><div class="pageNav-inner"><a class="pageNav-jump">2</a></div></nav>`;
  const { rows, more } = parseRepliesPage(html);
  assert.equal(more, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].postId, '9');
});

test('parseRepliesPage tolerates empty/missing pieces', () => {
  assert.deepEqual(parseRepliesPage(''), { rows: [], more: false });
  assert.deepEqual(parseRepliesPage(null), { rows: [], more: false });
  // row with a post link but no time/snippet still yields a usable entry
  const html = '<li class="block-row block-row--separated js-inlineModContainer">' +
    '<a href="/threads/t.1/post-7/">x</a></li>';
  const { rows } = parseRepliesPage(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].postId, '7');
  assert.equal(rows[0].date, '');
  assert.equal(rows[0].snippet, '');
});

test('parseRepliesPage decodes numeric entities in snippets', () => {
  const html = '<li class="block-row block-row--separated js-inlineModContainer">' +
    '<a href="/threads/t.1/post-3/">x</a><div class="contentRow-snippet">&#9829; &lt;3 &quot;q&quot;</div></li>';
  const { rows } = parseRepliesPage(html);
  assert.equal(rows[0].snippet, '♥ <3 "q"');
});
