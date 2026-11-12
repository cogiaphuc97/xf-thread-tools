// Runtime guard: silent exit on non-XF / non-thread pages; under Node
// (tests) document is undefined and nothing below ever runs.
  const rootEl = typeof document !== 'undefined' ? document.documentElement : null;
  if (rootEl && rootEl.id === 'XF' && rootEl.dataset && rootEl.dataset.template === 'thread_view') {
    try {
      main();
    } catch (err) {
      console.warn('[xf-thread-tools] init failed: ' + ((err && err.message) || err));
    }
  }
