# Homepage acquisition review

## Approved release — 22 September 2026

The user approved the English preview and authorized localization and deployment.
Terra implements; Astra independently verifies. The verified release was prepared on
`codex/homepage-conversion`, based on main `bce79891`. Newer unrelated upstream
work is preserved. Publishing uses the existing website deployment workflow;
production evidence is recorded in the task’s release ledger.

Preview: http://127.0.0.1:3080/ (English and all eight supported locales).
The local review server disables analytics and rejects POST requests. No installer,
newsletter subscription, vote, or checkout was initiated during browser review.

## Changes

The homepage presents the full email client: reading, replying, searching, and
several inbox views, alongside deliberate local archiving. Three real product
examples show inbox views, mismatched web links/sender warnings, and archive state.
Premium features are labeled explicitly; detailed support stories follow product
examples.

The Mac hero resolves to the current trusted GitHub installer. Linux uses the Snap
Store, with adjacent access to other formats. Unsupported devices retain a generic
setup route. Setup puts installer actions before plan instructions, preserving
Free/monthly/yearly intent, trial eligibility, billing, and cancellation language.
Downloading neither starts a trial nor transfers a plan to the desktop app.

Demo Download remains visible on small screens, and tour surfaces use opaque theme
colors. Localized links, billing choices, release status, newsletter feedback, vote
feedback, and accessible language labels retain the chosen language. JS/CSS URLs
are versioned so cached assets do not mask the release.

All eight dictionaries cover the current English corpus. The inherited missing
copy on homepage/setup/pricing was translated as part of this release. Generated
locale pages, sitemap, search indexes, and screenshots use the existing pipeline.
Root `index.html` exactly matches `website/index.html`; its large diff replaces an
outdated legacy copy. No new dependencies, backend/billing changes, or desktop mail
behavior are included.

First-party events are production-only: `home_cta`, `setup_view`, `download_action`,
`demo_open`, `demo_download`, and `demo_tour_start`, with
`page_version: homepage-en-20260922`. Properties identify placement, plan, platform,
and file/store/fallback destinations without user identifiers. The legacy download
counter covers actual installer/store controls, so historical comparisons must
account for that instrumentation change. No app telemetry or user-level attribution
was added.

## Verification

- Independent Astra verification passed with no remaining P1/P2 findings:
  125 website/demo tests and 23 localization pipeline tests passed.
- All eight locale dictionaries pass 2181/2181. Generated verification passes for
  400 pages, 19760 internal links, and 2744 responsive image references.
- English-equal placeholder translations were corrected and independently
  rechecked; all homepage/setup runtime messages are translated. The 256 translated
  acquisition markup blocks preserve tags, links, and required attributes.
- Demo and CSS builds passed. Root/homepage equality and whitespace checks passed.
- English homepage/setup and demo were checked at desktop, 390px, and 320px widths
  in both themes. Download controls stayed visible; screenshot dialogs supported
  Escape and restored focus. Opaque demo tour surfaces were independently checked.
- Japanese, German, and French homepage/setup passed actual nested viewport checks
  at 1280, 390, and 320px, with no horizontal overflow. Translated CTA and language
  labels remained readable. These retain the browser's desktop user agent;
  physical-device installation was not tested. Platform routing has focused tests.
- A hermetic test against the actual public analytics script confirmed exactly one
  `setup_view` after initialization, with localized path, selected plan, and release
  marker. It sent no production analytics.
- Local preview screenshot aliases use existing published assets. Deployment
  regenerates all 36 localized preview images through the normal CI workflow.

Final browser review also verified Portuguese homepage/yearly setup and the
corrected French help copy. Production verification is recorded in the task’s
publishing ledger. This release does not itself establish a conversion improvement;
compare supported-device
cohorts over complete subsequent windows and separate deployment probes from buyers.

## Earlier English reviews — historical

The entries below describe earlier work, not this preview's location, current
verification totals, or deployment status. The former September 5 Mac mini preview
at `192.168.68.64:3080` is not the current review target.

## Studio branding and sharing card

