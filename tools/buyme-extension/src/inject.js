/**
 * Runs in the page's own JavaScript context (MAIN world) so it can see the
 * site's fetch/XHR traffic. An isolated content script cannot — it gets a
 * separate `window`.
 *
 * This only observes: every call is passed through untouched, and any failure
 * here is swallowed so the site keeps working even if BuyMe changes shape.
 */
(function () {
  'use strict';
  if (window.__buymeHarvesterInstalled) return;
  window.__buymeHarvesterInstalled = true;

  const TAG = 'buyme-harvest';
  const MAX_BYTES = 4 * 1024 * 1024; // don't relay a payload big enough to jam postMessage

  function relay(url, text) {
    try {
      if (!text || text.length > MAX_BYTES) return;
      const trimmed = text.trim();
      if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return;
      window.postMessage({ __tag: TAG, url: String(url || ''), body: trimmed }, '*');
    } catch { /* never let observation break the page */ }
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        p.then((res) => {
          try {
            const type = res.headers && res.headers.get && res.headers.get('content-type');
            if (type && !/json/i.test(type)) return;
            res.clone().text().then((t) => relay(res.url, t)).catch(() => {});
          } catch { /* ignore */ }
        }).catch(() => {});
      } catch { /* ignore */ }
      return p;
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      try { this.__buymeUrl = url; } catch { /* ignore */ }
      return open.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (...args) {
      try {
        this.addEventListener('load', () => {
          try {
            if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
            const body = this.responseType === 'json'
              ? JSON.stringify(this.response)
              : this.responseText;
            relay(this.__buymeUrl, body);
          } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
      return send.apply(this, args);
    };
  }
})();
