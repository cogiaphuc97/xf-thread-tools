// rt-cache: IndexedDB wrapper (posts/threads stores, cap handling, fallback), cachePutPosts, threadUrl builder.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // ---------- step 6: IndexedDB cache with 100 MB cap + memory fallback ----------
    const cache = {
      mode: 'none',
      db: null,
      memPosts: new Map(),
      memThreads: new Map(),
      stopPersist: false,
      totalBytes: 0,

      open() {
        return new Promise((resolve, reject) => {
          let req;
          try { req = indexedDB.open('xf-thread-tools', 1); } catch (e) { reject(e); return; }
          // A pending open that never settles would hang boot forever with no
          // error anywhere — bail to the in-memory cache instead
          const bail = setTimeout(() => { try { req.transaction ? null : null; } catch (e) {} reject(new Error('open timeout')); }, 3000);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('posts')) {
              db.createObjectStore('posts', { keyPath: 'postId' }).createIndex('threadKey', 'threadKey');
            }
            if (!db.objectStoreNames.contains('threads')) {
              db.createObjectStore('threads', { keyPath: 'threadKey' });
            }
          };
          req.onblocked = () => { clearTimeout(bail); reject(new Error('blocked by another connection')); };
          req.onsuccess = () => { clearTimeout(bail); resolve(req.result); };
          req.onerror = () => { clearTimeout(bail); reject(req.error); };
        });
      },

      async init() {
        try {
          if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable');
          this.db = await this.open();
          this.mode = 'idb';
        } catch (err) {
          this.mode = 'memory';
          console.warn('[xf-thread-tools] IndexedDB unavailable (' + ((err && err.message) || err) + ') — session-only in-memory cache.');
        }
      },

      degradeToMemory(err) {
        this.mode = 'memory';
        console.warn('[xf-thread-tools] IndexedDB failed (' + ((err && err.message) || err) + ') — falling back to in-memory cache.');
      },

      putPosts(recs) {
        const self = this;
        if (!recs.length) return Promise.resolve();
        for (const r of recs) {
          this.memPosts.set(r.postId, r);
          this.totalBytes += measure(r);
        }
        const est = estimateSize(this.totalBytes, settings.capBytes);
        if (est.stopPersist && !this.stopPersist) {
          this.stopPersist = true;
          hub.capNotice = true;
          console.warn('[xf-thread-tools] cache cap reached (' + Math.round(est.capBytes / 1048576) + ' MB) — further posts kept in memory only.');
          notify();
        }
        if (this.mode !== 'idb' || this.stopPersist) return Promise.resolve();
        return new Promise((resolve) => {
          let tx;
          try { tx = self.db.transaction('posts', 'readwrite'); } catch (err) { self.degradeToMemory(err); resolve(); return; }
          const st = tx.objectStore('posts');
          for (const r of recs) st.put(r); // keyPath postId -> dedupe (step 5b)
          tx.oncomplete = () => resolve();
          tx.onerror = () => { self.degradeToMemory(tx.error); resolve(); };
          tx.onabort = () => { self.degradeToMemory(tx.error); resolve(); };
        });
      },

      getAllPosts(tk) {
        const self = this;
        if (this.mode === 'idb') {
          return new Promise((resolve) => {
            let req;
            try {
              const tx = self.db.transaction('posts', 'readonly');
              req = tx.objectStore('posts').index('threadKey').getAll(tk);
            } catch (err) { self.degradeToMemory(err); req = null; }
            if (!req) { resolve(self.memPostsFor(tk)); return; }
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => { self.degradeToMemory(req.error); resolve(self.memPostsFor(tk)); };
          });
        }
        return Promise.resolve(this.memPostsFor(tk));
      },

      memPostsFor(tk) {
        const out = [];
        for (const r of this.memPosts.values()) if (r.threadKey === tk) out.push(r);
        return out;
      },

      getThreadMeta(tk) {
        const self = this;
        if (this.mode === 'idb') {
          return new Promise((resolve) => {
            let req;
            try { req = self.db.transaction('threads', 'readonly').objectStore('threads').get(tk); }
            catch (err) { self.degradeToMemory(err); req = null; }
            if (!req) { resolve(self.memThreads.get(tk) || null); return; }
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => { self.degradeToMemory(req.error); resolve(self.memThreads.get(tk) || null); };
          });
        }
        return Promise.resolve(this.memThreads.get(tk) || null);
      },

      putThreadMeta(meta) {
        const self = this;
        this.memThreads.set(meta.threadKey, meta);
        if (this.mode !== 'idb' || this.stopPersist) return Promise.resolve();
        return new Promise((resolve) => {
          let tx;
          try { tx = self.db.transaction('threads', 'readwrite'); } catch (err) { self.degradeToMemory(err); resolve(); return; }
          tx.objectStore('threads').put(meta);
          tx.oncomplete = () => resolve();
          tx.onerror = () => { self.degradeToMemory(tx.error); resolve(); };
          tx.onabort = () => { self.degradeToMemory(tx.error); resolve(); };
        });
      },

      clearThread(tk) {
        const self = this;
        for (const [k, r] of Array.from(this.memPosts.entries())) {
          if (r.threadKey === tk) this.memPosts.delete(k);
        }
        this.memThreads.delete(tk);
        this.totalBytes = 0;
        this.stopPersist = false;
        if (this.mode !== 'idb') return Promise.resolve();
        return new Promise((resolve) => {
          let tx;
          try { tx = self.db.transaction('posts', 'readwrite'); } catch (err) { self.degradeToMemory(err); resolve(); return; }
          const idx = tx.objectStore('posts').index('threadKey');
          let req;
          try { req = idx.openCursor(IDBKeyRange.only(tk)); } catch (err) { resolve(); return; }
          req.onsuccess = () => {
            const cur = req.result;
            if (cur) { cur.delete(); cur.continue(); }
          };
          tx.oncomplete = () => {
            const tx2 = (function () {
              try { return self.db.transaction('threads', 'readwrite'); } catch (err) { self.degradeToMemory(err); return null; }
            })();
            if (!tx2) { resolve(); return; }
            try { tx2.objectStore('threads').delete(tk); } catch (e) { /* already degraded */ }
            tx2.oncomplete = () => resolve();
            tx2.onerror = () => resolve();
          };
          tx.onerror = () => { self.degradeToMemory(tx.error); resolve(); };
          tx.onabort = () => { self.degradeToMemory(tx.error); resolve(); };
        });
      }
    };

    function cachePutPosts(recs) { cache.putPosts(recs).catch(() => {}); }

    // ---------- step 4: sequential, abortable, stop-with-partial fetcher ----------
    function threadUrl(suffix) {
      return location.origin + settings.basePath + '/' + route.prefix + '/' + route.seg + suffix;
    }

