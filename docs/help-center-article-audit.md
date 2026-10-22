# Help-center article audit

Reviewed on **2026-10-22** against the checked-out **MailVault 2.20.0** source (`package.json`). Scope: **76 English pages: 8 FAQ topics, 27 guides, 41 blog posts**. This pass changed factual copy on **60 pages**, including structured answers and metadata where the affected statement was present. The help-center shell, media, translated page generation, and build checks are separate work.

This is a source-and-documentation consistency audit, not a new hands-on review of competing products, a live mailbox test, a benchmark rerun, or a legal opinion. It checks the storage, connection, retention, pricing and feature-gate claims described below. “Reviewed; retained” does not certify every numerical claim or every instruction on that page. Historical release architecture, test totals and measured performance remain attributed to their original date, rather than being presented as new 2.20 measurements.

## Main corrections

- Described Maildir as the default and acknowledged optional JMAP storage. The latter keeps raw message blobs and JSON records and deduplicates identical messages. Storage format and account protocol are separate choices.
- Added current IMAP / personal Outlook.com Microsoft Graph / JMAP connection scope; corrected Yahoo app-password advice that contradicted the already-correct body of the Yahoo guide.
- Replaced Yahoo’s obsolete 1 TB allowance with the current official 20 GB figure and a direction to check the account itself.
- Removed obsolete “per account” Premium pricing; current early-access prices are $4/month or $25/year, with up to five installations and eligibility conditions for the first yearly trial. Existing accurate free/Premium distinctions were retained: Archive and separate Delete from Server are free; combined Archive & Delete and Archive, Back up & Delete are Premium.
- Corrected advice that treated background caching as a complete retained archive. Recent caches and Index Only differ from explicit archive/backup; Hoarder is Premium.
- Removed universal file-compatibility and zero-risk deletion guarantees. Corrected folder-path versus filename metadata and the Windows `;2,` filename separator.
- Corrected blanket “nothing leaves this computer” wording to account for provider synchronization and user-selected remote AI or cloud-synchronized folders.
- Corrected the GDPR article’s suggestion that copying a record locally bypasses retention obligations; local copies need the same justified purpose, access controls and deletion rules. Qualified tracking-pixel consent claims for exemptions and transition rules. Distinguished CMS’s 2,685 fines with known amounts/dates from its 3,062 total cases.
- Corrected Microsoft’s pricing article: Business Basic $6 → $7 and Standard $12.50 → $14 in the cited US list table; Premium remains $22. Corrected rollout and standalone Exchange Online Plan 1 scope.
- Marked Notion’s September 2026 export deadline as past, disclosed that the old official guide now redirects, and avoided promising recovery of unexported Mail-only data.
- Marked seven engineering/release posts as historical. Corrected Piler Enterprise’s contact-for-pricing wording and acknowledged Mail Archiver X’s direct MBOX/PDF storage option alongside its database workflow.

## Source evidence

All external pages below were opened or searched through the web tool on **2026-10-22**. Links are primary product documentation, vendor repositories, regulator guidance or the publisher of the cited dataset. Source references in the page register identify the applicable evidence, not a claim that every page used every source.

### Repository evidence

