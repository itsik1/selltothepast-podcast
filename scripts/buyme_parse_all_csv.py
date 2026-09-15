import csv, json, re
from urllib.parse import urlsplit

SRC = "data/buyme_all_businesses.csv"
rows = []
with open(SRC, encoding="utf-8-sig", newline="") as fh:
    for r in csv.DictReader(fh):
        name = (r.get("Business Name") or "").strip()
        if not name:
            continue
        url = (r.get("Website") or "").strip()
        clean = re.sub(r"[?&](utm_[^=]*|srsltid)=[^&]*", "", url).rstrip("?&/")
        rows.append({
            "name": name,
            "website": clean,
            "domain": urlsplit(clean).netloc.lower().removeprefix("www."),
            "phone": (r.get("Phone") or "").strip(),
            "redeem_type": (r.get("Redeem Type") or "").strip(),
        })

json.dump(rows, open("merchants_all.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
from collections import Counter
print(f"{len(rows)} businesses |", dict(Counter(r["redeem_type"] for r in rows)))
