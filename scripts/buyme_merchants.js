#!/usr/bin/env node
/**
 * Extract the merchants that honor a BuyMe voucher into merchants.json.
 *
 * buyme.co.il is a React SPA: plain HTTP returns nav chrome only, so this drives a
 * headless Chromium. Every XHR/fetch is logged first (api-log.json) — when the page's
 * own JSON API turns up in that log, paging it directly is cheaper and more complete
 * than scraping cards, so the script prefers it and falls back to the DOM otherwise.
 *
 *   NODE_PATH=$(npm root -g) node scripts/buyme_merchants.js [brandId] [--headful]
 *
 * Defaults to brand 13438757 (BUYME ALL) with the online-redemption filter on.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BRAND_ID = process.argv.find((a) => /^\d+$/.test(a)) || '13438757';
const PAGE_URL = `https://buyme.co.il/brands/${BRAND_ID}?online=true`;
const OUT_DIR = process.cwd();
const ONLINE_RE = /מימוש\s*ONLINE/i;

/** Responses worth recording: JSON bodies from the site's own origin. */
function isApiCandidate(response) {
  const url = response.url();
  const type = (response.headers()['content-type'] || '').toLowerCase();
  if (!/buyme|multipass/i.test(url)) return false;
  return type.includes('json') || /\/api\/|\/v\d+\//.test(url);
}

/** Pull merchants out of whatever shape the API returned. */
function harvest(node, sink, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) return node.forEach((n) => harvest(n, sink, depth + 1));
  if (typeof node !== 'object') return;

  const name = node.name || node.title || node.supplierName || node.businessName;
  const id = node.id || node.supplierId || node.supplier_id;
  if (typeof name === 'string' && name.trim() && id != null) {
    const blob = JSON.stringify(node);
    sink.set(String(id), {
      name: name.trim(),
      // Only assert true when the payload actually says so; never infer from the filter.
      online_redemption: /online/i.test(blob) ? Boolean(
        node.online ?? node.isOnline ?? node.onlineRedemption ?? ONLINE_RE.test(blob)
      ) : null,
      category: node.category?.name || node.categoryName || node.category || null,
      buyme_url: `https://buyme.co.il/supplier/${id}`,
    });
  }
  for (const v of Object.values(node)) harvest(v, sink, depth + 1);
}

/** Scroll and click "load more" until the card count stops growing. */
async function exhaustList(page) {
  const countCards = () =>
    page.evaluate(() => document.querySelectorAll('a[href*="/supplier/"]').length);

  let stable = 0;
  let last = await countCards();
  for (let i = 0; i < 400 && stable < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const more = page
      .locator('button, a')
      .filter({ hasText: /עוד|הצג|טען|load more|show more/i })
      .first();
    if (await more.count().catch(() => 0)) {
      await more.click({ timeout: 2000 }).catch(() => {});
    }
    await page.waitForTimeout(900);
    const now = await countCards();
    stable = now === last ? stable + 1 : 0;
    last = now;
    if (i % 10 === 0) process.stderr.write(`  …${now} cards\n`);
  }
  return last;
}

(async () => {
  const browser = await chromium.launch({ headless: !process.argv.includes('--headful') });
  const context = await browser.newContext({
    locale: 'he-IL',
    viewport: { width: 1440, height: 1000 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const apiLog = [];
  const fromApi = new Map();
  page.on('response', async (response) => {
    if (!isApiCandidate(response)) return;
    let body = null;
    try {
      body = await response.json();
    } catch {
      return;
    }
    apiLog.push({ url: response.url(), status: response.status(), sample: body });
    harvest(body, fromApi);
  });

  console.error(`→ ${PAGE_URL}`);
  try {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    // A sandbox that blocks egress fails here, long before any bot wall. Say which.
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|NS_ERROR_PROXY/.test(err.message)) {
      console.error(
        `! egress blocked: the proxy refused CONNECT to buyme.co.il.\n` +
          `  This is the sandbox's network policy, not BuyMe blocking the scraper.\n` +
          `  Allow buyme.co.il outbound, or run this script off the sandbox.`
      );
      await browser.close();
      process.exit(2);
    }
    throw err;
  }
  await page
    .waitForSelector('a[href*="/supplier/"]', { timeout: 30000 })
    .catch(() => console.error('! no merchant cards appeared — check for a bot wall'));

  const cards = await exhaustList(page);
  console.error(`DOM settled at ${cards} cards; ${apiLog.length} JSON responses seen`);

  // DOM pass: authoritative for the ONLINE badge, which the card actually renders.
  const fromDom = await page.evaluate((onlineSrc) => {
    const re = new RegExp(onlineSrc, 'i');
    const out = new Map();
    for (const a of document.querySelectorAll('a[href*="/supplier/"]')) {
      const card = a.closest('li, article, div[class*="card"], div[class*="item"]') || a;
      const text = (card.textContent || '').replace(/\s+/g, ' ').trim();
      const name = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
      const id = (a.getAttribute('href').match(/\/supplier\/(\d+)/) || [])[1];
      if (!id || !name) continue;
      if (!out.has(id)) {
        out.set(id, {
          name,
          online_redemption: re.test(text),
          category: null,
          buyme_url: new URL(a.getAttribute('href'), location.origin).href,
        });
      }
    }
    return [...out.values()];
  }, ONLINE_RE.source);

  // DOM wins on name/badge; the API fills in category where the cards omit it.
  const merged = new Map();
  for (const m of fromApi.values()) merged.set(m.buyme_url, m);
  for (const m of fromDom) {
    const prev = merged.get(m.buyme_url);
    merged.set(m.buyme_url, { ...prev, ...m, category: m.category ?? prev?.category ?? null });
  }

  const merchants = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, 'he'));
  fs.writeFileSync(
    path.join(OUT_DIR, 'merchants.json'),
    JSON.stringify(merchants, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'api-log.json'),
    JSON.stringify(apiLog.map(({ url, status }) => ({ url, status })), null, 2) + '\n'
  );

  const online = merchants.filter((m) => m.online_redemption === true).length;
  console.error(`wrote merchants.json — ${merchants.length} merchants, ${online} flagged ONLINE`);
  if (!merchants.length) process.exitCode = 1;

  await browser.close();
})();
