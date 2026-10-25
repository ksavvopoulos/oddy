export default defineContentScript({
  matches: ['https://*.dynamics.com/*', 'https://*.powerapps.com/*'],
  main() {
    let lastUrl = location.href;
    let interval: number | undefined;
    let stopped = false;

    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      if (interval !== undefined) window.clearInterval(interval);
      window.removeEventListener('popstate', notifyIfChanged);
      window.removeEventListener('hashchange', notifyIfChanged);
    };

    const notifyContextChanged = () => {
      if (stopped) return;
      try {
        if (!chrome.runtime?.id) {
          cleanup();
          return;
        }
        void chrome.runtime.sendMessage({ type: 'CONTEXT_CHANGED' }).catch(() => {
          try {
            if (!chrome.runtime?.id) cleanup();
          } catch {
            cleanup();
          }
        });
      } catch {
        // Reloading an unpacked extension invalidates content scripts already
        // running in open tabs. Stop this stale instance without logging errors.
        cleanup();
      }
    };

    function notifyIfChanged() {
      if (stopped || location.href === lastUrl) return;
      lastUrl = location.href;
      notifyContextChanged();
    }

    // A full-page entity-list navigation creates a fresh content-script instance,
    // so notify the side panel immediately rather than waiting for another URL change.
    notifyContextChanged();
    if (stopped) return;

    window.addEventListener('popstate', notifyIfChanged);
    window.addEventListener('hashchange', notifyIfChanged);
    interval = window.setInterval(notifyIfChanged, 1000);
    window.addEventListener('pagehide', cleanup, { once: true });
  }
});
