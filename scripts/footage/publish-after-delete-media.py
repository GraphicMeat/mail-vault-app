#!/usr/bin/env python3
"""Publish the howto-after-delete recordings: zoomed videos, stills, captions, manifest entries.

    python3 scripts/footage/publish-after-delete-media.py <run dir> [--dry <out dir>]

The run dir is what scripts/footage/after-delete-media.sh wrote: one unpacked run
per website locale in <run dir>/<locale>/ (or one unpacked English run). Each
holds, per clip, <clip>.mov, .mov.json, .steps.json, .actions.json, .census.json,
plus howto-after-delete.facts.json and geometry.json. Non-English captions come
from scripts/footage/after-delete-captions.json (a missing string is an error).
Needs ffmpeg, ffprobe and Pillow.

The camera is built from what the take recorded, not from fractions: every step
in <clip>.steps.json carries the window-point rectangles of what it is about (the
select and its example, the opened row, the Delete button, the reader), so the
zoom lands on the right spot in every language. The pointer and click ripples are
drawn on the full 2x frame first and zoom with it; the crop reads the 3072 px
source, so a 2x zoom is still 1:1 pixels. Added pixels: the pointer, the ripple
and the version footer, as the other how-to media.

With --dry the files go to <out dir> and website/help-media.json is left alone.
"""
import argparse
import importlib.util
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


base = load("help_media", "publish-help-media.py")
howto = load("howto_media", "publish-howto-media.py")

CLIPS = {
    "after-delete-none": ("none", "After deleting an email: select nothing"),
    "after-delete-next": ("next", "After deleting an email: select the next email"),
    "after-delete-previous": ("previous", "After deleting an email: select the previous email"),
    "after-delete-next-unread": ("nextUnread", "After deleting an email: select the next unread email"),
    "after-delete-previous-unread": ("previousUnread", "After deleting an email: select the previous unread email"),
}
# Alt text of each still, per option: English keys of after-delete-captions.json.
STILL_ALT = {
    "option": {
        "none": "Mail preferences, Deleting, with Select nothing chosen and its example",
        "next": "Mail preferences, Deleting, with Select the next email chosen and its example",
        "previous": "Mail preferences, Deleting, with Select the previous email chosen and its example",
        "nextUnread": "Mail preferences, Deleting, with Select the next unread email chosen and its example",
        "previousUnread": "Mail preferences, Deleting, with Select the previous unread email chosen and its example",
    },
    "open": {m: "Inbox with one email open in the reading pane, before it is deleted"
             for m in ("none", "next", "previous", "nextUnread", "previousUnread")},
    "after": {
        "none": "Reading pane after the delete: no email is selected",
        "next": "Reading pane after the delete: the email below the deleted one is open",
        "previous": "Reading pane after the delete: the email above the deleted one is open",
        "nextUnread": "Reading pane after the delete: the next unread email below is open",
        "previousUnread": "Reading pane after the delete: the previous unread email above is open",
    },
}
OUT_W, OUT_H = 1440, 900
SRC_W, SRC_H = 3072, 1920           # the 2x window recording
FOOT = round(OUT_W * 44 / 960)
MAX_ZOOM = 2.3
CAPTIONS = Path(__file__).with_name("after-delete-captions.json")


def run(*args):
    return subprocess.run([str(a) for a in args], check=True, capture_output=True).stdout


def captions_for(locale):
    doc = json.loads(CAPTIONS.read_text())
    if locale == "en":
        return lambda text: text
    table = doc["locales"].get(locale)
    if table is None:
        raise ValueError(f"no captions for {locale} in {CAPTIONS.name}")
    missing = [x for x in doc["strings"] if x not in table]
    if missing:
        raise ValueError(f"{locale}: untranslated captions {missing[:3]}")
    return lambda text: table.get(text, text)


# ── the camera ───────────────────────────────────────────────────────────────

def union(*boxes):
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    x0 = min(b["x"] for b in boxes)
    y0 = min(b["y"] for b in boxes)
    x1 = max(b["x"] + b["w"] for b in boxes)
    y1 = max(b["y"] + b["h"] for b in boxes)
    return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}


def frame_for(box, win, pad=28, max_zoom=MAX_ZOOM):
    """(zoom, cx, cy): the 16:10 crop that holds `box` plus `pad` points, centre as a fraction of the window."""
    W, H = win
    w, h = box["w"] + 2 * pad, box["h"] + 2 * pad
    z = min(max_zoom, max(1.0, min(W / w, H / h)))
    cx = (box["x"] + box["w"] / 2) / W
    cy = (box["y"] + box["h"] / 2) / H
    return clamp(z, cx, cy)


