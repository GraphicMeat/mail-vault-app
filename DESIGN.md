---
name: MailVault
description: A local-first mail client whose interface is a dark desk — quiet until a message's custody is at stake.
colors:
  accent: "#6366f1"
  accent-hover: "#818cf8"
  bg: "#0a0a0f"
  surface: "#12121a"
  surface-hover: "#1a1a25"
  border: "#2a2a3a"
  text: "#e4e4e7"
  text-muted: "#71717a"
  input-bg: "#0a0a0f"
  local: "#10b981"
  server: "#3b82f6"
  success: "#22c55e"
  warning: "#f59e0b"
  danger: "#ef4444"
  chat-sent-bg: "#4f46e5"
  chat-received-bg: "#1e1e2e"
typography:
  display:
    fontFamily: "Instrument Sans, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.2
  headline:
    fontFamily: "Instrument Sans, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "Instrument Sans, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Instrument Sans, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Instrument Sans, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
  micro:
    fontFamily: "Instrument Sans, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.01em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  full: "9999px"
spacing:
  hair: "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "#ffffff"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.text}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.md}"
    padding: "8px"
  button-icon-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.text}"
  input-text:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  chip-folder:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "4px 10px"
  chip-folder-active:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.full}"
    padding: "4px 10px"
  card-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "20px"
  dialog:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "24px"
    width: "448px"
  row-email:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    padding: "0 16px"
    height: "56px"
  row-email-unread:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    height: "56px"
  chat-bubble-sent:
    backgroundColor: "{colors.chat-sent-bg}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  chat-bubble-received:
    backgroundColor: "{colors.chat-received-bg}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
---

# Design System: MailVault

## Overview

**Creative North Star: "The Night Desk"**

MailVault is a dark room with one lamp on it. The ground is near-black with a blue cast (`#0a0a0f`), surfaces step up from it in barely-there increments, and the only saturated colour in a resting window is the indigo on the folder you are standing in. People sit in this app for hours, moving thousands of messages between a server they do not control and a vault they do — the interface has to stay legible at 2am and stay quiet while it does.

Quiet is not the same as empty. Every pixel of colour in this system is doing custody work: emerald says a message is in your vault, blue says it is on the server, amber says the server no longer has it and this is your only copy. That vocabulary is the reason the palette is otherwise so restrained — if surfaces competed for attention, the three colours that actually matter would stop being readable as a claim about where your mail lives.

Density is deliberate and high. Rows are 56px (52px compact), body text is 14px, labels 12px, and the list stays smooth past 17,000 messages. This is a working instrument, not a showcase: nothing decorative, nothing that costs a frame in a virtualized scroll, nothing that makes a person hunt for the state of their own archive.

It is explicitly **not** webmail (no promo chrome, no tabbed inbox, no Material bounce), **not** a consumer Electron app (no gradient hero buttons, no illustrations, no mascots), and **not** backup-utility grey (progress bars are not a personality).

**Key Characteristics:**
- Dark-first: `[data-theme="dark"]` is `:root`; light is a full, equal second theme, not an afterthought.
- One accent, spent sparingly — indigo marks the live thing, nothing else.
- Custody colour is a closed vocabulary: emerald / blue / amber mean vault / server / only-copy, and never anything else.
- Depth by tone and hairline, not by shadow.
- 14px body, 12px label, 8px rhythm; high information density at rest.
- Motion is short and functional: 150–200ms fades, spring-eased overlays, nothing that delays a click.

## Colors

A near-monochrome blue-black field with exactly one accent and a three-colour custody vocabulary laid over it. Values in the frontmatter are the dark theme (`:root`); the light theme redefines the same token names in `src/styles/index.css` and is equally normative.

### Primary
- **Desk Lamp Indigo** (`accent`): the single live colour. Active folder, focus ring, primary button, links inside message bodies, selection highlight, sent chat bubbles, the left border on the selected row. In light theme it deepens (`#4f46e5`) so it survives a white ground. Its hover pair (`accent-hover`) brightens in dark and darkens in light — the direction reverses per theme on purpose.

### Secondary — the custody vocabulary
- **Vault Emerald** (`local`): the message is in your vault, on your disk. Used on the drive glyph, the filled backup dot, archive affordances.
- **Server Blue** (`server`): the message is on the server and only there. Used on the cloud glyph.
- **Only-Copy Amber** (`warning`): the server no longer has this message. This is the loudest claim the UI can make and it requires proof of server absence — an unverified uid set renders as a plain vault row instead.

### Tertiary — status
- **Confirm Green** (`success`) for completed operations, **Destructive Red** (`danger`) for delete actions and error states. Red also appears as raw `bg-red-500` in some dialogs; treat `--mail-danger` as the token of record.