| ID | Source inspected | What it establishes |
| --- | --- | --- |
| S1 | `package.json`; `src-daemon/`; `src/services/ai.js` | Version 2.20.0, Rust daemon, AI processing options and Google-mail on-device restriction. |
| S2 | `src-core/src/jmap_store/mod.rs`; `src/components/settings/StorageFormatSettings.jsx`; `src-core/src/maildir.rs`; `src-daemon/src/backup_zip.rs` | Maildir/JMAP formats, raw `.eml` blobs plus JSON, shared blobs, conversion UI, exported EML and manifest, OS-specific filename syntax. |
| S3 | `src/components/AccountModal.jsx`; `src/components/account/JmapFields.jsx`; `src-core/src/jmap/`; `src-daemon/src/handlers/jmap_bridge.rs`; existing provider FAQ | Account setup, JMAP session discovery, personal Outlook.com Graph branch and IMAP sign-in distinctions. |
| S4 | `src/components/BulkOperationsModal.jsx` (`PREMIUM_ACTIONS`); `src/data/premiumFeatures.js`; `website/pricing.html` | Combined archive/delete gates; scheduled backup, attachment search, Hoarder, migration and other paid capabilities; published early-access pricing and five installations. |
| S5 | `src/stores/settingsStore.js` (`fetchMode`, Hoarder guard, `backupScope`); `src/services/backupScheduler.js` | Default Keep Recent, explicit archive/backup scope, Premium Hoarder, scheduling, daily-limit checkpoints. |
| S6 | `src-tauri/tauri.conf.json`; `src/components/settings/MailStorageLocation.jsx`; `src-tauri/src/backup.rs` | macOS minimum 11.0, configurable working store and separate external-copy/bookmark behavior. |
| S7 | `src/stores/privacyStore.js`; `src/components/privacy/PrivacyModeButton.jsx`; Premium catalog | Privacy mode’s Premium gate without a platform exclusion. Detection/removal wording remains scoped to recognized trackers. |
| S8 | `src-core/src/imap/abd_cmds.rs`; `src-core/src/imap/mod.rs`; bulk-operation confirmation copy | Capability-dependent IMAP deletion and verify-before-delete behavior; no universal UID EXPUNGE guarantee. |
| S9 | `src-daemon/src/search_index.rs` (`search_index_bench_50k_real_parser`); `src-core/src/search_index/`; `src/stores/viewStore.js`; `src-core/src/app_db/views.rs`; `src-daemon/src/insights.rs` | Benchmark fixture exists; local index, three free saved views, header-based Insights. Original timings were not rerun. |

### External evidence

