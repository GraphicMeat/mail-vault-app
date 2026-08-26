---
name: MailVault
description: A local-first mail client whose interface is a dark desk — where every saturated colour is a claim about who holds your mail.
colors:
  accent: "#6366f1"
  accent-hover: "#818cf8"
  accent-text: "#a5b4fc"
  accent-fill: "#4f46e5"
  accent-tint: "#262759"
  local: "#10b981"
  local-tint: "#0c3f33"
  server: "#3b82f6"
  server-tint: "#1b3360"
  only-copy: "#fbbf24"
  only-copy-tint: "#4d3d17"
  only-copy-row: "#443516"
  only-copy-row-unread: "#574418"
  only-copy-row-hover: "#614b18"
  bg: "#0a0a12"
  surface: "#15151f"
  surface-hover: "#1e1e2c"
  border: "#2e2e45"
  border-strong: "#5f5f8a"
  input-bg: "#0a0a12"
  text: "#e8e8ef"
  text-muted: "#8b8ba3"
  text-on-tint: "#c9c9d8"
  success: "#22c55e"
  success-tint: "#113e27"
  warning: "#fb923c"
  warning-tint: "#4d301e"
  danger: "#f87171"
  danger-fill: "#dc2626"
  danger-tint: "#4d272d"
  chat-sent-bg: "#4338ca"
  chat-received-bg: "#1e1e2c"
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
    backgroundColor: "{colors.accent-fill}"
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
    backgroundColor: "{colors.danger-fill}"
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
  chip-custody-local:
    backgroundColor: "{colors.local-tint}"
    textColor: "{colors.local}"
    rounded: "{rounded.sm}"
    size: "20px"
  chip-custody-server:
    backgroundColor: "{colors.server-tint}"
    textColor: "{colors.server}"
    rounded: "{rounded.sm}"
    size: "20px"
  chip-custody-only-copy:
    backgroundColor: "{colors.only-copy-tint}"
    textColor: "{colors.only-copy}"
    rounded: "{rounded.sm}"
    size: "20px"
  band-custody-only-copy:
    backgroundColor: "{colors.only-copy-tint}"
    textColor: "{colors.text-on-tint}"
    typography: "{typography.label}"
    padding: "6px 12px"
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
  row-email-only-copy:
    backgroundColor: "{colors.only-copy-row}"
    textColor: "{colors.text}"
    height: "56px"
  row-email-only-copy-unread:
    backgroundColor: "{colors.only-copy-row-unread}"
    textColor: "{colors.text}"
    height: "56px"
  row-email-only-copy-hover:
    backgroundColor: "{colors.only-copy-row-hover}"
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

MailVault is a dark room with one lamp on it and four things on the desk worth looking at. The ground is near-black with a blue cast (`bg`), surfaces step up from it in barely-there increments, and the saturated colour that survives on that field is doing exactly one job: telling you who holds a copy of your mail. People sit in this app for hours, moving thousands of messages between a server they do not control and a vault they do — the interface has to stay legible at 2am and has to answer *where does this live* before anyone reads a word.

Colour here is a claim, not decoration. Four named roles carry the whole system: **Vault Emerald** says the message is on your disk, **Server Blue** says it is on someone else's machine, **Only-Copy Gold** says the server no longer has it and this file is all that is left, and **Desk Lamp Indigo** marks the live thing — what is selected, focused, or about to happen. Each role owns a solid tint surface, so a custody chip, a washed row and a reading-pane band can all state the same claim at three different scales without any of them being a guess about what is behind it. Status colours (green, orange, red) exist alongside and are deliberately outside that vocabulary; they describe an *operation*, never a location.

Density is deliberate and high. Rows are 56px (52px compact), body text is 14px, labels 12px, and the list stays smooth past 17,000 messages. This is a working instrument, not a showcase: nothing decorative, nothing that costs a frame in a virtualized scroll, nothing that makes a person hunt for the state of their own archive. The one derived fill in the entire system is the per-account identity wash, and only because the user picks that colour and no token can precompute it.

It is explicitly **not** webmail (no promo chrome, no tabbed inbox, no Material bounce), **not** a consumer Electron app (no gradient hero buttons, no illustrations, no mascots), and **not** backup-utility grey (progress bars are not a personality).

