// replies: pure helpers for the per-post replies lookup (0.25.0).
// "Who replied to this post?" has no local edge in XF2 — a quote is a
// rendered copy living in the REPLIER's body — so the forum's own search
// engine is the index: q=post-<id> scoped to the thread, date-sorted.
// The result page is parsed with regexes (no DOM) like parseImagePage.

// Generic XF2 search wire shape (works on stock search):
//   <origin>/search/1/?q=post-<postId>&t=post&c[thread]=<threadId>&o=date
export function repliesSearchUrl(origin, postId, threadId) {
  const o = String(origin || '').replace(/\/+$/, '');
  return o + '/search/1/?q=post-' + encodeURIComponent(postId) +
    '&t=post&c[thread]=' + encodeURIComponent(threadId) + '&o=date';
}

const REPLY_ROW_RE = /<li\b[^>]*class="[^"]*\bblock-row--separated\b[^"]*"[^>]*>[\s\S]*?<\/li>/g;
const POST_LINK_RE = /<a\b[^>]*href="([^"]*\/post-(\d+)[^"]*)"/;
const TIME_TAG_RE = /<time\b([^>]*)>([\s\S]*?)<\/time>/;
const DATETIME_RE = /datetime="([^"]*)"/;
const SNIPPET_RE = /<div\b[^>]*class="[^"]*\bcontentRow-snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/;
const PAGENAV_RE = /class="[^"]*\bpageNav\b[^"]*"/;

const REPLY_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeReplyEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ''; }
    })
    .replace(/&([a-z]+);/gi, (m, name) => (name.toLowerCase() in REPLY_ENTITIES ? REPLY_ENTITIES[name.toLowerCase()] : m));
}

// parseRepliesPage(html) -> { rows, more }
//   rows: [{ postId, href, date, dateIso, snippet }] in result order
//   (XF date sort = newest first). href stays as-written (usually relative);
//   the runtime absolutizes against the page origin. Rows whose post link
//   can't be found are skipped. `more` = a pager is present (we only ever
//   read page 1 — the footer links to the search for the rest).
export function parseRepliesPage(html) {
  const rows = [];
  const s = String(html || '');
  if (!s) return { rows, more: false };
  for (const m of s.matchAll(REPLY_ROW_RE)) {
    const chunk = m[0];
    const link = chunk.match(POST_LINK_RE);
    if (!link) continue;
    const time = chunk.match(TIME_TAG_RE);
    const dtm = time ? (time[1] || '').match(DATETIME_RE) : null;
    const snip = chunk.match(SNIPPET_RE);
    rows.push({
      postId: link[2],
      href: decodeReplyEntities(link[1]),
      date: time ? decodeReplyEntities(time[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim() : '',
      dateIso: dtm ? dtm[1] : '',
      snippet: snip ? decodeReplyEntities(snip[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : ''
    });
  }
  return { rows, more: PAGENAV_RE.test(s) };
}
