# BuyMe Merchants — Chrome extension

Collects the merchant list from **buyme.co.il**, lets you search it by name,
category and redemption type, and exports it to CSV or JSON.

BuyMe's site makes it hard to answer a simple question like *"which businesses
that honour my voucher sell electronics, online?"* — the list is paginated, the
filters are coarse, and there is no export. This puts the whole list in one
searchable place.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this `buyme-extension` folder

## Use

1. Open any merchant listing on buyme.co.il — e.g.
   `https://buyme.co.il/brands/13438757?online=true`
2. The extension collects merchants **passively** as the page loads its data.
3. Click the toolbar icon → **סרוק דף זה** to scroll the full list and sweep
   whatever pagination hasn't loaded yet.
4. Search, filter, then **ייצוא CSV** / **ייצוא JSON**.

Exports respect the active filters, so you can export just one category.

## How it works

The interesting part is where the data comes from. Scraping the rendered cards
gets you names and not much else — no category, no phone, and the "מימוש ONLINE"
badge only when it happens to be on screen.

So `src/inject.js` runs in the **page's own JavaScript context** and wraps
`fetch` and `XMLHttpRequest`, observing the JSON the site requests for itself.
That yields structured records — category, phone, website, redemption type —
without knowing anything about BuyMe's API in advance.

`src/extract.js` then walks that JSON looking for merchant-shaped objects rather
than following fixed field paths, so a backend change doesn't immediately break
it. DOM scraping still runs as a fallback during a scan, and the two sources are
merged: a value already present is never overwritten by a blank one.

| File | Role |
|---|---|
| `src/inject.js` | MAIN-world observer of fetch/XHR. Passes every call through untouched. |
| `src/content.js` | Receives payloads, merges into `chrome.storage.local`, drives the page sweep. |
| `src/extract.js` | Pure logic: harvest, normalize, merge, search, CSV. Shared with the tests. |
| `src/popup.*` | Search, filter, export. |

Notes on the details that bite:

- **utm stripping** — BuyMe appends `utm_source=buyme&…` to every outbound
  merchant link; those are removed so `website` is the merchant's real URL.
- **CSV BOM** — exports start with a BOM and use CRLF, or Excel mangles Hebrew.
- **No guessing** — `redeem_type` is left empty unless the payload or the badge
  actually says. An empty field is more useful than a confident wrong one.

## Tests

```bash
node --test test/extract.test.mjs        # pure logic, 13 tests
NODE_PATH=$(npm root -g) xvfb-run -a node test/e2e.mjs   # real Chromium, 16 checks
```

The end-to-end test loads the extension into Chromium and serves a stand-in page
**on the buyme.co.il origin** via request interception, so the content script
runs for the real reason — its match pattern — rather than because the test
loosened anything. It never contacts BuyMe.

Regenerate the icons with `node tools/gen-icons.js`.

## Scope

Reads only buyme.co.il, stores only on your machine, sends nothing anywhere.
The page-context hook observes responses and modifies none of them.

Built against the site as of September 2026. If BuyMe restructures its API the
harvester should degrade to the DOM pass rather than break outright — if a scan
starts returning names with no categories, that is what happened.
