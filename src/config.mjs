// config: Storage keys, default settings (delays, caps, AI opts), BASE_SEL selector defaults. No functions, no DOM. (split from the single-file userscript; see scripts/modules.json)
export const SETTINGS_KEY = 'xfThreadTools:settings';
export const AI_KEY = 'xfThreadTools:aiKey'; // API key: GM storage ONLY, never the localStorage fallback (page-readable)
export const DEFAULT_CAP_BYTES = 100 * 1024 * 1024; // 100 MB persistence cap
export const DEFAULT_SETTINGS = {
  delayMs: 350,                // politeness delay between page fetches
  chunkSize: 50,               // sorted-view render chunk
  rowCap: 500,                 // panel rows rendered before "show more" (Links tab)
  capBytes: DEFAULT_CAP_BYTES, // IndexedDB persistence cap
  autoFetch: 1,                // 1 = fetch the whole thread in background on page load
  basePath: '',                // '' = auto-detect the subpath the thread route sits under; '/forum' style override for exotic mounts
  forceAnimations: 0,          // 1 = run UI animations even under prefers-reduced-motion
  mediaGroup: 'flat',          // media grid grouping: flat | post | page | user
  mediaOrder: 'default',       // panel item order: default | latest | react (one control, media + links)
  albumHosts: ['gofile.io'],   // hosts whose /d/<id> links are ALBUMS (SPA file hosts with an api.<domain> content API); /d/ otherwise stays video-page routed. gofile default-on (public API); blank/absent adopts this default, 'none' opts out
  selectors: {},               // per-site selector overrides, merged over BASE_SEL
  aiProvider: 'ollama',        // AI tab provider preset (Ollama-only phase; engine stays provider-generic)
  aiBase: '',                  // '' = provider preset base URL
  aiModel: '',                 // selected chat model id
  aiLang: 'en',                // default-prompt language: en | vi
  aiCtxTokens: 0               // context window for chat: 0 = auto (min(model,16k))
};
export const BASE_SEL = {
  post: 'article.message--post[data-content^="post-"]',
  postBody: '.bbWrapper',
  author: '.message-name',
  date: 'time[datetime]',
  reactionsBar: '.reactionsBar.js-reactionsList',
  reactionsLink: 'a.reactionsBar-link',
  repliesHost: '.message-main',
  image: 'img.bbImage',
  unfurlImage: 'img.bbCodeBlockUnfurl-image',
  attachment: 'a[href*="attachments"], a.file-preview', // file-preview: XF2 attachment anchors whose file URLs live outside any /attachments/ path (data/<type>/ mounts)
  quote: 'blockquote.bbCodeBlock--quote',
  signature: '.message-signature',
  pageNav: '.pageNav',
  pageNavPage: '.pageNav-page',
  toolbar: '.p-title-pageAction, .p-title .buttonGroup, .p-title',
  toolbarFallback: '.pageContent, .p-body'
};

