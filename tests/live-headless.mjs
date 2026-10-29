// Headless live harness — verifies the userscript against a real thread page
// with a throwaway Chrome profile (no visible window, no user-session popups).
//
//   node tests/live-headless.mjs [threadUrl]
//
// Not part of `npm test` (needs Chrome + network). Structure-only probes:
// counts and element presence, never page content.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CHROME = '/opt/google/chrome/chrome';
const PORT = 9333;
const PROFILE = '/tmp/xf-headless-profile-' + process.pid;
const URL = process.argv[2] || 'https://xamvn.my/threads/224067/';
const INJECT = '/tmp/xf-serve/inject.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-features=Translate', '--window-size=1400,900',
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
  'about:blank'
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch (e) {} };
process.on('exit', cleanup);

async function pageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url === 'about:blank')
        || list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* endpoint not up yet */ }
    await sleep(250);
  }
  throw new Error('chrome devtools endpoint never came up');
}

// Minimal CDP client over the global WebSocket (node >= 21).
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        waitEvent(method, timeoutMs = 60000) {
          return new Promise((res, rej) => {
            const tryTake = () => {
              const i = events.findIndex((e) => e.method === method);
              if (i >= 0) return events.splice(i, 1)[0].params;
              return null;
            };
            const got = tryTake();
            if (got) return res(got);
            const t = setTimeout(() => rej(new Error('timeout waiting ' + method)), timeoutMs);
            const poll = setInterval(() => {
              const p = tryTake();
              if (p) { clearTimeout(t); clearInterval(poll); res(p); }
            }, 100);
          });
        },
        close: () => ws.close()
      });
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else if (msg.method) events.push(msg);
    });
  });
}

async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

