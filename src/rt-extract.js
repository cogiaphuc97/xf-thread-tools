// rt-extract: Record ordering/positions, URL absolutize, lazy body HTML, extractPost (media/links/imgPages/albums, quote+signature skip), doc extraction, live-page seed, size measurement.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    function orderedRecords() {
      const arr = Array.from(hub.records.values());
      arr.sort((a, b) => (a.pageN - b.pageN) || (a.seq - b.seq));
      return arr;
    }

    function posOf(postId) {
      if (!posMap || posMapVersion !== recordsVersion) {
        posMap = new Map(orderedRecords().map((r, i) => [r.postId, i + 1]));
        posMapVersion = recordsVersion;
      }
      return posMap.get(postId);
    }

    function absolutize(u) {
      try { return new URL(u, location.origin).href; } catch (e) { return ''; }
    }

    // ---------- step 5: extractor ----------
    function lazyBodyHtml(bodyEl) {
      const c = bodyEl.cloneNode(true);
      c.querySelectorAll('img').forEach((im) => {
        im.setAttribute('loading', 'lazy');
        im.removeAttribute('data-xf-init');
      });
      return c.innerHTML;
    }

    function extractPost(art, pageN, seq) {
      const dc = art.getAttribute('data-content') || '';
      const postId = dc.indexOf('post-') === 0 ? dc.slice(5) : dc;
      const authorEl = art.querySelector(SEL.author);
      const dateEl = art.querySelector(SEL.date);
      // Signatures carry their OWN .bbWrapper (XF2: aside.message-signature >
      // div.bbWrapper). A post with no/empty body would otherwise extract the
      // signature as the post body — take the first body OUTSIDE the signature.
      let body = null;
      for (const b of art.querySelectorAll(SEL.postBody)) {
        if (!b.closest(SEL.signature)) { body = b; break; }
      }

      let reactionCount = 0;
      const bar = art.querySelector(SEL.reactionsBar);
      if (bar && bar.classList.contains('is-active')) {
        const link = bar.querySelector(SEL.reactionsLink);
        if (link) reactionCount = parseReactionCount(link.textContent);
      }

      const rawLinks = [];
      const images = [];
      const videos = [];
      const embeds = [];
      const imgPages = {}; // embeddedUrl -> image landing page (/img/<id>)
      // Quoted content is a COPY of another post's media/links — collect only
      // what THIS post authored (probe 2026-10-29: 9 of 19 bbImage were inside
      // blockquote.bbCodeBlock--quote on a live page). Signature content is
      // boilerplate the author did not write in this post — skip it too.
      const skip = (el) => !!((el.closest && (el.closest(SEL.quote) || el.closest(SEL.signature))));
      if (body) {
        body.querySelectorAll('a[href]').forEach((a) => {
          if (!skip(a)) rawLinks.push(a.getAttribute('href') || '');
        });
        body.querySelectorAll(SEL.image).forEach((im) => {
          if (skip(im)) return;
          // smilies are not content media: XF marks them with class "smilie"
          // ("smilie--sprite67", "smilie smilie--emoji", …); legacy editors
          // also embed them as plain bbImage <img> whose URL hits /smilies/
          if ([].some.call(im.classList, (t) => t === 'smilie' || t.indexOf('smilie--') === 0)) return;
          // Lazy-loaded images carry a 1×1 svg data-URI placeholder in src;
          // the real URL lives in data-src/data-url (voz-style lazy loading).
          // Placeholder-first means src must be discarded when it is data:/blob:.
          let s = im.getAttribute('src') || '';
          if (/^(data|blob):/i.test(s)) {
            s = im.getAttribute('data-src') || im.getAttribute('data-url') || im.getAttribute('data-lazy-src') || '';
          }
          if (s && !isSmilieUrl(s)) {
            const abs = absolutize(s);
            images.push(abs);
            // a wrapper anchor to the image's own landing page is the only
            // route to the full-quality original for re-encoded embeds
            const wrapA = im.closest('a[href]');
            const page = wrapA ? imagePageHref(wrapA.getAttribute('href') || '') : '';
            if (page) imgPages[abs] = page;
          }
        });
        // HTML5 videos: <video class="videotag"><source src> (site media threads)
        body.querySelectorAll('video').forEach((v) => {
          if (skip(v)) return;
          const srcEl = v.querySelector('source');
          const s = (srcEl && srcEl.getAttribute('src')) || v.getAttribute('src') || '';
          if (s) videos.push(absolutize(s));
        });
        // Third-party embed iframes (video hosts): the real <video> lives in a
        // cross-origin document we cannot read, and its src is a signed URL
        // that expires — the iframe src itself is the only stable, playable
        // identifier. Lazy variants carry the URL in data-src.
        body.querySelectorAll('iframe').forEach((f) => {
          if (skip(f)) return;
          let s = f.getAttribute('src') || '';
          if (!s || /^(data|blob):/i.test(s)) s = f.getAttribute('data-src') || '';
          if (/^https?:/i.test(s)) embeds.push(absolutize(s));
        });
      }
      // XF2 attachment blocks (.message-attachments) sit OUTSIDE .bbWrapper —
      // scan the whole article; video-file attachments go to Videos by extension
      art.querySelectorAll(SEL.attachment).forEach((a) => {
        if (skip(a)) return;
        const h = a.getAttribute('href') || '';
        if (!h) return;
        const abs = absolutize(h);
        if (VID_EXT_RE.test(abs)) videos.push(abs);
        else images.push(abs);
      });

      // media-file anchors (lightbox wraps img.bbImage in <a>) belong on the
      // Files/Videos tabs, not Links — partition before filtering
      const parts = partitionLinks(rawLinks);
      for (const u of parts.imageLinks) images.push(absolutize(u));
      for (const u of parts.videoLinks) videos.push(absolutize(u));
      // short-slug /d/ file pages (filester-style): extension-less links that
      // are video landing pages on ANOTHER host — they belong on Videos,
      // where the resolver streams them direct; same-host /d/ routes are the
      // forum's own and stay on Links
      const restLinks = [];
      const albums = [];
      for (const u of parts.links) {
        const abs = absolutize(u);
        if (isFileDPageUrl(abs) && extractDomain(abs) !== hostKey(location.host)) videos.push(abs);
        else if (isAlbumPageUrl(abs) && extractDomain(abs) !== hostKey(location.host)) albums.push(abs);
        else restLinks.push(u);
      }
      const imgSet = new Set(images.filter(Boolean));
      const vidSet = new Set(videos.filter(Boolean));
      const embSet = new Set(embeds.filter(Boolean));
      return {
        threadKey: threadKey,
        postId: postId,
        pageN: pageN,
        seq: seq,
        author: authorEl ? (authorEl.textContent || '').trim() : '',
        date: dateEl ? (dateEl.getAttribute('datetime') || '') : '',
        reactionCount: reactionCount,
        bodyHtml: body ? lazyBodyHtml(body) : '',
        links: filterLinks(restLinks, location.host).filter((u) => !imgSet.has(u) && !vidSet.has(u) && !embSet.has(u)),
        images: Array.from(new Set(images.filter(Boolean))),
        videos: Array.from(new Set(videos.filter(Boolean))),
        embeds: Array.from(new Set(embeds.filter(Boolean))),
        albums: albums.length ? Array.from(new Set(albums)) : undefined, // old records: undefined
        imgPages: Object.keys(imgPages).length ? imgPages : undefined // old records: undefined
      };
    }

    function extractPostsFromDoc(doc, pageN) {
      const out = [];
      let seq = 0;
      const arts = Array.from(doc.querySelectorAll(SEL.post));
      for (const art of arts) {
        try { out.push(extractPost(art, pageN, seq)); seq += 1; } catch (e) { /* skip malformed post */ }
      }
      return out;
    }

    function seedLivePage() {
      const page = getCurrentPage();
      if (seededPage === page) return;
      const recs = extractPostsFromDoc(document, page);
      for (const r of recs) hub.records.set(r.postId, r);
      seededPage = page;
      recordsVersion += 1;
      cachePutPosts(recs); // step 5b: postId keyPath dedupes at write
    }

    function measure(rec) {
      try { return JSON.stringify(rec).length * 2; } catch (e) { return 0; } // UTF-16 estimate
    }

