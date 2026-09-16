/**
 * Isolated-world content script. Receives the JSON that inject.js observed in
 * the page context, turns it into merchant records, and keeps a merged copy in
 * extension storage. Also drives the "scan this page" sweep for the popup.
 */
(function () {
  'use strict';
  const X = self.BuyMeExtract;
  const TAG = 'buyme-harvest';
  const KEY = 'merchants';
  const META = 'meta';

  let pending = [];
  let flushTimer = null;

  async function load() {
    const got = await chrome.storage.local.get([KEY]);
    return Array.isArray(got[KEY]) ? got[KEY] : [];
  }

  /** Batch writes: a listing page can fire dozens of responses in a second. */
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      const batch = pending;
      pending = [];
      if (!batch.length) return;
      const merged = X.merge(await load(), batch);
      await chrome.storage.local.set({
        [KEY]: merged,
        [META]: { updated: Date.now(), count: merged.length, origin: location.href },
      });
      chrome.runtime.sendMessage({ type: 'buyme:updated', count: merged.length }).catch(() => {});
    }, 700);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__tag !== TAG || typeof d.body !== 'string') return;
    let parsed;
    try { parsed = JSON.parse(d.body); } catch { return; }
    const found = X.harvestJson(parsed);
    if (found.length) { pending.push(...found); scheduleFlush(); }
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Scroll and click "load more" until the card count stops growing. */
  async function sweep(onProgress) {
    const count = () => document.querySelectorAll('a[href*="/supplier/"]').length;
    let last = count();
    let stable = 0;
    for (let i = 0; i < 400 && stable < 3; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      const more = [...document.querySelectorAll('button, a')].find((el) =>
        /עוד|הצג|טען|load more|show more/i.test(el.textContent || '')
      );
      if (more) { try { more.click(); } catch { /* ignore */ } }
      await sleep(800);
      const now = count();
      stable = now === last ? stable + 1 : 0;
      last = now;
      onProgress(now);
    }
    return last;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'buyme:scan') {
      (async () => {
        const cards = await sweep((n) => {
          chrome.runtime.sendMessage({ type: 'buyme:progress', cards: n }).catch(() => {});
        });
        // Flush whatever the sweep's own network calls produced, then add the DOM pass.
        pending.push(...X.harvestDom(document));
        clearTimeout(flushTimer);
        flushTimer = null;
        const merged = X.merge(await load(), pending);
        pending = [];
        await chrome.storage.local.set({
          [KEY]: merged,
          [META]: { updated: Date.now(), count: merged.length, origin: location.href },
        });
        sendResponse({ ok: true, cards, total: merged.length });
      })();
      return true; // keep the channel open for the async reply
    }
    if (msg?.type === 'buyme:ping') { sendResponse({ ok: true }); return false; }
    return false;
  });
})();
