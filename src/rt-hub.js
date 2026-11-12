// rt-hub: Shared thread state hub (meta, fetch progress) + record version/pos-map/sorter-pending state.
// Order-preserving slice of main()'s body — shares main() scope; no imports.
    // ---------- shared state ----------
    const hub = {
      records: new Map(),            // postId -> record
      meta: { threadKey: threadKey, pageCount: getPageCount(), postIds: [], fetchedAt: 0, complete: false },
      progress: { done: 0, total: 0 },
      fetchRunning: false,
      abortRef: null,                // { aborted: boolean }
      pagesDone: new Set(),          // fetched page numbers (resume support)
      capNotice: false,
      partialNotice: false,
      partialWhy: ''
    };
    let recordsVersion = 0;          // bumped on every records mutation
    let posMap = null;
    let posMapVersion = -1;
    let sorterPending = false;
    let seededPage = -1;             // page number seeded from the live DOM
    let currentRun = null;

