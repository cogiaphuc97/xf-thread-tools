# xf-thread-tools

Tampermonkey userscript for XenForo 2 forums. Two tools on thread pages:

- **⚡ Sort by reactions** — fetches every thread page (sequential, cached), reorders posts by reaction count. Click again to restore original order. Partial downloads stay sortable; re-click while fetching cancels.
- **📁 Media panel** — right-docked drawer with three tabs:
  - **Media**: grid of embedded images + videos (All / Image / Video), fullscreen viewer with keyboard nav + filmstrip, batch download as zip.
  - **Links**: external links grouped per post, search + user/domain filters.
  - **AI**: chat about the thread via local Ollama.
- Album links (`/a/…` on image hosts) expand into their child media inline, deduped against thread embeds. Embedded thumbnails auto-upgrade to full resolution where the host allows it.

No admin access, no server. Everything runs client-side.

## Install

Open <https://raw.githubusercontent.com/cogiaphuc97/xf-thread-tools/main/xf-thread-tools.user.js> — Tampermonkey intercepts the URL, click Install. Updates arrive automatically on version bumps.

Grants: `GM_setValue`/`GM_getValue` (settings), `GM_xmlhttpRequest` (cross-host media, album, and download requests that page `fetch` cannot make — e.g. referer-walled image hosts). Thread pages themselves are fetched same-origin with your session cookies.

## Settings

Single JSON object, Tampermonkey key `xfThreadTools:settings` (Dashboard → script → Storage, or the panel **⚙** form).

| Key | Default | Meaning |
|-----|---------|---------|
| `delayMs` | `350` | Delay between page fetches. Don't lower on forums you don't operate. |
| `chunkSize` | `50` | Sorted posts rendered per chunk. |
| `rowCap` | `500` | Panel rows per render step. |
| `capBytes` | `104857600` | IndexedDB persistence cap; past it, stop writing (session keeps working). |
| `autoFetch` | `1` | Fetch whole thread in background on page load. |
| `basePath` | `""` | `"/forum"` if the forum lives under a subpath. |
| `mediaGroup` | `"flat"` | Media grid grouping: `flat` \| `post` \| `page` \| `user`. |
| `forceAnimations` | `0` | Run animations under prefers-reduced-motion. |
| `selectors` | `{}` | Per-site selector overrides, merged over defaults (below). |
| `aiProvider` / `aiBase` / `aiModel` / `aiLang` / `aiCtxTokens` | `ollama` / `""` / `""` / `en` / `0` | AI tab: provider preset (Ollama), base URL, model id, prompt language `en`\|`vi`, context tokens (0 = auto). |

### Selector overrides

Stock XF2 markup works out of the box. If your style renames a class, override just that key:

```json
{ "selectors": { "toolbar": ".myCustomActions", "image": "img.myImageClass" } }
```

Defaults: `post` `article.message--post[data-content^="post-"]` · `postBody` `.bbWrapper` · `author` `.message-name` · `date` `time[datetime]` · `reactionsBar` `.reactionsBar.js-reactionsList` · `reactionsLink` `a.reactionsBar-link` · `image` `img.bbImage` · `attachment` `a[href*="attachments"]` · `quote` `blockquote.bbCodeBlock--quote` · `signature` `.message-signature` · `pageNav` `.pageNav` · `pageNavPage` `.pageNav-page` · `toolbar` `.p-title-pageAction, .p-title .buttonGroup, .p-title` · `toolbarFallback` `.pageContent, .p-body`

Media/links inside quote blocks and signatures are skipped (they belong to the quoted post). Attachments are scanned across the whole post; video extensions route to Videos.

## Politeness

Sorting = downloading every page of the thread. Requests are strictly sequential with the `delayMs` delay, cancellable, and cached per thread in IndexedDB — revisits issue zero requests until **↻ Refresh**. The script reads only pages your logged-in session can already see; respect the forum's terms.

## Development

```
npm test
```

`node:test` suite against the pure functions exported via the userscript's UMD tail. The runtime guard (`<html id="XF" data-template="thread_view">`) keeps all DOM/GM code inert under Node, so the same file is both deliverable and test target — and inert (no buttons, no console output, no network) on non-thread pages.