| ID | Primary source | Verification |
| --- | --- | --- |
| E1 | [Yahoo app passwords](https://ca.help.yahoo.com/kb/account/generate-manage-rd-party-passwords-sln15241.html) | Clients without Yahoo’s branded login require an app password; account eligibility is controlled by Yahoo. |
| E2 | [Yahoo Mail Storage FAQ](https://help.yahoo.com/kb/SLN37064.html) | Current free allowance is 20 GB. |
| E3 | [Google data download](https://support.google.com/accounts/answer/3024190?hl=en), [recently deleted account recovery](https://support.google.com/accounts/answer/6236295?hl=en) | Takeout selection/export is distinct from deletion; recently deleted accounts may be recoverable, with no fixed recovery promise. |
| E4 | [CNIL retention periods](https://www.cnil.fr/fr/passer-laction/les-durees-de-conservation-des-donnees), [CNIL tracking-pixel recommendation](https://www.cnil.fr/fr/recommandation-pixel-suivi-courriels), [CNIL FAQ](https://www.cnil.fr/fr/faq-recommandation-pixels-courriers-electroniques), [Garante announcement](https://garanteprivacy.it/home/docweb/-/docweb-display/docweb/10241977) | Purpose-based retention applies to archives; pixel consent has exceptions and transitional rules. EUR-Lex was attempted but returned a bot challenge, so it was not treated as successfully read. |
| E5 | [Apple iCloud IMAP/SMTP settings](https://support.apple.com/en-us/102525) | Manual IMAP app-password route and other supported Apple authorization methods. |
| E6 | [Microsoft 365 Basic](https://www.microsoft.com/en-us/microsoft-365/p/microsoft-365-basic/cfq7ttc0ktxs), [Outlook.com limits](https://support.microsoft.com/en-us/outlook/storage-limits-in-outlook-com) | Basic entitlements; Outlook.com’s separate 15 GB email/5 GB cloud allowances, 100 GB subscriber mailbox, Trash/Junk and over-quota behavior. |
| E7 | [Former Notion shutdown guide](https://www.notion.com/help/notion-mail-inbox-is-going-away-what-to-do-next), [Notion’s indexed official setup notice](https://www.notion.com/vi/help/get-started-with-notion-mail) | Former guide redirects to help home; official indexed notice states September 22, 2026 shutdown. This pass cannot independently verify current recovery of Mail-only data. |
| E8 | [Microsoft pricing announcement](https://www.microsoft.com/en-us/microsoft-365/blog/2025/12/04/advancing-microsoft-365-new-capabilities-and-pricing-update/), [Business plan comparison](https://www.microsoft.com/en-us/microsoft-365/business/microsoft-365-plans-and-pricing), [Exchange entitlement explanation](https://techcommunity.microsoft.com/blog/exchange/understanding-the-new-100-gb-mailbox-entitlement-for-microsoft-365-business-suit/4548243) | Plan-specific pricing, eligible 100 GB suite mailboxes, June–September rollout and separate Plan 1 limit. Pricing announcement redirects to Microsoft’s Copilot blog. |
| E9 | [CNIL backup security](https://www.cnil.fr/fr/securite-sauvegarder) | Encryption, independent storage and restore testing matter; no blanket claim is made about all cloud vendors’ key access. |
| E10 | [CMS report numbers and figures](https://cms.law/en/gbr/publication/gdpr-enforcement-tracker-report/numbers-and-figures/) | March 2026 report cutoff, €6.11 billion, 2,685 fines with amount/date information and 3,062 cases including incomplete entries. These remain report-dated figures, not a fresh live total. |
| E11 | [Piler edition comparison](https://www.mailpiler.org/compare/) | Open Source legal hold/audit/retention features and Enterprise “Contact for pricing”. |
| E12 | [Mail Archiver X product details](https://www.mothsoftware.com/content/content/mailarchiverx.php) | Database archive workflow and direct MBOX/PDF storage/export; a fresh checkout purchase was not tested. |
| E13 | [Google January 2027 transition](https://support.google.com/mail/answer/17101213?hl=en), [Gmailify/POP FAQ](https://support.google.com/mail/answer/16604719?hl=en) | Third-party Send as, Gmailify and external POP-fetch retirement; access to Gmail from external IMAP/POP/API clients remains supported. |
| E14 | [Google Workspace bandwidth limits](https://knowledge.workspace.google.com/admin/gmail/gmail-bandwidth-limits) | Official Workspace bandwidth reference retained; provider limits can change. Consumer-account guarantees are not newly established by this admin document. |
| E15 | [Apple mailbox export](https://support.apple.com/guide/mail/import-or-export-mailboxes-mlhlp1030/mac), [Thunderbird profile export](https://support.mozilla.org/en-US/kb/thunderbird-export) | MBOX export/import route and Thunderbird’s documented 2 GB ZIP limit/manual large-profile copy. |
| E16 | [Canary AI](https://web.canarymail.io/features/ai), [Canary pricing](https://web.canarymail.io/pricing), [eM Client licensing](https://www.emclient.com/licensing?lang=en), [Mailbird Free](https://support.getmailbird.com/hc/en-us/articles/360026807893-Is-Mailbird-free) | Reviewed the linked local/cloud AI, Free/Growth/Pro+, license-use and free-account-limit claims. No independent product use or purchase test. |
| E17 | [Shortwave provider support](https://www.shortwave.com/docs/how-tos/microsoft-outlook-exchange-other-sign-in-support/), [Shortwave pricing](https://www.shortwave.com/pricing/), [Spark pricing](https://sparkmailapp.com/pricing), [Superhuman Mail pricing](https://help.superhuman.com/hc/en-us/articles/46178817646861-Pricing-Plans) | Confirmed the reviewed provider/forwarding restrictions and the quoted plan prices or explicit live-price caveats. |
| E18 | [MailStore Home](https://www.mailstore.com/en/products/mailstore-home/), [MailStore Server](https://www.mailstore.com/en/products/mailstore-server/), [Mail-Archiver README](https://github.com/s1t5/mail-archiver), [Open Archiver README](https://github.com/LogicLabs-OU/OpenArchiver) | Product scope, personal/server distinctions, Mail-Archiver reverse-proxy requirement, Open Archiver ingestion/storage and legal-hold TBD. Not a deployment or compliance certification. |
| E19 | [Google Gmail search announcement](https://workspaceupdates.googleblog.com/2026/09/gmail-searchs-ai-overviews-now-available-globally.html), [Microsoft Q2 2026 email threats](https://www.microsoft.com/en-us/security/blog/2026/07/23/email-threat-landscape-q2-2026-trends-and-insights/) | Linked primary announcements exist and support the dated article topics; no phishing-detection capability is attributed to MailVault. |

## Page-by-page register

Every row below was reviewed on **2026-10-22**. “Default storage” means the targeted Maildir/JMAP qualifier, not a wholesale rewrite.

| English page | Outcome and evidence |
| --- | --- |
| `blog/apple-mail-review-mailvault-comparison.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/best-email-archive-app-for-mac.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/best-email-backup-software-for-mac.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/canary-ai-email-review-mailvault-comparison.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/cloud-backup-vendor-reads-your-email.html` | Local files are not automatically encrypted or uniquely accessible (S2, E9).; Qualify Maildir instructions alongside optional JMAP storage (S2).; Recognize encryption/key ownership (E9).; Remove absolute cloud-readable/local-private claim (E9).; Remove universal file compatibility claim (RFC 5322 and app export docs).; Match metadata to qualified privacy claims (E9).; Cloud backup can remove a failure dependency; access is conditional (E9).; Remove unsupported universal vendor access conclusion (E9). |
| `blog/cloud-vs-local-email-search.html` | Reviewed; no copy change. Retained dated Google rollout, local-search coverage and separate AI-provider discussion (E19, S1/S9). |
| `blog/does-archiving-gmail-free-up-space.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/em-client-review-mailvault-comparison.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/email-insights-who-fills-your-inbox.html` | Reviewed; no copy change. Retained free Insights/Explorer, header-only coverage and Premium cleanup distinctions (S4/S9). |
| `blog/email-provider-not-a-backup.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/email-templates-for-client-replies.html` | Reviewed; no copy change. Retained free named templates and manual placeholder substitution; no new feature claim added (current templates UI/source). |
| `blog/find-emails-you-havent-replied-to.html` | Reviewed; no copy change. Retained three-free-view limit and answered-flag/coverage caveats (S9). |
| `blog/gdpr-fines-indefinite-email-retention.html` | Distinguish permitted preservation from compliance enforcement (E4, S4).; Qualify Maildir instructions alongside optional JMAP storage (S2).; Qualify consent exemptions (E4).; Remove retention-evasion CTA (E4).; Correct local-copy retention loophole and add primary regulator link (E4).; Distinguish fine count from all recorded cases; link report (E10). |
| `blog/gmail-gemini-review-mailvault-comparison.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/gmail-oauth2.html` | Mark release-specific architecture and test counts as historical (S1, S3, S9). |
| `blog/gmail-storage-squeeze.html` | Reviewed; no copy change. Retained as a dated May 2026 report of a limited test, not a current universal 5 GB rule. Its cited reporting was not independently replaced by a new primary rollout announcement (E3 for recovery/inactivity only). |
| `blog/gmail-third-party-changes-2027.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/how-to-check-email-backup.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/how-to-search-thousands-of-emails-fast.html` | Reviewed; no copy change. Retained local coverage, free message search and Premium supported-attachment search distinctions (S4/S5/S9). |
| `blog/how-we-test-mailvault.html` | Mark release-specific architecture and test counts as historical (S1, S3, S9). |
| `blog/leave-email-provider-safely.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/local-email-storage-vs-cloud-email.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/mailbird-review-mailvault-comparison.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/mailvault-240-stability.html` | Mark release-specific architecture and test counts as historical (S1, S3, S9). |
| `blog/mailvault-windows-memory-use.html` | Mark release-specific architecture and test counts as historical (S1, S3, S9). |
| `blog/ms365-100gb-mailbox-price-hike.html` | Correct plan-specific official USD prices and add primary link (E8).; Microsoft Business Premium price unchanged; Basic and Standard differ (E8).; Qualify Maildir instructions alongside optional JMAP storage (S2).; Remove repeated false Premium hike (E8).; Correct rollout scope and distinguish Plan 1 (E8). |
| `blog/notion-mail-closing.html` | Expire countdown without inventing post-shutdown recovery (E7).; Expired shutdown guidance and unavailable former source (E7).; Qualify Maildir instructions alongside optional JMAP storage (S2).; Replace expired action steps with honest current next steps (E7).; Source redirect and historical limitation (E7). |
| `blog/offline-email-search-for-mac.html` | Reviewed; no copy change. Retained explicit offline coverage and cache-versus-archive caveats (S4/S5/S9). |
| `blog/organize-invoice-emails-automatically.html` | Reviewed; no copy change. Retained metadata-only AI-rule scope and three-free-view distinction; not a new model-quality test (S1/S9). |
| `blog/outlook-oauth-odyssey.html` | Mark release-specific architecture and test counts as historical (S1, S3, S9). |
| `blog/outlook-review-mailvault-comparison.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/phishing-beyond-suspicious-links.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/private-email-archive-for-mac.html` | Reviewed; no copy change. Retained local-file access, disk-encryption and cloud-folder caveats (S1/S2/E9). |
| `blog/refactoring-mailvault-from-monolith-to-modules.html` | Mark release-specific architecture and test counts as historical (S1, S3, S9). |
| `blog/sandbox-signing-saga.html` | Mark release-specific architecture and test counts as historical (S1, S3, S9). |
| `blog/search-50000-emails-in-milliseconds.html` | Reviewed; no copy change. Retained dated synthetic warm-cache benchmark and limits. Fixture exists; measurements were not rerun (S9). |
| `blog/shortwave-ai-email-review-mailvault-comparison.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/spark-ai-email-review-mailvault-comparison.html` | Reviewed; no copy change. Retained already-qualified workflow/pricing and model availability claims (S1/S4, E17). |
| `blog/superhuman-ai-email-review-mailvault-comparison.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/thunderbird-review-mailvault-comparison.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `blog/which-personal-emails-should-you-keep.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `faq/backup-and-restore.html` | Archive flags in both formats (S2).; Current transports and default storage (S1–S3). |
| `faq/explorer-and-insights.html` | Reviewed; no copy change. Retained free grouping and header-only Insights coverage (S4/S9). |
| `faq/getting-started.html` | Current transports, explicit retention, optional storage and data-flow scope (S1–S5). |
| `faq/premium.html` | Privacy toggle has no platform gate (S7).; Tracker removal is detection-based, not complete anonymity (S7). |
| `faq/providers.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `faq/scheduled-send.html` | Reviewed; no copy change. Retained Premium exact scheduling, free short delay and background-helper conditions (S4; scheduled worker/source). |
| `faq/storage-and-vault.html` | File compatibility scope (S2).; Qualify default format and compatible readers (S2).; Remove universal file compatibility claim (RFC 5322 and app export docs).; Scope macOS path to build and actual configured location (S6).; Working store may be relocated (S6).; Clarify local storage versus chosen remote services in visible answer and JSON-LD (S1–S3).; Scope colon separator examples to macOS/Linux (S2).; Document Windows semicolon separator (S2). |
| `faq/troubleshooting.html` | Reviewed; no copy change. Retained Workspace bandwidth reference, Linux dictionary dependency and connectivity/folder-refresh explanations. Not a fresh cross-distro or firewall test (E14; spellcheck/network source). |
| `guides/archive-imap-emails-locally.html` | Provider-specific authentication and transports (E1, S3).; Qualify Maildir instructions alongside optional JMAP storage (S2).; Remove universal file compatibility claim (RFC 5322 and app export docs).; Yahoo quota (E2). |
| `guides/back-up-outlook-com-email-to-mac.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `guides/backup-email-before-closing-account.html` | Qualify Maildir instructions alongside optional JMAP storage (S2).; Current transports and authentication (S3). |
| `guides/backup-email-linux.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `guides/backup-gmail-to-eml.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `guides/best-email-archiver-for-mac.html` | Qualify Maildir instructions alongside optional JMAP storage (S2).; Qualify database workflow; vendor also supports direct MBOX/PDF storage (E12). |
| `guides/delete-thousands-of-old-emails-safely.html` | Provider authentication (E1, E5, S3).; Qualify Maildir instructions alongside optional JMAP storage (S2).; Remove zero-risk deletion guarantee (S8). |
| `guides/download-all-emails-mac.html` | Reviewed; no copy change. Retained free Archive versus Premium combined delete and Apple MBOX export steps (S4, E15). |
| `guides/download-all-gmail-emails.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `guides/email-archiving-for-freelancers.html` | Correct mistaken Microsoft-based Google Workspace and protocol scope (S3).; Qualify Maildir instructions alongside optional JMAP storage (S2).; Remove per-account pricing; current plan and eligibility (S4). |
| `guides/email-archiving-for-mac.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `guides/export-icloud-mail.html` | Qualify Maildir instructions alongside optional JMAP storage (S2).; Scope app-password advice to MailVault; other Apple auth exists (E5).; Current Apple manual IMAP route (E5). |
| `guides/export-outlook-to-eml.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `guides/free-up-email-storage.html` | Google Takeout supports label selection (E3).; Qualify Maildir instructions alongside optional JMAP storage (S2).; Remove universal file compatibility claim (RFC 5322 and app export docs).; Separate cache from explicit archive and Hoarder gate (S4–S5). |
| `guides/free-up-space-hotmail-outlook-com.html` | Reviewed; no copy change. Retained accurate free two-step/Premium combined action distinction and Microsoft storage steps (S4/S8, E6). |
| `guides/gmail-storage-full.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `guides/imap-backup-tool-checklist.html` | Correct inverted Yahoo authentication advice (E1).; Qualify Maildir instructions alongside optional JMAP storage (S2).; Remove universal file compatibility claim (RFC 5322 and app export docs).; Yahoo authentication (E1, S3). |
| `guides/keep-emails-after-server-deletion.html` | Correct filename vs folder path metadata (S2).; Do not imply personal archives meet compliance requirements (E4, S4).; Local retention does not bypass company policy (E4).; Remove universal file compatibility claim (RFC 5322 and app export docs).; Remove universal UID EXPUNGE and no-risk claim (S8). |
| `guides/leave-gmail-keep-your-emails.html` | Qualify Maildir instructions alongside optional JMAP storage (S2).; Do not claim deleted accounts are never recoverable (E3).; Qualify account recovery (E3). |
| `guides/linux-email-archive.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `guides/mailstore-alternative-mac.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `guides/mailstore-alternatives-compared.html` | Qualify Maildir instructions alongside optional JMAP storage (S2).; Piler Enterprise comparison says Contact for pricing (E11).; Qualify default database workflow; vendor also supports direct MBOX/PDF storage (E12). |
| `guides/mailstore-server-alternative.html` | Qualify Maildir instructions alongside optional JMAP storage (S2).; Piler Enterprise comparison says Contact for pricing (E11). |
| `guides/outlook-hotmail-mailbox-full.html` | Basic does not bundle desktop Office apps (E6).; Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `guides/outlook-storage-full-what-to-do.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `guides/what-is-an-email-vault.html` | Qualify Maildir instructions alongside optional JMAP storage (S2). |
| `guides/yahoo-mail-backup.html` | Correct current Yahoo quota and rationale (E2).; Distinguish implicit TLS and STARTTLS (E1).; Remove obsolete 1 TB quota; current official quota 20 GB (E2).; Yahoo app-password flow (E1).; Correct contradictory Yahoo FAQ and JSON-LD (E1). |

## Validation and remaining limits

- Parsed **89 JSON-LD blocks across all 76 English pages** after the copy edits; all parsed successfully. This checks syntax, not search-engine eligibility.
- Generated **117 exact normalized translation-unit mappings** and **4 added units** using the site’s own `collect`/`normalize` behavior. Translation followups use new English content hashes. CJK changed spans and sentence-count overrides preserve inline tags and attributes; final locale generation/checks are owned by the parent task.
- Historical test totals, release implementation descriptions, Windows memory measurements and the search benchmark were **not rerun**. Explicit historical notes prevent treating them as fresh 2.20 validation.
- No competing application was installed, purchased, benchmarked or deployed during this audit. Vendor feature claims were checked against the sources identified above. Detailed third-party version numbers, every regional price, every license edge case and every existing article claim were not independently recertified.
- The older Google storage-test post remains an attributed historical report; the current official account-specific quota should govern user decisions. The former Notion export source is no longer directly available, and no promise of post-deadline recovery is made.
- App Store purchasing behavior, every Linux distribution’s dictionary packages, corporate tenant authorization policies, and provider behavior on a live mailbox need environment-specific verification. This audit did not access private mail or change any account.