### Neutral — the Midnight Ink family
- **Midnight Ink** (`bg`): the window ground, and the inside of text inputs (`input-bg` is the same value in dark) so fields read as cut into the desk rather than raised off it.
- **Ink Surface** (`surface`): panels, sidebars, unread rows, settings cards — one step up from the ground.
- **Ink Raised** (`surface-hover`): hover fills, code blocks, secondary chips — one step above that.
- **Hairline** (`border`): every division in the app, always 1px.
- **Paper** (`text`) and **Half-Light** (`text-muted`): primary and secondary text; muted also carries every icon at rest.

### Named Rules
**The One Lamp Rule.** Indigo marks the live thing — what is selected, focused, or about to happen — and nothing else. A resting window shows it in one or two places. If a screen has three indigo elements competing, two of them are decoration and should be `text-muted`.

**The Custody Colour Rule.** Emerald, blue and amber are reserved words. Emerald means the vault, blue means the server, amber means "your only copy". Never spend them on generic status, brand accenting, or category colour — an account's identity colour comes from the per-account palette, not from these three.

**The Proof Rule.** Amber is a claim about the server, so it may only render when server state was actually verified. Absence of local knowledge is not proof of server absence; render the calm state and say "not verified yet" in the tooltip.

## Typography

**Display / Body Font:** Instrument Sans (fallback `system-ui, sans-serif`), loaded with JetBrains Mono from Google Fonts in `app.html` at weights 400/500/600/700.
**Label/Mono Font:** JetBrains Mono (fallback `ui-monospace, SFMono-Regular, monospace`) for message IDs, raw headers, paths, and `.eml` internals. The TipTap editor's own code blocks use the `ui-monospace` stack directly.

**Character:** Instrument Sans is a grotesque with slightly narrow, evenly-weighted letterforms — it holds up at 12px in a dense list, which is most of what this app asks of it. The pairing reads as engineering-adjacent rather than editorial: type is here to be scanned, and the mono is reserved for the moments where the app shows you the actual bytes it stored.

### Hierarchy
- **Display** (700, 1.5rem/24px): app-level titles and onboarding headlines. Rare — six occurrences in the entire client.
- **Headline** (600, 1.25rem/20px): section headers in full-screen surfaces like Settings.
- **Title** (600, 1.125rem/18px): dialog and modal titles, panel headers.
- **Body** (400, 0.875rem/14px, 1.5): the workhorse — subjects, sender names, message text, buttons, inputs. Over 500 usages; if a size is not obviously something else, it is this.
- **Label** (500, 0.75rem/12px): timestamps, folder chips, counts, secondary metadata, every icon-adjacent word.
- **Micro** (500, 0.6875rem/11px, and 10px for badge digits): unread counts, state badges, table-of-contents furniture inside dense rows. The floor.
- **Mono** (400, 0.8125rem/13px): raw headers, message IDs, file paths.

### Named Rules
**The 14/12 Rule.** Body is 14px and labels are 12px. Anything bigger is a title and must be one of the three heading roles; anything smaller than 11px is a badge digit, never prose.

**The One Weight Up Rule.** Emphasis comes from weight (500 → 600) and colour (`text-muted` → `text`), never from size. Unread rows go bolder, not larger, so row height never shifts under a sync.

**Surface divergence, recorded not blessed:** the marketing site (`index.html`, `website/`) uses **Inter**, not Instrument Sans, while sharing this exact indigo (Tailwind `primary.500` = `#6366f1`). The indigo is the thread between the two surfaces; the type is not. Any future alignment is a decision to be made deliberately, not drifted into.

## Layout

A three-pane desktop shell: account rail and folder sidebar on the left, virtualized message list in the middle, reading pane on the right. Panes are divided by 1px hairlines, never by gaps or shadows.

- **Rhythm:** an 8px base. `gap-2` (8px) is the default separation between adjacent controls, `gap-1` (4px) inside a control, `gap-3` (12px) between groups. Panel padding is 20px (`p-5`) or 16px (`p-4`); dialog padding is 24px (`p-6`).
- **Rows:** 56px comfortable, 52px compact, set as a user density preference. Chat sender rows 56px, topic rows 52px, nested message rows 44px. Rows are absolutely positioned inside a virtualizer (`contain: content`), so nothing in a row may change its height in response to state.
- **Dialogs:** `max-w-md` (448px) for confirmations, 480px for forms, `max-w-[92vw]` as the small-window floor. Centered, over a `black/50` scrim with `backdrop-blur-sm`.
- **Message list width:** the reading pane must survive hostile HTML mail — every column in the chain carries `min-w-0` so a wide DMARC report or a fixed-width newsletter cannot push the app sideways.
- **Responsive:** this is a resizable desktop window, not a breakpoint system. Layout adapts by pane collapse and truncation, and `truncate` is `overflow: clip` (not `hidden`) so a clipped subject can never become a silently scrolled one.

