# MailVault App Icon - Image Generation Prompt

## For ChatGPT with DALL-E or Midjourney

### Primary Prompt (Clean, Modern)

```
Create a macOS app icon for "MailVault" - an email client that saves emails locally for permanent storage. 

Design requirements:
- Modern, minimalist macOS Big Sur/Sonoma style
- Rounded square shape (squircle) with subtle gradient
- Combine an envelope symbol with a vault/safe or hard drive element
- Color palette: Deep indigo/purple (#6366f1) as primary, with emerald green (#10b981) accent representing "saved/local"
- Dark background (#0a0a0f to #12121a gradient)
- Clean, professional look suitable for a productivity app
- No text in the icon
- Slight 3D depth with soft shadows
- 1024x1024 pixels, PNG format with transparency
```

### Alternative Prompt (More Detailed)

```
Design a premium macOS application icon for an email client called "MailVault". 

The app lets users save important emails permanently to local storage, even after they're deleted from email servers.

Visual concept: A sleek envelope emerging from or protected by a vault door, or an envelope with a small hard drive/shield badge in the corner.

Style guidelines:
- Apple macOS Big Sur design language
- Squircle (rounded square) shape
- Rich gradient background: dark navy to deep purple
- Primary color: Indigo (#6366f1)
- Accent color: Emerald green (#10b981) for the "local/saved" indicator
- Soft lighting from top-left
- Subtle inner glow and drop shadow
- Glass/frosted effect optional
- Professional and trustworthy appearance
- Must work at small sizes (16x16) and large (1024x1024)

Do NOT include: text, letters, words, or the app name in the icon.

Output: 1024x1024 PNG with transparent background
```

### Midjourney Prompt

```
macOS app icon, email vault application, envelope with vault protection symbol, indigo and emerald green gradient, dark background, squircle shape, Big Sur style, minimalist, professional, 3D subtle depth, soft shadows, no text --v 6 --ar 1:1 --s 250
```

### Prompt for Simpler Style

```
Minimalist macOS app icon: envelope with a small green checkmark badge indicating "saved locally". Dark purple/indigo gradient background, rounded square shape, clean vector style, no text, professional email app aesthetic. 1024x1024 PNG.
```

---

## After Generating the Icon

Once you have your 1024x1024 PNG icon, place it in the project and run:

```bash
cd mail-client
npm run tauri:icon path/to/your-icon.png
```

This will automatically generate all required sizes:
- icon.icns (macOS)
- icon.ico (Windows)  
- 32x32.png
- 128x128.png
- 128x128@2x.png
- icon.png (512x512)

---

## Icon Concept Sketches (ASCII)

### Concept 1: Envelope + Vault Door
```
    ┌─────────────┐
    │  ╱╲         │
    │ ╱  ╲   [●]  │  ← vault lock
    │╱────╲       │
    │             │
    │   ═══════   │  ← envelope lines
    └─────────────┘
```

### Concept 2: Envelope + Hard Drive Badge
```
    ┌─────────────┐
    │  ╱╲         │
    │ ╱  ╲        │
    │╱────╲  ┌──┐ │
    │      │ │▪▪│ │  ← hard drive badge (green)
    │      │ └──┘ │
    └─────────────┘
```

### Concept 3: Shield + Envelope
```
    ┌─────────────┐
    │    ╱▼╲      │
    │   ╱ ✉ ╲     │  ← envelope inside shield
    │  ╱     ╲    │
    │  ╲     ╱    │
    │   ╲   ╱     │
    │    ╲▲╱      │
    └─────────────┘
```
