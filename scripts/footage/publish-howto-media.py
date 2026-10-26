#!/usr/bin/env python3
"""Publish the howto-abd recordings: videos, per-step stills, captions, manifest entries.

    python3 scripts/footage/publish-howto-media.py <collected run dir>

The run dir holds what scenes/howto-abd.js wrote (unpacked run tar): per clip
<clip>.mov, <clip>.mov.json, <clip>.steps.json, <clip>.census.json, plus
howto-abd.facts.json and geometry.json. Needs ffmpeg, ffprobe and Pillow.

App pixels come only from the mini's ScreenCaptureKit footage. Added pixels are
the version footer below the window (as publish-help-media.py). A long progress
wait is cut out of the video (and said so in the captions); stills are taken at
the recorded step moments, never from the cut. Entries are MERGED into
website/help-media.json (existing workflows stay) so media policy and the
localizer find them, and the evidence goes to assets/help-media/capture-howto-evidence.json.
"""
import argparse
import importlib.util
import json
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("help_media", Path(__file__).with_name("publish-help-media.py"))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

CLIPS = {
    "bulk-archive-delete": "Archive and delete from the server for selected emails",
    "bulk-archive-backup-delete": "Archive, back up and delete from the server for selected emails",
    "settings-archive-delete": "Archive and delete from the server for a whole account in Settings",
    "settings-archive-backup-delete": "Archive, back up and delete from the server for a whole account in Settings",
}
WIDTH, HEIGHT = 1440, 900      # window 1536 x 960 pt, scaled
KEEP_HEAD, KEEP_TAIL = 5.0, 2.0  # seconds kept either side of a cut wait
MIN_CUT = 6.0
# A bulk "progress" mark is taken as the bubble's first percent shows, while the confirmation dialog still fades.
STILL_OFFSET = {("bulk-archive-delete", "progress"): 2.0, ("bulk-archive-backup-delete", "progress"): 2.0}


def run(*args):
    return subprocess.run([str(a) for a in args], check=True, capture_output=True).stdout


def keep_intervals(steps, total):
    """[(start, end)] of the source that stays in the video; the middle of a long progress wait goes."""
    t = {s["id"]: s["t"] for s in steps}
    cut_from = t["progress"] + KEEP_HEAD
    cut_to = (t["job-complete"] if "job-complete" in t else t["done"]) - KEEP_TAIL
    if cut_to - cut_from < MIN_CUT:
        return [(0.0, total)], None
    return [(0.0, cut_from), (cut_to, total)], (cut_from, cut_to)


def to_output(t, cut):
    if not cut or t <= cut[0]:
        return t
    return t - (cut[1] - cut[0])


