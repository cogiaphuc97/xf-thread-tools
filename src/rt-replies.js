// rt-replies: per-post replies table (0.25.0). A "View replies" bar under
// every post; first open asks the forum search (XF2 shape, q=post-<id>
// scoped to the thread) for posts quoting that post and renders a
// Post # / Date / Reply table. Session-cached per post id; failures cool
// down 30s. Shape-based: host selector in BASE_SEL, URL from
// location.origin at runtime. Sorter clones (built from scratch in
// buildClone) never carry the button; sorter-moved ORIGINALS keep theirs.
const repliesCache = new Map();   // postId -> rows[]
const repliesCool = new Map();    // postId -> ms of last failure
const REPLIES_COOL_MS = 30000;

function attachRepliesButtons() {
  for (const art of document.querySelectorAll(SEL.post)) {
    const host = (SEL.repliesHost && art.querySelector(SEL.repliesHost)) || art;
    if (host.querySelector('.xft-rbtn')) continue;
    const dc = art.getAttribute('data-content') || '';
    if (dc.indexOf('post-') !== 0) continue;
    const pid = dc.slice(5);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xft-rbtn';
    btn.dataset.xftPid = pid;
    btn.textContent = 'View replies';
    btn.addEventListener('click', () => onRepliesToggle(btn, host, pid));
    host.appendChild(btn);
  }
}

function onRepliesToggle(btn, host, pid) {
  let wrap = host.querySelector('.xft-rwrap[data-xft-pid="' + pid + '"]');
  if (wrap) {
    const hidden = wrap.hasAttribute('hidden');
    if (hidden) wrap.removeAttribute('hidden'); else wrap.setAttribute('hidden', '');
    btn.textContent = hidden ? 'Hide replies' : 'View replies';
    return;
  }
  wrap = document.createElement('div');
  wrap.className = 'xft-rwrap';
  wrap.dataset.xftPid = pid;
  const load = document.createElement('div');
  load.className = 'xft-rload';
  load.textContent = 'Loading replies…';
  wrap.appendChild(load);
  host.appendChild(wrap);
  btn.textContent = 'Hide replies';
  if (repliesCache.has(pid)) { renderReplies(wrap, repliesCache.get(pid), false, ''); return; }
  if (Date.now() - (repliesCool.get(pid) || 0) < REPLIES_COOL_MS) { renderRepliesError(wrap); return; }
  const url = repliesSearchUrl(location.origin, pid, threadId);
  let settled = false;
  const done = (html) => {
    if (settled) return; settled = true;
    const parsed = parseRepliesPage(html);
    // a post matching its own reference is not a reply to itself
    const rows = parsed.rows.filter((r) => r.postId !== pid);
    repliesCache.set(pid, rows);
    renderReplies(wrap, rows, parsed.more, url);
  };
  const fail = () => {
    if (settled) return; settled = true;
    repliesCool.set(pid, Date.now());
    renderRepliesError(wrap);
  };
  gmGetText(url, done, fail);
}

function renderReplies(wrap, rows, more, searchUrl) {
  wrap.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'xft-rload';
    empty.textContent = 'No replies found.';
    wrap.appendChild(empty);
    return;
  }
  const table = document.createElement('div');
  table.className = 'xft-rtable';
  const head = document.createElement('div');
  head.className = 'xft-rrow xft-rhead';
  for (const t of ['Post #', 'Date', 'Reply']) {
    const c = document.createElement('span');
    c.textContent = t;
    head.appendChild(c);
  }
  table.appendChild(head);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'xft-rrow';
    const num = document.createElement('span');
    num.className = 'xft-rnum';
    const a = document.createElement('a');
    try { a.href = new URL(r.href, location.origin).href; } catch (e) { a.href = r.href; }
    a.textContent = '#' + r.postId;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    num.appendChild(a);
    const dt = document.createElement('span');
    dt.className = 'xft-rdate';
    dt.textContent = r.date || '';
    if (r.dateIso) dt.title = r.dateIso;
    const sn = document.createElement('span');
    sn.className = 'xft-rsnip';
    appendLinkedText(sn, r.snippet);
    row.append(num, dt, sn);
    table.appendChild(row);
  }
  wrap.appendChild(table);
  if (more && searchUrl) {
    const m = document.createElement('a');
    m.className = 'xft-rmore';
    m.href = searchUrl;
    m.target = '_blank';
    m.rel = 'noopener noreferrer';
    m.textContent = 'Older replies may exist — open search';
    wrap.appendChild(m);
  }
}

// text + http(s) links only — model output-style discipline: raw text never
// touches innerHTML, link hrefs locked to http(s) at parse time
function appendLinkedText(el, text) {
  const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
  const s = String(text || '');
  let last = 0, m;
  while ((m = URL_RE.exec(s))) {
    if (m.index > last) el.appendChild(document.createTextNode(s.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[1];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = m[1];
    el.appendChild(a);
    last = m.index + m[1].length;
  }
  if (last < s.length) el.appendChild(document.createTextNode(s.slice(last)));
}

function renderRepliesError(wrap) {
  wrap.replaceChildren();
  const err = document.createElement('div');
  err.className = 'xft-rload';
  err.textContent = 'Replies unavailable — try again shortly.';
  wrap.appendChild(err);
}
