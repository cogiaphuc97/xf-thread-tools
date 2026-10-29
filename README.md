# xf-thread-tools


## Install (one click)

1. Open: https://raw.githubusercontent.com/cogiaphuc97/xf-thread-tools/main/xf-thread-tools.user.js
2. Tampermonkey intercepts the .user.js URL -> click Install.
3. Updates arrive automatically on version bumps (Tampermonkey checks `@updateURL` periodically; or Utilities -> Check for userscript updates).

A single Tampermonkey userscript for **XenForo 2** forums that adds two tools to thread pages:

1. **Reaction sort** — fetches every page of the thread (sequentially, politely, cached in IndexedDB), then reorders the posts you see by reaction count, descending. Zero-reaction posts go last; equal counts keep thread order. Click again to restore the exact original order.
2. **Media panel** — a right-docked drawer panel with two tabs: **Media** (grid of embedded images + videos, with **All / Image / Video** sub-tabs) and **Links** (external http(s) links from post bodies, same-host/profile/permalink links filtered out, grouped per post, with search + user/domain column filters). Items are labeled `[post#] author` and fill in progressively while pages download. Media and links are collected from each post's **own content only** — anything inside a quote block is skipped, so a reply quoting media does not duplicate it.

Built and validated against XenForo 2 markup (probe date 2026-10-29). No admin access, no API keys, no server — everything runs client-side in your browser.

## Install (Tampermonkey)

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Edge/Firefox).
2. Open the Tampermonkey dashboard → **Utilities** tab → *Import from file*, or simply create a new userscript and paste the full contents of `xf-thread-tools.user.js`, then save.
3. Visit any thread page, e.g. `https://your-forum.example/threads/12345/`. Both XF thread routes work: `/threads/{slug}.{id}` and the short `/t/{slug}.{id}`. Two buttons appear in the page-action toolbar next to the thread title: **⚡ Sort by reactions** and **📁 Media**.

The script requests only two grants — `GM_setValue` / `GM_getValue` (used to store your settings). All page fetching is same-origin `fetch` with your session cookies; there is no `@connect` and no third-party network access.

## Usage

### Reaction sort
- Click **⚡ Sort by reactions**. If the thread is not cached yet, the button shows live fetch progress (`n/total`, e.g. `412/1886`). Clicking again while it is fetching cancels the download — already-fetched posts are still sorted (partial data stays usable).
- When done, posts are reordered in the page. Posts from other pages are rendered as lightweight clones (class `xf-fetched`, no quote/reply/react action bars, lazy-loaded images) in chunks of 50 with a **Show more** button that also auto-loads as you scroll.
- Click the button again (now labeled **↕ Chronological**) to remove all clones and restore the exact original post order.