def publish(source):
    facts = base.read(source / "howto-abd.facts.json")
    geometry = base.read(source / "geometry.json")
    version = json.loads((ROOT / "package.json").read_text())["version"]
    commit = run("git", "-C", ROOT, "rev-parse", "HEAD").decode().strip()
    locale = "en"
    label = f"MailVault version {version} {locale}"
    out = ROOT / "website/assets/help-media" / locale
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = ROOT / "website/help-media.json"
    manifest = base.read(manifest_path)
    workflows = manifest["locales"][locale]["workflows"]
    evidence = {"version": version, "sourceCommit": commit,
                "note": "Recorded from the minijob snapshot of this commit plus the uncommitted scripts/footage/scenes/howto-abd.js; the app code is the commit's.",
                "geometry": geometry, "facts": facts, "clips": {}}

    for clip, description in CLIPS.items():
        mov = source / f"{clip}.mov"
        recorder = base.read(source / f"{clip}.mov.json")
        census = base.read(source / f"{clip}.census.json")
        steps_doc = base.read(source / f"{clip}.steps.json")
        steps = steps_doc["steps"]
        if recorder.get("blankSuspect") or census["probe"].get("theme") != "dark":
            raise ValueError(f"unfit recording: {clip}")
        if (recorder["pixelW"], recorder["pixelH"]) != (3072, 1920):
            raise ValueError(f"not a 2x window recording: {clip} {recorder['pixelW']}x{recorder['pixelH']}")
        total = float(run("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mov))
        intervals, cut = keep_intervals(steps, total)
        alt = f"{description} · {label}"
        with tempfile.TemporaryDirectory(prefix="mv-howto-") as tmp:
            tmp = Path(tmp)
            footer = tmp / "footer.png"
            base.stamp(WIDTH, label).save(footer)
            video = out / f"{clip}.mp4"
            if len(intervals) == 1:
                head = f"[0:v]trim=0:{intervals[0][1]},setpts=PTS-STARTPTS[c]"
            else:
                (a0, a1), (b0, b1) = intervals
                head = (f"[0:v]split=2[a][b];[a]trim={a0}:{a1},setpts=PTS-STARTPTS[v0];"
                        f"[b]trim={b0}:{b1},setpts=PTS-STARTPTS[v1];[v0][v1]concat=n=2:v=1:a=0[c]")
            fc = (f"{head};[c]fps=30,scale={WIDTH}:{HEIGHT}:flags=lanczos,pad=iw:ih+{round(WIDTH * 44 / 960)}:0:0:color=0x171717[p];"
                  f"[p][1:v]overlay=0:H-h:format=auto,format=yuv420p[v]")
            run("ffmpeg", "-y", "-v", "error", "-i", mov, "-i", footer, "-filter_complex", fc, "-map", "[v]", "-an",
                "-c:v", "libx264", "-crf", "24", "-preset", "slow", "-movflags", "+faststart", video)
            probe = json.loads(run("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", video))
            stream = probe["streams"][0]
            if stream["codec_name"] != "h264" or len(probe["streams"]) != 1 or stream["width"] != WIDTH:
                raise ValueError(f"invalid video: {clip}")
            duration = float(probe["format"]["duration"])

            # Captions: one cue per step, on the output timeline.
            cues = []
            for i, step in enumerate(steps):
                start = to_output(step["t"], cut)
                end = to_output(steps[i + 1]["t"], cut) if i + 1 < len(steps) else duration
                text = step["caption"]
                if cut and step["id"] == "progress":
                    text += " The wait is shortened here."
                if end - start > 0.2:
                    cues.append((start, end, text))
            vtt = "WEBVTT\n\n" + "\n".join(f"{base.clock(s)} --> {base.clock(e)}\n{c}\n" for s, e, c in cues)
            (out / f"{clip}.vtt").write_text(vtt)

            entries = {}
            for step in steps:
                name = f"{clip}-{step['id']}"
                raw = tmp / f"{name}.png"
                frame_t = step["t"] + STILL_OFFSET.get((clip, step["id"]), 0.0)
                run("ffmpeg", "-y", "-v", "error", "-ss", str(frame_t), "-i", mov, "-frames:v", "1",
                    "-vf", f"scale={WIDTH}:{HEIGHT}:flags=lanczos", raw)
                image = Image.open(raw).convert("RGB")
                foot = base.stamp(image.width, label)
                final = Image.new("RGB", (image.width, image.height + foot.height))
                final.paste(image, (0, 0))
                final.paste(foot, (0, image.height))
                final.save(out / f"{name}.webp", "WEBP", quality=88, method=6)
                if step["id"] == "progress":
                    final.resize((960, round(final.height * 960 / final.width)), Image.Resampling.LANCZOS).save(
                        out / f"{clip}.jpg", "JPEG", quality=90, optimize=True)
                step_alt = f"{step['caption']} · {label}"
                entries[name] = {
                    "image": f"/assets/help-media/{locale}/{name}.webp", "imageAlt": step_alt,
                    "imageSize": [final.width, final.height], "stamp": label, "captureVersion": version,
                    "captureCommit": commit, "captureLocale": locale, "recordingVerified": True,
                    "sourceFrameSeconds": frame_t, "sourceSHA256": base.digest(mov),
                    "sha256": {"webp": base.digest(out / f"{name}.webp")},
                }
            poster = out / f"{clip}.jpg"
            files = {ext: out / f"{clip}.{ext}" for ext in ["mp4", "jpg", "vtt"]}
            entries[clip] = {
                "video": f"/assets/help-media/{locale}/{clip}.mp4", "videoLabel": alt,
                "poster": f"/assets/help-media/{locale}/{clip}.jpg", "posterAlt": alt,
                "captions": f"/assets/help-media/{locale}/{clip}.vtt",
                "transcript": [c for _, _, c in cues], "duration": duration,
                "videoSize": [stream["width"], stream["height"]], "stamp": label, "captureVersion": version,
                "captureCommit": commit, "captureLocale": locale, "recordingVerified": True,
                "recordingFrames": recorder.get("delivered"), "sourceSeconds": total,
                "cutSourceSeconds": list(cut) if cut else None, "sourceSHA256": base.digest(mov),
                "sha256": {ext: base.digest(path) for ext, path in files.items()},
            }
            workflows.update(entries)
            evidence["clips"][clip] = {"recorder": recorder, "census": census, "steps": steps_doc, "cut": cut}
            print(f"Published {clip}: {duration:.1f}s from {total:.1f}s, {len(steps)} stills")

    manifest["provenance"] = [p for p in manifest["provenance"] if not p.startswith("How-to recordings")] + [
        "How-to recordings (bulk-* and settings-* archive and delete): ScreenCaptureKit takes of the real app on the Mac mini at 2x; "
        "stills are decoded at recorded step moments; a long progress wait is cut from the videos and captioned as shortened."]
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    (ROOT / "website/assets/help-media/capture-howto-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    publish(parser.parse_args().source.resolve())