**Key Characteristics:**
- Dark-first: `[data-theme="dark"]` is `:root`; light is a full, equal second theme, not an afterthought. `darkMode` is bound to `[data-theme="dark"]`, never to the OS.
- Four named colour roles — vault, server, only-copy, live — and every saturated hue on screen is one of them.
- Every role owns a **solid** tint surface. No stacked alpha for a custody claim: text contrast on a tint is a fixed number, not whatever happened to be behind it.
- Depth by tone and hairline, not by shadow.
- 14px body, 12px label, 8px rhythm; high information density at rest.
- Motion is short and functional: 150–200ms fades, spring-eased overlays, and `prefers-reduced-motion` is honoured in both CSS and Framer Motion.

## Colors

An indigo-cast near-black field carrying four named roles, each with a solid tint surface, plus a separate status vocabulary that is never allowed to mean custody. Values in the frontmatter are the dark theme (`:root` / `[data-theme="dark"]`); the light theme redefines every one of the same token names in `src/styles/index.css` and is equally normative.

### Primary
- **Desk Lamp Indigo** (`accent`): the live thing. Active folder, focus ring, selection highlight, control borders, the 2px left edge on a selected row, the checkbox and toggle fills. It splits three ways for contrast and the split is load-bearing: `accent` is the *identity* value (rings, borders, tints, edges), `accent-text` is indigo **as text or an icon** on a dark surface (9.09:1 on `surface`), and `accent-fill` is indigo **as a filled control under white text** (6.29:1 against white). `accent-hover` is the hover pair for both fills. In light theme `accent-text` deepens to the same value as `accent-hover` so it survives a white ground.

### Secondary — the custody vocabulary
- **Vault Emerald** (`local`): the message is in your vault, on your disk. `HardDrive` glyph, the filled backup dot, archive affordances, the fill of the custody meter.
- **Server Blue** (`server`): the message is on the server and only there. `Cloud` glyph, and the track of the custody meter — the track *is* the server side of the claim, so it is mixed to 45% against the surface rather than left at its tint, where it vanished.
- **Only-Copy Gold** (`only-copy`): the server no longer has this message. `CloudOff` glyph — its own shape, not the vault's, because emerald and gold converge under deuteranopia and the tooltip is hover/focus-only. This is the loudest claim the UI can make and it requires proof (see The Proof Rule).

Each of the three owns a tint (`local-tint`, `server-tint`, `only-copy-tint`) used by the 20×20 custody chip and by the reading pane's custody band. Only-copy additionally owns a **three-value row wash** — `only-copy-row`, `only-copy-row-unread`, `only-copy-row-hover` — because a row has three states and an alarm that vanishes under the cursor is not an alarm.

### Tertiary — status, never custody
- **Confirm Green** (`success`) for a completed operation, **Caution Orange** (`warning`) for degraded, rate-limited, unverified or quota conditions, **Destructive Red** (`danger` as text/icon at 6.55:1, `danger-fill` under white at 4.83:1). Each has a solid tint. Orange was deliberately re-cut from the old amber precisely so that it could never be mistaken for the only-copy claim it used to carry.

### Neutral — the Midnight Ink family
- **Midnight Ink** (`bg`): the window ground, and the inside of text inputs (`input-bg` is the same value in dark) so fields read as cut into the desk rather than raised off it.
- **Ink Surface** (`surface`): panels, sidebars, unread rows, settings cards — one step up from the ground.
- **Ink Raised** (`surface-hover`): hover fills, code blocks, secondary chips — one step above that. This is the bar every tint has to beat.
- **Hairline** (`border`): the structural division between panes, rows and panels. Always 1px.
- **Control Boundary** (`border-strong`): the *only* other stroke colour, at 3.01:1 on `surface` (3.51:1 in light) so an unchecked checkbox and an off toggle are perceivable controls rather than suggestions.
- **Paper** (`text`) and **Half-Light** (`text-muted`): primary and secondary text; muted also carries every icon at rest.
- **Ink on Tint** (`text-on-tint`): secondary text on *any* tinted surface. Grey muted falls to ~3.17:1 on the raised tints, and grey on a coloured surface is wrong regardless.

### Named Rules

**The Four Roles Rule.** Saturated colour on this field means one of four things: in your vault (emerald), on the server (blue), nowhere but here (gold), or live right now (indigo). A fifth saturated hue does not get invented — it gets argued for as a fifth role or it stays `text-muted`.

