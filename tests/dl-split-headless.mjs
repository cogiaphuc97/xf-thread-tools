// Headless download-split probe against the LOCAL fixture server (no real
// site).
//
//   node tests/dl-split-headless.mjs
//
// Lowers the per-part byte cap via the localhost test hook, downloads a
// 702-file + 2-dead-URL thread, and proves: the run splits into >=2 saved
// zip parts (no 'size cap reached' truncation), the union of entries across
// parts equals the item list exactly once, part blobs are freed as parts
// save (held stays bounded), perm/trans failure policy is unchanged
// (404 hit once, 500 hit 3x, both pinned), and an under-cap run keeps the
// exact 0.20.0 single-zip filename. Requires Chrome (headless) + the BUILT
// bundle. Not part of npm test.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';
import { zipFileName, siteTagFromHost } from '../src/zip.mjs';

const CHROME = '/opt/google/chrome/chrome';
const TMP = '/tmp/xf-dl-' + process.pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
}

// Same GM surface as the perf probe (plain-fetch shim, CORS OK on fixtures)
const STUB = `
window.__XFT_DL_PART_CAP_FOR_TESTS = ${100 * 1000}; // 100KB: part ~= 50 files of 2KB
window.GM_getValue = function (k, d) {
  const v = localStorage.getItem('xft_' + k);
  return v === null ? d : JSON.parse(v);
};
window.GM_setValue = function (k, v) { localStorage.setItem('xft_' + k, JSON.stringify(v)); };
window.GM_deleteValue = function (k) { localStorage.removeItem('xft_' + k); };
window.GM_xmlhttpRequest = function (o) {
  const ctl = new AbortController();
  const t = o.timeout ? setTimeout(() => { try { ctl.abort(); } catch (e) {} if (o.ontimeout) o.ontimeout(); }, o.timeout) : 0;
  const hs = Object.assign({}, o.headers || {});
  const ref = hs.Referer; delete hs.Referer;
  fetch(o.url, Object.assign({ method: o.method || 'GET', signal: ctl.signal, headers: hs, credentials: 'omit' }, ref ? { referrer: ref } : { referrerPolicy: 'no-referrer' }))
    .then(async (r) => {
      clearTimeout(t);
      const res = { status: r.status, responseHeaders: [...r.headers.entries()].map(([k2, v2]) => k2 + ': ' + v2).join('\\r\\n') };
      if (o.responseType === 'blob') res.response = await r.blob();
      else res.responseText = await r.text();
      if (o.onload) o.onload(res);
    })
    .catch(() => { clearTimeout(t); if (o.onerror) o.onerror(); });
  return { abort: () => { try { ctl.abort(); } catch (e) {} } };
};
`;

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        }
      });
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
  });
}

async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 500));
  return r.result.value;
}

async function pageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9412/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.url === 'about:blank') || list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* endpoint not up yet */ }
    await sleep(250);
  }
  throw new Error('chrome devtools endpoint never came up');
}

const N_FILES = 699;   // live /dl/<n>.jpg files
const N_TOTAL = N_FILES + 4; // + anim.gif + dead404 + dead500 + referer-walled

