/**
 * End-to-end check in real Chromium with the extension loaded.
 *
 * buyme.co.il is unreachable from CI and we must not hammer it anyway, so
 * Playwright serves a stand-in page on that origin. That keeps the content
 * script's match patterns honest — it runs because the URL really is
 * buyme.co.il, not because the test relaxed anything.
 *
 *   xvfb-run -a node test/e2e.mjs
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolved through CommonJS so a globally installed Playwright (NODE_PATH) works.
const { chromium } = createRequire(import.meta.url)('playwright');

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Chrome derives an unpacked extension's id from the SHA-256 of its path. */
function extensionId(absPath) {
  const hash = crypto.createHash('sha256').update(absPath).digest('hex');
  return hash.slice(0, 32).split('')
    .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const MERCHANT_PAGE = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<title>בתי עסק מכבדים</title></head><body>
<div id="list">
  <div class="card"><a href="/supplier/111" title="חנות אלפא">חנות אלפא</a><span>מימוש ONLINE</span></div>
  <div class="card"><a href="/supplier/222" title="חנות בטא">חנות בטא</a></div>
  <div class="card"><a href="/supplier/333" title="חנות גמא">חנות גמא</a><span>מימוש ONLINE</span></div>
</div>
<script>
  // The real site loads its list over XHR/fetch; this mirrors that so the
  // interceptor is exercised the same way.
  fetch('/api/v2/suppliers?page=1').then(r => r.json()).then(d => {
    window.__loaded = d.data.items.length;
  });
</script>
</body></html>`;

const API = {
  data: {
    categories: [{ id: 900, name: 'אלקטרוניקה' }],
    items: [
      { id: 111, name: 'חנות אלפא', category: { name: 'אלקטרוניקה' },
        website: 'https://alpha.co.il/?utm_source=buyme&utm_medium=referral', phone: '03-1111111' },
      { id: 222, name: 'חנות בטא', category: 'אופנה',
        website: 'https://beta.co.il', phone: '03-2222222', online: false },
      { id: 333, name: 'חנות גמא', category: 'אלקטרוניקה',
        website: 'https://gamma.co.il', phone: '03-3333333', online: true },
    ],
  },
};

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'buyme-ext-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

try {
  const id = extensionId(EXT);

  // One handler, because Playwright gives precedence to the most recently
  // registered route — a separate catch-all would shadow the API route.
  await ctx.route('**://buyme.co.il/**', (route) => {
    const url = route.request().url();
    if (url.includes('/api/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(API) });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: MERCHANT_PAGE });
  });

  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('   [page error]', m.text()); });
  page.on('pageerror', (e) => console.log('   [page exception]', e.message));
  await page.goto('https://buyme.co.il/brands/13438757?online=true', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__loaded === 3, null, { timeout: 10000 });
  await page.waitForTimeout(2000); // content script debounces its writes

  // Read what the extension stored, from the extension's own context.
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/src/popup.html`);
  await popup.waitForLoadState('domcontentloaded');

  const stored = await popup.evaluate(async () => {
    const got = await chrome.storage.local.get(['merchants']);
    return got.merchants || [];
  });

  check('extension loaded and popup reachable', stored !== undefined, `id ${id}`);
  check('captured all 3 merchants from the intercepted API', stored.length === 3, `got ${stored.length}`);

  const alpha = stored.find((r) => r.name === 'חנות אלפא');
  check('category came through from the API payload', alpha?.category === 'אלקטרוניקה', alpha?.category);
  check('utm referral params stripped from website',
    alpha?.website === 'https://alpha.co.il/', alpha?.website);
  check('domain derived', alpha?.domain === 'alpha.co.il', alpha?.domain);
  check('phone captured', alpha?.phone === '03-1111111', alpha?.phone);
  check('buyme_url built from id', alpha?.buyme_url === 'https://buyme.co.il/supplier/111');

  const beta = stored.find((r) => r.name === 'חנות בטא');
  const gamma = stored.find((r) => r.name === 'חנות גמא');
  check('online:false maps to In-store', beta?.redeem_type === 'In-store', beta?.redeem_type);
  check('online:true maps to Online', gamma?.redeem_type === 'Online', gamma?.redeem_type);
  check('category objects were not mistaken for merchants',
    !stored.some((r) => r.name === 'אלקטרוניקה' && !r.phone));

  // The popup renders from storage.
  await popup.reload();
  await popup.waitForFunction(() => document.querySelectorAll('#results li').length > 0, null, { timeout: 5000 });
  const rendered = await popup.locator('#results li').count();
  check('popup lists the stored merchants', rendered === 3, `${rendered} rows`);

  await popup.fill('#q', 'אלפא');
  await popup.waitForTimeout(300);
  check('search narrows the list', await popup.locator('#results li').count() === 1);

  await popup.fill('#q', '');
  await popup.selectOption('#redeem', 'Online');
  await popup.waitForTimeout(200);
  check('redeem filter works', await popup.locator('#results li').count() === 1, 'expected gamma only');

  await popup.selectOption('#redeem', '');
  await popup.selectOption('#category', 'אלקטרוניקה');
  await popup.waitForTimeout(200);
  check('category filter works', await popup.locator('#results li').count() === 2);

  const csv = await popup.evaluate(async () => {
    const got = await chrome.storage.local.get(['merchants']);
    return self.BuyMeExtract.toCsv(got.merchants || []);
  });
  check('CSV export carries a BOM for Excel', csv.startsWith('﻿'));
  check('CSV has a header plus one line per merchant',
    csv.trim().split('\r\n').length === 4, `${csv.trim().split('\r\n').length} lines`);

  await popup.screenshot({ path: path.join(EXT, 'test', 'popup.png') });
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
