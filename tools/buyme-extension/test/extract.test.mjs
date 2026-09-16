import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const X = require('../src/extract.js');

test('cleanUrl strips BuyMe referral params but keeps real query strings', () => {
  assert.equal(
    X.cleanUrl('https://a.co.il/?utm_source=buyme&utm_medium=referral'),
    'https://a.co.il/'
  );
  assert.equal(X.cleanUrl('http://www.b.co.il?utm_source=buyme'), 'http://www.b.co.il');
  assert.equal(X.cleanUrl('https://c.co.il/p?id=7'), 'https://c.co.il/p?id=7');
  assert.equal(X.cleanUrl(''), '');
});

test('domainOf drops scheme and www', () => {
  assert.equal(X.domainOf('https://www.Shekem-Electric.co.il/x'), 'shekem-electric.co.il');
  assert.equal(X.domainOf('not a url'), '');
});

test('looksLikeMerchant rejects a bare name+id, which is also what a category looks like', () => {
  assert.equal(X.looksLikeMerchant({ id: 5, name: 'אלקטרוניקה' }), false);
  assert.equal(X.looksLikeMerchant({ id: 5, name: 'שקם', phone: '073-1' }), true);
  assert.equal(X.looksLikeMerchant(null), false);
  assert.equal(X.looksLikeMerchant([{ name: 'x', phone: '1' }]), false);
});

test('normalize builds the canonical record', () => {
  const r = X.normalize({
    id: 13438757,
    name: '  שקם   אלקטריק ',
    website: 'https://www.shekem-electric.co.il/?utm_source=buyme',
    phone: '073-2398701',
    category: { name: 'אלקטרוניקה' },
    online: false,
  });
  assert.equal(r.id, '13438757');
  assert.equal(r.name, 'שקם אלקטריק');
  assert.equal(r.domain, 'shekem-electric.co.il');
  assert.equal(r.category, 'אלקטרוניקה');
  assert.equal(r.redeem_type, 'In-store');
  assert.equal(r.buyme_url, 'https://buyme.co.il/supplier/13438757');
});

test('normalize leaves redeem_type empty rather than guessing', () => {
  const r = X.normalize({ id: 1, name: 'X', phone: '03-1' });
  assert.equal(r.redeem_type, '');
});

test('normalize reads the Hebrew ONLINE badge when no flag is present', () => {
  const r = X.normalize({ id: 2, name: 'Y', phone: '03-2', note: 'מימוש ONLINE' });
  assert.equal(r.redeem_type, 'Online');
});

test('normalize returns null without a name', () => {
  assert.equal(X.normalize({ id: 9, phone: '03-3' }), null);
});

test('harvestJson finds merchants nested anywhere and skips category objects', () => {
  const payload = {
    data: {
      categories: [{ id: 1, name: 'אופנה' }, { id: 2, name: 'חשמל' }],
      results: {
        items: [
          { id: 10, name: 'חנות א', phone: '03-1', website: 'https://a.co.il?utm_source=buyme' },
          { id: 11, name: 'חנות ב', category: 'חשמל', online: true },
        ],
      },
    },
  };
  const found = X.harvestJson(payload);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((r) => r.name).sort(), ['חנות א', 'חנות ב']);
  assert.equal(found.find((r) => r.name === 'חנות ב').redeem_type, 'Online');
  assert.equal(found.find((r) => r.name === 'חנות א').domain, 'a.co.il');
});

test('harvestJson survives cycles and deep nesting without hanging', () => {
  const a = { id: 1, name: 'A', phone: '1' };
  a.self = a;
  assert.doesNotThrow(() => X.harvestJson(a));
});

test('merge dedupes by id and fills blanks without overwriting real values', () => {
  const dom = [{ id: '10', name: 'חנות א', category: '', redeem_type: 'Online', phone: '', website: '', domain: '', buyme_url: 'https://buyme.co.il/supplier/10', source: 'dom' }];
  const api = [{ id: '10', name: 'חנות א', category: 'חשמל', redeem_type: '', phone: '03-1', website: 'https://a.co.il', domain: 'a.co.il', buyme_url: 'https://buyme.co.il/supplier/10', source: 'api' }];
  const merged = X.merge(dom, api);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].category, 'חשמל');      // filled in from the API
  assert.equal(merged[0].redeem_type, 'Online');  // the DOM badge is not clobbered
  assert.equal(merged[0].phone, '03-1');
});

test('toCsv emits a BOM and escapes commas, quotes and newlines', () => {
  const csv = X.toCsv([
    { name: 'א, ב', category: 'say "hi"', redeem_type: 'Online', phone: '', website: '', domain: '', buyme_url: '', id: '1' },
  ]);
  assert.ok(csv.startsWith('﻿'), 'needs a BOM so Excel reads Hebrew');
  assert.ok(csv.includes('"א, ב"'));
  assert.ok(csv.includes('"say ""hi"""'));
  assert.ok(csv.includes('\r\n'));
});

test('categoriesOf splits multi-category rows and sorts them', () => {
  const cats = X.categoriesOf([
    { category: 'חשמל | מחשבים' },
    { category: 'חשמל' },
    { category: '' },
  ]);
  assert.deepEqual(cats.sort(), ['חשמל', 'מחשבים'].sort());
});

test('search requires every term and honours filters', () => {
  const rows = [
    { name: 'שקם אלקטריק', category: 'חשמל', domain: 'shekem-electric.co.il', website: '', phone: '', redeem_type: 'In-store' },
    { name: 'ליאור מוצרי חשמל', category: 'חשמל', domain: 'lior-electric.co.il', website: '', phone: '', redeem_type: 'Online' },
  ];
  assert.equal(X.search(rows, 'שקם').length, 1);
  assert.equal(X.search(rows, 'electric').length, 2);
  // Terms are ANDed over the row as a whole, so a name term and a category term
  // can both land on the same row — that is what makes "שקם חשמל" useful.
  assert.equal(X.search(rows, 'שקם חשמל').length, 1);
  assert.equal(X.search(rows, 'שקם ליאור').length, 0, 'every term must match');
  assert.equal(X.search(rows, '', { redeem: 'Online' }).length, 1);
  assert.equal(X.search(rows, '', { category: 'חשמל' }).length, 2);
  assert.equal(X.search(rows, '').length, 2);
});
