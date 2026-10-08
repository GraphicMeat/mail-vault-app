#!/usr/bin/env python3
"""Build the website file set of one locale from the published clips.

  python3 scripts/footage/site-set.py <published dir> <out dir> [--accept clip,clip]

<published dir> is a ~/Movies/MailVault Website Clips/<set> folder written by
`web-clips.sh publish` (dark <clip>.mp4 / .jpg and, beside them, the
<clip>.light.mp4 / .light.jpg of `publish <locale>.light`). Clips the output
check or a reviewer held sit in _needs-decision/; --accept names the ones that
ship anyway (a held clip never ships by itself).

<out dir> gets, for every card clip, exactly what the site asks for:

  <clip>.mp4  <clip>.jpg  <clip>-poster.jpg                (dark)
  <clip>.light.mp4  <clip>.light.jpg  <clip>-poster.light.jpg   (light)

and manifest.json (name, bytes) for the tests and the upload script. The card
poster is the 960x660 still resized to 640x440, progressive, at the highest
JPEG quality that stays under 44 KB (the site test allows 45 KB).
Needs Pillow. The hero montage is dark only and is not part of this set.
"""
import json
import os
import shutil
import sys

from PIL import Image

POSTER_MAX = 44000


def main(argv):
    args = [a for a in argv if not a.startswith('--')]
    accept = set()
    if '--accept' in argv:
        accept = set(argv[argv.index('--accept') + 1].split(','))
        args = [a for a in args if a != argv[argv.index('--accept') + 1]]
    if len(args) != 2:
        print(__doc__)
        return 64
    src, out = args
    os.makedirs(out, exist_ok=True)

    def find(name, clip):
        for d in (src, os.path.join(src, '_needs-decision')):
            f = os.path.join(d, name)
            if os.path.exists(f):
                return f, d != src
        return None, False

    clips = sorted(f[:-4] for f in os.listdir(src) if f.endswith('.mp4') and '.light' not in f)
    clips += sorted(f[:-4] for f in os.listdir(os.path.join(src, '_needs-decision')) if f.endswith('.mp4') and '.light' not in f) \
        if os.path.isdir(os.path.join(src, '_needs-decision')) else []
    clips = [c for c in dict.fromkeys(clips) if c != 'hero-montage']
    manifest, problems = [], []
    for clip in clips:
        for suffix in ('', '.light'):
            mp4, held = find(f'{clip}{suffix}.mp4', clip)
            jpg, _ = find(f'{clip}{suffix}.jpg', clip)
            if not mp4 or not jpg:
                problems.append(f'{clip}{suffix}: missing {"mp4" if not mp4 else "jpg"}')
                continue
            if held and clip not in accept:
                problems.append(f'{clip}{suffix}: held in _needs-decision (use --accept {clip} to ship it)')
                continue
            shutil.copy(mp4, os.path.join(out, f'{clip}{suffix}.mp4'))
            shutil.copy(jpg, os.path.join(out, f'{clip}{suffix}.jpg'))
            im = Image.open(jpg).convert('RGB')
            if im.size != (960, 660):
                problems.append(f'{clip}{suffix}: still is {im.size}, not 960x660')
                continue
            poster = os.path.join(out, f'{clip}-poster{suffix}.jpg')
            for q in (80, 74, 68, 62, 56, 50):
                im.resize((640, 440), Image.LANCZOS).save(poster, quality=q, optimize=True, progressive=True)
                if os.path.getsize(poster) < POSTER_MAX:
                    break
            else:
                problems.append(f'{clip}{suffix}: poster still {os.path.getsize(poster)} B at quality 50')
            for n in (f'{clip}{suffix}.mp4', f'{clip}{suffix}.jpg', f'{clip}-poster{suffix}.jpg'):
                manifest.append({'name': n, 'bytes': os.path.getsize(os.path.join(out, n))})
    with open(os.path.join(out, 'manifest.json'), 'w') as f:
        json.dump({'clips': len(clips), 'files': manifest}, f, indent=1)
    print(f'{len(clips)} clips, {len(manifest)} files -> {out}')
    for p in problems:
        print('PROBLEM', p)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