TITLEBAR = 34 / 960   # the native title bar (traffic lights) is window chrome: a zoomed crop starts below it


def clamp(z, cx, cy):
    # The crop never leaves the window: centre between half a crop in from each edge,
    # and a zoomed crop stays below the title bar.
    cx = min(max(cx, 0.5 / z), 1 - 0.5 / z)
    top = (TITLEBAR if z > 1.05 else 0) + 0.5 / z
    cy = min(max(cy, top), 1 - 0.5 / z)
    return z, cx, cy


FULL = (1.0, 0.5, 0.5)


def events_at(actions, kind, label):
    return [e for e in actions["events"] if e["type"] == kind and e.get("label") == label]


def click_time(actions, label):
    e = events_at(actions, "click", label)
    if not e:
        raise ValueError(f"no click '{label}' in the action log")
    return e[0].get("shown", e[0]["t"])


def plan_camera(clip, mode, steps, actions, duration):
    """Keyframes [(t, zoom, cx, cy)], each a hold; the camera eases between them (smoothstep)."""
    win = (actions["window"]["logicalW"], actions["window"]["logicalH"])
    st = {s["id"]: s for s in steps}
    r = lambda sid, name: (st.get(sid, {}).get("rects") or {}).get(name)
    t_settings, t_option = st["settings"]["t"], st["option"]["t"]
    t_close = click_time(actions, "settings-close")
    t_delete = click_time(actions, "delete")
    t_after = st["after"]["t"]

    settings_box = union(r("settings", "select"), r("settings", "example"), r("option", "select"), r("option", "example"))
    settings_f = frame_for(settings_box, win, pad=44)
    delete_f = frame_for(r("delete", "delete"), win, pad=150)
    list_box = r("after", "list") or r("open", "row")
    slot = r("after", "row") or r("delete", "row")        # the opened row, or where the deleted one was
    list_region = {"x": list_box["x"], "y": slot["y"] - 150, "w": list_box["w"], "h": slot["h"] + 300}
    list_f = frame_for(list_region, win, pad=0, max_zoom=1.9)
    reader = r("after", "reader")
    reader_region = {"x": reader["x"], "y": reader["y"] - 70, "w": reader["w"], "h": reader["h"] * (0.55 if mode != "none" else 0.75) + 70}
    reader_f = frame_for(reader_region, win, pad=10, max_zoom=1.7)

    eps = 0.05
    k = [(0.0, *FULL),
         (max(eps, t_settings - 0.9), *FULL), (t_settings + 0.4, *settings_f),
         (t_close - 0.35, *settings_f), (t_close + 0.45, *FULL),
         (max(t_close + 0.6, t_delete - 1.25), *FULL), (t_delete - 0.5, *delete_f),
         (t_delete + 0.35, *delete_f), (t_delete + 1.15, *list_f),
         (max(t_delete + 1.3, t_after - 0.2), *list_f), (max(t_delete + 1.9, t_after + 0.7), *reader_f),
         (duration, *reader_f)]
    out = []
    for item in k:  # strictly rising times
        if out and item[0] <= out[-1][0]:
            item = (out[-1][0] + 0.05, *item[1:])
        out.append(item)
    return out


def expr(points, i):
    """ffmpeg expression of the i-th field (1 zoom, 2 cx, 3 cy) over output frame number `on` at 30 fps."""
    value = f"{points[-1][i]:.5f}"
    for a, b in reversed(list(zip(points, points[1:]))):
        u = f"clip((on/30-{a[0]:.3f})/{b[0] - a[0]:.3f},0,1)"
        eased = f"({u}*{u}*(3-2*{u}))"
        value = f"if(lt(on/30,{b[0]:.3f}),{a[i]:.5f}+({b[i] - a[i]:.5f})*{eased},{value})"
    return value


def camera_at(points, t):
    for a, b in zip(points, points[1:]):
        if t < b[0]:
            u = min(max((t - a[0]) / (b[0] - a[0]), 0), 1)
            e = u * u * (3 - 2 * u)
            return tuple(a[i] + (b[i] - a[i]) * e for i in (1, 2, 3))
    return points[-1][1:]


# ── publish ──────────────────────────────────────────────────────────────────

def find_runs(source):
    if (source / "howto-after-delete.facts.json").exists():
        return {"en": source}
    runs = {d.name: d for d in sorted(source.iterdir()) if d.is_dir() and (d / "howto-after-delete.facts.json").exists()}
    if not runs:
        raise ValueError(f"no howto-after-delete runs under {source}")
    return runs


