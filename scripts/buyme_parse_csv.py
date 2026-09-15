import csv, json, re
from urllib.parse import urlsplit

SRC = "data/buyme_online_businesses.csv"

rows = []
with open(SRC, encoding="utf-8-sig", newline="") as fh:
    for r in csv.DictReader(fh):
        name = (r.get("Business Name") or "").strip()
        url = (r.get("Website") or "").strip()
        if not name:
            continue
        # Strip the BuyMe referral tracking so the URL is the merchant's own.
        clean = re.sub(r"[?&]utm_[^=]*=[^&]*", "", url).rstrip("?&")
        host = urlsplit(clean).netloc.lower().removeprefix("www.")
        rows.append({
            "name": name,
            "online_redemption": True,   # the source list is the online-redemption filter
            "category": None,            # not present in the export
            "website": clean,
            "domain": host,
        })

# de-dupe on name+domain, keep order
seen, out = set(), []
for r in rows:
    k = (r["name"], r["domain"])
    if k in seen:
        continue
    seen.add(k)
    out.append(r)

with open("merchants.json", "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=2)
    fh.write("\n")

print(f"parsed {len(rows)} rows -> {len(out)} unique merchants")
print("blank websites:", sum(1 for r in out if not r["domain"]))