**The Proof Rule.** Gold is a claim about the *server*, so it may only render when server state was actually verified: `describeMessageState` requires `source === 'local-only' && serverKnown`. Absence of local knowledge is not proof of server absence; render the calm vault state and say "Server copy not verified yet" in the tooltip. This rule is the reason an account switch no longer flashes "deleted from server" across the whole list.

**The One Claim Rule.** `describeMessageState` in `src/components/email/MessageStateIcon.jsx` is the *single* source of a custody claim. The row chip, the row wash (`EmailRow.jsx`), the tooltip, and the reading-pane band (`EmailViewer.jsx`, `data-testid="email-custody-band"`) all call it and all read the message's own `isArchived` / `source`. Nothing may derive custody from a store set, a selection field, or a local boolean — two carriers of the same provenance is two claims, and they will contradict each other on screen. (They did: the band read `selectedEmailSource`, whose contract silently includes `'header-only'` as a *loading* state, and rendered "Saved in your vault" over a row whose own glyph said "your only copy".)

**The Solid Tint Rule.** Every custody and status surface is a precomputed solid, never alpha over an unknown ground, so the text contrast on it is a fixed number. Each tint must also clear `surface-hover` by a visible margin — plain hover measures 1.10:1 against `surface`, and at their first values the tints measured 1.06–1.17:1, which made "where your mail lives" indistinguishable from "the mouse is here". The thinnest margin in the shipped set is `accent-tint` at 1.19:1; the custody three sit at 1.32–1.56:1.

**The Status-Is-Not-Custody Rule.** Green, orange and red describe an *operation* — it finished, it is degraded, it will destroy something. They never describe where a message lives, and the custody three never describe an operation.

### Open Decision — the hue collision, unresolved on purpose

Vault Emerald (`#10b981`) and Confirm Green (`#22c55e`) are **1.11:1** apart in the dark theme (1.08:1 in light). Only-Copy Gold (`#fbbf24`) and Caution Orange (`#fb923c`) are **1.36:1** apart (1.07:1 in light). They are near-indistinguishable as hues, and they **co-occur**: `Sidebar.jsx` puts a green `CheckCircle2` / orange `AlertCircle` backup indicator on the same account row that the identity spine and vault language sit on, and `settings/BackupVerificationTree.jsx` renders `bg-mail-local-tint text-mail-local` for a complete branch directly beside `text-mail-success` and `bg-mail-warning-tint text-mail-warning` for an incomplete one.

"Status is never custody" is currently enforced by **rule, by context, and by the distinct glyph** — not by hue. That is a deliberate position, not an oversight: separating the pairs by hue would mean either moving the vault off emerald (the colour the website also teaches) or moving success off green (the one convention every user already has). This is recorded so nobody later mistakes it for a defect and silently "fixes" it, and so nobody assumes the collision was never measured. Reopening it is a decision, not a cleanup.

### Contrast floors

The palette is checked as a *system*, not colour by colour. Every value must clear all of these:

- Text on its surface ≥ 4.5:1; `text` measures 14.86:1 and `text-muted` 5.45:1 on `surface`.
- A role colour used as an icon **on its own tint** ≥ 3:1 — emerald 4.67:1, blue 3.38:1, gold 6.30:1, indigo 3.10:1.
- `text-on-tint` ≥ 4.5:1 on every tint. **The worst case is the gold hover row, not any flat tint** — 5.08:1 dark, 4.81:1 light. Check it there.
- A filled control's label ≥ 4.5:1: that is what `accent-fill` and `danger-fill` exist for.
- Every tint > plain hover (1.10:1) against `surface`.

**Known drift to remove, not to copy:** two call sites still put white text on `bg-mail-accent` rather than `bg-mail-accent-fill` (`settings/MailStorageLocation.jsx`, `settings/MigrationSettings.jsx`), which measures 4.47:1 — just under the floor the fill token was cut to guarantee. Separately, `--mail-text-on-tint` has exactly one consumer (the custody band) and the `.border-mail-strong` utility class is declared with zero users, though `--mail-border-strong` itself is live inside `.custom-checkbox` and `.toggle-switch`. The tokens are the system; the coverage is incomplete.

### The account identity colour

An account's identity colour is **not** part of the four roles and is the one place a user picks a hue. `AVATAR_COLORS` in `src/stores/settingsStore.js` is de-conflicted against every reserved value — violet, pink, teal, cyan, lime, slate, fuchsia, rose — precisely because the identity colour is now structural rather than a 7px dot: `Sidebar.jsx` marks the active account with a **3px spine** in that colour over a `color-mix(in srgb, <color> 10%, transparent)` wash of the same colour. An account hashed to emerald would have claimed "in your vault" down the whole rail; one hashed to red would have read as destructive. This wash is the single derived fill in a system of solid tints, and it is derived because the source colour is the user's, so no token can precompute it.

