# MailVault Icons

Place your app icons here:

- `icon.png` - 512x512 PNG (used as base for generating others)
- `icon.icns` - macOS icon bundle
- `icon.ico` - Windows icon
- `32x32.png` - 32x32 PNG
- `128x128.png` - 128x128 PNG
- `128x128@2x.png` - 256x256 PNG (Retina)
- `tray-icon.png` - macOS menu bar template glyph (black, 32x32)
- `tray-icon-color.png` - Windows/Linux tray icon: `icon.png` cropped to its artwork (no margin), 64x64. Regenerate it when `icon.png` changes.

## Generate Icons

You can use the Tauri CLI to generate icons from a single 512x512 PNG:

```bash
npm run tauri icon path/to/icon.png
```

Or use an online tool like https://icon.kitchen/
