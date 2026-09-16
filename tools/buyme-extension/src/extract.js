/**
 * Core extraction logic, shared by the content script and the unit tests.
 *
 * BuyMe's own API shape is not documented and changes without notice, so nothing
 * here hard-codes a field path. harvestJson walks whatever JSON the page fetched
 * and keeps the objects that look like a merchant; harvestDom reads the rendered
 * cards as a fallback. Both feed the same normalize() so the two paths merge.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BuyMeExtract = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const ONLINE_RE = /מימוש\s*ONLINE/i; // "מימוש ONLINE"
  const NAME_KEYS = ['name', 'title', 'supplierName', 'businessName', 'business_name'];
  const ID_KEYS = ['id', 'supplierId', 'supplier_id', 'businessId', 'code'];
  /** A name+id pair alone is also true of categories and banners — require one of these. */
  const SIGNAL_KEYS = [
    'website', 'url', 'siteUrl', 'site_url', 'link',
    'phone', 'phoneNumber', 'tel',
    'supplier', 'supplierId', 'supplier_id',
    'redeem', 'redeemType', 'redeem_type', 'redemption',
    'branches', 'logo', 'logoUrl', 'image', 'categories', 'category',
  ];

  const firstKey = (obj, keys) => {
    for (const k of keys) {
      const v = obj[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  };

  /** Strip BuyMe's referral params so the URL is the merchant's own. */
  function cleanUrl(url) {
    if (typeof url !== 'string' || !url.trim()) return '';
    const stripped = url.replace(/[?&](utm_[^=&]*|srsltid|gclid|fbclid)=[^&]*/gi, '');
    return stripped.replace(/[?&]+$/, '').trim();
  }

  function domainOf(url) {
    if (!url) return '';
    const m = String(url).match(/^https?:\/\/([^/?#]+)/i);
    if (!m) return '';
    return m[1].toLowerCase().replace(/^www\./, '');
  }

  function categoryOf(raw) {
    const c = raw.category ?? raw.categoryName ?? raw.category_name ?? raw.categories;
    if (!c) return '';
    if (typeof c === 'string') return c.trim();
    if (Array.isArray(c)) {
      return c.map((x) => (typeof x === 'string' ? x : x && (x.name || x.title)) || '')
        .filter(Boolean).join(' | ');
    }
    if (typeof c === 'object') return String(c.name || c.title || '').trim();
    return '';
  }

  /** Only assert online/offline when something actually says so; never guess. */
  function redeemOf(raw, blob) {
    const explicit = raw.redeemType ?? raw.redeem_type ?? raw.redemption ?? raw.redeem;
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
    const flag = raw.online ?? raw.isOnline ?? raw.onlineRedemption ?? raw.online_redemption;
    if (typeof flag === 'boolean') return flag ? 'Online' : 'In-store';
    if (ONLINE_RE.test(blob)) return 'Online';
    return '';
  }

  function normalize(raw, extra) {
    const name = String(firstKey(raw, NAME_KEYS) || '').replace(/\s+/g, ' ').trim();
    if (!name) return null;
    const id = firstKey(raw, ID_KEYS);
    const website = cleanUrl(firstKey(raw, ['website', 'url', 'siteUrl', 'site_url', 'link']) || '');
    const blob = (() => { try { return JSON.stringify(raw); } catch { return ''; } })();

    return Object.assign({
      id: id == null ? '' : String(id),
      name,
      category: categoryOf(raw),
      redeem_type: redeemOf(raw, blob),
      phone: String(firstKey(raw, ['phone', 'phoneNumber', 'tel']) || '').trim(),
      website,
      domain: domainOf(website),
      buyme_url: id == null ? '' : `https://buyme.co.il/supplier/${id}`,
      source: 'api',
    }, extra || {});
  }

  function looksLikeMerchant(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (!firstKey(obj, NAME_KEYS)) return false;
    return SIGNAL_KEYS.some((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== '');
  }

  /** Walk any JSON payload and collect merchant-shaped objects. */
  function harvestJson(node, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (!node || depth > 12) return out;
    if (Array.isArray(node)) {
      for (const n of node) harvestJson(n, out, depth + 1);
      return out;
    }
    if (typeof node !== 'object') return out;

    if (looksLikeMerchant(node)) {
      const rec = normalize(node);
      if (rec) out.push(rec);
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') harvestJson(v, out, depth + 1);
    }
    return out;
  }

  /** Fallback: read the rendered merchant cards. */
  function harvestDom(doc) {
    const out = [];
    const anchors = doc.querySelectorAll('a[href*="/supplier/"]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const id = (href.match(/\/supplier\/(\d+)/) || [])[1];
      const name = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!id || !name) continue;
      const card = a.closest('li, article, div[class*="card"], div[class*="item"]') || a;
      const text = (card.textContent || '').replace(/\s+/g, ' ');
      out.push({
        id,
        name,
        category: '',
        redeem_type: ONLINE_RE.test(text) ? 'Online' : '',
        phone: '',
        website: '',
        domain: '',
        buyme_url: `https://buyme.co.il/supplier/${id}`,
        source: 'dom',
      });
    }
    return out;
  }

  /** Later records fill blanks in earlier ones; a non-empty value is never overwritten. */
  function merge(existing, incoming) {
    const byKey = new Map();
    const keyOf = (r) => r.id || r.buyme_url || `${r.name}|${r.domain}`;
    for (const r of existing || []) byKey.set(keyOf(r), Object.assign({}, r));
    for (const r of incoming || []) {
      const k = keyOf(r);
      const prev = byKey.get(k);
      if (!prev) { byKey.set(k, Object.assign({}, r)); continue; }
      for (const [field, val] of Object.entries(r)) {
        if (val !== '' && val != null && (prev[field] === '' || prev[field] == null)) prev[field] = val;
      }
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }

  const FIELDS = ['name', 'category', 'redeem_type', 'phone', 'website', 'domain', 'buyme_url', 'id'];

  function toCsv(rows, fields) {
    const cols = fields || FIELDS;
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
    // BOM so Excel reads the Hebrew correctly; CRLF for the same reason.
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function categoriesOf(rows) {
    const set = new Set();
    for (const r of rows) {
      for (const part of String(r.category || '').split('|')) {
        const c = part.trim();
        if (c) set.add(c);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'he'));
  }

  /** Every whitespace-separated term must match somewhere in the row. */
  function search(rows, query, filters) {
    const f = filters || {};
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((r) => {
      if (f.category && !String(r.category || '').includes(f.category)) return false;
      if (f.redeem && String(r.redeem_type || '') !== f.redeem) return false;
      if (!terms.length) return true;
      const hay = `${r.name} ${r.category} ${r.domain} ${r.website} ${r.phone}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  return {
    ONLINE_RE, FIELDS,
    cleanUrl, domainOf, normalize, looksLikeMerchant,
    harvestJson, harvestDom, merge, toCsv, categoriesOf, search,
  };
});