### Surface divergence, recorded not blessed

The marketing site (`index.html`, `website/`) uses **Inter**, not Instrument Sans. The two surfaces now share **the indigo and the custody trio** — and nothing else. The site's `--vault` (`#065f46`) is the same value as the app's light-theme `--mail-local`, deliberately: one emerald across both surfaces. `website/src/tailwind.css` carries `.lamp-text` / `.lamp-bg` as **solid** indigo (the indigo→violet→purple gradient that headlined every page is retired), `.c-vault` / `.c-server` / `.c-onlycopy` to colour custody words inside running copy, and `.custody-rule` — three solid flex fields with a 2px gap, because butted together at 3px tall they read as the gradient this system just removed. **There are zero gradients across app chrome and all 43 built HTML pages.** Any further alignment between the two surfaces is a decision to be made deliberately, not drifted into.

## Typography

**Display / Body Font:** Instrument Sans (fallback `system-ui, sans-serif`), self-hosted as a variable face at weights 400–700 via `src/styles/fonts.css` — no third-party request on launch, and the app's own chrome renders correctly offline.
**Label/Mono Font:** JetBrains Mono (fallback `ui-monospace, SFMono-Regular, monospace`) for message IDs, raw headers, paths, and `.eml` internals. The TipTap editor's own code blocks use the `ui-monospace` stack directly.

**Character:** Instrument Sans is a grotesque with slightly narrow, evenly-weighted letterforms — it holds up at 12px in a dense list, which is most of what this app asks of it. The pairing reads as engineering-adjacent rather than editorial: type is here to be scanned, and the mono is reserved for the moments where the app shows you the actual bytes it stored.

### Hierarchy
- **Display** (700, 1.5rem/24px): app-level titles and onboarding headlines. Rare — six occurrences in the entire client.
- **Headline** (600, 1.25rem/20px): section headers in full-screen surfaces like Settings.
- **Title** (600, 1.125rem/18px): dialog and modal titles, panel headers.
- **Body** (400, 0.875rem/14px, 1.5): the workhorse — subjects, sender names, message text, buttons, inputs. Over 500 usages; if a size is not obviously something else, it is this.
- **Label** (500, 0.75rem/12px): timestamps, folder chips, counts, secondary metadata, custody band text, every icon-adjacent word. Nearly as common as body.
- **Micro** (500, 0.6875rem/11px, and 10px for badge digits): unread counts, state badges, furniture inside dense rows. The floor.
- **Mono** (400, 0.8125rem/13px): raw headers, message IDs, file paths.

### Named Rules

**The 14/12 Rule.** Body is 14px and labels are 12px. Anything bigger is a title and must be one of the three heading roles; anything smaller than 11px is a badge digit, never prose.

**The One Weight Up Rule.** Emphasis comes from weight (500 → 600) and colour (`text-muted` → `text`), never from size. Unread rows go bolder, not larger, so row height never shifts under a sync.

## Layout

A three-pane desktop shell: account rail and folder sidebar on the left, virtualized message list in the middle, reading pane on the right. Panes are divided by 1px hairlines, never by gaps or shadows.

- **Rhythm:** an 8px base. `gap-2` (8px) is the default separation between adjacent controls, `gap-1` (4px) inside a control, `gap-3` (12px) between groups. Panel padding is 20px (`p-5`) or 16px (`p-4`); dialog padding is 24px (`p-6`).
- **Rows:** 56px comfortable, 52px compact, set as a user density preference. Chat sender rows 56px, topic rows 52px, nested message rows 44px. Rows are absolutely positioned inside a virtualizer (`contain: content`), so nothing in a row may change its height in response to state — including the custody wash, which is background-only for exactly this reason.
- **Dialogs:** `max-w-md` (448px) for confirmations, 480px for forms, `max-w-[92vw]` as the small-window floor. Centered, over a `black/50` scrim with `backdrop-blur-sm`.
- **Message list width:** the reading pane must survive hostile HTML mail — every column in the chain carries `min-w-0` so a wide DMARC report or a fixed-width newsletter cannot push the app sideways.
- **Responsive:** this is a resizable desktop window, not a breakpoint system. Layout adapts by pane collapse and truncation, and `truncate` is `overflow: clip` (not `hidden`) so a clipped subject can never become a silently scrolled one.