### Named Rules
**The Fixed Row Rule.** Row height is a constant the virtualizer knows. A state change may swap a glyph, a colour or a weight — never a size, a wrap, or a margin.

## Elevation & Depth

**This system conveys depth with tone and hairline, not with shadow.** Three ink steps (ground `#0a0a0f` → surface `#12121a` → raised `#1a1a25`) plus a 1px `border` hairline carry every layer in the app: sidebar over ground, unread row over read row, hover over rest, popover over panel. There is no ambient shadow vocabulary, and none should be introduced.

Overlays separate from the page by *scrim*, not by lift: a `black/50` backdrop with `backdrop-blur-sm` puts the app behind glass while the dialog itself sits on the plain ground colour with one hairline border.

**Known drift to remove, not to copy:** the current code still carries `shadow-2xl`/`shadow-xl`/`shadow-lg` on roughly 58 elements (dialogs, popovers, toasts), an indigo `shadow-glow` (`0 0 20px rgba(99,102,241,0.3)`), and a `.glass` treatment (`rgba(18,18,26,0.8)` + `blur(12px)`). Those predate this rule. New work must not add to them, and a cleanup pass should replace each with a hairline-plus-scrim treatment.

### Named Rules
**The No-Shadow Rule.** Depth is tone and hairline. If an element needs to read as "above", raise its ink one step and give it a 1px border — do not reach for a box-shadow, a glow, or a blur.

## Shapes

Soft-but-not-rounded rectangles, with a pill reserved for anything that is a piece of state rather than a place.

- **8px (`rounded-lg`)** is the default corner and by far the most used (403 occurrences): buttons, inputs, icon hit-areas, list-adjacent panels, hover fills.
- **12px (`rounded-lg` token, `rounded-xl` in code, 107 occurrences)** for containers that hold other components: settings cards, popovers, form panels.
- **16px (`rounded-xl` token, `rounded-2xl` in code)** for centered dialogs only — the largest radius in the system, and its rarity is what makes a dialog read as a dialog.
- **Pill (`rounded-full`, 161 occurrences)** for folder chips, unread counts, badges, avatars, progress tracks, the backup dot, and toggle knobs. Pill means *state*, rectangle means *place or action*.
- **4px (`rounded-xs`)** only for the custom checkbox.
- **Borders are always 1px** and always `--mail-border`, except the 2px left border that marks a selected row (indigo) and the 2px checkbox stroke. There are no 3px or dashed borders in the system.

### Named Rules
**The Hairline Rule.** Every division in the app is 1px of `--mail-border`. Thicker strokes are reserved for two jobs: marking the selected row (2px indigo, left edge) and drawing the checkbox.

## Components

### Buttons
- **Shape:** 8px corners (`rounded-lg`) on every variant. No pill buttons, no square buttons.
- **Primary:** indigo fill, white text, 14px/600, `8px 16px` padding. Hover moves the fill to `accent-hover`; `transition-colors` only, no transform, no lift.
- **Secondary:** `surface` fill with a 1px hairline, `text` label, 14px/500, `10px 16px`. Hover fills to `surface-hover`. This is the Cancel side of every dialog and outnumbers primary two to one.
- **Destructive:** `danger` fill, white text, same geometry as secondary. Only ever the confirming action in a dialog that names what will be destroyed.
- **Icon (ghost):** transparent, `text-muted` glyph at 14–18px, 8px padding, 8px corners. Hover fills `surface-hover` and lifts the glyph to `text`. This is the default for row and toolbar actions.
- **Disabled:** `opacity-50`, no colour change, cursor unchanged.
- **Focus:** 2px `accent` outline at `2px` offset via `:focus-visible` — never suppressed, never replaced by a colour-only cue.
- **Busy:** a 14px `Loader` icon spinning at 1s linear, inline before the label; the label text stays.

### Chips
- **Folder chips (unified inbox):** pill, `4px 10px`, 12px/500, 1px hairline, transparent fill. Active state fills indigo with a matching indigo border and white text. Names truncate at 140px.
- **Badges and counts:** pill, 10–11px, `accent/15` fill with `accent` text for counts, or a state colour at 10–20% alpha for status.

### Cards / Containers
- **Corner:** 12px.
- **Background:** `surface` on the `bg` ground.
- **Border:** 1px hairline. **Shadow:** none — see Elevation.
- **Padding:** 20px standard (`p-5`), 16px in dense contexts, 24px in dialogs.

