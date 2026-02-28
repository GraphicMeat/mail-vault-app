# Thread Readability & Sender Spoofing Check — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make email threads easier to read by collapsing quoted replies and signatures, and add sender verification badges to detect spoofing.

**Applies to:** Both ThreadView (stacked emails) and ChatBubbleView (chat bubbles).

---

## Feature 1: Quote Folding

Quoted reply content is detected and collapsed behind a clickable expander. Users see only the new content by default.

### Detection

**Plain text:**
- Lines starting with `>` (pipe quotes)
- "On [date] [person] wrote:" blocks
- "-------- Original Message --------" delimiters
- Outlook "From: / Sent: / To:" header blocks in body

**HTML (inside iframe):**
- `<blockquote>` elements
- `.gmail_quote` divs
- `#appendonsend` (Outlook)
- `div[class*="moz-cite"]` (Thunderbird)

### UI

A small clickable bar appears where quoted content was: `"..." or "Show quoted text"`. Clicking expands the quoted content inline. Clicking again collapses. Each email in the thread has its own independent toggle. Collapsed by default.

### Implementation

- **HTML emails (iframe):** Inject a JS snippet into the iframe's `srcDoc` that finds quote elements, wraps them in a container with `display:none`, and inserts a toggle button. Keeps it sandboxed.
- **Plain text emails:** Parse the text before rendering, split into "new content" and "quoted content" parts, render the quoted part in a collapsible `<div>`.

---

## Feature 2: Signature Folding

Email signatures are detected and collapsed with a configurable display mode.

### Detection

- RFC standard `-- ` delimiter (dash-dash-space on its own line)
- Mobile signatures: "Sent from my iPhone/iPad/Galaxy/Outlook"
- HTML signature divs: `.gmail_signature`, `.yahoo_signature`, `div[class*="signature"]`, `div[id*="signature"]`
- Outlook separator lines (`_____` or `-----`)
- Common patterns: "Get Outlook for iOS", "This email was sent from..."

### Settings (settingsStore, under Appearance or Reading)

| Setting | Behavior |
|---------|----------|
| **Smart (Default)** | Show signature once per unique sender in a thread. Hash each detected signature (normalized). First occurrence shown inline; subsequent identical signatures from same sender collapsed with "Same signature" indicator. |
| **Always show** | Never collapse signatures |
| **Always hide** | Collapse all signatures behind a toggle |
| **Collapsed with toggle** | All signatures collapsed, each has a "Show signature" expander |

### Implementation

- Signature detection utility extracts and hashes signature content per email.
- Thread-level: track `Map<senderEmail, Set<signatureHash>>` to implement Smart mode.
- HTML emails: inject CSS/JS into iframe to detect and wrap signature elements.
- Plain text emails: split text at signature delimiter, render in collapsible `<div>`.
- Replaces ChatBubbleView's current CSS `display:none` approach (which permanently hides signatures) with the configurable system.

---

## Feature 3: Sender Spoofing Check

Two-layer sender verification with visual badge.

### Layer 1 — Header Mismatch Detection

- Compare `From` address domain vs `Reply-To` domain — flag if different
- Compare `From` domain vs `Return-Path`/`Sender` domain — flag if different

### Layer 2 — Authentication Headers (SPF/DKIM/DMARC)

- Parse the `Authentication-Results` header from the email (added by receiving mail server)
- Extract SPF result (pass/fail/softfail/none)
- Extract DKIM result (pass/fail/none)
- Extract DMARC result (pass/fail/none)
- These headers are already present in .eml files — no external lookups needed

### UI — Badge next to sender name

| State | Icon | Tooltip |
|-------|------|---------|
| All checks pass | Green shield (or nothing — don't clutter) | "Sender verified (SPF, DKIM, DMARC pass)" |
| Reply-To mismatch | Orange warning | "Reply-To address (x@y.com) differs from sender" |
| Auth failure (SPF/DKIM/DMARC fail) | Red warning | "Sender authentication failed — this email may be spoofed" |
| No auth headers available | No icon | Nothing shown — don't alarm when headers are absent |

### Data Flow

- Rust IMAP fetch spec needs to also fetch `Authentication-Results`, `Return-Path`, and `Reply-To` headers (add to `BODY.PEEK[HEADER.FIELDS (...)]`).
- Graph API: request `internetMessageHeaders` (already fetched) — parse from there.
- Frontend parsing utility: small function that extracts and interprets auth results.
- Badge rendered on sender line in ThreadView, ChatBubbleView, and single-email EmailViewer.

---

## Files Likely Affected

- `src/components/EmailViewer.jsx` — ThreadView, ThreadEmailItem, ThreadEmailItemContent
- `src/components/ChatBubbleView.jsx` — MessageBubble content rendering
- `src/utils/emailParser.js` — Quote/signature detection utilities (extend existing)
- `src/stores/settingsStore.js` — Signature display mode setting
- `src/components/SettingsPage.jsx` — UI for signature setting
- `src-tauri/src/imap/mod.rs` — Add auth headers to IMAP fetch spec
- New: `src/utils/senderCheck.js` — SPF/DKIM/DMARC + header mismatch parsing