### Named Rules

**The Fixed Row Rule.** Row height is a constant the virtualizer knows. A state change may swap a glyph, a background, a colour or a weight — never a size, a wrap, or a margin. This is why the loudest claim in the app (only-copy) is delivered as a *background wash* and a fixed 20×20 chip rather than as a banner inside the row.

## Elevation & Depth

**This system conveys depth with tone and hairline, not with shadow.** Three ink steps (ground → surface → raised) plus a 1px `border` hairline carry every layer in the app: sidebar over ground, unread row over read row, hover over rest, popover over panel. There is no ambient shadow vocabulary, and none should be introduced. Custody adds a *fourth* kind of layer that is also not a shadow — a tinted solid — and it reads as "this surface is making a claim", not as "this surface is lifted".

Overlays separate from the page by *scrim*, not by lift: a `black/50` backdrop with `backdrop-blur-sm` puts the app behind glass while the dialog itself sits on the plain ground colour with one hairline border.

**Known drift to remove, not to copy:** the current code still carries `shadow-2xl` (28), `shadow-xl` (16) and `shadow-lg` (14) on 58 elements (dialogs, popovers, toasts), an indigo `shadow-glow` / `shadow-glow-lg` (`0 0 20px rgba(99,102,241,0.3)` and its 40px sibling, 10 uses), and a `.glass` treatment (`rgba(21,21,31,0.86)` + `blur(12px)`). Those predate this rule. New work must not add to them, and a cleanup pass should replace each with a hairline-plus-scrim treatment.

### Named Rules

**The No-Shadow Rule.** Depth is tone and hairline. If an element needs to read as "above", raise its ink one step and give it a 1px border — do not reach for a box-shadow, a glow, or a blur.

## Shapes

Soft-but-not-rounded rectangles, with a pill reserved for anything that is a piece of state rather than a place.

- **8px (`rounded-lg`)** is the default corner and by far the most used (405 occurrences): buttons, inputs, icon hit-areas, list-adjacent panels, hover fills.
- **12px (`rounded-lg` token, `rounded-xl` in code, 107 occurrences)** for containers that hold other components: settings cards, popovers, form panels.
- **16px (`rounded-xl` token, `rounded-2xl` in code, 11 occurrences)** for centered dialogs only — the largest radius in the system, and its rarity is what makes a dialog read as a dialog.
- **Pill (`rounded-full`, 163 occurrences)** for folder chips, unread counts, badges, avatars, progress tracks, the backup dot, the account spine, the custody meter, and toggle knobs. Pill means *state*, rectangle means *place or action*.
- **6px (`rounded-sm` token)** is the custody chip's corner — a fixed 20×20 box, softer than a control and harder than a badge, so it reads as a *field the glyph sits in* rather than as a button.
- **4px (`rounded-xs`)** only for the custom checkbox, and only in CSS.
- **Borders are 1px `--mail-border`**, except three jobs: the 2px indigo left border marking a selected row, the 2px `--mail-border-strong` checkbox stroke, and the 3px account identity spine.

### Named Rules

**The Hairline Rule.** Every structural division in the app is 1px of `--mail-border`. Thicker strokes are reserved for the three jobs above; a control that needs a *perceivable* boundary uses `--mail-border-strong` at 1px, not a thicker hairline.

## Components

### Buttons
- **Shape:** 8px corners (`rounded-lg`) on every variant. No pill buttons, no square buttons.
- **Primary:** `accent-fill` background, white text, 14px/600, `8px 16px` padding. Hover moves the fill to `accent-hover`; `transition-colors` only, no transform, no lift. **White text on a filled control uses `accent-fill`, never `accent`** — that is the entire reason the token is split.
- **Secondary:** `surface` fill with a 1px hairline, `text` label, 14px/500, `10px 16px`. Hover fills to `surface-hover`. This is the Cancel side of every dialog and outnumbers primary two to one.
- **Destructive:** `danger-fill` background with white text, same geometry as secondary; `danger` is the value for destructive *text and icons*. Only ever the confirming action in a dialog that names what will be destroyed.
- **Icon (ghost):** transparent, `text-muted` glyph at 12–18px, 8px padding, 8px corners. Hover fills `surface-hover` and lifts the glyph to `text`. This is the default for row and toolbar actions.
- **Disabled:** `opacity-50`, no colour change.
- **Focus:** 2px `accent` outline at 2px offset via `:focus-visible` — never suppressed, never replaced by a colour-only cue.
- **Busy:** a 12–14px `Loader` icon spinning at 1s linear, inline before the label; the label text stays.