try {
  const cdp = await connect(await pageWs());
  await cdp.send('Page.enable');

  // 1. Load the live page
  const navP = cdp.waitEvent('Page.loadEventFired', 45000);
  await cdp.send('Page.navigate', { url: URL });
  await navP;
  await sleep(3000); // let the forum's own JS settle

  const isThread = await ev(cdp, `document.documentElement.id === 'XF' && document.documentElement.dataset.template === 'thread_view'`);
  check('thread page rendered', isThread === true);

  // 2. Disable background auto-fetch so the run stays deterministic, then inject
  await ev(cdp, `localStorage.setItem('xft_xfThreadTools:settings', JSON.stringify({ autoFetch: 0, delayMs: 250 })); true`);
  await cdp.send('Runtime.evaluate', { expression: readFileSync(INJECT, 'utf8') });
  await sleep(1500);

  const boot = await ev(cdp, `({
    sortBtn: !!document.getElementById('xft-sort-btn'),
    sortLabel: (document.getElementById('xft-sort-btn') || {}).textContent || '',
    panel: !!document.getElementById('xft-panel'),
    edge: !!document.getElementById('xft-edge-btn')
  })`);
  check('toolbar + panel + edge button injected', boot.sortBtn && boot.panel && boot.edge, 'label=' + JSON.stringify(boot.sortLabel));

  // 3. Open panel; sub-tabs must exist with counts; unfurl logos must be absent
  await ev(cdp, `document.getElementById('xft-edge-btn').click(); true`);
  await sleep(800);
  const panel = await ev(cdp, `({
    open: document.getElementById('xft-panel').classList.contains('xft-open'),
    subtabs: Array.from(document.querySelectorAll('#xft-panel .xft-subtab')).map((b) => b.textContent.trim()),
    unfurlSrcs: Array.from(document.images).filter((i) => i.classList.contains('bbCodeBlockUnfurl-image')).map((i) => i.src),
    // media a post AUTHORED itself: outside every blockquote.bbCodeBlock--quote
    ownSrcs: Array.from(document.querySelectorAll('article img.bbImage, article video'))
      .filter((el) => !el.closest('blockquote.bbCodeBlock--quote'))
      .map((el) => el.src || (el.querySelector('source') || {}).src || '')
      .filter(Boolean),
    quotedSrcs: Array.from(document.querySelectorAll('article blockquote.bbCodeBlock--quote img.bbImage')).map((i) => i.src),
    cellSrcs: Array.from(document.querySelectorAll('#xft-panel .xft-cell img, #xft-panel .xft-cell video')).map((el) => el.src)
  })`);
  check('panel opens', panel.open === true);
  check('sub-tabs All/Image/Video present', panel.subtabs.length === 3 && panel.subtabs.every((t) => /^(All|Image|Video) \d+$/.test(t)), panel.subtabs.join(' | '));
  const leak = panel.cellSrcs.filter((s) => panel.unfurlSrcs.includes(s));
  check('no unfurl-logo media in grid', leak.length === 0, leak.length + ' leaked of ' + panel.unfurlSrcs.length + ' unfurl imgs on page');
  // quote exclusion: grid == exactly the non-quote media (originals in, copies out).
  // A quoted URL legitimately still appears via its ORIGINAL post, so the test
  // is set equality against own media, not emptiness against quoted media.
  // video cells carry a #t=0.1 seek fragment — compare hashless
  const norm = (s) => String(s).split('#')[0];
  const cells = new Set(panel.cellSrcs.map(norm));
  const own = new Set(panel.ownSrcs.map(norm));
  const missing = [...own].filter((s) => !cells.has(s));
  const extra = [...cells].filter((s) => !own.has(s));
  check('media grid = own-post media only (quotes excluded)',
    missing.length === 0 && extra.length === 0,
    'grid=' + cells.size + ' own=' + own.size + ' missing=' + missing.length + ' extra=' + extra.length + ' (quoted copies on page: ' + panel.quotedSrcs.length + ')');

  // 4. Sort on partial cache: click 1 starts the fetch, click 2 aborts + sorts
  const firstArticleBefore = await ev(cdp, `(document.querySelector('article[data-content^="post-"]') || {}).dataset ? document.querySelector('article[data-content^="post-"]').dataset.content : ''`);
  await ev(cdp, `document.getElementById('xft-sort-btn').click(); true`);
  await sleep(1200);
  const fetching = await ev(cdp, `({
    label: document.getElementById('xft-sort-btn').textContent,
    progress: (document.querySelector('#xft-panel .xft-note, #xft-panel .xft-count') || { textContent: '' }).textContent.trim()
  })`);
  check('sort click resumes fetch', fetching.label.indexOf('…') !== -1, JSON.stringify(fetching.label) + ' / ' + JSON.stringify(fetching.progress));

  await ev(cdp, `document.getElementById('xft-sort-btn').click(); true`); // abort → sort partial
  let sortedState = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    sortedState = await ev(cdp, `({
      label: document.getElementById('xft-sort-btn').textContent,
      marker: !!document.querySelector('.xft-sort-marker'),
      clones: document.querySelectorAll('article.xf-fetched').length,
      originals: document.querySelectorAll('article[data-content^="post-"]').length
    })`);
    if (sortedState.marker && sortedState.label.indexOf('…') === -1) break;
  }
  check('partial sort applied with (partial) label',
    sortedState.marker === true && /partial/.test(sortedState.label),
    JSON.stringify(sortedState.label) + ' clones=' + sortedState.clones + ' originals=' + sortedState.originals);

  // 5. Restore exact original order
  await ev(cdp, `document.getElementById('xft-sort-btn').click(); true`);
  await sleep(800);
  const restored = await ev(cdp, `({
    label: document.getElementById('xft-sort-btn').textContent,
    marker: !!document.querySelector('.xft-sort-marker'),
    clones: document.querySelectorAll('article.xf-fetched').length,
    firstArticle: (document.querySelector('article[data-content^="post-"]') || {}).dataset ? document.querySelector('article[data-content^="post-"]').dataset.content : ''
  })`);
  check('restore returns to chronological',
    restored.marker === false && restored.clones === 0 && restored.label.indexOf('Sort by reactions') !== -1
      && restored.firstArticle === firstArticleBefore,
    JSON.stringify(restored.label) + ' first=' + restored.firstArticle);

  cdp.close();
} catch (e) {
  check('harness completed without error', false, e.message);
} finally {
  cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'));
process.exit(failed.length === 0 ? 0 : 1);