### Media panel
- Click the **📁 Media** tab on the right edge of the page. The panel slides in as a drawer (click **✕** to slide it back out). Panel UI is styled by an embedded token system (shadcn/ui's zinc palette and radius scale, as plain CSS custom properties — no dependencies) and follows your OS light/dark mode.
- **Media** tab: 4-column grid of images and videos (video cells carry a ▶ badge). Sub-tabs **All / Image / Video** below the tab row switch kinds; each shows its count.
- Click any cell for the fullscreen viewer: **‹ Prev / Next ›** buttons, arrow keys, `Esc` to close, a position counter (`n/total · [post#] author`), **Go to comment**, and a thumbnail filmstrip below the preview showing the media around the current item (click a thumb to jump there).
- **Links** tab: rows are grouped per post — the `[post#] author` label appears once in a fixed-width column (long names ellipsize), with that post's links stacked beneath it. Below the tab row sits a toolbar, always visible: a **search box** (matches the URL or the author name, case-insensitive) and two column filters (**User ▾**, **Domain ▾**) that open checkbox lists built from the values currently in the table, with All/None shortcuts.
- Click the `[post#] author` label to jump: if that post is currently in the DOM it scrolls to it and pulses a highlight; otherwise it opens `/threads/{id}/post-{postId}` in a new tab. The URL itself always opens in a new tab.
- Header controls: `n/total` progress, **■ Stop** (cancels the fetch, keeps the partial list interactive), **↻ Refresh** (deletes the cached records for this thread and re-fetches), **⚙** (settings), **✕** (close).
- Rows are capped at 500 per tab with a **Show more rows** button (cap configurable, see Settings).

### Caching
- Extracted posts are cached per thread in IndexedDB (db `xf-thread-tools`, stores `posts` and `threads`). Reopening a cached thread is instant — the script issues **zero** page requests until you press **↻ Refresh**.
- Persistence is capped at **100 MB** of estimated data. Past the cap the script stops writing to IndexedDB (everything already written stays), keeps fetching into memory, shows a notice in the panel, and the sort/panel keep working for the session.
- If IndexedDB is unavailable (private mode, blocked storage), the script warns once in the console and falls back to a session-only in-memory cache — all features still work, nothing persists.

## Settings

Settings live under the Tampermonkey storage key `xfThreadTools:settings` (Dashboard → your script → *Storage* tab; or edit via the panel's **⚙** form for the numeric ones). They are a single JSON object; unknown keys keep their defaults.

| Key | Default | Meaning |
|-----|---------|---------|
| `delayMs` | `350` | Delay between sequential page fetches. Do not lower this on large forums. |
| `chunkSize` | `50` | How many sorted posts/clones are rendered per chunk. |
| `rowCap` | `500` | Panel rows rendered per "show more" step. |
| `capBytes` | `104857600` | IndexedDB persistence cap (100 MB) before the stop-persist fallback. |
| `basePath` | `""` | Forum base path. `""` assumes the forum is at the site root (`/threads/...`). Set `"/forum"` if your forum lives at `https://site.example/forum/threads/...` (see note below). |
| `selectors` | `{}` | Per-site selector overrides, merged over the defaults (see table below). |

### Subpath installs (origin/base-path override)

The URL builder assumes XenForo is served from the site root, i.e. thread pages look like `https://site.example/threads/{id}/page-N`. If your forum is installed under a subpath — `https://site.example/forum/threads/{id}/page-N` — the `@match` pattern already catches the pages, but the script's fetch and jump URLs need the prefix. Set:

```json
{ "basePath": "/forum" }
```

in the settings object (Storage tab or the ⚙ form's *base path* field). No trailing slash.

### Selector overrides

Validated against stock XF2 markup. If your style/add-ons rename a class, override just that entry inside `selectors`:

| Settings key | Default selector | What it finds |
|--------------|------------------|---------------|
| `post` | `article.message--post[data-content^="post-"]` | A post |
| `postBody` | `.bbWrapper` | Post body container |
| `author` | `.message-name` | Author name element |
| `date` | `time[datetime]` | Post timestamp element |
| `reactionsBar` | `.reactionsBar.js-reactionsList` | Reaction bar (must also carry `.is-active` for a nonzero count) |
| `reactionsLink` | `a.reactionsBar-link` | Element whose text holds the count ("A, B and 12 others" / "A, B và 12 người khác") |
| `image` | `img.bbImage` | Embedded image |
| `attachment` | `a[href*="attachments"]` | XF attachment link — scanned across the whole post (XF renders attachment blocks outside `.bbWrapper`); video extensions route to Videos |
| `quote` | `blockquote.bbCodeBlock--quote` | Quoted content inside a post — media/links inside it are skipped (they belong to the quoted post, not this one) |
| `pageNav` | `.pageNav` | Pagination block (page count = highest page number found) |
| `pageNavPage` | `.pageNav-page` | A single page-number element |
| `toolbar` | `.p-title-pageAction, .p-title .buttonGroup, .p-title` | Primary toolbar button anchor (first match wins) |
| `toolbarFallback` | `.pageContent, .p-body` | Fallback toolbar anchor chain |

Example:

```json
{ "selectors": { "toolbar": ".myCustomActions", "image": "img.myImageClass" } }
```

If the toolbar anchor cannot be found at all, the script logs one warning and skips button injection — everything else still initializes.

## Politeness / rate-limit warning

Sorting a thread means downloading **every page of it**. A 1886-page thread is 1886 requests and roughly 11 minutes at the default 350 ms delay.

- Requests are strictly **sequential** with the configurable delay; there is no parallel fetching. Do not lower `delayMs` below the default on forums you do not operate.
- Fetches are **cancellable** (sort button re-click or panel **■ Stop**) and everything already downloaded stays cached, so you never need to re-download on the next visit.
- Cache writes are capped at 100 MB; past that the script stops persisting rather than filling your disk.
- Respect the forum's terms and your account standing. This tool only reads pages your logged-in session can already see; it does not bypass hidden-content permissions.

## Development

```
npm test
```

runs the `node:test` suite (`tests/parse.test.mjs`) against the pure functions (`parseReactionCount`, `filterLinks`, `sortPosts`, `estimateSize`, `partitionLinks`, `extractDomain`, `groupLinkItems`, `applyLinkFilters`) exported from the userscript via its UMD tail. The script's runtime guard (`<html id="XF" data-template="thread_view">`) keeps all DOM/GM code inert under Node, so the same file is both the deliverable and the test target.

The userscript is inert by design on non-XF pages and on non-thread XF pages (forum list, profile, …): no buttons, no console output, no network.
