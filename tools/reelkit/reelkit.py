#!/usr/bin/env python3
"""reelkit - turn a folder of drone/phone footage into marketing cuts.

Two steps, by design:

    reelkit.py scan  <footage-dir>   ->  work/  (tiny proxies + manifest.json)
    reelkit.py render <edit.json>    ->  out/   (full-quality cuts)

`scan` is cheap and produces small files you can hand to someone (or to Claude)
to decide what goes in the edit. `render` does the heavy lifting locally, with
hardware encoding when the machine has it.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".m4v", ".avi", ".mts"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".dng", ".tif", ".tiff"}
# DJI writes a low-res .LRF next to every clip and a .SRT of flight telemetry.
SIDECAR_EXT = {".lrf", ".srt", ".txt"}

HDR_TRANSFERS = {"arib-std-b67", "smpte2084"}  # HLG, PQ

TONEMAP = (
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
    "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv"
)


# --------------------------------------------------------------------------
# locating ffmpeg
# --------------------------------------------------------------------------

def find_ffmpeg() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    sys.exit(
        "ffmpeg not found. Install it:\n"
        "  macOS    brew install ffmpeg\n"
        "  Windows  winget install Gyan.FFmpeg\n"
        "  Linux    sudo apt install ffmpeg\n"
        "  anywhere pip install imageio-ffmpeg"
    )


def find_ffprobe(ffmpeg: str) -> str | None:
    found = shutil.which("ffprobe")
    if found:
        return found
    # static bundles often ship both binaries side by side
    sibling = Path(ffmpeg).with_name("ffprobe" + (".exe" if os.name == "nt" else ""))
    return str(sibling) if sibling.exists() else None


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def has_filter(ffmpeg: str, name: str) -> bool:
    out = run([ffmpeg, "-hide_banner", "-filters"]).stdout
    return re.search(rf"\s{re.escape(name)}\s", out) is not None


# --------------------------------------------------------------------------
# probing
# --------------------------------------------------------------------------

@dataclass
class Media:
    path: str
    name: str
    kind: str                      # "video" | "image"
    duration: float = 0.0
    width: int = 0
    height: int = 0
    fps: float = 0.0
    codec: str = ""
    transfer: str = ""
    bitrate_mbps: float = 0.0
    size_mb: float = 0.0
    hdr: bool = False
    telemetry: dict = field(default_factory=dict)
    frames: list[str] = field(default_factory=list)
    contact_sheet: str = ""


def _fraction(text: str) -> float:
    if not text or text in ("0/0", "N/A"):
        return 0.0
    if "/" in text:
        num, _, den = text.partition("/")
        try:
            return float(num) / float(den) if float(den) else 0.0
        except ValueError:
            return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def probe_with_ffprobe(ffprobe: str, path: Path) -> dict:
    proc = run([
        ffprobe, "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ])
    if proc.returncode != 0:
        return {}
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {}


def probe_with_ffmpeg(ffmpeg: str, path: Path) -> dict:
    """Fallback when ffprobe is missing: scrape `ffmpeg -i` stderr."""
    err = run([ffmpeg, "-hide_banner", "-i", str(path)]).stderr
    info: dict = {}
    m = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", err)
    if m:
        h, mi, s = m.groups()
        info["duration"] = int(h) * 3600 + int(mi) * 60 + float(s)
    m = re.search(r"Video:\s*(\w+).*?,\s*(\d{2,5})x(\d{2,5})", err, re.S)
    if m:
        info["codec"], info["width"], info["height"] = m.group(1), int(m.group(2)), int(m.group(3))
    m = re.search(r"([\d.]+)\s*fps", err)
    if m:
        info["fps"] = float(m.group(1))
    return info


def describe(path: Path, ffmpeg: str, ffprobe: str | None) -> Media:
    ext = path.suffix.lower()
    kind = "video" if ext in VIDEO_EXT else "image"
    item = Media(
        path=str(path),
        name=path.name,
        kind=kind,
        size_mb=round(path.stat().st_size / 1e6, 1),
    )

    if ffprobe:
        data = probe_with_ffprobe(ffprobe, path)
        streams = data.get("streams", [])
        fmt = data.get("format", {})
        video = next((s for s in streams if s.get("codec_type") == "video"), None)
        if video:
            item.width = int(video.get("width") or 0)
            item.height = int(video.get("height") or 0)
            item.codec = video.get("codec_name", "")
            item.transfer = video.get("color_transfer", "") or ""
            item.fps = round(_fraction(video.get("avg_frame_rate", "")), 2)
            # a portrait-shot clip reports landscape dimensions plus a rotation
            rotation = 0
            for entry in video.get("side_data_list", []) or []:
                if "rotation" in entry:
                    rotation = abs(int(entry["rotation"]))
            if rotation in (90, 270):
                item.width, item.height = item.height, item.width
        if fmt:
            item.duration = round(float(fmt.get("duration") or 0), 2)
            bitrate = float(fmt.get("bit_rate") or 0)
            item.bitrate_mbps = round(bitrate / 1e6, 1)
    else:
        raw = probe_with_ffmpeg(ffmpeg, path)
        item.duration = round(raw.get("duration", 0.0), 2)
        item.width = raw.get("width", 0)
        item.height = raw.get("height", 0)
        item.fps = raw.get("fps", 0.0)
        item.codec = raw.get("codec", "")

    item.hdr = item.transfer in HDR_TRANSFERS
    if kind == "image":
        # a still decodes as a one-frame video; the duration/fps it reports are noise
        item.duration, item.fps, item.bitrate_mbps = 0.0, 0.0, 0.0
    else:
        item.telemetry = read_dji_telemetry(path)
    return item


# --------------------------------------------------------------------------
# DJI flight telemetry
# --------------------------------------------------------------------------

def read_dji_telemetry(video: Path) -> dict:
    """DJI drops a .SRT beside each clip with GPS, altitude and camera settings."""
    srt = next(
        (c for c in (video.with_suffix(".SRT"), video.with_suffix(".srt")) if c.exists()),
        None,
    )
    if not srt:
        return {}
    try:
        text = srt.read_text(errors="ignore")
    except OSError:
        return {}

    def numbers(pattern: str) -> list[float]:
        return [float(v) for v in re.findall(pattern, text)]

    lats = numbers(r"latitude\s*:?\s*([-\d.]+)")
    lons = numbers(r"long[ti]tude\s*:?\s*([-\d.]+)")
    alts = numbers(r"rel_alt\s*:?\s*([-\d.]+)")

    out: dict = {}
    if lats and lons:
        out["gps"] = [round(lats[0], 6), round(lons[0], 6)]
    if alts:
        out["altitude_m"] = {"start": round(alts[0], 1), "max": round(max(alts), 1)}
    m = re.search(r"\b(20\d{2}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})", text)
    if m:
        out["shot_at"] = m.group(1)
    return out


# --------------------------------------------------------------------------
# scan
# --------------------------------------------------------------------------

def gather(folder: Path) -> list[Path]:
    files = []
    for path in sorted(folder.rglob("*")):
        if not path.is_file():
            continue
        ext = path.suffix.lower()
        if ext in SIDECAR_EXT:
            continue
        if ext in VIDEO_EXT or ext in IMAGE_EXT:
            files.append(path)
    return files


def sample_times(duration: float, wanted: int) -> list[float]:
    """Evenly spaced stills, skipping the first and last moments of a clip."""
    if duration <= 0:
        return [0.0]
    head, tail = duration * 0.04, duration * 0.96
    if wanted == 1 or tail <= head:
        return [duration / 2]
    step = (tail - head) / (wanted - 1)
    return [round(head + step * i, 2) for i in range(wanted)]


def extract_frames(ffmpeg: str, item: Media, out_dir: Path, per_clip: int,
                   width: int, tonemap_ok: bool) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(item.name).stem
    chain = f"{TONEMAP}," if (item.hdr and tonemap_ok) else ""
    chain += f"scale={width}:-2:flags=bicubic"
    written = []

    if item.kind == "image":
        target = out_dir / f"{stem}.jpg"
        proc = run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                    "-i", item.path, "-vf", chain, "-q:v", "4", str(target)])
        if proc.returncode == 0 and target.exists():
            written.append(target.name)
        return written

    for index, when in enumerate(sample_times(item.duration, per_clip)):
        target = out_dir / f"{stem}_t{when:07.2f}.jpg"
        # -ss before -i seeks by keyframe, which is what makes this fast on 4K
        proc = run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                    "-ss", str(when), "-i", item.path, "-frames:v", "1",
                    "-vf", chain, "-q:v", "4", str(target)])
        if proc.returncode == 0 and target.exists():
            written.append(target.name)
    return written


def build_contact_sheet(ffmpeg: str, frame_dir: Path, frames: list[str],
                        target: Path, columns: int = 4, cell: int = 480) -> str:
    """One overview image per clip, so a whole shoot reads at a glance."""
    if not frames:
        return ""
    rows = (len(frames) + columns - 1) // columns
    listing = target.with_suffix(".txt")
    listing.write_text(
        "".join(f"file '{(frame_dir / f).as_posix()}'\n" for f in frames)
    )
    proc = run([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-r", "1", "-i", str(listing),
        "-vf", f"scale={cell}:-2,tile={columns}x{rows}:padding=6:margin=6:color=0x111111",
        "-frames:v", "1", "-q:v", "4", str(target),
    ])
    listing.unlink(missing_ok=True)
    return target.name if proc.returncode == 0 and target.exists() else ""


def cmd_scan(args: argparse.Namespace) -> int:
    folder = Path(args.folder).expanduser().resolve()
    if not folder.is_dir():
        sys.exit(f"not a folder: {folder}")

    ffmpeg = find_ffmpeg()
    ffprobe = find_ffprobe(ffmpeg)
    tonemap_ok = has_filter(ffmpeg, "zscale") and has_filter(ffmpeg, "tonemap")

    work = Path(args.out).expanduser().resolve()
    frame_dir, sheet_dir = work / "frames", work / "contact"
    frame_dir.mkdir(parents=True, exist_ok=True)
    sheet_dir.mkdir(parents=True, exist_ok=True)

    files = gather(folder)
    if not files:
        sys.exit(f"no video or image files under {folder}")

    print(f"{len(files)} files in {folder}")
    if not ffprobe:
        print("  (ffprobe missing - falling back to ffmpeg for metadata)")
    if not tonemap_ok:
        print("  (no zscale/tonemap - HDR clips may look washed out in proxies)")

    catalog: list[Media] = []
    for position, path in enumerate(files, start=1):
        item = describe(path, ffmpeg, ffprobe)
        label = f"{item.width}x{item.height}"
        if item.kind == "video":
            label += f" {item.fps:g}fps {item.duration:g}s"
        print(f"  [{position}/{len(files)}] {item.name}  {label}")

        item.frames = extract_frames(
            ffmpeg, item, frame_dir, args.frames, args.width, tonemap_ok
        )
        if item.kind == "video" and len(item.frames) > 1:
            item.contact_sheet = build_contact_sheet(
                ffmpeg, frame_dir, item.frames,
                sheet_dir / f"{Path(item.name).stem}.jpg",
            )
        catalog.append(item)

    manifest = {
        "source": str(folder),
        "machine": f"{platform.system()} {platform.machine()}",
        "encoder": pick_encoder(ffmpeg)[0],
        "totals": {
            "files": len(catalog),
            "videos": sum(1 for c in catalog if c.kind == "video"),
            "images": sum(1 for c in catalog if c.kind == "image"),
            "footage_seconds": round(sum(c.duration for c in catalog), 1),
            "gigabytes": round(sum(c.size_mb for c in catalog) / 1000, 2),
        },
        "media": [asdict(c) for c in catalog],
    }
    manifest_path = work / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))

    proxy_mb = sum(f.stat().st_size for f in work.rglob("*.jpg")) / 1e6
    print(f"\nmanifest  {manifest_path}")
    print(f"frames    {frame_dir}  ({len(list(frame_dir.glob('*.jpg')))} stills, {proxy_mb:.1f} MB)")
    print(f"sheets    {sheet_dir}")
    print(f"\n{manifest['totals']['footage_seconds']:g}s of footage, "
          f"{manifest['totals']['gigabytes']}GB -> {proxy_mb:.1f}MB of proxies.")
    print("Hand the contact sheets + manifest.json to Claude to get an edit.json back.")
    return 0


# --------------------------------------------------------------------------
# encoders
# --------------------------------------------------------------------------

def encoder_runs(ffmpeg: str, name: str) -> bool:
    """Presence in -encoders only means it was compiled in; try it for real."""
    proc = run([ffmpeg, "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.1",
                "-c:v", name, "-f", "null", "-"])
    return proc.returncode == 0


_encoder_cache: tuple[str, list[str]] | None = None


def pick_encoder(ffmpeg: str, bitrate_mbps: int = 14) -> tuple[str, list[str]]:
    global _encoder_cache
    if _encoder_cache:
        return _encoder_cache

    compiled = run([ffmpeg, "-hide_banner", "-encoders"]).stdout
    candidates = []
    if sys.platform == "darwin":
        candidates.append(("h264_videotoolbox", ["-b:v", f"{bitrate_mbps}M"]))
    candidates.append(("h264_nvenc", ["-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0"]))
    if sys.platform == "win32":
        candidates.append(("h264_qsv", ["-global_quality", "21"]))

    for name, extra in candidates:
        if name in compiled and encoder_runs(ffmpeg, name):
            _encoder_cache = (name, extra)
            return _encoder_cache

    _encoder_cache = ("libx264", ["-preset", "medium", "-crf", "20"])
    return _encoder_cache


# --------------------------------------------------------------------------
# filter building
# --------------------------------------------------------------------------

FOCUS_X = {
    "center": "(iw-ow)/2", "left": "0", "right": "iw-ow",
    "top": "(iw-ow)/2", "bottom": "(iw-ow)/2",
}
FOCUS_Y = {
    "center": "(ih-oh)/2", "top": "0", "bottom": "ih-oh",
    "left": "(ih-oh)/2", "right": "(ih-oh)/2",
}


def fill_frame(width: int, height: int, focus: str) -> str:
    """Cover WxH from any source aspect, cropping the overflow."""
    x = FOCUS_X.get(focus, FOCUS_X["center"])
    y = FOCUS_Y.get(focus, FOCUS_Y["center"])
    return (f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=bicubic,"
            f"crop={width}:{height}:{x}:{y}")


def clip_chain(clip: dict, item: Media | None, width: int, height: int,
               fps: int, tonemap_ok: bool, zoompan_ok: bool) -> tuple[str, float]:
    """Filter chain for one cut, plus how long it ends up on screen."""
    start = float(clip.get("in", 0.0))
    stop = float(clip.get("out", start + 3.0))
    speed = float(clip.get("speed", 1.0)) or 1.0
    focus = clip.get("focus", "center")
    is_image = bool(item and item.kind == "image")

    steps: list[str] = []
    if item and item.hdr and tonemap_ok:
        steps.append(TONEMAP)

    if is_image:
        duration = float(clip.get("dur", 3.0))
        if zoompan_ok:
            # Ken Burns: oversample, then drift across it
            zoom_to = float(clip.get("zoom", 1.14))
            frames = max(1, int(duration * fps))
            steps.append(fill_frame(int(width * 1.3), int(height * 1.3), focus))
            steps.append(
                f"zoompan=z='min(1+{(zoom_to - 1) / frames:.6f}*in,{zoom_to})':d=1"
                f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps}"
            )
        else:
            steps.append(fill_frame(width, height, focus))
        on_screen = duration
    else:
        duration = max(0.1, stop - start)
        if clip.get("push") and zoompan_ok:
            zoom_to = float(clip.get("zoom", 1.12))
            frames = max(1, int(duration / speed * fps))
            steps.append(fill_frame(int(width * 1.25), int(height * 1.25), focus))
            steps.append(
                f"zoompan=z='min(1+{(zoom_to - 1) / frames:.6f}*in,{zoom_to})':d=1"
                f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps}"
            )
        else:
            steps.append(fill_frame(width, height, focus))
        if speed != 1.0:
            steps.append(f"setpts={1 / speed:.6f}*PTS")
        on_screen = duration / speed

    steps.append(f"fps={fps}")
    steps.append("format=yuv420p")
    steps.append("setsar=1")
    return ",".join(steps), round(on_screen, 3)


def xfade_chain(labels: list[str], lengths: list[float], seconds: float,
                style: str = "fade") -> tuple[str, str, float]:
    """Cross-fade a list of already-normalised streams into one."""
    if len(labels) == 1:
        return "", labels[0], lengths[0]

    parts, current, running = [], labels[0], lengths[0]
    for index in range(1, len(labels)):
        # a transition can never be longer than the shorter of the two cuts
        span = min(seconds, lengths[index] * 0.5, running * 0.5)
        offset = running - span
        out = f"x{index}"
        parts.append(
            f"[{current}][{labels[index]}]"
            f"xfade=transition={style}:duration={span:.3f}:offset={offset:.3f}[{out}]"
        )
        current, running = out, running + lengths[index] - span
    return ";".join(parts), current, round(running, 3)


# --------------------------------------------------------------------------
# on-screen text (ASS via libass - handles Hebrew right-to-left properly)
# --------------------------------------------------------------------------

DEFAULT_FONT = {
    "Darwin": "Arial Hebrew",
    "Windows": "Arial",
}.get(platform.system(), "Noto Sans Hebrew")


def ass_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{int(hours)}:{int(minutes):02d}:{secs:05.2f}"


def write_ass(path: Path, width: int, height: int, font: str,
              captions: list[dict], endcard: dict | None, endcard_at: float) -> None:
    scale = height / 1920
    body = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,{font},{int(82 * scale)},&H00FFFFFF,&H000000FF,&H00101010,&H78000000,1,0,0,0,100,100,0,0,1,{max(2, int(4 * scale))},{max(1, int(2 * scale))},2,{int(70 * scale)},{int(70 * scale)},{int(230 * scale)},1
Style: Card,{font},{int(112 * scale)},&H00FFFFFF,&H000000FF,&H00101010,&H00000000,1,0,0,0,100,100,2,0,1,0,0,5,{int(70 * scale)},{int(70 * scale)},0,1
Style: CardSub,{font},{int(52 * scale)},&H00D8D8D8,&H000000FF,&H00101010,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,{int(70 * scale)},{int(70 * scale)},0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    for caption in captions:
        start = float(caption.get("t", 0))
        end = start + float(caption.get("dur", 2.5))
        text = str(caption.get("line", "")).replace("\n", r"\N")
        if not text:
            continue
        lines.append(
            f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Main,,0,0,0,,"
            f"{{\\fad(220,220)}}{text}"
        )

    if endcard:
        title = str(endcard.get("line", "")).replace("\n", r"\N")
        sub = str(endcard.get("sub", "")).replace("\n", r"\N")
        span = float(endcard.get("dur", 2.4))
        if title:
            lines.append(
                f"Dialogue: 1,{ass_time(endcard_at + 0.15)},{ass_time(endcard_at + span)},Card,,0,0,0,,"
                f"{{\\fad(320,260)\\pos({width // 2},{int(height * 0.46)})}}{title}"
            )
        if sub:
            lines.append(
                f"Dialogue: 1,{ass_time(endcard_at + 0.45)},{ass_time(endcard_at + span)},CardSub,,0,0,0,,"
                f"{{\\fad(320,260)\\pos({width // 2},{int(height * 0.56)})}}{sub}"
            )

    path.write_text(body + "\n".join(lines) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------
# render
# --------------------------------------------------------------------------

def load_catalog(work: Path) -> dict[str, Media]:
    manifest = work / "manifest.json"
    if not manifest.exists():
        return {}
    data = json.loads(manifest.read_text(encoding="utf-8"))
    catalog: dict[str, Media] = {}
    for entry in data.get("media", []):
        item = Media(**{k: v for k, v in entry.items() if k in Media.__dataclass_fields__})
        catalog[item.name] = item
        catalog[item.path] = item
    return catalog


def render_one(ffmpeg: str, spec: dict, target: dict, catalog: dict[str, Media],
               out_dir: Path, tonemap_ok: bool, zoompan_ok: bool,
               dry_run: bool) -> Path | None:
    width, height = int(target["w"]), int(target["h"])
    fps = int(spec.get("fps", 30))
    name = target.get("name", f"{width}x{height}")
    font = spec.get("font", DEFAULT_FONT)

    inputs: list[str] = []
    chains: list[str] = []
    labels: list[str] = []
    lengths: list[float] = []

    for index, clip in enumerate(spec.get("clips", [])):
        source = clip["src"]
        item = catalog.get(source) or catalog.get(Path(source).name)
        path = item.path if item else source
        if not Path(path).exists():
            sys.exit(f"missing source: {path}")

        is_image = (item.kind == "image") if item else Path(path).suffix.lower() in IMAGE_EXT
        if is_image:
            inputs += ["-loop", "1", "-t", str(float(clip.get("dur", 3.0))), "-i", path]
        else:
            start = float(clip.get("in", 0.0))
            span = max(0.1, float(clip.get("out", start + 3.0)) - start)
            inputs += ["-ss", f"{start:.3f}", "-t", f"{span:.3f}", "-i", path]

        chain, on_screen = clip_chain(clip, item, width, height, fps, tonemap_ok, zoompan_ok)
        chains.append(f"[{index}:v]{chain}[c{index}]")
        labels.append(f"c{index}")
        lengths.append(on_screen)

    if not labels:
        sys.exit("edit spec has no clips")

    endcard = spec.get("endcard")
    endcard_seconds = float(endcard.get("dur", 2.4)) if endcard else 0.0
    if endcard:
        colour = endcard.get("bg", "black")
        position = len(labels)
        inputs += ["-f", "lavfi", "-t", f"{endcard_seconds:.3f}",
                   "-i", f"color=c={colour}:s={width}x{height}:r={fps}"]
        chains.append(f"[{position}:v]format=yuv420p,setsar=1[c{position}]")
        labels.append(f"c{position}")
        lengths.append(endcard_seconds)

    transition = spec.get("transition", {})
    fade_seconds = float(transition.get("duration", 0.0))
    style = transition.get("type", "fade")
    joins, final_label, total = xfade_chain(labels, lengths, fade_seconds, style)

    graph = ";".join(chains + ([joins] if joins else []))

    captions = spec.get("text", [])
    subtitle_file = out_dir / f"{name}.ass"
    if captions or endcard:
        write_ass(subtitle_file, width, height, font, captions, endcard,
                  endcard_at=max(0.0, total - endcard_seconds))
        graph += f";[{final_label}]subtitles={subtitle_file.name}[vout]"
        final_label = "vout"

    music = spec.get("music") or {}
    music_path = music.get("file")
    if music_path and Path(music_path).exists():
        audio_index = len(labels)
        inputs += ["-i", music_path]
        gain = float(music.get("gain_db", -4))
        graph += (
            f";[{audio_index}:a]atrim=0:{total:.3f},asetpts=N/SR/TB,"
            f"afade=t=in:st=0:d=0.8,afade=t=out:st={max(0.0, total - 1.4):.3f}:d=1.4,"
            f"volume={gain}dB[aout]"
        )
        audio_args = ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
    else:
        if music_path:
            print(f"  music file not found, rendering silent: {music_path}")
        # every clip and the endcard contributed exactly one input, so the
        # silent track lands at len(labels)
        silent_index = len(labels)
        inputs += ["-f", "lavfi", "-t", f"{total:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
        audio_args = ["-map", f"{silent_index}:a", "-c:a", "aac", "-b:a", "128k"]

    encoder, encoder_args = pick_encoder(ffmpeg, bitrate_mbps=12 if height <= 1920 else 28)
    output = out_dir / f"{name}.mp4"

    command = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-stats", *inputs,
               "-filter_complex", graph,
               "-map", f"[{final_label}]", *audio_args,
               "-c:v", encoder, *encoder_args,
               "-pix_fmt", "yuv420p", "-r", str(fps),
               "-movflags", "+faststart", "-shortest", str(output)]

    print(f"  {name}: {len(spec.get('clips', []))} cuts, {total:.1f}s, {encoder}")
    if dry_run:
        print("    " + " ".join(command))
        return None

    proc = subprocess.run(command, cwd=out_dir, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        print(proc.stderr[-4000:], file=sys.stderr)
        sys.exit(f"render failed for {name}")
    return output


def cmd_render(args: argparse.Namespace) -> int:
    spec_path = Path(args.spec).expanduser().resolve()
    if not spec_path.exists():
        sys.exit(f"no such edit spec: {spec_path}")
    spec = json.loads(spec_path.read_text(encoding="utf-8"))

    ffmpeg = find_ffmpeg()
    tonemap_ok = has_filter(ffmpeg, "zscale") and has_filter(ffmpeg, "tonemap")
    zoompan_ok = has_filter(ffmpeg, "zoompan")

    work = Path(spec.get("work", args.work)).expanduser().resolve()
    catalog = load_catalog(work)
    if not catalog:
        print(f"no manifest under {work} - resolving sources as plain paths")

    out_dir = Path(spec.get("out", args.out)).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    targets = spec.get("targets") or [{"name": "reel", "w": 1080, "h": 1920}]
    print(f"rendering {len(targets)} target(s) into {out_dir}")

    made = []
    for target in targets:
        result = render_one(ffmpeg, spec, target, catalog, out_dir,
                            tonemap_ok, zoompan_ok, args.dry_run)
        if result:
            made.append(result)

    for path in made:
        print(f"  {path}  ({path.stat().st_size / 1e6:.1f} MB)")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    ffmpeg = find_ffmpeg()
    ffprobe = find_ffprobe(ffmpeg)
    encoder, extra = pick_encoder(ffmpeg)
    version = run([ffmpeg, "-version"]).stdout.splitlines()[0]
    print(f"machine   {platform.system()} {platform.machine()} (python {platform.python_version()})")
    print(f"ffmpeg    {ffmpeg}")
    print(f"          {version}")
    print(f"ffprobe   {ffprobe or 'MISSING - metadata will be less precise'}")
    print(f"encoder   {encoder} {' '.join(extra)}")
    for name in ("zscale", "tonemap", "zoompan", "xfade", "subtitles"):
        print(f"  {name:<10} {'yes' if has_filter(ffmpeg, name) else 'NO'}")
    print(f"font      {DEFAULT_FONT}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="reelkit",
        description="Turn a folder of footage into marketing cuts.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    scan = sub.add_parser("scan", help="index footage and write small proxies")
    scan.add_argument("folder", help="folder of video/images, e.g. DCIM/DJI_001")
    scan.add_argument("--out", default="work", help="where proxies land (default: work)")
    scan.add_argument("--frames", type=int, default=12, help="stills per clip (default: 12)")
    scan.add_argument("--width", type=int, default=640, help="proxy width (default: 640)")
    scan.set_defaults(func=cmd_scan)

    render = sub.add_parser("render", help="render an edit spec at full quality")
    render.add_argument("spec", help="edit.json")
    render.add_argument("--work", default="work", help="folder holding manifest.json")
    render.add_argument("--out", default="out", help="output folder (default: out)")
    render.add_argument("--dry-run", action="store_true", help="print the ffmpeg command only")
    render.set_defaults(func=cmd_render)

    check = sub.add_parser("check", help="report what this machine can do")
    check.set_defaults(func=cmd_check)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
