# MailVault Icons

The master artwork is `src/assets/mailvault-icon-teal-concept.png`.

Regenerate all desktop, mobile, tray, in-app, and website icons with Pillow:

```bash
python3 scripts/generate-icons.py
```

- `icon.png`: 512×512 desktop base; `icon.icns`: macOS multi-resolution bundle; `icon.ico`: Windows multi-resolution bundle.
- Size-specific PNGs and Windows Store logos preserve their required dimensions.
- `tray-icon.png`: 32×32 black macOS template glyph; `tray-icon-color.png`: 64×64 cropped Windows/Linux artwork.
- iOS icons use opaque teal backgrounds. Android includes legacy, round, and adaptive icons with safe foreground margins.
- Website assets include PNG/WebP branding, multi-resolution favicons, and a 180×180 Apple touch icon.

The generator preserves `dmg-background.png`, which is installer artwork rather than an app icon.