### Chips
- **Folder chips (unified inbox):** pill, `4px 10px`, 12px/500, 1px hairline, transparent fill. Active state fills indigo with a matching indigo border and white text. Names truncate at 140px.
- **Custody chip:** the signature — see below.
- **Badges and counts:** pill, 10–11px, `accent/10`–`accent/20` fill with `accent-text`, or a status tint for status.

### Cards / Containers
- **Corner:** 12px. **Background:** `surface` on the `bg` ground. **Border:** 1px hairline. **Shadow:** none — see Elevation. **Padding:** 20px standard (`p-5`), 16px in dense contexts, 24px in dialogs.

### Inputs / Fields
- **Style:** `input-bg` fill (the ground colour in dark, white in light), 1px hairline, 8px corners, `8px 12px` padding, 14px text, `text-muted` placeholder.
- **Focus:** the border becomes `accent` over a 150ms `border-color` transition; some surfaces additionally use a 1px accent ring. Never both a ring and a glow.
- **Checkbox:** 18px, 2px `border-strong` stroke, 4px corners, indigo fill with a white check when checked, indigo border on hover.
- **Toggle:** 44×24px pill track at `border-strong` when off, `accent` when active, 20px white knob translating 20px over 200ms.
- **Range:** 6px `border` track, 16px indigo thumb, scale-1.1 on hover.

### Navigation
- **Sidebar folder rows:** 8px corners, `8px 6px` padding, 16px glyph + 14px label at `gap-2`. Rest is `text` on transparent; hover fills `surface-hover`; **active is `accent/10` fill with `accent-text`** — the accent tint plus the readable accent, not a solid fill, so the list stays quiet and the label still clears 4.5:1.
- **Account rail:** the active account is marked by a **3px spine in its own identity colour** at the rail edge, over a 10% `color-mix` wash of the same colour. Not a generic accent, and not a fill.

### Message rows
- Flex row at fixed height, 16px side padding, `gap-3` (comfortable) or `gap-2` (compact), separated by a bottom hairline.
- **Unread:** `surface` fill against the `bg` ground, plus heavier weight. No dot, no size change.
- **Only-copy:** the whole row ground goes gold — `.row-only-copy`, with `.row-only-copy.row-unread` and `.row-only-copy:hover` overriding it. One property carries all three meanings so none of them can win silently, and hover is *suppressed* for only-copy rows so the wash cannot be replaced by `surface-hover`.
- **Selected:** 2px indigo left border with padding compensated to 14px so text does not shift.
- **Hover:** `surface-hover` fill, suppressed while the row is selected or only-copy.

### Chat bubbles
- 12px corners, `8px 12px` padding, 14px text. **Sent** is a deeper indigo than the accent (`chat-sent-bg`, the same value in both themes) with white text; **received** is `chat-received-bg` with a 1px hairline. The deliberate half-step between the sent bubble and the accent keeps a wall of sent mail from reading as a wall of buttons.

### Custody chip and band — the signature components

The one claim the whole palette exists to make, at three scales.

- **Chip** (`.custody-chip`, rendered by `MessageStateIcon.jsx`): a fixed **20×20** inline-flex box with a 6px radius, tinted by `data-tone` — `local` / `server` / `only-copy` map to the three tints. Inside sits the tone's glyph at 12–14px in the tone's colour, over a 150ms `background-color` transition. Fixed size is not a style choice: it is what lets a state change land inside a virtualized row.
- **Glyph trio:** `Cloud` = on the server, `HardDrive` = in your vault, **`CloudOff`** = your only copy. Gold gets its own shape, not the vault's, so the difference between "safe" and "the last copy in existence" is never carried by hue alone.
- **Backup dot:** a 6px pill overlapping the glyph's corner — filled emerald when a backup drive holds a copy, hollow with a `text-muted` border when the drive is not connected and the answer is unknown.
- **Row wash:** for only-copy only. A 20px chip is not a place to make the loudest claim in the app; the row itself carries it.
- **Band** (`EmailViewer.jsx`, `data-testid="email-custody-band"`): the reading pane opens *under* the claim — a full-width tinted strip with the tone's glyph, the claim in `text` at 12px/500, and the implication in `text-on-tint`. Same words as the chip's tooltip, because both come from `describeMessageState`.
- **Meter** (`.custody-meter`): a 3px pill showing how much of the loaded window is already in the vault. Emerald fill over a track mixed from `server` at 45% — two solid fields, no gradient. It always ships beside its own count text (`"N of M loaded in your vault"`), so the proportion is never colour-only information.
- **Tooltip:** portals to `<body>` (rows clip their overflow), flips above the anchor within 120px of the window bottom, clamps to a 240px max width against both viewport edges, closes on capture-phase scroll, and always carries two lines: the claim and what it implies.

