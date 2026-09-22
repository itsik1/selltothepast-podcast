# reelkit

Turns a folder of drone/phone footage into marketing cuts. Built for 4K60 DJI
material, but it reads anything ffmpeg reads.

Two steps on purpose: `scan` is cheap and produces small files someone can
actually look at; `render` does the heavy lifting locally with hardware
encoding. The originals never move.

```
python3 reelkit.py check                      # what this machine can do
python3 reelkit.py scan DCIM/DJI_001          # -> work/ (manifest + stills)
python3 reelkit.py render edit.json           # -> out/  (full quality)
```

`scan` on 16s of 4K60 took 12s and turned 180 MB of footage into 0.7 MB of
proxies — small enough to hand to someone (or to Claude) to pick the shots.

## Requirements

ffmpeg on PATH. `brew install ffmpeg` / `winget install Gyan.FFmpeg` /
`sudo apt install ffmpeg`, or `pip install imageio-ffmpeg` as a fallback.
`ffprobe` is optional — without it metadata is scraped from ffmpeg's output
instead, which is less precise.

## What scan handles

- **HDR** — clips tagged `smpte2084` or `arib-std-b67` get tone-mapped, so
  proxies don't come back washed out.
- **DJI telemetry** — a `.SRT` beside a clip yields GPS, flight altitude and
  the shot timestamp, all of which are useful copy.
- **Rotation** — a portrait clip reports landscape dimensions plus a rotation
  flag; the manifest records what you'd actually see.

## edit.json

```json
{
  "fps": 30,
  "targets": [
    {"name": "reel", "w": 1080, "h": 1920},
    {"name": "square", "w": 1080, "h": 1080}
  ],
  "transition": {"type": "fade", "duration": 0.35},
  "music": {"file": "track.mp3", "gain_db": -4},
  "clips": [
    {"src": "DJI_0001.MP4", "in": 3.5, "out": 6.2, "focus": "center", "push": true},
    {"src": "DJI_0002.MP4", "in": 11.0, "out": 14.0, "focus": "top", "speed": 0.5},
    {"src": "DJI_0004.JPG", "dur": 2.5, "zoom": 1.15}
  ],
  "text": [{"t": 0.6, "dur": 2.4, "line": "שורה ראשונה"}],
  "endcard": {"line": "שם המקום", "sub": "להזמנות", "dur": 2.4}
}
```

Per clip: `in`/`out` (seconds) for video, `dur` for stills, `focus`
(center/top/bottom/left/right) decides which part survives the crop to a
vertical frame, `speed` for slow motion, `push` for a slow zoom in.

On-screen text is rendered through libass, so Hebrew lays out right-to-left
correctly — `drawtext` does not and is deliberately unused. Set `"font"` at
the top level to override the per-platform default.