async function main() {
  mkdirSync(TMP, { recursive: true });
  // dead URLs sit at the END of the list: while they back off (2s+6s), the
  // live tail has already finished — the run's wall time is the live fetches
  const fx = await startFixtureServer({
    pages: 1, perPage: N_TOTAL,
    imgUrl: (n) => n === N_FILES + 1 ? '/dldead/dead404.jpg'
      : n === N_FILES + 2 ? '/dldead/dead500.jpg'
      : n === N_FILES + 3 ? '/anim.gif'
      : n === N_FILES + 4 ? '/dlref/wall.jpg?b=1500'
      : '/dl/' + n + '.jpg?b=2000'
  });

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate', '--window-size=1400,900',
    `--user-data-dir=${TMP}/profile`, '--remote-debugging-port=9412',
    'about:blank'
  ], { stdio: 'ignore' });
  process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch (e) {} });

  const cdp = await connect(await pageWs());
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: fx.url });
  await sleep(1500);

  await ev(cdp, `localStorage.setItem('xft_xfThreadTools:settings', JSON.stringify({ autoFetch: 1, delayMs: 120, rowCap: 900, forceAnimations: 1, mediaGroup: 'flat' })); true`);
  const inject = STUB + '\n' + readFileSync(new URL('../xf-thread-tools.user.js', import.meta.url), 'utf8');
  writeFileSync(TMP + '/inject.js', inject);
  const inj = await cdp.send('Runtime.evaluate', { expression: inject });
  if (inj.exceptionDetails) console.log('INJECT EXCEPTION:', JSON.stringify((inj.exceptionDetails.exception || {}).description || '').slice(0, 600));
  await sleep(2500);

  // capture anchor-click saves: snapshot the blob bytes AT CLICK TIME (the
  // engine revokes objectURLs 60s later) and parse entries in-page
  await ev(cdp, `(() => {
    window.__xftSaves = [];
    window.__xftSaveParts = [];
    window.__xftZipNames = (ab) => {
      const u = new Uint8Array(ab);
      const dv = new DataView(ab);
      let eocd = -1;
      for (let i = u.length - 22; i >= Math.max(0, u.length - 66000); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error('no EOCD');
      const count = dv.getUint16(eocd + 10, true);
      let off = dv.getUint32(eocd + 16, true);
      const dec = new TextDecoder();
      const names = [];
      for (let i2 = 0; i2 < count; i2++) {
        if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('bad CD sig at ' + off);
        const nlen = dv.getUint16(off + 28, true);
        const elen = dv.getUint16(off + 30, true);
        const clen = dv.getUint16(off + 32, true);
        names.push(dec.decode(u.subarray(off + 46, off + 46 + nlen)));
        off += 46 + nlen + elen + clen;
      }
      return names;
    };
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download) return;
      const nm = this.download;
      window.__xftSaves.push({ name: nm, url: this.href });
      fetch(this.href).then((r) => r.arrayBuffer()).then((ab) => {
        window.__xftSaveParts.push({ name: nm, ab: ab });
      }).catch(() => {});
    };
    return true;
  })()`);
  await ev(cdp, `document.getElementById('xft-edge-btn').click(); true`);
  await sleep(1000);

  let items = -1, stable = 0;
  for (let i = 0; i < 60; i++) {
    const c = await ev(cdp, `parseInt(((document.querySelector('#xft-panel .xft-count')||{textContent:''}).textContent.match(/(\\d+)/)||[0,'0'])[1], 10)`);
    const busy = await ev(cdp, `!!document.querySelector('#xft-panel .xft-spinner')`);
    if (c === items && !busy) stable++; else stable = 0;
    items = c;
    if (stable >= 3 && c >= N_TOTAL) break;
    await sleep(700);
  }
  check('fetch completed', items >= N_TOTAL, 'items=' + items);

  // ---- run 1: lowered cap -> multi-part --------------------------------
  await ev(cdp, `document.querySelector('.xft-dlbtn').click(); true`);
  let maxHeld = 0;
  let statsText = '';
  for (let i = 0; i < 240; i++) { // up to ~168s
    await sleep(700);
    const st = await ev(cdp, `(() => {
      const L = window.__xftDlLedger || { peak: 0 };
      const t = (document.querySelector('#xft-panel .xft-dlstats')||{textContent:''}).textContent;
      return { peak: L.peak | 0, saves: (window.__xftSaves||[]).length, text: t };
    })()`);
    if (st.peak > maxHeld) maxHeld = st.peak;
    statsText = st.text;
    if (/Saved|Stopped|zip error|error/.test(st.text)) break;
  }
  const saves1 = await ev(cdp, `window.__xftSaves.slice()`);
  const ledger1 = await ev(cdp, `Object.assign({}, window.__xftDlLedger || {})`);
  const stats1 = await fx.stats();

  check('AC-DL-2: run completed, no truncation', /Saved/.test(statsText) && !/truncated/.test(statsText), JSON.stringify(statsText));
  check('AC-DL-2: split into >=2 parts', saves1.length >= 2, 'saves=' + saves1.length);
  check('AC-DL-2: part naming', saves1.length > 0 && saves1.every((s) => /\.part\d+\.zip$/.test(s.name)), (saves1[0] || {}).name + ' …');

  // parse every saved part (bytes snapshotted at click time), union entries
  let parts1 = [];
  for (let i = 0; i < 40 && parts1.length < saves1.length; i++) {
    await sleep(250);
    parts1 = await ev(cdp, `window.__xftSaveParts.map((p) => ({ name: p.name, entries: window.__xftZipNames(p.ab) }))`);
  }
  const union = [];
  for (const p of parts1) union.push(...p.entries);
  const counts = new Map();
  for (const n of union) counts.set(n, (counts.get(n) || 0) + 1);
  const dupes = [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
  const missing = [];
  for (let i = 1; i <= N_FILES; i++) {
    const nm = String(i).padStart(3, '0') + '_' + i + '.jpg';
    if (!counts.has(nm)) missing.push(nm);
  }
  check('AC-DL-2: union = full item list exactly once', dupes.length === 0 && missing.length === 0,
    'files=' + N_FILES + ' entries=' + union.length + ' dupes=' + dupes.length + ' missing=' + missing.length);

  check('AC-DL-1: part blobs released as parts save', (ledger1.released | 0) >= N_FILES, 'released=' + ledger1.released);
  const heldBound = Math.ceil(100000 / 2000) + 6 + 6; // cap/filesize + net slots + slack
  check('AC-DL-1: held jobs stay bounded (~one part)', maxHeld > 0 && maxHeld <= heldBound, 'maxHeld=' + maxHeld + ' bound=' + heldBound);

  check('AC-DL-4: perm 404 burned after 1 hit', (stats1['dl|/dldead/dead404.jpg'] || 0) === 1, 'hits=' + (stats1['dl|/dldead/dead404.jpg'] || 0));
  check('AC-DL-4: trans 500 retried to 3 hits', (stats1['dl|/dldead/dead500.jpg'] || 0) === 3, 'hits=' + (stats1['dl|/dldead/dead500.jpg'] || 0));
  check('AC-DL-4: both dead files pinned as fails', (ledger1.fails | 0) === 2, 'fails=' + (ledger1.fails | 0));
  // 0.26.4: the referer-walled file 403s the forum-referer attempt, the
  // no-referer retry lands it — exactly 2 download hits, entry in the zip
  check('AC-REF: referer wall retried no-referer (2 hits)', ((stats1['wall403|dl|/dlref/wall.jpg'] || 0) === 1 || (stats1['wall403|/dlref/wall.jpg'] || 0) === 1) && ((stats1['wallok|dl|/dlref/wall.jpg'] || 0) + (stats1['wallok|/dlref/wall.jpg'] || 0)) >= 1,
    JSON.stringify({ w403dl: stats1['wall403|dl|/dlref/wall.jpg'], w403: stats1['wall403|/dlref/wall.jpg'], wokdl: stats1['wallok|dl|/dlref/wall.jpg'], wok: stats1['wallok|/dlref/wall.jpg'] }));
  check('AC-REF: walled file saved into the zip', union.some((n2) => /wall\.jpg$/.test(n2)), JSON.stringify(union.filter((n2) => /wall/.test(n2))));

  // ---- run 2: default-size cap -> single part, exact 0.20.0 name --------
  await ev(cdp, `(() => {
    window.__XFT_DL_PART_CAP_FOR_TESTS = 500 * 1048576;
    window.__xftSaves = [];
    window.__xftDlLedger = null;
    return true;
  })()`);
  await sleep(300);

  // ---- UI disabled states (AC-UI-1/2) -----------------------------------
  // this page has 0 video items: Video sub-tab -> Download disabled;
  // Image/All -> enabled. Stop disabled while idle (no fetch running).
  const stopBtn = `[...document.querySelectorAll('#xft-panel .xft-head button')].find((b) => b.textContent.includes('Stop'))`;
  check('AC-UI-2: header Stop disabled while idle', await ev(cdp, stopBtn + ' ? ' + stopBtn + '.disabled : null') === true,
    'stop=' + await ev(cdp, stopBtn + ' ? ' + stopBtn + '.disabled : \'missing\''));
  const resumeState = await ev(cdp, `(() => { const b = [...document.querySelectorAll('#xft-panel .xft-head button')].find((x) => x.textContent.includes('Resume')); return b ? { hidden: b.hidden, disabled: b.disabled } : null; })()`);
  check('AC-UI-2: Resume visible but disabled on a complete thread', resumeState && resumeState.hidden === false && resumeState.disabled === true, JSON.stringify(resumeState));
  await ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-subtab')].find((b) => /^Video/.test(b.textContent)).click(); true`);
  await sleep(250);
  check('AC-UI-1: Download disabled on an empty sub-tab', await ev(cdp, `document.querySelector('.xft-dlbtn').disabled`) === true, '');
  await ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-subtab')].find((b) => /^Image/.test(b.textContent)).click(); true`);
  await sleep(250);
  check('AC-UI-1: Download enabled once the list is non-empty', await ev(cdp, `document.querySelector('.xft-dlbtn').disabled`) === false, '');
  await ev(cdp, `[...document.querySelectorAll('#xft-panel .xft-subtab')].find((b) => /^All /.test(b.textContent)).click(); true`);
  await sleep(250);
  check('AC-UI-1: Download enabled on All (re-evaluated per switch)', await ev(cdp, `document.querySelector('.xft-dlbtn').disabled`) === false, '');

  // Stop enables the moment a THREAD fetch runs: fire a Refresh and poll
  // the short window (one fixture page = a few hundred ms of fetchRunning)
  const refreshBtn = `[...document.querySelectorAll('#xft-panel .xft-head button')].find((b) => b.textContent.includes('Refresh'))`;
  await ev(cdp, refreshBtn + '.click(); true');
  let stopEnabledSeen = false;
  for (let i = 0; i < 30; i++) {
    if (await ev(cdp, stopBtn + ' ? !' + stopBtn + '.disabled : false') === true) { stopEnabledSeen = true; break; }
    await sleep(40);
  }
  check('AC-UI-2: header Stop enabled while a thread fetch is running', stopEnabledSeen, '');

  // the forced Refresh cleared records and is refetching. The count text
  // can be stale (no render between clear and repopulate), so wait on the
  // fetch-END edge — Stop re-disables exactly when the run finishes — then
  // confirm the count.
  for (let i = 0; i < 80; i++) {
    if (await ev(cdp, stopBtn + ' ? ' + stopBtn + '.disabled : false') === true) break;
    await sleep(200);
  }
  for (let i = 0; i < 60; i++) {
    const c = await ev(cdp, `parseInt(((document.querySelector('#xft-panel .xft-count')||{textContent:''}).textContent.match(/(\\d+)/)||[0,'0'])[1], 10)`);
    if (c >= N_TOTAL) break;
    await sleep(400);
  }

  const run2Pre = await ev(cdp, `(() => { try { return { count: ((document.querySelector('#xft-panel .xft-count')||{textContent:''}).textContent), active: ((document.querySelector('#xft-panel .xft-subtab.xft-tab-active')||{textContent:''}).textContent), dlDisabled: document.querySelector('.xft-dlbtn').disabled, stats: ((document.querySelector('#xft-panel .xft-dlstats')||{textContent:''}).textContent) }; } catch (e) { return { err: String(e) }; } })()`);
  await ev(cdp, `document.querySelector('.xft-dlbtn').click(); true`);
  await sleep(400); // download fetch phase is live: the Download button IS the stop
  // control (must stay clickable); header Stop targets the THREAD fetch, which
  // is idle here — it stays disabled (nothing for it to act on)
  check('AC-UI-2: header Stop stays disabled with no thread fetch running', await ev(cdp, stopBtn + ' ? ' + stopBtn + '.disabled : null') === true, '');
  check('AC-UI-1: Download button stays clickable mid-run (stop affordance)', await ev(cdp, `document.querySelector('.xft-dlbtn').disabled`) === false, '');
  const texts2 = [];
  const preStats2 = (run2Pre && run2Pre.stats) || '';
  for (let i = 0; i < 240; i++) {
    await sleep(700);
    const t = await ev(cdp, `(document.querySelector('#xft-panel .xft-dlstats')||{textContent:''}).textContent`);
    texts2.push(t);
    // the pre-click summary still matches the break regex — only a CHANGED
    // text counts as run 2's outcome
    if (t !== preStats2 && /Saved|Stopped|zip error|error/.test(t)) break;
  }
  const saves2 = await ev(cdp, `window.__xftSaves.slice()`);
  if (!(saves2 || []).length) console.log('RUN2 DEBUG: last texts =', JSON.stringify(texts2.slice(-6)));
  const expected2 = zipFileName(siteTagFromHost('127.0.0.1'), 'fixture thread', 'Images');
  check('AC-DL-3: under-cap run keeps the exact single-zip name',
    saves2.length === 1 && saves2[0].name === expected2,
    'got=' + JSON.stringify((saves2[0] || {}).name) + ' want=' + JSON.stringify(expected2));

  const fails = results.filter((r) => !r.ok).length;
  console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS');
  await fx.close();
  try { chrome.kill('SIGKILL'); } catch (e) {}
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