### Motion
Framer Motion under `<MotionConfig reducedMotion="user">`, used sparingly and always short. Fades 150–200ms; dialogs scale `0.95 → 1` with opacity; trays and panels use `spring, damping 25, stiffness 300`; spinners are 1s linear infinite; the ambient `pulse-soft` is 2s ease-in-out. `@media (prefers-reduced-motion: reduce)` collapses every CSS animation and transition to 0.01ms — **except spinners, which keep turning at 1.5s**, because a frozen spinner reads as a hung operation, which is worse than a slow one. Motion never gates an interaction; a click lands on the first frame.

## Do's and Don'ts

### Do:
- **Do** treat every saturated hue as one of the four roles — vault, server, only-copy, live (The Four Roles Rule).
- **Do** route every custody claim through `describeMessageState`, so the chip, the wash, the tooltip and the band can never disagree (The One Claim Rule).
- **Do** require verified server state before rendering gold, and say "not verified yet" when you do not have it (The Proof Rule).
- **Do** define a new tinted surface as a **solid** token, and check it against both its surface and `surface-hover` before shipping it (The Solid Tint Rule).
- **Do** check `text-on-tint` on the gold hover row, not on a flat tint — that is the worst case in the system.
- **Do** use `accent-fill` / `danger-fill` under white text and `accent-text` / `danger` for coloured text and icons.
- **Do** give a custody state its own glyph as well as its own colour, so the claim survives colour-blindness and a missing tooltip.
- **Do** build structural depth from the three ink steps plus a 1px `--mail-border` hairline (The No-Shadow Rule).
- **Do** keep body at 14px and labels at 12px, and express emphasis with weight and colour (The 14/12 Rule).
- **Do** hold row height constant across every state change, and keep `truncate` as `overflow: clip` (The Fixed Row Rule).
- **Do** ship both themes together: any new token needs a `[data-theme="light"]` value in the same commit.
- **Do** carry `min-w-0` down every column of the reading pane so hostile mail cannot widen the app.
- **Do** leave `:focus-visible` at a 2px accent outline with 2px offset on every interactive element.

### Don't:
- **Don't** spend emerald, blue or gold on decoration, category colour, or generic status — and don't spend green, orange or red on where a message lives (The Status-Is-Not-Custody Rule).
- **Don't** carry custody in a second field. A store set, a selection field, or a local boolean beside `describeMessageState` is a second claim, and it will contradict the first.
- **Don't** build a custody or status surface out of stacked alpha; the whole point of the tint tokens is that contrast on them is a fixed number.
- **Don't** add a colour to `AVATAR_COLORS` that collides with `--mail-accent`, `--mail-local`, `--mail-server`, `--mail-only-copy`, `--mail-warning` or `--mail-danger` — the identity colour is structural now.
- **Don't** introduce a gradient anywhere, on either surface. There are currently zero, and the retired site gradient is the reason.
- **Don't** add a box-shadow, glow, or `.glass` blur to anything new — the 58 that exist are drift, not precedent.
- **Don't** put white text on `bg-mail-accent`; that is 4.47:1 and `accent-fill` exists for it.
- **Don't** use size for emphasis, or let any prose fall below 11px.
- **Don't** let a custody state change a row's height, wrap, or margin — background, glyph, colour and weight only.
- **Don't** animate anything that delays interaction, add a transition longer than 300ms, or freeze a spinner under reduced motion.
- **Don't** put a pill on an action or a rectangle on a piece of state.
- **Don't** import the marketing site's Inter, hero styling, or illustration style into the client — the two surfaces share the indigo and the custody trio, and nothing else.
- **Don't** let a resting window look busy: if three elements are competing for attention, two are wrong.