### Inputs / Fields
- **Style:** `input-bg` fill (the ground colour in dark, white in light), 1px hairline, 8px corners, `8px 12px` padding, 14px text, `text-muted` placeholder.
- **Focus:** the border becomes `accent` over a 150ms `border-color` transition; some surfaces additionally use a 1px accent ring. Never both a ring and a glow.
- **Checkbox:** 18px, 2px hairline stroke, 4px corners, indigo fill with a white check when checked, indigo border on hover.
- **Toggle:** 44×24px pill track, `border` at rest, `accent` when active, 20px white knob translating 20px over 200ms.
- **Range:** 6px `border` track, 16px indigo thumb, scale-1.1 on hover.

### Navigation
- **Sidebar folder rows:** 8px corners, `8px 6px` padding, 16px glyph + 14px label at `gap-2`. Rest is `text` on transparent; hover fills `surface-hover`; **active is `accent/10` fill with `accent` text and glyph** — the accent tint, not a solid fill, so the list stays quiet.
- **Account rail:** 8px-cornered buttons with a per-account identity colour; the active account is marked by a 2px ring with a 1px offset against the surface, not by a fill.

### Message rows
- Flex row at fixed height, 16px side padding, `gap-3` (comfortable) or `gap-2` (compact), separated by a bottom hairline.
- **Unread:** `surface` fill against the `bg` ground, plus heavier weight. No dot, no size change.
- **Selected:** 2px indigo left border with padding compensated to `14px` so text does not shift.
- **Hover:** `surface-hover` fill, suppressed while the row is selected.

### Chat bubbles
- 12px corners, `8px 12px` padding, 14px text. **Sent** is a deeper indigo than the accent (`chat-sent-bg`) with white text; **received** is `chat-received-bg` with a 1px hairline. The deliberate half-step between the sent bubble and the accent keeps a wall of sent mail from reading as a wall of buttons.

### Message State Glyph — the signature component
The one glyph that says where a message lives, and the reason this palette is restrained.

- **Cloud, Server Blue** — on the server, not in your vault.
- **Drive, Vault Emerald** — saved in your vault.
- **Drive, Only-Copy Amber** — the server no longer has it; this is your only copy.
- **Backup dot:** a 6px pill beside the glyph — filled emerald when a backup drive holds a copy, hollow with a `text-muted` border when the drive is not connected and the answer is unknown.
- **Tooltip:** portals to `<body>` (rows clip their overflow), flips above the anchor within 120px of the window bottom, clamps to a 240px max width against both viewport edges, and always carries two lines: the claim and what it implies ("Your only copy" / "Deleted from the server. Nothing else has it.").

### Motion
Framer Motion, used sparingly and always short. Fades 150–200ms; dialogs scale `0.95 → 1` with opacity; trays and panels use `spring, damping 25, stiffness 300`; spinners are 1s linear infinite; the ambient `pulse-soft` is 2s ease-in-out. Motion never gates an interaction — a click lands on the first frame.

**Gap to close:** no `prefers-reduced-motion` handling exists anywhere in the app. Every animation above should be reduced to an opacity change or removed under that query.

## Do's and Don'ts

### Do:
- **Do** spend indigo on exactly one thing per view — the live, selected, or imminent action (The One Lamp Rule).
- **Do** use emerald / blue / amber only for vault / server / only-copy, and require verified server state before rendering amber (The Proof Rule).
- **Do** build depth from the three ink steps plus a 1px `--mail-border` hairline (The No-Shadow Rule).
- **Do** keep body at 14px and labels at 12px, and express emphasis with weight and colour (The 14/12 Rule).
- **Do** hold row height constant across every state change, and keep `truncate` as `overflow: clip` (The Fixed Row Rule).
- **Do** ship both themes together: any new token needs a `[data-theme="light"]` value in the same commit, and the accent's hover direction reverses between them.
- **Do** carry `min-w-0` down every column of the reading pane so hostile mail cannot widen the app.
- **Do** leave `:focus-visible` at a 2px accent outline with 2px offset on every interactive element.

### Don't:
- **Don't** add a box-shadow, glow, or `.glass` blur to anything new — the 58 that exist are drift, not precedent.
- **Don't** introduce a second accent, a gradient fill, or a brand colour beyond the account identity palette.
- **Don't** reuse emerald, blue, or amber for decoration, category colour, or generic status.
- **Don't** use size for emphasis, or let any prose fall below 11px.
- **Don't** animate anything that delays interaction, or add a transition longer than 300ms.
- **Don't** put a pill on an action or a rectangle on a piece of state.
- **Don't** import the marketing site's Inter, hero gradients, or illustration style into the client — the two surfaces share the indigo and nothing else.
- **Don't** let a resting window look busy: if three elements are competing for attention, two are wrong.