Graphic Meat's stepped line motif appears in indigo beneath the English header
and at the homepage pricing boundary. The studio credit near the footer uses the
existing Graphic Meat logo and red line. The header links to the parent studio.

English pages reference `/assets/og-mailvault-en-v2.png` (1200×630), while existing
localized pages retain their previous share asset. Regenerate the code-defined
card with `node scripts/generate-social-card.mjs`; set SHARP_MODULE to a bundled
sharp installation if sharp is not installed locally. The preview server rewrites
only the new image's origin to its LAN address, so unapproved previews do not fetch
an unavailable asset from production. The public production URLs remain in source.

### Public feedback and contribution examples
The homepage now links guided GitHub issue forms for bug reports and feature requests, with a private contact alternative. Timings are individual examples measured from public discussion timestamps, not service guarantees: 3 September 15:49:37 UTC initial move report to 4 September 13:59:40 UTC v2.11.3 announcement (~22h10m); follow-up at 12:38:47 UTC to announcement (1h21m). Nested-folder request on 1 September 12:20:50 UTC to v2.11.1 announcement on 3 September 09:01:13 UTC (~44h40m). The first bug-fix attempt and continued testing are explicitly acknowledged. Source: discussion 1, comment IDs 18271741, 18288670, 18290423, 18296186, 18233405, 18265086, 18269423. No email addresses copied.

### English-wide visual rollout (feedback refinement)
All 52 English HTML pages now use the reviewed visual direction. The 51 normal pages share the language selector, stepped header line, studio/product footer and base typography; the Yahoo callback retains its redirect behavior with matching colors and a small brand credit. Legacy theme/menu scripts were replaced, while FAQ deep-link forwarding, search, statistics and screenshot scripts were preserved. Content pages use `assets/english-content.css`. `scripts/style-english-pages.py` applies the shared shell to fresh generated English pages; changelog generation invokes it. Existing localized files were not changed.

Feedback now emphasizes exact quote excerpts, author names and initial markers (not invented portraits). Bug/feature examples have compact timing labels with native expandable context. Product icons are linked directly from Graphic Meat: `/assets/photobooks/images/icon.png`, `/assets/meatpad/images/icon.png`, `/assets/mailmule/icon.svg` on https://graphicmeat.com. All three were verified loading in the preview. Browser checks covered desktop feedback, product icons, features, documentation search, mobile articles, dark mode and feedback detail expansion. Both website test files pass (13 tests), including shared-shell and dependency checks across English pages.

### Interactive Premium catalog
Pricing now lists all ten entries from `src/data/premiumFeatures.js` individually. Each link opens its corresponding details, using the English onboarding description and existing screenshot (nine screenshots; the five-device allowance has a simple factual panel). Screenshots use the existing enlargement dialog. `scripts/generate-premium-web.py` regenerates the catalog from app source; the catalog parity test checks completeness and exact descriptions. Browser verified link opening, single expanded feature, screenshot zoom and mobile device allowance. Full website suite: 27 tests passing.

### Stable pricing and pixel-art plan positioning
Initial annotated prices and the currency selector reserve their layout space until the country-based API result is ready. Manual choice renders immediately; Automatic remembers the last resolved currency for failure fallback. The lookup is bounded to four seconds and late responses are ignored after fallback, preventing a second currency flip. No-JavaScript visitors retain static pricing. Added pixel grill/mailbox SVG assets and distinct Free/Early Bird treatments on home and pricing. Manual backups are explicitly promised free forever at the user's direction. EML and Maildir-style portability copy is qualified by client support. Code/market evidence and recommended conversion measures are in `docs/marketing/website-positioning-2026-09-05.md`. Desktop and 320px mobile reviewed; website suite 28 tests passes.

### Final navigation and review updates
Removed the currency selector; pricing uses automatic country detection with a cached fallback. Added flags beside language names and fixed the header line stacking behind dropdowns. Added Blog to desktop/mobile navigation across English pages. Widened Blog and Help directories to the shared 1200px container. Final website suite: 27 tests passing.
