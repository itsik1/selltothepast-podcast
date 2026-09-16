/* Popup: search and filter what has been collected, and export it. */
(function () {
  'use strict';
  const X = self.BuyMeExtract;
  const KEY = 'merchants';
  const META = 'meta';
  const MAX_RENDER = 300; // the list is scanned, not read end to end

  const $ = (id) => document.getElementById(id);
  const el = { q: $('q'), category: $('category'), redeem: $('redeem'), results: $('results'),
    count: $('count'), empty: $('empty'), status: $('status'), scan: $('scan'),
    csv: $('csv'), json: $('json'), clear: $('clear') };

  let all = [];

  const fmtDate = (ts) => new Date(ts).toLocaleString('he-IL', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  async function refresh() {
    const got = await chrome.storage.local.get([KEY, META]);
    all = Array.isArray(got[KEY]) ? got[KEY] : [];
    const meta = got[META];

    el.status.textContent = all.length
      ? `${all.length} בתי עסק${meta?.updated ? ` · עודכן ${fmtDate(meta.updated)}` : ''}`
      : 'אין נתונים עדיין';

    const chosen = el.category.value;
    const cats = X.categoriesOf(all);
    el.category.innerHTML = '<option value="">כל הקטגוריות</option>' +
      cats.map((c) => `<option${c === chosen ? ' selected' : ''}></option>`).join('');
    // Set text via the DOM so a category name can never be read as markup.
    [...el.category.options].forEach((opt, i) => { if (i > 0) opt.value = opt.textContent = cats[i - 1]; });

    render();
  }

  function render() {
    const rows = X.search(all, el.q.value, {
      category: el.category.value,
      redeem: el.redeem.value,
    });

    el.count.textContent = rows.length
      ? `${rows.length} תוצאות${rows.length > MAX_RENDER ? ` · מוצגות ${MAX_RENDER} הראשונות` : ''}`
      : '';
    el.results.replaceChildren();

    if (!rows.length) {
      el.empty.hidden = false;
      el.empty.textContent = all.length
        ? 'אין תוצאות לחיפוש הזה.'
        : 'פתח דף בתי עסק ב‑buyme.co.il ולחץ "סרוק דף זה".';
      return;
    }
    el.empty.hidden = true;

    const frag = document.createDocumentFragment();
    for (const r of rows.slice(0, MAX_RENDER)) frag.appendChild(row(r));
    el.results.appendChild(frag);
  }

  function row(r) {
    const li = document.createElement('li');

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = r.name;
    li.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'meta';
    if (r.redeem_type) {
      const b = document.createElement('span');
      b.className = 'badge ' + (r.redeem_type === 'Online' ? 'on' : 'off');
      b.textContent = r.redeem_type === 'Online' ? 'אונליין' : 'בחנות';
      meta.appendChild(b);
    }
    if (r.category) {
      const c = document.createElement('span');
      c.className = 'cat';
      c.textContent = r.category;
      meta.appendChild(c);
    }
    if (meta.children.length) li.appendChild(meta);

    const links = document.createElement('div');
    links.className = 'links';
    if (r.website) links.appendChild(link(r.website, r.domain || 'אתר'));
    if (r.buyme_url) links.appendChild(link(r.buyme_url, 'BuyMe'));
    if (r.phone) {
      const p = document.createElement('span');
      p.className = 'cat';
      p.textContent = r.phone;
      links.appendChild(p);
    }
    if (links.children.length) li.appendChild(links);

    return li;
  }

  function link(href, text) {
    const a = document.createElement('a');
    // Only http(s) — a merchant field must never become a javascript: link.
    a.href = /^https?:\/\//i.test(href) ? href : '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = text;
    return a;
  }

  function download(text, filename, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    chrome.downloads.download({ url, filename, saveAs: true }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
  }

  /** Export what is on screen, so the category filter doubles as an export filter. */
  const visible = () => X.search(all, el.q.value, {
    category: el.category.value, redeem: el.redeem.value,
  });

  const stamp = () => new Date().toISOString().slice(0, 10);

  el.csv.addEventListener('click', () =>
    download(X.toCsv(visible()), `buyme-merchants-${stamp()}.csv`, 'text/csv;charset=utf-8'));

  el.json.addEventListener('click', () =>
    download(JSON.stringify(visible(), null, 2), `buyme-merchants-${stamp()}.json`, 'application/json'));

  el.clear.addEventListener('click', async () => {
    if (!confirm('למחוק את כל בתי העסק שנאספו?')) return;
    await chrome.storage.local.remove([KEY, META]);
    refresh();
  });

  el.scan.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:\/\/([^/]*\.)?buyme\.co\.il\//i.test(tab.url || '')) {
      el.status.textContent = 'פתח קודם דף ב‑buyme.co.il';
      return;
    }
    el.scan.disabled = true;
    el.scan.textContent = 'סורק…';
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'buyme:scan' });
      el.status.textContent = res?.ok ? `נסרקו ${res.cards} כרטיסים · ${res.total} סה״כ` : 'הסריקה נכשלה';
    } catch {
      el.status.textContent = 'רענן את הדף ונסה שוב';
    } finally {
      el.scan.disabled = false;
      el.scan.textContent = 'סרוק דף זה';
      refresh();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'buyme:progress') el.status.textContent = `סורק… ${msg.cards} כרטיסים`;
    if (msg?.type === 'buyme:updated') refresh();
  });

  let debounce;
  el.q.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(render, 120); });
  el.category.addEventListener('change', render);
  el.redeem.addEventListener('change', render);

  refresh();
})();
