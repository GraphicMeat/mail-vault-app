# English acquisition review

English-only update for human review. Do not rebuild translations until approved.

## Review pages

- Homepage: http://192.168.68.64:3080/
- Pricing: http://192.168.68.64:3080/pricing.html
- Yearly setup: http://192.168.68.64:3080/get-started.html?plan=yearly
- Monthly setup: http://192.168.68.64:3080/get-started.html?plan=monthly

The Mac mini preview uses a separate copy at
`/Users/unicorn/sites/mailvault-english-review-20260905`, served on port 3080.
The PID and log files are in `/Users/unicorn/sites/` with the same prefix.
The server script is `mailvault-english-review-20260905-server.py` there.
To stop this preview, inspect the PID file/process and terminate that process.
No production deployment or desktop application changes were made.

For a local preview from the repository root:

```sh
python3 scripts/preview-website.py --directory website --port 3080
```

The review server rejects form submissions and disables website analytics.
Only public pricing is read from the live API. Release downloads still link to
real public installers. It sends no signup, checkout, or purchase request.

## Implementation

`index.html`, `pricing.html`, and `get-started.html` use the English-only
`assets/english-site.css` and `assets/english-site.js`. The shared compiled CSS,
translated pages, and locale dictionaries are unchanged.

The setup URL preserves free/yearly/monthly intent across refresh and bookmark.
There is no supported billing deep link in the current desktop app, so setup
explicitly directs the visitor to Settings → Billing. Downloading does not start
a trial. Trial eligibility and final charges are confirmed during app checkout.

Currency localization uses the existing pricing-localize.js endpoint contract.
Price elements for both billing periods remain in the DOM so async localization
and period switching work in either order. Failed pricing requests keep USD
fallbacks; failed release requests keep usable GitHub release-page links.

Production counts the existing anonymous pricing_view and download_click events.
Download clicks are counted on actual platform download links on the setup page,
not on the intermediate homepage CTA. Existing backend checkout_created and
sub_activated counters remain unchanged. Historical download comparisons should
account for the former hero handler omission. No user-level attribution or app
telemetry has been introduced.

## Verification

- `npx vitest run website/__tests__/english-acquisition.test.js`
- `node /Users/Rokas/.agents/skills/impeccable/scripts/detect.mjs --json website/index.html website/pricing.html website/get-started.html`
- Browser: desktop and 390×844 mobile, light/dark themes, monthly/yearly handoff,
  actual release URLs, localized prices, mobile menu, screenshot dialog and
  Escape/focus restoration. Width checks at 320, 768, and 1024 pixels found no
  horizontal overflow on setup. Mobile-size checks preserve the browser's desktop
  user agent; physical-device installation was not exercised.

## After approval

Update the localization pipeline's shared navigation to reflect the compact
selector, extract new page copy and interaction strings, translate, and rebuild
locale pages. The new setup page currently exists only in English; its language
menu leads to existing localized homepages until translated setup pages exist.
Rebuild the search index and sitemap as part of that approved publishing pass.
Do not claim automatic desktop plan transfer without implementing and shipping a
supported billing deep link in the app.

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
