// @vitest-environment jsdom
// (SettingsPage.jsx pulls in stores that touch `window` at module load time,
// so this needs jsdom even though the guard itself only reads files with fs.)
//
// Guard against settings search rotting: every setting label rendered by a
// component under src/components/settings must be findable through
// settingSearchGroups in SettingsPage.jsx (or explicitly allowlisted here as
// not a real, independently-searchable setting). This is how the "Software
// updates" row in BehaviorSettings went missing from search in the first
// place — nothing forced someone adding a setting to also index it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allTabs, settingSearchGroups } from '../../SettingsPage';

const settingsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// How a setting's accessible name shows up in this codebase: a component's
// `label`/`aria-label` prop (ToggleSwitch, SettingRow, inputs/selects), a
// plain <label> element wrapping a translated string directly, or a section
// <h4>/<h3> heading (optionally preceded by an icon element) that introduces
// one. Whitespace/self-closing tags (icons) are allowed between the opening
// tag and the {t(...)} call so a multi-line heading like
//   <h4><Download .../>\n  {t('settings.behavior.updateTrackTitle')}</h4>
// still matches — a same-line-only pattern is exactly what let that key (and
// its sibling updateTrackLabel) go unindexed.
const LABEL_PATTERNS = [
  /aria-label=\{t\('([^']+)'\)\}/g,
  /\blabel=\{t\('([^']+)'\)\}/g,
  /<label\b[^>]*>(?:\s|<[^>]*\/>)*\{t\('([^']+)'\)\}/g,
  /<h[34]\b[^>]*>(?:\s|<[^>]*\/>)*\{t\('([^']+)'\)\}/g,
];

// Matched keys that are NOT independently-searchable settings: dialog/section
// headings whose content is already covered by the child settings that
// follow them, duplicate labels for a control already indexed under a
// different key, and incidental chrome (reorder buttons, placeholders,
// decorative list icons). Each has a one-word-ish reason.
const ALLOWLIST = new Set([
  // upsell / explainer / empty-state / error headings — not settings
  'settings.ai.aiFeaturesRequirePremium', 'settings.ai.howEmailCleanupWorks',
  'settings.cleanup.classifyingEmails', 'settings.cleanup.emailCleanupPremiumFeature', 'settings.cleanup.noClassificationsYet',
  'settings.timeCapsule.howTimeCapsuleWorks', 'settings.timeCapsule.timeCapsuleRequiresPremium',
  'settings.tracking.beforeAfter', 'settings.tracking.mail', 'settings.tracking.trackerBlockingPremiumFeature',
  'settings.tracking.whatOnePixelTellsSender', 'settings.tracking.whatTrackingPixelLooksLike',
  'settings.backup.config.cloudBackupsOneTimePurchase', 'settings.backup.config.secondCopyExternalColdStorage',
  'settings.billing.earlyBirdFamilyPricing', 'settings.billing.plansCouldNotLoaded', 'settings.billing.whatSIncluded',
  'settings.migration.reviewMigration', 'settings.migration.selectAll', 'common.premiumFeature',
  'settings.security.howWorks', 'common.noAccountsConfigured', 'settings.storage.security',
  // section headings already covered by their child settings / sectionKey
  'settings.accounts.accountSettings', 'settings.accounts.authentication', 'settings.appearance.dateAndTime',
  'settings.appearance.readingAndConversations', 'settings.colors.title', 'workspace.title',
  'settings.behavior.deleting', 'settings.behavior.emailSync', 'settings.behavior.markRead', 'settings.behavior.sending',
  'settings.storage.localEmailCaching', 'settings.timeCapsule.automaticSnapshots',
  'settings.migration.selectDestinationAccount', 'settings.migration.selectFoldersMigrate',
  'settings.language.title', 'settings.logs.applicationLogs', 'settings.templates.emailTemplates',
  // duplicate labels for a setting already indexed under a different key
  'settings.accounts.signatureContent', 'settings.accounts.newPassword', 'settings.accounts.sentFolder2',
  'settings.backup.account.whatBackUp', 'settings.backup.account.foldersBackUp',
  'email.original.attachments', 'account.emailAddress', 'common.premium', 'settings.billing.monthly', 'settings.billing.yearly',
  'settings.behavior.afterDeleting', 'notifyPolicy.allowlist.placeholder', 'settings.sendAs.sendTest',
  'settings.storage.account', 'settings.storage.action', 'settings.storage.olderThan',
  // generic reused strings, too generic to be a distinguishing search result
  'settings.appearance.custom', 'common.from', 'common.folder', 'workspace.selectMessage',
  'premium.list.included', 'premium.list.locked', 'premium.list.title',
  'settings.accounts.preferences', // SettingsTabs group aria-label, not a setting
  'autoTag.newTagPlaceholder', 'autoTag.resultHeading',
  'fields.moveUp', 'fields.moveDown', 'fields.newOption', 'fields.optionColor',
  'settings.searchIndex.indexing', // progress status text, not a setting
  // page chrome, not settings
  'settingsPage.close', 'settingsPage.restore',
  // already indexed via a top-level tab's own labelKey (also reused as an in-page heading)
  'settings.tab.security', 'settings.tab.backup', 'shortcuts.keyboardShortcuts', 'settings.behavior.search',
  // duplicate heading text for the shortcuts section, already covered by the
  // shortcuts.keyboardShortcuts sectionKey and the enableKeyboardShortcuts entry
  'settings.shortcuts.keyboardShortcuts',
]);

function labelKeysIn(file) {
  const src = fs.readFileSync(path.join(settingsDir, file), 'utf8');
  const keys = new Set();
  for (const re of LABEL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) keys.add(m[1]);
  }
  return keys;
}

const indexed = new Set([
  ...allTabs.map(tab => tab.labelKey),
  ...settingSearchGroups.flatMap(group => [group.sectionKey, ...group.settings.map(([labelKey]) => labelKey)]),
].filter(Boolean));

const files = fs.readdirSync(settingsDir).filter(f => f.endsWith('.jsx'));

describe('settings search coverage', () => {
  for (const file of files) {
    it(`indexes every setting label rendered by ${file}`, () => {
      const missing = [...labelKeysIn(file)].filter(key => !indexed.has(key) && !ALLOWLIST.has(key));
      expect(missing,
        `${file} renders label(s) not findable by settings search. Add each to settingSearchGroups in ` +
        `SettingsPage.jsx, or to the ALLOWLIST above with a reason if it isn't a real, independently-searchable ` +
        `setting: ${missing.join(', ')}`
      ).toEqual([]);
    });
  }
});
