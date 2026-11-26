// rt-settings: GM storage read/write, AI key storage (GM-only), settings load/merge, selector merge (SEL), sleep/route/threadId/threadKey helpers, page-number readers.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // ---------- settings (GM_setValue-backed; localStorage fallback) ----------
    function readStore(key, def) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(key);
          return v === undefined || v === null ? def : v;
        }
      } catch (e) { /* fall through */ }
      try {
        if (typeof localStorage !== 'undefined') {
          const v = localStorage.getItem(key);
          return v === null ? def : JSON.parse(v);
        }
      } catch (e) { /* fall through */ }
      return def;
    }
    function writeStore(key, val) {
      try {
        if (typeof GM_setValue === 'function') { GM_setValue(key, val); return; }
      } catch (e) { /* fall through */ }
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(val));
      } catch (e) { /* ignore */ }
    }

    // The provider API key must never reach the localStorage fallback (any
    // page script can read it there). GM-only store; session-memory
    // otherwise. Stripped from every persisted settings write.
    function readAiKey() {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(AI_KEY);
          return typeof v === 'string' ? v : '';
        }
      } catch (e) { /* ignore */ }
      return '';
    }
    function saveSettings() {
      writeStore(SETTINGS_KEY, Object.assign({}, settings, { aiKey: undefined }));
    }

    const settings = Object.assign({}, DEFAULT_SETTINGS, readStore(SETTINGS_KEY, {}));
    settings.aiKey = readAiKey();
    // albumHosts (0.26): tolerate garbage — keep trimmed lowercase non-empty
    // substrings only, so a mistyped settings blob can never break routing
    if (!Array.isArray(settings.albumHosts)) settings.albumHosts = [];
    settings.albumHosts = settings.albumHosts
      .map((h) => String(h || '').trim().toLowerCase().replace(/^[*.]+/, ''))
      .filter((h) => h.length >= 3 && /^[a-z0-9.*-]+$/.test(h));
    // 0.28.2: gofile albums default-on. Saves from 0.26–0.28.1 baked an
    // EMPTY list into storage — that empty means "never configured", not
    // "opted out", so it adopts the shipped default. 'none' (or any host
    // that never matches) is the explicit opt-out.
    if (!settings.albumHosts.length) settings.albumHosts = DEFAULT_SETTINGS.albumHosts.slice();
    // Ollama-only phase: no provider picker — coerce stale stored presets and
    // drop bases that point at the old default so the UI shows one truth
    if (settings.aiProvider !== 'ollama') settings.aiProvider = 'ollama';
    if (settings.aiBase === 'https://api.openai.com/v1') settings.aiBase = '';
    // 0.24.0 order modes are default | latest | react — coerce anything
    // else (incl. 'page' stored 0.23.2–0.23.3) so the select never shows
    // a ghost option
    if (settings.mediaOrder !== 'default' && settings.mediaOrder !== 'latest' && settings.mediaOrder !== 'react') settings.mediaOrder = 'default';
    if (!settings.selectors || typeof settings.selectors !== 'object') settings.selectors = {};
    const SEL = Object.assign({}, BASE_SEL, settings.selectors);

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---------- step 3: thread meta ----------
    // XF ships two thread routes: /threads/{slug}.{id} and the short /t/{slug}.{id}.
    // Remember BOTH the prefix and the full slug segment: rebuilt URLs must
    // reuse the exact route the user is on (some sites' WAF/SEO rules 404 or
    // redirect slugless /threads/{id} shapes). Subpath installs
    // (/phpBB2/threads/…) are captured too: everything before the route
    // prefix becomes the default basePath (user-set basePath still wins).
    const route = (function () {
      const m = location.pathname.match(/^(.*?\/)?(threads|t)\/([^/?#]+)/);
      if (!m) return null;
      const seg = decodeURIComponent(m[3]);
      const dot = seg.lastIndexOf('.');
      const tail = dot >= 0 ? seg.slice(dot + 1) : seg;
      return { prefix: m[2], seg: seg, id: /^\d+$/.test(tail) ? tail : seg, base: m[1] ? m[1].replace(/\/+$/, '') : '' };
    })();
    if (!route) return; // non-standard thread route: stay silent
    const threadId = route.id;
    // basePath '' = auto: page-walk URLs reuse the subpath the thread was
    // actually browsed under (root installs collapse to ''). An explicitly
    // stored basePath overrides (exotic mounts where fetching must target a
    // different base than browsing).
    if (!settings.basePath) settings.basePath = route.base;

    const threadKey = threadId;

    function getCurrentPage() {
      const m = location.pathname.match(/\/page-(\d+)/);
      return m ? parseInt(m[1], 10) : 1;
    }

    function getPageCount() {
      const nav = document.querySelector(SEL.pageNav);
      if (!nav) return 1;
      let max = 1;
      nav.querySelectorAll(SEL.pageNavPage).forEach((el) => {
        const t = (el.textContent || '').trim();
        if (/^\d+$/.test(t)) max = Math.max(max, parseInt(t, 10));
      });
      if (max === 1) {
        nav.querySelectorAll('a[href*="page-"]').forEach((a) => {
          const m = (a.getAttribute('href') || '').match(/page-(\d+)/);
          if (m) max = Math.max(max, parseInt(m[1], 10));
        });
      }
      return max;
    }

