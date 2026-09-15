import json

# Hand-picked from a full read of all 425 rows; the export carries no category
# field, so these are classified from merchant name + domain, not from the site.
TIERS = {
    "lior-electric.co.il":  ("A", "Electronics retailer - smartphones, laptops, Samsung audio, appliances"),
    "intech-trade.co.il":   ("A", "Electronics importer / mobile accessories distributor"),
    "ofiyaa-israel.com":    ("B", "Portable monitors / computer peripherals"),
    "dreame-israel.co.il":  ("B", "Smart home - robot vacuums"),
    "shop.smeg.co.il":      ("B", "Kitchen appliances"),
    "xi-mobility.co.il":    ("B", "Electric mobility"),
    "smoovee-ltd.com":      ("B", "Electric mobility"),
    "nextheat.co.il":       ("B", "Home heating appliances"),
    "swingfans.co.il":      ("B", "Fans / small appliances"),
    "il.water.io":          ("B", "Smart water bottles"),
}

merchants = json.load(open("merchants.json", encoding="utf-8"))
out = []
for m in merchants:
    t = TIERS.get(m["domain"])
    if not t:
        continue
    tier, note = t
    out.append({**m, "tier": tier, "classification": note,
                "sells_sm_r640": "unverified", "buyme_checkout": "unverified"})

out.sort(key=lambda r: (r["tier"], r["name"]))
json.dump(out, open("electronics_candidates.json", "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)
print(f"{len(merchants)} merchants -> {len(out)} electronics candidates")
for r in out:
    print(f"  [{r['tier']}] {r['name']:<28} {r['domain']}")
