// rt-boot: Toolbar injection, embedded CSS (token system), boot IIFE (progress init, autoFetch kick).
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // ---------- step 9: toolbar injection ----------
    function injectToolbar() {
      const host = document.querySelector(SEL.toolbar) || document.querySelector(SEL.toolbarFallback)
        || document.querySelector('.p-body') || document.querySelector('.p-title');
      if (!host) {
        console.warn('[xf-thread-tools] toolbar anchor not found — buttons not injected.');
        return;
      }
      const sortBtn = document.createElement('button');
      sortBtn.type = 'button';
      sortBtn.id = 'xft-sort-btn';
      sortBtn.className = 'button button--link';
      sortBtn.textContent = '⚡ Sort by reactions';
      sortBtn.addEventListener('click', () => sorter.toggle());
      host.append(sortBtn);
    }

    function injectStyles() {
      // Design system: shadcn/ui's token set (zinc palette, HSL custom
      // properties, --radius scale) ported to plain CSS. Everything is
      // scoped with the --xft-* prefix so the host page is untouched;
      // component classes consume tokens only — never raw colors.
      const st = document.createElement('style');
      st.textContent = [
        ':root{',
        '--xft-bg:0 0% 100%;--xft-fg:240 10% 3.9%;--xft-card:0 0% 100%;--xft-popover:0 0% 100%;',
        '--xft-muted:240 4.8% 95.9%;--xft-muted-fg:240 3.8% 46.1%;',
        '--xft-primary:240 5.9% 10%;--xft-primary-fg:0 0% 98%;',
        '--xft-secondary:240 4.8% 95.9%;--xft-secondary-fg:240 5.9% 10%;',
        '--xft-accent:240 4.8% 95.9%;--xft-accent-fg:240 5.9% 10%;',
        '--xft-destructive:0 84.2% 60.2%;--xft-border:240 5.9% 90%;--xft-input:240 5.9% 90%;--xft-ring:240 5.9% 10%;',
        '--xft-radius:0.5rem;',
        '}',
        '@media (prefers-color-scheme:dark){:root{',
        '--xft-bg:240 10% 3.9%;--xft-fg:0 0% 98%;--xft-card:240 10% 3.9%;--xft-popover:240 10% 3.9%;',
        '--xft-muted:240 3.7% 15.9%;--xft-muted-fg:240 5% 64.9%;',
        '--xft-primary:0 0% 98%;--xft-primary-fg:240 5.9% 10%;',
        '--xft-secondary:240 3.7% 15.9%;--xft-secondary-fg:0 0% 98%;',
        '--xft-accent:240 3.7% 15.9%;--xft-accent-fg:0 0% 98%;',
        '--xft-destructive:0 62.8% 50.6%;--xft-border:240 3.7% 15.9%;--xft-input:240 3.7% 15.9%;--xft-ring:240 4.9% 83.9%;',
        '}}',
        // ---- surfaces ----
        '#xft-panel{position:fixed;top:0;right:0;bottom:0;width:560px;max-width:100vw;display:flex;flex-direction:column;background:hsl(var(--xft-bg));color:hsl(var(--xft-fg));border-left:1px solid hsl(var(--xft-border));box-shadow:0 10px 40px hsl(240 10% 3.9%/.18);z-index:9999;font:12px/1.5 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Inter,Roboto,\'Helvetica Neue\',Arial,sans-serif;transform:translateX(100%);transition:transform .28s cubic-bezier(.16,1,.3,1)}',
        '#xft-panel.xft-open{transform:translateX(0)}',
        '#xft-edge-btn{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:9998;border:1px solid hsl(var(--xft-border));border-right:none;border-radius:calc(var(--xft-radius) - 2px) 0 0 calc(var(--xft-radius) - 2px);background:hsl(var(--xft-bg));color:hsl(var(--xft-fg));padding:14px 9px;cursor:pointer;font:12px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Inter,sans-serif;writing-mode:vertical-rl;box-shadow:0 4px 16px hsl(240 10% 3.9%/.15);transition:background .15s,opacity .2s}',
        '#xft-edge-btn:hover{background:hsl(var(--xft-accent))}',
        '#xft-edge-btn.xft-edge-hidden{opacity:0;pointer-events:none}',
        // ---- button (secondary / outline / ghost variants) ----
        '.xft-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;padding:0 10px;border:1px solid transparent;border-radius:calc(var(--xft-radius) - 4px);background:hsl(var(--xft-secondary));color:hsl(var(--xft-secondary-fg));font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s,color .15s;user-select:none}',
        '.xft-btn:hover{background:hsl(var(--xft-accent));color:hsl(var(--xft-accent-fg))}',
        '.xft-btn:focus-visible,#xft-edge-btn:focus-visible,.xft-cell:focus-visible,.xft-vthumb:focus-visible{outline:2px solid transparent;box-shadow:0 0 0 2px hsl(var(--xft-bg)),0 0 0 4px hsl(var(--xft-ring))}',
        '.xft-btn:disabled{opacity:.45;cursor:default;pointer-events:none}',
        // fetch spinner (page-loading indicator)
        '.xft-spinner{display:inline-block;vertical-align:-1px;width:11px;height:11px;margin-right:4px;border:2px solid hsl(var(--xft-border));border-top-color:hsl(var(--xft-primary));border-radius:50%;animation:xft-rot .7s linear infinite}',
        '@keyframes xft-rot{to{transform:rotate(360deg)}}',
        // removal fade-out + pop suppression on rebuild
        '.xft-cell.xft-out{animation:xft-out .22s ease-in both;pointer-events:none}',
        '.xft-vrow.xft-nopop img,.xft-vrow.xft-nopop video,.xft-vrow.xft-nopop .xft-vtile{animation:none}',
        // viewer + settings open/close
        '#xft-viewer.xft-vwin{animation:xft-pop .2s ease-out}',
        '#xft-viewer.xft-vclose{animation:xft-out .16s ease-in both}',
        '.xft-settings.xft-vwin{animation:xft-drop .18s ease-out}',
        '.xft-settings.xft-vclose{animation:xft-out .14s ease-in both}',
        '@keyframes xft-drop{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}',
        // ---- bars / rows ----
        '.xft-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid hsl(var(--xft-border));user-select:none}',
        '.xft-title{font-weight:600;letter-spacing:-.01em;margin-right:auto;white-space:nowrap}',
        '.xft-progress{font-variant-numeric:tabular-nums;color:hsl(var(--xft-muted-fg));margin-right:4px}',
        // shadcn TabsList: muted rounded track; active trigger = surface + shadow
        '.xft-tabs{display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:1px solid hsl(var(--xft-border));background:hsl(var(--xft-muted))}',
        '.xft-tabs .xft-tab{background:transparent;border-color:transparent;color:hsl(var(--xft-muted-fg))}',
        '.xft-tabs .xft-tab:hover{background:hsl(var(--xft-fg)/.08);color:hsl(var(--xft-fg))}',
        '.xft-tabs .xft-tab-active,.xft-tabs .xft-tab-active:hover{background:hsl(var(--xft-bg));color:hsl(var(--xft-fg));border-color:hsl(var(--xft-border));box-shadow:0 1px 2px hsl(240 10% 3.9%/.1)}',
        '.xft-count{margin-left:auto;color:hsl(var(--xft-muted-fg));font-variant-numeric:tabular-nums}',
        '.xft-subtabs{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid hsl(var(--xft-border))}',
        '.xft-subtabs[hidden]{display:none}',
        '.xft-subtab{font-size:11px;height:22px;padding:0 8px;background:transparent;color:hsl(var(--xft-muted-fg))}',
        '.xft-subtab:hover{background:hsl(var(--xft-accent));color:hsl(var(--xft-accent-fg))}',
        // shadcn Toggle active: secondary chip, readable on the plain panel bg
        '.xft-subtab.xft-tab-active,.xft-subtab.xft-tab-active:hover{background:hsl(var(--xft-secondary));color:hsl(var(--xft-fg));font-weight:600}',
        '.xft-gsel{margin-left:auto;height:22px;font-size:11px;background:hsl(var(--xft-secondary));color:hsl(var(--xft-fg));border:1px solid hsl(var(--xft-border));border-radius:6px;padding:0 4px;cursor:pointer;outline:none}',
        '.xft-dlbtn{min-width:70px;text-align:center}',
        '.xft-dlbar{padding:8px 10px;border-bottom:1px solid hsl(var(--xft-border));background:hsl(var(--xft-muted));display:flex;flex-direction:column;gap:6px}',
        '.xft-dlbar[hidden]{display:none}',
        '.xft-dltop{display:flex;align-items:center;gap:6px;min-width:0}',
        '.xft-dlname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}',
        '.xft-dlspd{color:hsl(var(--xft-muted-fg));font-variant-numeric:tabular-nums;font-size:11px;white-space:nowrap}',
        '.xft-dlstop{height:22px;padding:0 8px;font-size:11px}',
        '.xft-dlprogrow{display:flex;align-items:center;gap:8px}',
        '.xft-dlprog{flex:1;height:6px;border-radius:99px;background:hsl(var(--xft-border));overflow:hidden}',
        '.xft-dlprog>i{display:block;height:100%;width:0;background:hsl(var(--xft-ring));border-radius:99px;transition:width .25s}',
        '.xft-dlpct{width:34px;text-align:right;font-variant-numeric:tabular-nums;font-size:11px;color:hsl(var(--xft-muted-fg));flex:none}',
        '.xft-dlstats{display:flex;gap:12px;color:hsl(var(--xft-muted-fg));font-variant-numeric:tabular-nums;font-size:11px;white-space:nowrap;overflow:hidden}',
        '.xft-dl-ok{color:hsl(142 60% 45%)}',
        '.xft-dl-bad{color:hsl(var(--xft-destructive))}',
        '.xft-dl-on{color:hsl(var(--xft-fg))}',
        '.xft-dlrows{display:flex;flex-direction:column;gap:2px;max-height:132px;overflow-y:auto;scrollbar-width:thin;margin-top:2px}',
        '.xft-dlrows[hidden]{display:none}',
        '.xft-dlrow{display:flex;align-items:center;gap:8px;min-width:0;font-size:11px;line-height:18px}',
        '.xft-dlrowname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:hsl(var(--xft-fg))}',
        '.xft-dlrowbar{width:56px;height:4px;border-radius:99px;background:hsl(var(--xft-border));overflow:hidden;flex:none}',
        '.xft-dlrowbar>b{display:block;height:100%;width:0;background:hsl(var(--xft-ring));border-radius:99px}',
        '.xft-dlrowpct{width:30px;text-align:right;font-variant-numeric:tabular-nums;color:hsl(var(--xft-muted-fg));flex:none}',
        '.xft-dlrowmeta{width:72px;text-align:right;font-variant-numeric:tabular-nums;color:hsl(var(--xft-muted-fg));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none}',
        '.xft-dlrow-bad .xft-dlrowname,.xft-dlrow-bad .xft-dlrowpct,.xft-dlrow-bad .xft-dlrowmeta{color:hsl(var(--xft-destructive))}',
        '.xft-dlrow-bad .xft-dlrowbar>b{background:hsl(var(--xft-destructive))}',
        '.xft-dlzip .xft-dlprog>i{width:100%;background:linear-gradient(90deg,transparent,hsl(var(--xft-ring)),transparent);background-size:200% 100%;animation:xft-dlslide 1.1s linear infinite}',
        '@keyframes xft-dlslide{from{background-position:200% 0}to{background-position:-200% 0}}',
        '.xft-dl-run{background:hsl(var(--xft-ring)/.18)!important;border-color:hsl(var(--xft-ring))!important}',
        '.xft-jumps{position:absolute;right:10px;bottom:14px;display:flex;flex-direction:column;gap:6px;z-index:5}',
        '.xft-jumps[hidden]{display:none}',
        '.xft-jumpbtn{width:30px;height:30px;padding:0;font-size:14px;line-height:1;border-radius:8px;box-shadow:0 2px 8px hsl(240 10% 3.9%/.25)}',
        // group headers: label + hairline filler; the fixed heights (30/24)
        // are the virtual grid's headH/subH inputs — keep CSS and
        // layoutMetrics in sync if these change
        '.xft-ghead{display:flex;align-items:center;gap:8px;height:30px;user-select:none}',
        '.xft-ghead.xft-gjump{cursor:pointer}',
        '.xft-glabel{font-size:12px;font-weight:600;color:hsl(var(--xft-fg));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70%}',
        '.xft-gline{flex:1 1 auto;border-top:1px solid hsl(var(--xft-border))}',
        '.xft-gsub{height:24px;padding-left:14px}',
        '.xft-gsub .xft-glabel{font-weight:500;font-size:11px;color:hsl(var(--xft-muted-fg))}',
        '.xft-linksbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid hsl(var(--xft-border))}',
        '.xft-linksbar[hidden]{display:none}',
        // shadcn Input
        '.xft-linksbar input[type=search]{flex:1;min-width:0;height:26px;border:1px solid hsl(var(--xft-input));border-radius:calc(var(--xft-radius) - 4px);padding:0 8px;font:12px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Inter,sans-serif;background:transparent;color:hsl(var(--xft-fg))}',
        '.xft-linksbar input[type=search]::placeholder{color:hsl(var(--xft-muted-fg))}',
        '.xft-linksbar input[type=search]:focus-visible{outline:2px solid transparent;border-color:hsl(var(--xft-ring));box-shadow:0 0 0 2px hsl(var(--xft-ring)/.25)}',
        '.xft-filter{position:relative}',
        '.xft-filter-on{background:hsl(var(--xft-primary));color:hsl(var(--xft-primary-fg));font-weight:600}',
        '.xft-filter-on:hover{background:hsl(var(--xft-primary));color:hsl(var(--xft-primary-fg));opacity:.9}',
        // ---- body / grid ----
        '.xft-body{overflow-y:auto;flex:1;padding:8px 10px;scrollbar-width:thin;scrollbar-color:hsl(var(--xft-border)) transparent;overscroll-behavior:contain}',
        '.xft-body::-webkit-scrollbar{width:8px}',
        '.xft-body::-webkit-scrollbar-thumb{background:hsl(var(--xft-muted));border-radius:4px}',
        '.xft-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}',
        // windowed grid: the spacer holds the EXACT total height; only
        // windowed entries are in the DOM, positioned by transform at their
        // computed offsets (layoutMetrics)
        '.xft-vrows{position:relative}',
        '.xft-vrows>*{position:absolute;left:0;right:0;top:0}',
        '.xft-vrow{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}',
        '.xft-hq-top{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity .35s ease;z-index:2;pointer-events:none}',
        '.xft-cell .xft-hq-top{object-fit:cover}',
        '.xft-hq-top.xft-hq-on{opacity:1}',
        '.xft-cell{position:relative;aspect-ratio:1;overflow:hidden;border:1px solid hsl(var(--xft-border));border-radius:calc(var(--xft-radius) - 2px);cursor:zoom-in;background:hsl(var(--xft-muted));padding:0;transition:box-shadow .15s}',
        '.xft-cell:hover{box-shadow:0 0 0 2px hsl(var(--xft-ring)/.35)}',
        '.xft-cell img,.xft-cell video{width:100%;height:100%;object-fit:cover;display:block}',
        // video thumbs: no fetch — a muted gradient tile with the ▶ badge
        '.xft-cell .xft-vtile{width:100%;height:100%;background:linear-gradient(160deg,hsl(var(--xft-muted)),hsl(var(--xft-muted-fg)/.14));display:flex;align-items:center;justify-content:center;position:relative}',
        // the video ▶ marker is the .xft-cell-badge chip — do not add a second one here
        '.xft-cell-label{position:absolute;left:0;right:0;bottom:0;background:linear-gradient(transparent,hsl(240 10% 3.9%/.82));color:hsl(0 0% 98%);font-size:10px;padding:12px 5px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}',
        // shadcn Badge (secondary) for the ▶ marker
        '.xft-cell-badge{position:absolute;top:4px;right:4px;background:hsl(240 10% 3.9%/.72);color:hsl(0 0% 98%);border-radius:9999px;font-size:10px;font-weight:500;padding:1px 7px;pointer-events:none}',
        '.xft-badge-album{top:4px;left:4px;right:auto;background:hsl(var(--xft-ring)/.55)}',
        '.xft-album-tile{flex-direction:column;gap:2px}',
        '.xft-album-count{font-size:11px;font-weight:600;color:hsl(var(--xft-muted-fg));background:hsl(var(--xft-muted));border-radius:9999px;padding:2px 10px}',
        '.xft-broken{opacity:.15;filter:grayscale(1)}',
        // stalled: origin is burst-failing — the slot is HELD while a
        // background ladder rechecks; visually distinct from shimmer
        // (loading) and ⚠ (gone): muted, breathing, retry hint
        '.xft-cell.xft-stalled{opacity:.45;animation:xft-skel-pulse 1.6s ease-in-out infinite}',
        '.xft-cell.xft-stalled::after{content:"↻ retrying";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;color:hsl(var(--xft-muted-fg));pointer-events:none}',
        // a dead link renders as an explicit placeholder, never a black void
        '.xft-cell.xft-broken,.xft-vthumb.xft-broken{background:hsl(var(--xft-muted))}',
        '.xft-cell.xft-broken::after{content:"⚠ broken link";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;color:hsl(var(--xft-muted-fg));pointer-events:none}',
        '.xft-vthumb.xft-broken::after{content:"⚠";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:16px;color:hsl(0 0% 98%/.7)}',
        // ---- links table ----
        '.xft-lrow{display:grid;grid-template-columns:170px 1fr;gap:8px;align-items:baseline;padding:3px 0;border-bottom:1px solid hsl(var(--xft-border)/.5)}',
        '.xft-lrow-first{padding-top:6px}',
        '.xft-lcell-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;color:hsl(var(--xft-fg));font-weight:500;background:none}',
        '.xft-lcell-label:hover,.xft-lcell-label:focus-visible{text-decoration:underline;text-underline-offset:2px;color:hsl(var(--xft-primary))}',
        '.xft-lcell-link{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
        '.xft-lcell-link a{color:hsl(var(--xft-muted-fg));text-decoration:none}',
        '.xft-lcell-link a:hover{color:hsl(var(--xft-fg));text-decoration:underline;text-underline-offset:2px}',
        '.xft-empty{padding:12px 0;color:hsl(var(--xft-muted-fg))}',
        // ---- popover ----
        '.xft-fpop{position:absolute;top:calc(100% + 6px);right:0;min-width:200px;max-width:280px;max-height:280px;overflow:auto;scrollbar-width:thin;background:hsl(var(--xft-popover));border:1px solid hsl(var(--xft-border));border-radius:calc(var(--xft-radius) - 2px);box-shadow:0 8px 30px hsl(240 10% 3.9%/.22);padding:6px;z-index:20}',
        '.xft-fpop-head{display:flex;gap:6px;padding:2px 2px 6px;border-bottom:1px solid hsl(var(--xft-border)/.6);margin-bottom:4px}',
        '.xft-fpop-head .xft-btn{height:22px;padding:0 8px;font-size:11px;background:transparent;color:hsl(var(--xft-muted-fg))}',
        '.xft-fpop label{display:flex;align-items:center;gap:6px;padding:3px 5px;border-radius:calc(var(--xft-radius) - 4px);font-size:11px;color:hsl(var(--xft-fg));cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.xft-fpop label:hover{background:hsl(var(--xft-accent))}',
        '.xft-fpop label span{overflow:hidden;text-overflow:ellipsis}',
        // ---- notice / settings ----
        '.xft-note{padding:6px 10px;border-top:1px solid hsl(var(--xft-border));color:hsl(32 95% 30%);background:hsl(38 92% 50%/.14);font-size:11px}',
        '.xft-note[hidden]{display:none}',
        '.xft-settings{padding:8px;border-bottom:1px solid hsl(var(--xft-border))}',
        '.xft-settings[hidden]{display:none}',
        '.xft-set-row{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:11px;color:hsl(var(--xft-fg))}',
        // ---- AI chat tab ----
        '.xft-ai{display:flex;flex-direction:column;gap:8px;height:100%}',
        '.xft-ai-cfg{display:flex;flex-direction:column;gap:2px;padding:8px;border:1px solid hsl(var(--xft-border));border-radius:var(--xft-radius);background:hsl(var(--xft-muted))}',
        '.xft-ai-cfg[hidden]{display:none}',
        '.xft-ai-hint{font-size:10px;color:hsl(var(--xft-muted-fg));margin:6px 0 2px}',
        '.xft-ai-ctxrow{display:flex;align-items:center;gap:8px;justify-content:space-between;font-size:11px;color:hsl(var(--xft-muted-fg))}',
        '.xft-ai-log{display:flex;flex-direction:column;gap:6px;overflow-y:auto;flex:1 1 auto;min-height:80px;padding:8px;border:1px solid hsl(var(--xft-border));border-radius:var(--xft-radius);background:hsl(var(--xft-bg))}',
        '.xft-ai-send{flex:0 0 44px;width:44px;height:48px;min-width:44px;font-size:14px;line-height:1;padding:0}',
        '.xft-ai-testmsg{font-size:11px;color:hsl(var(--xft-muted-fg))}',
        '.xft-ai-testbad{color:hsl(0 62% 60%)}',
        '.xft-ai-empty{color:hsl(var(--xft-muted-fg));font-size:12px;padding:8px}',
        '.xft-ai-m{max-width:88%;padding:6px 10px;border-radius:calc(var(--xft-radius) - 2px);font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-word}',
        '.xft-ai-user{align-self:flex-end;background:hsl(var(--xft-primary)/.15);border:1px solid hsl(var(--xft-primary)/.35)}',
        '.xft-ai-asst{align-self:flex-start;background:hsl(var(--xft-muted))}',
        '.xft-ai-err{align-self:flex-start;background:hsl(0 62% 45%/.12);border:1px solid hsl(0 62% 45%/.4);color:hsl(0 70% 75%)}',
        '.xft-ai-note{align-self:center;background:none;border:none;color:var(--xft-mut);font-size:11px;font-style:italic;padding:2px 6px}',
        '.xft-ai-pend{opacity:.6}',
        '.xft-ai-asst p{margin:0 0 6px}.xft-ai-asst p:last-child{margin-bottom:0}',
        '.xft-ai-asst h2,.xft-ai-asst h3,.xft-ai-asst h4{margin:8px 0 4px;font-size:13px;line-height:1.3}',
        '.xft-ai-asst h2{font-size:14px}.xft-ai-asst h3{font-size:13px}.xft-ai-asst h4{font-size:12px}',
        '.xft-ai-asst ul,.xft-ai-asst ol{margin:0 0 6px;padding-left:18px}',
        '.xft-ai-asst li{margin:2px 0}',
        '.xft-ai-asst blockquote{margin:0 0 6px;padding:2px 10px;border-left:3px solid hsl(var(--xft-border));color:hsl(var(--xft-muted-fg))}',
        '.xft-ai-asst hr{border:none;border-top:1px solid hsl(var(--xft-border));margin:8px 0}',
        '.xft-ai-asst a{color:hsl(var(--xft-ring));text-decoration:underline;word-break:break-all}',
        '.xft-ai-icode{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;background:hsl(var(--xft-bg));border:1px solid hsl(var(--xft-border));border-radius:4px;padding:1px 4px}',
        '.xft-ai-code{margin:0 0 6px;padding:8px 10px;background:hsl(var(--xft-bg));border:1px solid hsl(var(--xft-border));border-radius:calc(var(--xft-radius) - 2px);overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.45;white-space:pre}',
        '.xft-ai-asst .xft-ai-code:last-child{margin-bottom:0}',
        '.xft-ai-quick{display:flex;gap:6px;flex-wrap:wrap}',
        '.xft-ai-bar{display:flex;gap:6px;align-items:flex-end}',
        '.xft-ai-input{flex:1;min-width:0;resize:vertical;font:inherit;font-size:12px;line-height:1.4;padding:6px 8px;color:hsl(var(--xft-fg));background:hsl(var(--xft-bg));border:1px solid hsl(var(--xft-input));border-radius:calc(var(--xft-radius) - 2px)}',
        '.xft-ai-input:focus-visible{outline:2px solid transparent;border-color:hsl(var(--xft-ring));box-shadow:0 0 0 2px hsl(var(--xft-ring)/.25)}',
        '.xft-set-row span{flex:0 0 150px;color:hsl(var(--xft-muted-fg))}',
        '.xft-set-row input{flex:1;height:24px;border:1px solid hsl(var(--xft-input));border-radius:calc(var(--xft-radius) - 4px);padding:0 6px;font-size:11px;background:transparent;color:hsl(var(--xft-fg))}',
        '.xft-set-row input:focus-visible{outline:2px solid transparent;border-color:hsl(var(--xft-ring));box-shadow:0 0 0 2px hsl(var(--xft-ring)/.25)}',
        // ---- viewer (always dark media surface, independent of theme) ----
        '#xft-viewer{position:fixed;inset:0;background:hsl(240 10% 3.9%/.94);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}',
        '#xft-viewer iframe{width:min(92vw,1120px);aspect-ratio:16/9;max-height:80vh;border:0;border-radius:calc(var(--xft-radius) - 2px);background:#000}',
        // every viewer media sits in ONE fixed-size slot: no size popping
        // between items; shimmer until loaded
        '.xft-vslot{position:relative;height:80vh;width:min(92vw,1120px);display:flex;align-items:center;justify-content:center;background:#000;border-radius:calc(var(--xft-radius) - 2px);overflow:hidden}',
        // fixed-height media stage: paging must not move bar/filmstrip
        '.xft-vstage{height:80vh;width:min(92vw,1120px);display:flex;align-items:center;justify-content:center}',
        // image slot: narrow placeholder box while loading; JS sets the
        // exact aspect width on load (markMediaLoaded / openViewerAt)
        '.xft-vslot.xft-vimg{width:min(45vh,420px)}',
        '.xft-vslot img,.xft-vslot video{max-width:100%;max-height:100%;object-fit:contain}',
        // media renders PROGRESSIVELY while loading (no opacity gate): a
        // progressive JPEG paints blurry-then-sharp on its own — a real
        // blur-up with zero extra requests (hosts offer no tiny-image URLs)
        // reveal-on-load (lazy-load style): while an image streams, it stays
        // hidden inside its shimmer skeleton (no progressive part-by-part
        // painting); when it loads, it fades in sharp as a whole. Cached
        // images are already .xft-ok at build → render instantly.
        '.xft-cell img,.xft-vthumb img,.xft-vslot img{opacity:0;filter:blur(6px);transition:opacity .35s ease,filter .35s ease}',
        '.xft-cell img.xft-ok,.xft-vthumb img.xft-ok,.xft-vslot img.xft-ok{opacity:1;filter:blur(0)}',
        // tiles and video thumbs still pop on build (no progressive paint)
        '.xft-cell video,.xft-cell .xft-vtile{animation:xft-pop .3s ease-out both}',
        // skeleton: bright sweeping band + soft breathing base — strong
        // enough to read as animation, not a static tint
        '.xft-cell.xft-loading,.xft-vslot.xft-loading,.xft-embed-host.xft-loading{animation:xft-skel-pulse 1.6s ease-in-out infinite}',
        '.xft-cell.xft-loading::after,.xft-vslot.xft-loading::after,.xft-embed-host.xft-loading::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(100deg,transparent 20%,hsl(0 0% 98%/.20) 46%,hsl(0 0% 98%/.28) 50%,hsl(0 0% 98%/.20) 54%,transparent 80%);animation:xft-shimmer 1.1s linear infinite}',
        '@keyframes xft-shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}',
        '@keyframes xft-pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}',
        '@keyframes xft-skel-pulse{0%,100%{background-color:hsl(240 6% 16%)}50%{background-color:hsl(240 6% 20%)}}',
        // AFTER the loading rules on purpose: a cell that is both loading
        // and dying must fade out, not keep shimmering (same specificity,
        // source order wins)
        '.xft-cell.xft-out{animation:xft-out .22s ease-in both;pointer-events:none}',
        '@keyframes xft-out{to{opacity:0;transform:scale(.9)}}',
        '@media (prefers-reduced-motion: reduce){html:not(.xft-anim-force) .xft-cell.xft-loading::after,html:not(.xft-anim-force) .xft-vslot.xft-loading::after,html:not(.xft-anim-force) .xft-embed-host.xft-loading::after{animation:none}html:not(.xft-anim-force) .xft-cell.xft-stalled{animation:none}html:not(.xft-anim-force) .xft-cell.xft-loading,html:not(.xft-anim-force) .xft-vslot.xft-loading,html:not(.xft-anim-force) .xft-embed-host.xft-loading{animation:none}html:not(.xft-anim-force) .xft-cell img,html:not(.xft-anim-force) .xft-cell video,html:not(.xft-anim-force) .xft-cell .xft-vtile{animation:none;transition:none}html:not(.xft-anim-force) .xft-vthumb img,html:not(.xft-anim-force) .xft-vslot img{transition:none}html:not(.xft-anim-force) .xft-spinner,html:not(.xft-anim-force) #xft-viewer,html:not(.xft-anim-force) .xft-settings,html:not(.xft-anim-force) .xft-cell.xft-out{animation:none}}',
        // embed viewer box is sized BEFORE the video arrives (sign round-trip
        // + metadata load would otherwise grow the box from zero and pop)
        '.xft-embed-host{position:relative;display:flex;align-items:center;justify-content:center;width:min(92vw,1120px);aspect-ratio:16/9;max-height:80vh;border-radius:calc(var(--xft-radius) - 2px);background:#000;overflow:hidden}',
        '#xft-viewer .xft-embed-host video{width:100%;height:100%;object-fit:contain;display:block;background:#000}',
        '#xft-viewer .xft-embed-host iframe{width:100%;height:100%;border:0;background:#000}',
        '.xft-viewer-bar{display:flex;gap:8px;align-items:center;color:hsl(0 0% 98%);font-size:12px}',
        '#xft-viewer .xft-btn{background:hsl(240 5% 20%/.85);color:hsl(0 0% 98%);border-color:hsl(240 5% 32%)}',
        '#xft-viewer .xft-btn:hover{background:hsl(240 5% 28%);color:hsl(0 0% 98%)}',
        '#xft-viewer .xft-btn:disabled{opacity:.4}',
        '.xft-viewer-strip{display:flex;gap:6px;overflow-x:auto;max-width:94vw;padding:4px;scrollbar-width:thin}',
        '.xft-vthumb{flex:0 0 72px;width:72px;height:72px;border:2px solid transparent;border-radius:calc(var(--xft-radius) - 4px);overflow:hidden;cursor:pointer;background:hsl(240 5% 12%);position:relative;padding:0}',
        '.xft-vthumb img,.xft-vthumb video{width:100%;height:100%;object-fit:cover;display:block;opacity:.7;transition:opacity .15s}',
        '.xft-vthumb:hover img,.xft-vthumb:hover video{opacity:1}',
        '.xft-vthumb-active{border-color:hsl(0 0% 98%)}',
        '.xft-vthumb-active img,.xft-vthumb-active video{opacity:1}',
        '.xft-vtile img{width:100%;height:100%;object-fit:cover;display:block}',
        // ---- sorted clones / misc (host-page surface) ----
        'article.xf-fetched{border:1px solid hsl(var(--xft-border)/.6);border-radius:var(--xft-radius);margin:8px 0;padding:8px 12px;background:transparent}',
        '.xft-clone-head{font-size:11px;color:hsl(var(--xft-muted-fg));margin-bottom:6px}',
        '.xft-show-more{display:block;margin:8px auto}',
        '.xft-sort-marker{display:none}',
        '.xft-pulse{outline:3px solid transparent;animation:xftpulse 1.6s ease-out 2}',
        '@keyframes xftpulse{0%{outline-color:hsl(38 92% 50%)}100%{outline-color:transparent}}',
        '#xft-sort-btn{margin-left:4px;cursor:pointer}',
        '@media (prefers-reduced-motion:reduce){html:not(.xft-anim-force) #xft-panel,html:not(.xft-anim-force) .xft-btn,html:not(.xft-anim-force) #xft-edge-btn,html:not(.xft-anim-force) .xft-cell{transition:none}html:not(.xft-anim-force) .xft-pulse{animation:none}html:not(.xft-anim-force) .xft-hq-top{transition:none}html:not(.xft-anim-force) .xft-dlzip .xft-dlprog>i{animation:none;background:hsl(var(--xft-ring))}html:not(.xft-anim-force) .xft-dlprog>i{transition:none}}'
      ].join('');
      document.head.appendChild(st);
    }

    // ---------- boot ----------
    (async function init() {
      injectStyles();
      await cache.init();
      const savedMeta = await cache.getThreadMeta(threadKey);
      if (savedMeta) {
        // load complete AND partial caches — partial data stays usable (resume)
        const recs = await cache.getAllPosts(threadKey);
        for (const r of recs) hub.records.set(r.postId, r);
        recordsVersion += 1;
        hub.meta = Object.assign({ threadKey: threadKey, pageCount: getPageCount(), postIds: [], pagesDone: [], fetchedAt: 0, complete: false }, savedMeta);
        hub.meta.pageCount = Math.max(hub.meta.pageCount, getPageCount());
        hub.pagesDone = new Set(savedMeta.pagesDone || []);
        // always re-seed the live page: current-page records refresh with the
        // latest extractor (new media forms appear without a full ↻ Refresh)
        seedLivePage();
        if (seededPage > 0) hub.pagesDone.add(seededPage);
        hub.progress = { done: hub.meta.complete ? hub.meta.pageCount : hub.pagesDone.size, total: hub.meta.pageCount };
        if (hub.meta.pageCount === 1 && hub.pagesDone.has(1)) {
          hub.meta.complete = true;
          hub.meta.fetchedAt = Date.now();
          hub.meta.postIds = orderedRecords().map((r) => r.postId);
          hub.meta.pagesDone = Array.from(hub.pagesDone);
          cache.putThreadMeta(hub.meta).catch(() => {});
        }
      } else {
        seedLivePage();
        if (hub.meta.pageCount === 1 && seededPage === 1) {
          // whole single-page thread is already in the live DOM: no fetch needed
          hub.meta.complete = true;
          hub.meta.fetchedAt = Date.now();
          hub.meta.pagesDone = Array.from(hub.pagesDone);
          hub.meta.postIds = orderedRecords().map((r) => r.postId);
          cache.putThreadMeta(hub.meta).catch(() => {});
        }
      }
      injectToolbar();
      buildPanel();
      applyAnimOverride();
      updateProgressText();
      // background full-thread fetch: starts on page load, resumes partials,
      // never waits for the user to open the panel (setting: autoFetch)
      if (settings.autoFetch && !hub.meta.complete && !currentRun) {
        currentRun = runFetch(false).catch(() => {}).then(() => { currentRun = null; });
      }
    })();