def encode(mov, actions, points, tmp, video, label, total):
    howto.WIDTH, howto.HEIGHT = SRC_W, SRC_H          # draw the pointer at source size so it zooms with the frame
    extra, overlay = howto.click_overlay(actions, tmp, 2)
    z, cx, cy = expr(points, 1), expr(points, 2), expr(points, 3)
    camera = (f"[ov]fps=30,zoompan=z='{z}':x='iw*({cx})-iw/zoom/2':y='ih*({cy})-ih/zoom/2':d=1:s={OUT_W}x{OUT_H}:fps=30,"
              f"pad=iw:ih+{FOOT}:0:0:color=0x171717[p];[p][1:v]overlay=0:H-h:format=auto,format=yuv420p[v]")
    footer = tmp / "footer.png"
    base.stamp(OUT_W, label).save(footer)
    run("ffmpeg", "-y", "-v", "error", "-i", mov, "-i", footer, *extra, "-filter_complex", f"{overlay};{camera}",
        "-map", "[v]", "-t", f"{total:.3f}", "-an", "-c:v", "libx264", "-crf", "32", "-preset", "slow", "-movflags", "+faststart", video)


def still(mov, t, framing, out_path, label, win):
    """The source frame at `t`, cropped to the camera framing (zoom, cx, cy), at 1440 px wide, with the footer."""
    z, cx, cy = framing
    w, h = SRC_W / z, SRC_H / z
    x = min(max(cx * SRC_W - w / 2, 0), SRC_W - w)
    y = min(max(cy * SRC_H - h / 2, 0), SRC_H - h)
    with tempfile.TemporaryDirectory(prefix="mv-ad-still-") as d:
        raw = Path(d) / "f.png"
        run("ffmpeg", "-y", "-v", "error", "-ss", str(t), "-i", mov, "-frames:v", "1",
            "-vf", f"crop={w:.0f}:{h:.0f}:{x:.0f}:{y:.0f},scale={OUT_W}:{OUT_H}:flags=lanczos", raw)
        image = Image.open(raw).convert("RGB")
    foot = base.stamp(image.width, label)
    final = Image.new("RGB", (image.width, image.height + foot.height))
    final.paste(image, (0, 0))
    final.paste(foot, (0, image.height))
    final.save(out_path, "WEBP", quality=88, method=6)
    return final


def publish(source, dry):
    version = json.loads((ROOT / "package.json").read_text())["version"]
    commit = run("git", "-C", ROOT, "rev-parse", "HEAD").decode().strip()
    manifest_path = ROOT / "website/help-media.json"
    manifest = base.read(manifest_path)
    evidence_path = ROOT / "website/assets/help-media/capture-after-delete-evidence.json"
    evidence = base.read(evidence_path) if evidence_path.exists() else {"locales": {}}
    evidence.update({"version": version, "sourceCommit": commit})
    evidence.setdefault("locales", {})
    for locale, run_dir in find_runs(source).items():
        out = (dry / locale) if dry else (ROOT / "website/assets/help-media" / locale)
        publish_locale(locale, run_dir, version, commit, manifest, evidence, out, dry)
    if dry:
        return
    manifest["provenance"] = [p for p in manifest["provenance"] if not p.startswith("After-delete recordings")] + [
        "After-delete recordings (after-delete-*): ScreenCaptureKit takes of the real app on the Mac mini at 2x, one app launch per locale "
        "(UI language and demo mailbox from the locale catalog). Each take re-seeds read flags off camera and fails unless the reader opens "
        "the email the option promises. The camera zoom is cut from the same 2x frames, aimed at rectangles the take recorded; pointer, "
        "click ripple and version footer are the only added pixels."]
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")


