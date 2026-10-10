"""Regenerate platform and web icons. Requires Pillow; run from any directory."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / 'src-tauri/icons'
SOURCE = ROOT / 'src/assets/mailvault-icon-purple.png'
master = Image.open(SOURCE).convert('RGBA')
resample = Image.Resampling.LANCZOS

def resized(size):
    return master.resize((size, size), resample)

def opaque(size):
    canvas = Image.new('RGBA', (size, size), '#4f46e5')
    canvas.alpha_composite(resized(size))
    return canvas.convert('RGB')

outputs = {}
for path in ICONS.glob('*.png'):
    if path.name in ('dmg-background.png', 'tray-icon.png', 'tray-icon-color.png'):
        continue
    outputs[path] = resized(Image.open(path).width)
for path in (ICONS / 'ios').glob('*.png'):
    outputs[path] = opaque(Image.open(path).width)
for directory, scale in [('mdpi', 1), ('hdpi', 1.5), ('xhdpi', 2), ('xxhdpi', 3), ('xxxhdpi', 4)]:
    folder = ICONS / 'android' / f'mipmap-{directory}'
    size = round(48 * scale)
    outputs[folder / 'ic_launcher.png'] = opaque(size)
    circular = opaque(size).convert('RGBA')
    mask = Image.new('L', (size, size))
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    circular.putalpha(mask)
    outputs[folder / 'ic_launcher_round.png'] = circular
    # Android adaptive icons expose the central 72dp of a 108dp layer.
    foreground = Image.new('RGBA', (round(108 * scale),) * 2)
    artwork = resized(round(66 * scale))
    offset = (foreground.width - artwork.width) // 2
    foreground.alpha_composite(artwork, (offset, offset))
    outputs[folder / 'ic_launcher_foreground.png'] = foreground
outputs[ROOT / 'src/assets/mailvault-icon.png'] = resized(256)
for name, size in [('icon-128.png', 128), ('icon-128.webp', 128), ('favicon-32x32.png', 32), ('apple-touch-icon.png', 180)]:
    outputs[ROOT / 'website' / name] = opaque(size) if name == 'apple-touch-icon.png' else resized(size)
# Crop transparent padding for the small Windows/Linux tray image.
outputs[ICONS / 'tray-icon-color.png'] = master.crop(master.getchannel('A').getbbox()).resize((64, 64), resample)
# macOS template image: a simple envelope pocket and dial, drawn at 4x.
glyph = Image.new('RGBA', (128, 128))
draw = ImageDraw.Draw(glyph)
ink = (0, 0, 0, 255)
draw.rounded_rectangle((16, 12, 112, 116), radius=20, outline=ink, width=8)
draw.rounded_rectangle((28, 24, 100, 76), radius=6, outline=ink, width=7)
draw.line([(30, 28), (64, 55), (98, 28)], fill=ink, width=7)
draw.ellipse((73, 81, 101, 109), outline=ink, width=6)
outputs[ICONS / 'tray-icon.png'] = glyph.resize((32, 32), resample)
for path, image in outputs.items():
    image.save(path, **({'lossless': True} if path.suffix == '.webp' else {}))
resized(1024).save(ICONS / 'icon.icns', format='ICNS')
resized(256).save(ICONS / 'icon.ico', format='ICO', sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
resized(64).save(ROOT / 'website/favicon.ico', format='ICO', sizes=[(n, n) for n in (16, 32, 48, 64)])
(ICONS / 'android/values/ic_launcher_background.xml').write_text('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">#4f46e5</color>\n</resources>\n')
print(f'Generated {len(outputs) + 3} icon files from {SOURCE.name}')

# Preserve the original teal design for the runtime icon picker.
alternates = ICONS / 'alternates'
alternates.mkdir(exist_ok=True)
teal = Image.open(ROOT / 'src/assets/mailvault-icon-teal-concept.png').convert('RGBA')
for name, image in [('purple', master), ('teal', teal)]:
    image.resize((512, 512), resample).save(alternates / f'{name}.png')
    image.crop(image.getchannel('A').getbbox()).resize((64, 64), resample).save(alternates / f'{name}-tray.png')

teal.resize((256, 256), resample).save(ROOT / 'src/assets/mailvault-icon-teal.png')
