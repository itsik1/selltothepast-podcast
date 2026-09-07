#!/usr/bin/env python3
"""Collect the public state of the show (feed, Apple, Spotify, YouTube) into status.json.

Runs from GitHub Actions (see .github/workflows/status.yml). Everything that needs a
credential is optional: when the secret/variable is missing the section says so instead
of failing.
"""
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

SITE = "https://itsik1.github.io/selltothepast-podcast"
FEED_URL = f"{SITE}/feed.xml"
NAMES = ["למכור לעבר", "Sell to the Past"]
UA = {"User-Agent": "selltothepast-status/1.0"}
NOW = datetime.now(timezone.utc)


def get(url, headers=None, data=None, timeout=30):
    req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.headers, r.read()


def safe(fn):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 - one broken source must not hide the others
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def check_feed():
    status, _, body = get(FEED_URL)
    root = ET.fromstring(body)
    ns = {"itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd"}
    ch = root.find("channel")
    items = []
    for it in ch.findall("item"):
        enc = it.find("enclosure")
        pub = parsedate_to_datetime(it.findtext("pubDate"))
        entry = {
            "title": it.findtext("title"),
            "published": pub.isoformat(),
            "days_ago": round((NOW - pub).total_seconds() / 86400, 1),
            "duration": it.findtext("itunes:duration", namespaces=ns),
            "audio": enc.get("url") if enc is not None else None,
            "bytes": int(enc.get("length")) if enc is not None else None,
        }
        # HEAD the audio so a broken enclosure shows up here, not in a listener's app
        try:
            req = urllib.request.Request(entry["audio"], method="HEAD", headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                entry["audio_http"] = r.status
                clen = r.headers.get("Content-Length")
                entry["audio_bytes_match"] = clen is None or int(clen) == entry["bytes"]
        except Exception as e:  # noqa: BLE001
            entry["audio_http"] = str(e)
            entry["audio_bytes_match"] = False
        items.append(entry)
    items.sort(key=lambda i: i["published"], reverse=True)
    return {
        "ok": status == 200 and bool(items),
        "http": status,
        "title": ch.findtext("title"),
        "cover": ch.find("itunes:image", ns).get("href") if ch.find("itunes:image", ns) is not None else None,
        "episodes": len(items),
        "latest": items[0] if items else None,
        "days_since_last_episode": items[0]["days_ago"] if items else None,
        "items": items,
    }


def check_apple():
    """Apple Podcasts directory via the public iTunes Search API (no key needed)."""
    found = None
    for name in NAMES:
        q = urllib.parse.urlencode({"term": name, "media": "podcast", "country": "IL", "limit": 25})
        _, _, body = get(f"https://itunes.apple.com/search?{q}")
        for r in json.loads(body).get("results", []):
            if r.get("feedUrl", "").rstrip("/") == FEED_URL or r.get("collectionName") in NAMES:
                found = r
                break
        if found:
            break
    if not found:
        return {"ok": True, "listed": False, "note": "not in the Apple Podcasts directory yet (search by name and by feed URL)"}
    return {
        "ok": True,
        "listed": True,
        "name": found.get("collectionName"),
        "url": found.get("collectionViewUrl"),
        "id": found.get("collectionId"),
        "episodes": found.get("trackCount"),
        "artwork": found.get("artworkUrl600"),
    }


SPOTIFY_SHOW_URL = "https://open.spotify.com/show/{show_id}"


def check_spotify():
    """Spotify catalog check. Default: the public oEmbed endpoint (no key, no Premium needed).
    With SPOTIFY_CLIENT_ID/SECRET (Web API access) it also reports the episode count."""
    show_id = os.environ.get("SPOTIFY_SHOW_ID")
    if not show_id:
        return {"ok": True, "configured": False, "note": "set repo variable SPOTIFY_SHOW_ID (the id in open.spotify.com/show/...) to check the Spotify catalog"}
    show_url = SPOTIFY_SHOW_URL.format(show_id=show_id)
    q = urllib.parse.urlencode({"url": show_url})
    try:
        _, _, body = get(f"https://open.spotify.com/oembed?{q}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"ok": True, "configured": True, "listed": False, "url": show_url, "note": "show id not found in the Spotify catalog yet"}
        raise
    data = json.loads(body)
    out = {"ok": True, "configured": True, "listed": True, "name": data.get("title"), "url": show_url, "id": show_id,
           "artwork": data.get("thumbnail_url"), "source": "oembed"}
    cid, sec = os.environ.get("SPOTIFY_CLIENT_ID"), os.environ.get("SPOTIFY_CLIENT_SECRET")
    if cid and sec:
        auth = base64.b64encode(f"{cid}:{sec}".encode()).decode()
        _, _, body = get("https://accounts.spotify.com/api/token",
                         headers={"Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"},
                         data=b"grant_type=client_credentials")
        token = json.loads(body)["access_token"]
        _, _, body = get(f"https://api.spotify.com/v1/shows/{show_id}?market=IL", headers={"Authorization": f"Bearer {token}"})
        out["episodes"] = json.loads(body).get("total_episodes")
        out["source"] = "web-api"
    return out


def check_youtube():
    channel = os.environ.get("YOUTUBE_CHANNEL_ID")
    if not channel:
        return {"ok": True, "configured": False,
                "note": "set repo variable YOUTUBE_CHANNEL_ID (starts with UC…) to list uploads; add secret YOUTUBE_API_KEY for subscribers/views"}
    out = {"ok": True, "configured": True, "channel_id": channel, "url": f"https://www.youtube.com/channel/{channel}"}
    _, _, body = get(f"https://www.youtube.com/feeds/videos.xml?channel_id={channel}")
    root = ET.fromstring(body)
    ns = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015", "media": "http://search.yahoo.com/mrss/"}
    vids = []
    for e in root.findall("a:entry", ns):
        pub = datetime.fromisoformat(e.findtext("a:published", namespaces=ns).replace("Z", "+00:00"))
        stats = e.find("media:group/media:community/media:statistics", ns)
        vids.append({
            "title": e.findtext("a:title", namespaces=ns),
            "url": f"https://www.youtube.com/watch?v={e.findtext('yt:videoId', namespaces=ns)}",
            "published": pub.isoformat(),
            "days_ago": round((NOW - pub).total_seconds() / 86400, 1),
            "views": int(stats.get("views")) if stats is not None else None,
        })
    out["channel_title"] = root.findtext("a:title", namespaces=ns)
    out["videos_in_feed"] = len(vids)
    out["videos"] = vids[:15]
    key = os.environ.get("YOUTUBE_API_KEY")
    if key:
        q = urllib.parse.urlencode({"part": "statistics,snippet", "id": channel, "key": key})
        try:
            _, _, body = get(f"https://www.googleapis.com/youtube/v3/channels?{q}")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:600]
            try:
                detail = json.loads(detail)["error"]["message"]
            except Exception:  # noqa: BLE001
                pass
            out["api_key_error"] = f"HTTP {e.code}: {detail}"
            body = b"{}"
        items = json.loads(body).get("items") or []
        if items:
            st = items[0]["statistics"]
            out["subscribers"] = int(st.get("subscriberCount", 0))
            out["views"] = int(st.get("viewCount", 0))
            out["video_count"] = int(st.get("videoCount", 0))
            out["handle"] = items[0]["snippet"].get("customUrl")
    return out


def main():
    status = {
        "generated_at": NOW.isoformat(timespec="seconds"),
        "site": SITE,
        "feed_url": FEED_URL,
        "feed": safe(check_feed),
        "apple": safe(check_apple),
        "spotify": safe(check_spotify),
        "youtube": safe(check_youtube),
    }
    # one-line verdicts the phone page can show first
    todo = []
    f = status["feed"]
    if not f.get("ok"):
        todo.append("הפיד לא נטען או ריק")
    elif f.get("days_since_last_episode", 0) > 10:
        todo.append(f"עברו {int(f['days_since_last_episode'])} ימים מהפרק האחרון")
    if f.get("latest") and not f["latest"].get("audio_bytes_match", True):
        todo.append("קובץ האודיו של הפרק האחרון לא תואם לפיד")
    if status["apple"].get("ok") and not status["apple"].get("listed"):
        todo.append("עדיין לא מופיע ב‑Apple Podcasts")
    sp = status["spotify"]
    if sp.get("configured") and not sp.get("listed"):
        todo.append("עדיין לא מופיע ב‑Spotify")
    if not sp.get("configured"):
        todo.append("בדיקת Spotify לא מוגדרת (חסר SPOTIFY_SHOW_ID)")
    yt = status["youtube"]
    if not yt.get("ok"):
        todo.append(f"בדיקת YouTube נכשלה: {yt.get('error')}")
    elif not yt.get("configured"):
        todo.append("בדיקת YouTube לא מוגדרת (חסר YOUTUBE_CHANNEL_ID)")
    elif yt.get("api_key_error"):
        todo.append(f"מפתח YouTube API לא עובד: {yt['api_key_error']}")
    status["todo"] = todo
    out = os.environ.get("STATUS_OUT", "status.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(status, fh, ensure_ascii=False, indent=2)
    print(json.dumps(status, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
