// rt-viewstate: View state (tab/subtab/scroll memory per view), viewer state vars, render queue flag, mkBtn button helper.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    let settingsView = null;
    let panelTab = 'files';
    let panelSubTab = 'all';        // media sub-tab: all | image | video
    // every view (tab × sub-tab × group) remembers its own scroll position —
    // switching views restores where the user left THAT list, it must not
    // inherit the scroll of the list being left
    const scrollMemory = {};
    let lastRenderedView = null;
    let lastUserScrollAt = 0; // ANY user scroll (wheel/drag/keys) — restores must not fight an active scroller
    let programmaticScrollAt = 0; // last time OUR code wrote the scroll position (apply/jump/normalizer)
    function viewKey() { return panelTab === 'links' ? 'links' : panelTab === 'ai' ? 'ai' : panelSubTab + ':' + settings.mediaGroup; }
    function saveViewScroll() { if (panelBodyEl) scrollMemory[viewKey()] = panelBodyEl.scrollTop; }
    // smooth for short hops, instant for long jumps (a smooth glide across
    // 50k px is a blur, not an animation). The bottom target re-asserts for
    // a couple of frames; renderSlice fires synchronously so a windowed
    // grid lands on RENDERED rows, never a blank frame.
    function jumpScroll(top) {
      if (!panelBodyEl) return;
      const apply = (n, smooth) => {
        if (!panelBodyEl || n < 0) return;
        const target = top ? 0 : panelBodyEl.scrollHeight - panelBodyEl.clientHeight;
        const far = Math.abs(target - panelBodyEl.scrollTop) > 4000;
        programmaticScrollAt = performance.now();
        panelBodyEl.scrollTo({ top: target, behavior: smooth && !far ? 'smooth' : 'auto' });
        renderSlice();
        if (!top) requestAnimationFrame(() => apply(n - 1, false));
      };
      apply(3, true);
    }
    let subtabsEl = null;
    let subTabBtns = {};
    let linksBarEl = null;
    let linkSearchEl = null;
    let linkUserSel = null;         // Set of allowed authors; null = no filter
    let linkDomainSel = null;       // Set of allowed domains; null = no filter
    let viewerItems = [];           // media items the fullscreen viewer navigates
    let viewerIndex = -1;
    let viewerKeyHandler = null;
    let rowLimit = settings.rowCap;
    let renderQueued = false;

    function mkBtn(label, fn, cls) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls || 'xft-btn';
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    }

