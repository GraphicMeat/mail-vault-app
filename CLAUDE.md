# MailVault Local Notes

This file is for local agent guidance and repo-specific working rules. Stable architecture belongs in `architecture.md`.

## Read First

- Read `architecture.md` before making structural changes.
- Treat `README.md` as user-facing product documentation.
- Treat `BUILDING.md` and release scripts as the source for packaging and distribution mechanics, but verify commands against `package.json` before trusting prose docs.

## Current Stack

- Desktop app: Tauri v2 + React + Zustand.
- Daemon: `src-daemon/` sidecar process does the real work (sync, storage, indexing, backup); shared testable logic in `src-core/`.
- Tauri shell: `src-tauri/src/` for windowing, platform integration, and forwarding to the daemon.
- Local storage: Maildir-style `.eml` files plus JSON caches and keychain-backed credentials.
- Website: static pages and website API under `website/`, separate from the desktop runtime.

## Architecture Rule: App Is a Shell

- The Tauri app is a thin shell: UI, windows, native dialogs, OS integration, and RPC to the daemon. Nothing else.
- All heavy logic and actions (IMAP/Graph sync, fetch, delete, backup, archive, indexing, import/export, vault and cache writes) live in the daemon, each long-running job on its own thread/worker so it never blocks RPC handling or other jobs.
- New features go straight into the daemon (logic in `src-core/` where testable). Do not add work to `src-tauri` commands; when touching an existing one that does real work, move it to the daemon rather than extending it.
- The daemon reports progress back via events; the app renders state and never computes it.

## Canonical Commands

- `npm run dev` for web-only development flow.
- `npm run tauri:dev` for the full desktop app in development.
- `npm run tauri:build` for desktop packaging.
- Prefix every test command with `~/.claude/bin/testq` — it queues runs so parallel worktrees of this repo don't fight over ports, the mock IMAP server, and CPU. Each suite gets its own lane, so a different suite in another worktree runs alongside yours and only an identical suite waits; `testq --status` shows the queue.
- `testq`'s lock is keyed on the repo's `.git` dir, which unifies worktrees of this repo automatically but does **not** unify separate e2e runner clones (`~/Repos/mv-*` on the mac mini, made because `tauri-wd` needs a fixed, unique port that a worktree can't give). Two clones running the same suite do not serialize against each other by default. `wdio.conf.js` reads its driver port from `E2E_TAURI_WD_PORT` (default 4444) — set it once per clone instead of sed-ing the literal port in multiple places (a past clone silently inherited another's port this way). When queuing an e2e run on a clone with a non-default port, add `testq --port $E2E_TAURI_WD_PORT ...`: this takes a second, clone-independent lock keyed on the port itself, so any two runs (any clones) claiming the same port always serialize even though their `.git` dirs differ.
- `npm run test` for frontend tests (hermetic — no network, no credentials).
- `npm run test:imap` for the Rust IMAP suites against the mock server in `src-mock-imap`.
- `npm run test:integration` for the JS integration suite against the mock IMAP server (hermetic; replaced the old live-provider suite).
- `npm run test:dmg` for the post-build smoke test of the signed macOS bundle.
- `npm run test:e2e` for end-to-end coverage.
- `bash scripts/bump-version.sh <patch|minor|major>` for version bumps.

## Repo Conventions

- `app.html` is the desktop window entry point.
- Root `package.json` uses `"type": "module"`; Node scripts using `require()` should use `.cjs`.
- `CLAUDE.md` and `architecture.md` are tracked so every worktree gets them.
- Update `architecture.md` when architectural boundaries or core data flow change.
- Do not store secrets, account credentials, provider hostnames, or signing identities in local guidance docs.

## Product and UX Rules

- Prefer resilient behavior over noisy failures.
- Retry transient network and credential operations where appropriate before surfacing errors.
- Avoid writes that can overwrite richer local state with partial state.
- Keep feature parity in mind when changing email indicators, threading metadata, or message detail affordances across multiple views.

## Platform File Access Rules

- Sandboxed macOS builds cannot rely on raw file paths for user-selected external locations. Access is lost after restart unless persisted as a security-scoped bookmark.
- Any feature that persists access to user-chosen files or folders must go through native Rust access management (`external_location.rs` for backup, or equivalent for future features).
- Long-lived file access is a Rust/platform-integration concern. Frontend code must not bypass native authorization or treat a raw path string as proof of access.
- Linux Snap confinement may block writes to paths outside the snap's permitted directories. Always validate actual write access rather than assuming a path is writable.

## Release and Website Rules

- `CHANGELOG.md` is for app changes, not website-only edits.
- New changelog entries belong under `## [Unreleased]`.
- Use the bump-version script for releases instead of hand-editing version files.
- Keep root `index.html` in sync with `website/index.html` when homepage content changes.
- If a change affects product messaging or discoverability, consider whether `README.md`, `website/index.html`, and `website/faq.html` should also be updated.

### Website crawl files (every page added, removed, renamed, or amended)

- `website/sitemap.xml` is generated: run `cd website && node i18n/i18n.mjs build` and commit the result. Never hand-edit it. `noindex` pages are left out automatically; English-only pages to index go in `SITEMAP_EXTRA` in `i18n.mjs`.
- `website/llms.txt` is hand-kept: add the page if it is a product, help, or comparison page, and fix any listed URL, price, platform, or Premium claim the change touched. `seo.test.js` checks every link resolves.
- `website/robots.txt` stays `Allow: /` plus the `Sitemap:` line. Check it whenever a new top-level section or a path that must stay private appears; never block AI or search crawlers without asking Rokas.
- Every page carries the Meatlytics tag exactly like its siblings (`<script defer src="/gm.js?…" data-site="mailvault" data-tag="…">`, copy it from a neighbouring page); `english-acquisition.test.js` checks it. New trackable CTAs follow the existing `data-acquisition-*` attributes.
- Structured data (JSON-LD) claims such as platforms, features, and prices must match the page they sit on. `softwareVersion` and `datePublished` belong to the release tooling.
- A page served at arbitrary URLs (the 404 page) uses root-absolute URLs only, and is `noindex` with no canonical.
- Missing URLs return a real 404 through the Caddy step in `.github/workflows/deploy-website.yml`; a new locale needs its `404.html` and a place in that step's locale list (a test enforces both).

## Maintenance Standard

Update this file only for stable repo-specific guidance. Do not turn it back into a dump of implementation details, hardcoded secrets, or rapidly changing internals.
