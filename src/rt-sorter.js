// rt-sorter: Sort button state, post clone builder, reaction sorter (reorder, chunked Show more, restore).
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    function notify() {
      updateProgressText();
      if (sorterPending && !hub.fetchRunning) {
        sorterPending = false;
        sorter.start();
      }
      schedulePanelRender();
    }

    // ---------- step 7: sorter (clone rendering, chunked) ----------
    function setSortBtn(label, busy) {
      const b = document.getElementById('xft-sort-btn');
      if (!b) return;
      b.textContent = label;
      b.disabled = !!busy;
    }

    function buildClone(rec) {
      const art = document.createElement('article');
      art.className = 'message message--post xf-fetched';
      // step 7: clones carry NO data-content / data-xf-init and no action bars,
      // so XF delegated handlers (quote/reply/react) never fire on them.
      art.setAttribute('data-post-id', rec.postId);
      const head = document.createElement('div');
      head.className = 'xft-clone-head';
      const pos = posOf(rec.postId);
      head.textContent = '#' + (pos || rec.postId) + ' · ' + (rec.author || '?') + (rec.date ? ' · ' + rec.date : '');
      const body = document.createElement('div');
      body.className = 'bbWrapper';
      body.innerHTML = rec.bodyHtml || '';
      body.querySelectorAll('img').forEach((im) => im.setAttribute('loading', 'lazy'));
      body.querySelectorAll('[data-xf-init]').forEach((el) => el.removeAttribute('data-xf-init'));
      art.append(head, body);
      return art;
    }

    const sorter = {
      active: false,
      container: null,
      originals: null,   // node references of the original articles (never destroyed)
      anchor: null,      // node right after the last original article at sort time
      marker: null,
      moreBtn: null,
      sorted: null,
      rendered: 0,
      observer: null,

      toggle() {
        if (this.active) { this.restore(); return; }
        if (sorterPending) {
          // second click while waiting for the fetch cancels it; partial data then sorts
          if (hub.abortRef) hub.abortRef.aborted = true;
          return;
        }
        sorterPending = true;
        // NOT disabled: a second click while pending cancels the fetch and
        // sorts the partial data (toggle's abort branch above)
        setSortBtn('⚡ …', false);
        updateProgressText();
        const p = ensureForSort();
        if (!hub.fetchRunning) {
          // data already complete: runFetch resolved synchronously-ish, or cached
          p.then(() => {
            if (sorterPending && !hub.fetchRunning) { sorterPending = false; sorter.start(); }
          });
        }
        // otherwise notify() renders when the fetch run ends
      },

      start() {
        const first = document.querySelector(SEL.post);
        if (!first) { setSortBtn('⚡ Sort by reactions', false); return; }
        this.container = first.parentElement;
        this.originals = Array.from(this.container.querySelectorAll(SEL.post));
        const last = this.originals[this.originals.length - 1];
        this.anchor = last ? last.nextSibling : null;
        this.marker = document.createElement('div');
        this.marker.className = 'xft-sort-marker';
        this.container.insertBefore(this.marker, this.anchor);
        this.moreBtn = document.createElement('button');
        this.moreBtn.type = 'button';
        this.moreBtn.className = 'button xft-show-more';
        this.moreBtn.textContent = 'Show more';
        this.moreBtn.addEventListener('click', () => this.renderChunk());
        this.container.insertBefore(this.moreBtn, this.anchor);
        this.sorted = sortPosts(orderedRecords());
        this.rendered = 0;
        this.active = true;
        this.observer = new IntersectionObserver((entries) => {
          if (entries.some((en) => en.isIntersecting)) this.renderChunk();
        }, { rootMargin: '800px' });
        this.observer.observe(this.moreBtn);
        this.renderChunk();
        // label partial sorts: records exist but the thread is not fully fetched
        // (canceled fetch / HTTP stop / cache cap) — the view is a subset
        setSortBtn(hub.meta.complete ? '↕ Chronological' : '↕ Chronological (partial)', false);
      },

      renderChunk() {
        if (!this.active) return;
        const liveById = new Map(this.originals.map((el) => {
          const dc = el.getAttribute('data-content') || '';
          return [dc.indexOf('post-') === 0 ? dc.slice(5) : dc, el];
        }));
        const end = Math.min(this.rendered + settings.chunkSize, this.sorted.length);
        for (let i = this.rendered; i < end; i++) {
          const rec = this.sorted[i];
          let node = liveById.get(rec.postId);
          if (node && !node.classList.contains('xft-placed')) {
            node.classList.add('xft-placed'); // originals are moved, never destroyed
          } else {
            node = buildClone(rec);
          }
          this.container.insertBefore(node, this.marker);
        }
        this.rendered = end;
        if (end >= this.sorted.length) {
          if (this.observer) this.observer.disconnect();
          if (this.moreBtn) { this.moreBtn.remove(); this.moreBtn = null; }
          if (this.marker) { this.marker.remove(); this.marker = null; }
        } else if (this.moreBtn) {
          this.moreBtn.hidden = false;
        }
      },

      restore() {
        if (this.observer) this.observer.disconnect();
        if (this.moreBtn) { this.moreBtn.remove(); this.moreBtn = null; }
        if (this.marker) { this.marker.remove(); this.marker = null; }
        if (this.container) this.container.querySelectorAll('.xf-fetched').forEach((n) => n.remove());
        if (this.originals) {
          for (const el of this.originals) {
            el.classList.remove('xft-placed');
            this.container.insertBefore(el, this.anchor); // exact original order (AC1)
          }
        }
        this.active = false;
        this.container = null;
        this.originals = null;
        this.anchor = null;
        this.sorted = null;
        this.rendered = 0;
        this.observer = null;
        setSortBtn('⚡ Sort by reactions', false);
      }
    };