def publish_locale(locale, source, version, commit, manifest, evidence, out, dry):
    tr = captions_for(locale)
    facts = base.read(source / "howto-after-delete.facts.json")
    if facts.get("locale") and facts["locale"] != {"pt-br": "pt-BR", "zh": "zh-Hans"}.get(locale, locale):
        raise ValueError(f"{locale}: run was recorded in {facts['locale']}")
    label = f"MailVault version {version} {locale}"
    out.mkdir(parents=True, exist_ok=True)
    workflows = manifest["locales"][locale]["workflows"]
    ev = evidence["locales"][locale] = {"facts": facts, "clips": {}}
    for clip, (mode, english) in CLIPS.items():
        mov = source / f"{clip}.mov"
        recorder = base.read(source / f"{clip}.mov.json")
        census = base.read(source / f"{clip}.census.json")
        steps_doc = base.read(source / f"{clip}.steps.json")
        actions = base.read(source / f"{clip}.actions.json")
        steps = steps_doc["steps"]
        if recorder.get("blankSuspect") or census["probe"].get("theme") != "dark":
            raise ValueError(f"unfit recording: {clip}")
        if (recorder["pixelW"], recorder["pixelH"]) != (SRC_W, SRC_H) or actions["window"]["scale"] != 2:
            raise ValueError(f"not a 2x window recording: {clip}")
        total = float(run("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mov))
        points = plan_camera(clip, mode, steps, actions, total)
        win = (actions["window"]["logicalW"], actions["window"]["logicalH"])
        alt = f"{tr(english)} · {label}"
        with tempfile.TemporaryDirectory(prefix="mv-after-delete-") as tmp:
            tmp = Path(tmp)
            video = out / f"{clip}.mp4"
            encode(mov, actions, points, tmp, video, label, total)
            probe = json.loads(run("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", video))
            stream = probe["streams"][0]
            if stream["codec_name"] != "h264" or len(probe["streams"]) != 1 or stream["width"] != OUT_W:
                raise ValueError(f"invalid video: {clip}")
            duration = float(probe["format"]["duration"])
            cues = []
            for i, step in enumerate(steps):
                start = step["t"]
                end = steps[i + 1]["t"] if i + 1 < len(steps) else duration
                if end - start > 0.2:
                    cues.append((start, end, tr(step["caption"])))
            (out / f"{clip}.vtt").write_text("WEBVTT\n\n" + "\n".join(f"{base.clock(s)} --> {base.clock(e)}\n{c}\n" for s, e, c in cues))
            st = {s["id"]: s for s in steps}
            moments = {  # still name -> (source second, framing)
                "option": (st["option"]["t"] + 0.1, camera_at(points, st["option"]["t"] + 0.1)),
                "open": (st["open"]["t"], FULL),
                "after": (st["after"]["t"], FULL),
            }
            entries = {}
            for name, (t, framing) in moments.items():
                key = f"{clip}-{name}"
                path = out / f"{key}.webp"
                final = still(mov, t, framing, path, label, win)
                step_alt = f"{tr(STILL_ALT[name][mode])} · {label}"
                entries[key] = {
                    "image": f"/assets/help-media/{locale}/{key}.webp", "imageAlt": step_alt,
                    "imageSize": [final.width, final.height], "stamp": label, "captureVersion": version,
                    "captureCommit": commit, "captureLocale": locale, "recordingVerified": True,
                    "sourceFrameSeconds": t, "sourceSHA256": base.digest(mov), "sha256": {"webp": base.digest(path)},
                }
            poster = still(mov, st["option"]["t"] + 0.1, camera_at(points, st["option"]["t"] + 0.1), out / f"{clip}-poster.tmp.webp", label, win)
            poster.resize((960, round(poster.height * 960 / poster.width)), Image.Resampling.LANCZOS).save(
                out / f"{clip}.jpg", "JPEG", quality=90, optimize=True)
            (out / f"{clip}-poster.tmp.webp").unlink()
            files = {ext: out / f"{clip}.{ext}" for ext in ["mp4", "jpg", "vtt"]}
            entries[clip] = {
                "video": f"/assets/help-media/{locale}/{clip}.mp4", "videoLabel": alt,
                "poster": f"/assets/help-media/{locale}/{clip}.jpg", "posterAlt": alt,
                "captions": f"/assets/help-media/{locale}/{clip}.vtt",
                "transcript": [c for _, _, c in cues], "duration": duration,
                "videoSize": [stream["width"], stream["height"]], "stamp": label, "captureVersion": version,
                "captureCommit": commit, "captureLocale": locale, "recordingVerified": True,
                "recordingFrames": recorder.get("delivered"), "sourceSeconds": total, "sourceSHA256": base.digest(mov),
                "sha256": {ext: base.digest(path) for ext, path in files.items()},
            }
            if not dry:
                workflows.update(entries)
            ev["clips"][clip] = {"recorder": recorder, "census": census, "steps": steps_doc, "camera": points}
            print(f"Published {clip}: {duration:.1f}s, {len(points)} camera keys, 3 stills")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--dry", type=Path, help="write media here and leave the manifest alone")
    args = parser.parse_args()
    if args.dry:
        shutil.rmtree(args.dry, ignore_errors=True)
    publish(args.source.resolve(), args.dry.resolve() if args.dry else None)
