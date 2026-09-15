/* Paste into Chrome DevTools Console on:
   https://buyme.co.il/brands/13438757?online=true
   Exhausts the list, then downloads merchants.json. */
(async () => {
  const count = () => document.querySelectorAll('a[href*="/supplier/"]').length;
  let last = count(), stable = 0;
  while (stable < 3) {
    window.scrollTo(0, document.body.scrollHeight);
    const more = [...document.querySelectorAll('button,a')]
      .find(e => /עוד|הצג|טען|load more/i.test(e.textContent || ''));
    if (more) more.click();
    await new Promise(r => setTimeout(r, 900));
    const now = count();
    stable = now === last ? stable + 1 : 0;
    last = now;
    console.log('cards:', now);
  }

  const out = new Map();
  for (const a of document.querySelectorAll('a[href*="/supplier/"]')) {
    const card = a.closest('li,article,div[class*="card"],div[class*="item"]') || a;
    const text = (card.textContent || '').replace(/\s+/g, ' ').trim();
    const name = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
    const id = (a.getAttribute('href').match(/\/supplier\/(\d+)/) || [])[1];
    if (!id || !name || out.has(id)) continue;
    out.set(id, {
      name,
      online_redemption: /מימוש\s*ONLINE/i.test(text),
      category: null,
      buyme_url: new URL(a.getAttribute('href'), location.origin).href,
    });
  }

  const arr = [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'he'));
  console.table(arr.slice(0, 20));
  console.log('TOTAL', arr.length, '| ONLINE badge', arr.filter(m => m.online_redemption).length);
  const url = URL.createObjectURL(new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: 'merchants.json' }).click();
})();
