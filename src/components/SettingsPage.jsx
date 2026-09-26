import React, { useState, useEffect, useId, useRef } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import {
  X,
  Minus,
  User,
  Mail,
  FileText,
  HardDrive,
  Palette,
  ScrollText,
  Shield,
  Clock,
  ArrowLeftRight,
  CreditCard,
  Sparkles,
  Server,
  Settings,
  ChevronLeft,
  Gauge,
  EyeOff,
  Languages,
  Search,
  HardDriveDownload,
  Bot,
  Tag,
  LayoutList,
  Maximize2,
  Usb,
  KeyRound,
  MailX,
  Activity,
} from 'lucide-react';
import { GeneralSettings } from './settings/GeneralSettings';
import { AppearanceSettings } from './settings/AppearanceSettings';
import { AccountSettings } from './settings/AccountSettings';
import { TemplateSettings } from './settings/TemplateSettings';
import { StorageSettings } from './settings/StorageSettings';
import DataUsageSettings from './settings/DataUsageSettings';
import { SecuritySettings } from './settings/SecuritySettings';
import { LogsSettings } from './settings/LogsSettings';
import { HelpSettings } from './settings/HelpSettings';
import BackupSettings from './settings/BackupSettings';
import MigrationSettings from './settings/MigrationSettings.jsx';
import { BillingSettings } from './settings/BillingSettings';
import { AISettings } from './settings/AISettings';
import { DaemonSettings } from './settings/DaemonSettings';
import { TimeCapsuleSettings } from './settings/TimeCapsuleSettings';
import { CleanupView } from './settings/CleanupSettings';
import { TrackerBlockingView } from './settings/TrackerBlockingView';
import { AiProvidersSettings } from './settings/AiProvidersSettings';
import { AutoTagSettings } from './settings/AutoTagSettings';
import { ViewsSettings } from './settings/ViewsSettings';
import { UnsubscribeSettings } from './settings/UnsubscribeSettings';
import { PortableSettings } from './settings/PortableSettings';
import { EncryptionSettings } from './settings/EncryptionSettings';
import { SettingsTabs } from './ui/SettingsTabs';
import { IS_APPSTORE_BUILD } from '../utils/buildFlags';
import { TimeCapsuleView } from './TimeCapsule';
import { useT } from '../i18n/index.js';
import { useUnsavedStore } from '../stores/unsavedStore';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';

const featureTabs = [
  { id: 'cleanup', labelKey: 'settings.tab.cleanup', icon: Sparkles },
  { id: 'time-capsule', labelKey: 'settings.tab.timeCapsule', icon: Clock },
  { id: 'tracking', labelKey: 'settings.tab.tracking', icon: EyeOff },
  { id: 'migration', labelKey: 'settings.tab.migration', icon: ArrowLeftRight },
  { id: 'backup', labelKey: 'settings.tab.backup', icon: HardDriveDownload },
  // Not in the App Store build: a sandboxed store app cannot run from a drive.
  ...(IS_APPSTORE_BUILD ? [] : [{ id: 'portable', labelKey: 'settings.tab.portable', icon: Usb }]),
];

const settingsTabs = [
  { id: 'appearance', labelKey: 'settings.appearance.appearance', descriptionKey: 'settings.navigation.appearanceSummary', icon: Palette },
  { id: 'mail-preferences', labelKey: 'settings.navigation.mailPreferences', descriptionKey: 'settings.navigation.mailPreferencesSummary', icon: Settings },
  { id: 'accounts', labelKey: 'settings.tab.accounts', icon: User },
  { id: 'templates', labelKey: 'settings.tab.templates', icon: FileText },
  { id: 'ai-providers', labelKey: 'settings.tab.aiProviders', icon: Bot },
  { id: 'auto-tags', labelKey: 'autoTag.tabLabel', icon: Tag },
  { id: 'unsubscribe', labelKey: 'unsubscribe.tabLabel', icon: MailX },
  { id: 'views', labelKey: 'views.section', descriptionKey: 'views.explainer', icon: LayoutList },
  { id: 'storage', labelKey: 'settings.tab.storage', icon: HardDrive },
  { id: 'data-usage', labelKey: 'settings.tab.dataUsage', icon: Gauge },
  { id: 'security', labelKey: 'settings.tab.security', icon: Shield },
  { id: 'encryption', labelKey: 'pgp.tab', icon: KeyRound },
  { id: 'billing', labelKey: 'settings.tab.billing', icon: CreditCard },
  { id: 'language', labelKey: 'settings.tab.language', icon: Languages },
];

const systemTabs = [
  { id: 'daemon', labelKey: 'settings.tab.daemon', icon: Server },
  { id: 'logs', labelKey: 'settings.tab.logs', icon: ScrollText },
  { id: 'help', labelKey: 'settings.tab.help', icon: Mail },
];

export const allTabs = [...featureTabs, ...settingsTabs, ...systemTabs];
// Tabs that show account pills and config sub-views
const accountPillTabIds = new Set(['cleanup', 'time-capsule']);

const tabsById = Object.fromEntries(allTabs.map(tab => [tab.id, tab]));
// One nav entry over several pages, shown as tabs. Each page keeps its id as a
// destination: it opens the host with that tab selected.
export const settingsHosts = {
  storage: { labelKey: 'settings.tab.storage', icon: HardDrive, pages: ['storage', 'data-usage'] },
  privacy: { labelKey: 'settings.tab.privacySecurity', icon: Shield, pages: ['security', 'tracking', 'encryption'] },
  diagnostics: { labelKey: 'settings.tab.diagnostics', icon: Activity, pages: ['daemon', 'logs'] },
};
const hostOf = Object.fromEntries(Object.entries(settingsHosts)
  .flatMap(([id, host]) => host.pages.map(page => [page, { id, ...host }])));
const navEntries = ids => ids.map(id => settingsHosts[id] ? { id, ...settingsHosts[id] } : tabsById[id]).filter(Boolean);
const sections = [
  { labelKey: 'settings.navigation.general', ids: ['appearance', 'mail-preferences'] },
  { labelKey: 'settings.navigation.accountsImport', ids: ['accounts', 'templates', 'migration'] },
  { labelKey: 'settings.navigation.organize', ids: ['views', 'auto-tags', 'ai-providers', 'unsubscribe', 'cleanup'] },
  { labelKey: 'settings.navigation.vaultPrivacy', ids: ['storage', 'backup', 'portable', 'time-capsule', 'privacy'] },
].map(section => ({ ...section, tabs: navEntries(section.ids) }));
// Support and system sit apart, pinned under the groups.
const footerTabs = navEntries(['billing', 'diagnostics', 'help']);

// Labels are resolved at render time, so search follows the current language.
// A result points to the same page and section that contain its real control.
// Exported so a guard test can assert every setting label in src/components/settings
// is indexed here (see settingsSearchCoverage.test.jsx).
export const settingSearchGroups = [
  { id: 'appearance', section: 'colors', sectionKey: 'settings.appearance.section.colors', settings: [
    ['settings.appearance.theme', 'theme light dark mode'],
    ['settings.colors.palette', 'palette color colour indigo graphite'],
    ['settings.appearance.emailViewerTheme', 'email message theme light dark background'],
  ] },
  { id: 'appearance', section: 'layout', sectionKey: 'settings.appearance.section.layout', settings: [
    ['workspace.mailExperience', 'mail view email chat'],
    ['workspace.readingPane', 'reading pane layout columns beside below'],
    ['workspace.sidebarLayout', 'sidebar accounts folders split stacked account switcher'],
    ['workspace.backupStatusLocation', 'backup status location indicator icon badge avatar green check info hide hidden sidebar'],
    ['workspace.navigation', 'sidebar navigation folders bubbles list'],
    ['workspace.messageRows', 'message rows density compact single two lines'],
    ['listPreview.title', 'preview snippet excerpt body text lines message list rows'],
  ] },
  { id: 'appearance', section: 'reading', sectionKey: 'settings.appearance.section.reading', settings: [
    ['settings.appearance.threadMode', 'conversation conversations thread threads grouping ungroup'],
    ['settings.appearance.threadSortOrder', 'thread conversation reply sort order newest oldest'],
    ['settings.appearance.signatureDisplay', 'signature reading collapse hide'],
    ['settings.appearance.rowHighlight', 'highlight selection hover pointer'],
    ['settings.appearance.actionButtonStyle', 'toolbar action buttons icons labels'],
  ] },
  { id: 'appearance', section: 'date-time', sectionKey: 'settings.appearance.section.dateTime', settings: [
    ['settings.appearance.dateFormat', 'date format custom regional'],
    ['settings.appearance.timeFormat', 'time format 12 24 hour clock'],
  ] },
  { id: 'appearance', section: 'quick-actions', sectionKey: 'quickActions.title', settings: [
    ['quickActions.layout', 'quick action toolbar button layout inline menu radial favorite order customize appearance'],
    ['quickActions.surface.row', 'list row message thread actions archive move label star'],
    ['quickActions.surface.selection', 'selected bulk toolbar actions delete archive move'],
    ['quickActions.surface.reader', 'reader email toolbar actions reply forward'],
    ['quickActions.scope', 'mailbox account unified search archive explorer scoped per-view reset'],
    ['quickActions.palette', 'neutral semantic custom color color palette'],
  ] },
  { id: 'mail-preferences', section: 'behavior', sectionKey: 'generalSettings.behavior', settings: [
    ['settings.behavior.defaultMail.title', 'default email app mailto links'],
    ['settings.behavior.refreshAppLaunch', 'sync refresh startup launch'],
    ['settings.behavior.autoRefreshInterval', 'sync refresh interval automatic check'],
    ['settings.behavior.autoDownloadAttachments', 'attachments download automatic'],
    ['settings.behavior.sendDelay', 'undo send delay sending'],
    ['settings.behavior.markEmailsRead', 'mark read unread delay'],
    ['settings.behavior.delayBeforeMarkingRead', 'mark read delay seconds'],
    ['settings.behavior.whenAnEmailIsDeleted', 'after delete next email selection'],
    ['settings.behavior.search', 'search history clear'],
    ['settings.behavior.searchHistoryLimit', 'search history limit saved searches'],
    ['settings.behavior.popularFiltersPeriod', 'popular filters history period'],
    ['settings.behavior.numberPopularFiltersShow', 'popular filters number limit'],
    ['settings.behavior.composeOpen.title', 'compose open mode new email window separate popup inline default'],
    ['settings.behavior.confirmBeforeDelete', 'confirm before delete ask skip warning dialog permanently'],
    ['settings.behavior.swipe.title', 'swipe gesture trackpad two finger left right archive snooze'],
    ['settings.behavior.swipe.enabled', 'swipe gesture trackpad two finger enable turn off'],
    ['settings.behavior.swipe.left', 'swipe gesture trackpad two finger left archive delete snooze move read star'],
    ['settings.behavior.swipe.right', 'swipe gesture trackpad two finger right archive delete snooze move read star'],
    ['settings.behavior.updateTrackTitle', 'update updates software nightly stable beta channel track release check version upgrade auto-update sparkle'],
    ['settings.behavior.updateTrackLabel', 'update track nightly stable beta channel choose select'],
    ['settings.behavior.updateTrackCheckNow', 'check for updates now manual update version'],
  ] },
  { id: 'mail-preferences', section: 'fields', sectionKey: 'fields.section', settings: [
    ['fields.section', 'custom fields extra properties per account labels'],
    ['fields.newName', 'add custom field name new field create'],
    ['fields.newKind', 'custom field kind type text number date select'],
    ['fields.copyFrom', 'copy custom fields another account duplicate'],
  ] },
  { id: 'mail-preferences', section: 'notifications', sectionKey: 'settings.notifications.notifications', settings: [
    ['settings.notifications.enableDesktopNotifications', 'notifications alerts desktop'],
    ['settings.notifications.showEmailPreview', 'notification message preview'],
    ['settings.notifications.newEmailSound', 'notification sound chime audio mac preview'],
    ['settings.notifications.perAccountSettings', 'notifications account folders'],
    ['settings.notifications.badge', 'badge dock unread count'],
    ['settings.notifications.showBadgeCount', 'dock badge counter count'],
    ['settings.notifications.badgeShows', 'dock badge unread total messages count'],
    ['settings.notifications.backupNotifications', 'backup notification success failure'],
    ['settings.notifications.notifyWhenBackupCompletes', 'backup notification success complete'],
    ['settings.notifications.notifyWhenBackupFails', 'backup notification failure error'],
    ['settings.notifications.previewSound', 'preview sound play test notification chime'],
    ['notifyPolicy.quietHours.title', 'quiet hours mute silence do not disturb schedule night'],
    ['notifyPolicy.allowlist.title', 'priority senders allowlist important vip always notify'],
    ['notifyPolicy.log.title', 'notification log history recent decisions sent activity'],
  ] },
  { id: 'mail-preferences', section: 'shortcuts', settings: [
    ['shortcuts.keyboardShortcuts', 'keyboard shortcuts hotkeys keys'],
    ['settings.shortcuts.enableKeyboardShortcuts', 'enable disable keyboard shortcuts hotkeys'],
  ] },
  { id: 'accounts', section: 'profile', sectionKey: 'settings.accounts.sectionProfile', settings: [
    ['settings.accounts.displayName', 'name sender from identity'],
    ['settings.accounts.sendMail', 'send as alias address identity'],
    ['settings.accounts.emailSignature', 'signature email sign off footer'],
    ['settings.accounts.enableSignature', 'signature enable toggle on off'],
  ] },
  { id: 'accounts', section: 'connection', sectionKey: 'settings.accounts.sectionConnection', settings: [
    ['settings.accounts.password', 'password update reset authentication login reconnect oauth'],
    ['settings.accounts.mailServer', 'mail server imap smtp connection hostname port'],
    ['settings.accounts.sentFolder', 'sent folder mailbox sent messages'],
  ] },
  { id: 'accounts', section: 'advanced', sectionKey: 'settings.accounts.sectionAdvanced', settings: [
    ['settings.accounts.avatarColor', 'account avatar color colour'],
    ['settings.accounts.accountVisible', 'account visible visibility hidden hide'],
    ['settings.accounts.removeAccount', 'account remove delete disconnect'],
  ] },
  { id: 'accounts', settings: [
    ['settings.transfer.title', 'export import transfer move migrate another computer new mac accounts passwords encrypted file'],
  ] },
  { id: 'views', settings: [
    ['views.section', 'view views saved filter filters smart folder builder preview'],
    ['views.new', 'create new view saved filter'],
    ['views.showTimeline', 'timeline month scrubber view default show edit'],
  ] },
  { id: 'daemon', settings: [
    ['settings.pendingActions.title', 'pending queued unfinished actions delete move flag retry stuck offline queue'],
    ['settings.daemon.alwaysOn.label', 'daemon always on background login item startup launch keep running'],
  ] },
  // Storage has no sections to switch: a result opens the page.
  { id: 'storage', section: 'search-index', sectionKey: 'settings.searchIndex.title', settings: [
    ['settings.searchIndex.bodies', 'search index body bodies message text words find offline'],
    ['settings.searchIndex.attachments', 'search index attachments pdf word excel powerpoint premium'],
    ['settings.searchIndex.imageText', 'search index image text ocr recognize photos scanned premium macos'],
    ['settings.searchIndex.rebuild', 'search index rebuild reindex attachments pdf ocr'],
    ['settings.searchIndex.concurrency', 'search index mailboxes searched at once speed performance concurrency'],
  ] },
  { id: 'storage', settings: [
    ['settings.storage.cacheDuration', 'cache duration local email caching how long keep'],
    ['settings.storage.advancedCustomStorageFolder', 'storage location folder custom move vault where files kept'],
    ['settings.storage.addCleanupRule', 'cleanup rule automatic delete archive old emails age folder schedule'],
    ['settings.storage.storageStatus', 'storage usage space used disk size'],
    ['settings.storage.dangerZone', 'empty vault delete everything reset erase all mail'],
  ] },
  { id: 'security', settings: [
    ['settings.security.linkSafetyScanning', 'security link safety scanning phishing malicious url check'],
    ['settings.security.clickConfirmation', 'security click confirmation links warn before opening'],
  ] },
  { id: 'encryption', settings: [
    ['pgp.keyLabel', 'openpgp pgp gpg gnupg encryption encrypted decrypt secret private key import armored'],
    ['pgp.passphraseLabel', 'openpgp pgp key passphrase password keychain'],
    ['pgp.removeKey', 'openpgp pgp remove delete key'],
  ] },
  { id: 'billing', settings: [
    ['settings.billing.manageSubscription', 'billing subscription manage cancel plan payment'],
    ['settings.billing.devices', 'billing devices premium license manage remove'],
  ] },
  { id: 'templates', settings: [
    ['settings.templates.templateName', 'email template name create new'],
    ['settings.templates.templateBody', 'email template body content text canned response'],
  ] },
  { id: 'appearance', section: 'language', sectionKey: 'settings.tab.language', settings: [
    ['settings.language.report.title', 'translation issue report wrong incorrect language bug'],
  ] },
  { id: 'ai-providers', settings: [
    ['ai.settings.enable', 'ai artificial intelligence enable turn on quick replies compose'],
    ['ai.settings.provider', 'ai provider local ollama endpoint apple intelligence choose'],
    ['ai.settings.endpointUrl', 'ai endpoint url server address ollama openai'],
    ['ai.settings.endpointModel', 'ai model name llama gguf'],
    ['ai.settings.endpointKey', 'ai api key token credential'],
    ['ai.settings.skipPreview', 'ai skip review preview before sending compose reply'],
  ] },
  { id: 'unsubscribe', settings: [
    ['unsubscribe.subscriptions', 'unsubscribe newsletter mailing list one-click stop emails sender subscriptions'],
    ['unsubscribe.history', 'unsubscribe history unsubscribed senders'],
  ] },
  { id: 'auto-tags', settings: [
    ['autoTag.name', 'auto tag rule name'],
    ['autoTag.instruction', 'auto tag rule instruction plain english ai classify'],
    ['autoTag.tag', 'auto tag label apply'],
    ['autoTag.inboxAction', 'auto tag inbox action move archive'],
    ['autoTag.hasAttachments', 'auto tag condition has attachment'],
    ['autoTag.listIdPresent', 'auto tag mailing list header condition'],
    ['autoTag.fromAddress', 'auto tag from address condition sender'],
    ['autoTag.fromDomain', 'auto tag from domain condition sender'],
    ['autoTag.minConfidence', 'auto tag minimum confidence ai threshold'],
    ['autoTag.allowRemote', 'auto tag allow remote ai provider rule'],
    ['autoTag.enabledLabel', 'auto tag rule enabled disabled toggle'],
  ] },
  { id: 'data-usage', settings: [
    ['settings.dataUsage.showUsageHover', 'data usage show hover bandwidth tooltip'],
    ['settings.dataUsage.account.dailyDownloadLimitMb', 'data usage daily download limit mb bandwidth cap'],
    ['settings.dataUsage.account.dailyUploadLimitMb', 'data usage daily upload limit mb bandwidth cap'],
    ['settings.dataUsage.account.warnWhenNearingDailyLimit', 'data usage warn near limit notification'],
    ['settings.dataUsage.account.pauseSyncDailyLimit', 'data usage pause sync stop limit reached'],
  ] },
  { id: 'logs', settings: [
    ['settings.logs.clearLog2', 'clear delete diagnostic logs'],
  ] },
  // Backup's own sub-tabs: section names the one that holds the setting.
  { id: 'backup', section: 'restore', settings: [
    ['settings.backup.restore.exportBackup', 'export backup zip vault download'],
    ['settings.backup.restore.importBackup', 'import backup zip vault restore'],
    ['settings.backup.restore.exportMbox', 'export mbox file standard format'],
    ['settings.backup.restore.importMbox', 'import mbox file standard format'],
  ] },
  { id: 'backup', section: 'config', sectionKey: 'settings.backup.backupSettings', settings: [
    ['settings.mailLocation.whereMailStored', 'storage location where mail stored folder move backup'],
    ['settings.backup.config.whatBackUp', 'backup scope what back up archived all emails'],
  ] },
  { id: 'backup', section: 'schedule', sectionKey: 'settings.backup.backupSchedule', settings: [
    ['settings.backup.schedule.automaticBackup', 'automatic backup schedule enable'],
    ['settings.backup.schedule.backupFrequency', 'backup frequency how often hourly daily weekly'],
    ['settings.backup.schedule.pickHours', 'backup hours pick specific times set hours schedule'],
    ['settings.backup.schedule.mailboxConcurrency', 'backup mailboxes processed at once concurrency speed performance'],
  ] },
  // Cleanup and Time Capsule keep their settings behind the page's own
  // "Settings" sub-view — section: 'config' tells openResult to open it.
  { id: 'cleanup', section: 'config', settings: [
    ['settings.ai.customCategories', 'cleanup custom categories ai classify email rules'],
    ['settings.ai.learnedRules', 'cleanup learned rules ai classify email automatic'],
  ] },
  { id: 'time-capsule', section: 'config', settings: [
    ['settings.timeCapsule.enableAutomaticSnapshots', 'time capsule automatic snapshots enable schedule frequency daily weekly'],
  ] },
  { id: 'tracking', settings: [
    ['settings.tracking.blockTrackingPixels', 'block tracking pixels privacy read receipts spy'],
  ] },
  { id: 'migration', settings: [
    ['settings.migration.selectSourceAccount', 'migrate mailbox move emails between accounts servers'],
    ['settings.migration.migrationHistory', 'migration history past migrations log'],
  ] },
  ...(IS_APPSTORE_BUILD ? [] : [{ id: 'portable', settings: [
    ['portable.title', 'portable usb stick external drive run from drive copy take with you'],
    ['portable.copyConfig', 'portable copy accounts settings to drive'],
    ['portable.copyMail', 'portable copy all mail emails to drive'],
    ['portable.removeFromHost', 'portable remove offload delete mail accounts from this computer'],
    ['portable.newPassword', 'portable password passphrase set new'],
    ['settings.transfer.confirmPassword', 'portable password passphrase confirm repeat'],
    ['portable.running.title', 'portable running from drive usb eject lock'],
    ['portable.currentPassword', 'portable password passphrase change current'],
  ] }]),
];

const normalizeTab = tab => tab === 'general' || tab === 'language' ? 'appearance' : tab === 'ai' ? 'cleanup'
  : settingsHosts[tab]?.pages[0] || tab;
const searchText = value => value.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
const settingText = value => value.replace(/\s+/g, ' ').trim();
const CONTROL = 'input, select, textarea, button, [tabindex]';
const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex="0"]';

// Where a searched setting sits on its page: the leaf-most element that reads
// exactly as its label, else the control named by it. Tab rows are page
// navigation, not the setting. Returns the row around it: the nearest
// ancestor that holds a control, so the highlight frames label and control.
function findSettingRow(root, label) {
  const inTabs = el => el.closest('[role="tablist"]');
  const texts = [...root.querySelectorAll('*')].filter(el => !inTabs(el) && settingText(el.textContent) === label);
  const hit = texts.find(el => !texts.some(other => other !== el && el.contains(other)))
    || [...root.querySelectorAll('[aria-label]')].find(el => !inTabs(el) && el.getAttribute('aria-label') === label);
  let row = hit;
  while (row && row !== root && !row.matches(CONTROL) && !row.querySelector(CONTROL)) row = row.parentElement;
  return row === root ? hit : row;
}

export function SettingsPage({ onClose, onAddAccount, onExportAccounts, onImportAccounts, onReportBug, initialTab, initialAccountId, initialSection,
  minimized = false, onMinimize, onDetach, onNavigationLabelChange }) {
  const t = useT();
  const accounts = useAccountStore(s => s.accounts);
  const activeAccountId = useAccountStore(s => s.activeAccountId);

  // Close on Escape — capture phase, and only while this is the top dialog, so
  // a confirmation opened inside Settings peels off first.
  const titleId = useId();

  // Preserve existing menu links while making Appearance a direct destination.
  const resolvedInitialTab = normalizeTab(initialTab);
  const [activeTab, setActiveTab] = useState(allTabs.some(tab => tab.id === resolvedInitialTab) ? resolvedInitialTab : 'appearance');
  const [query, setQuery] = useState('');
  const [appearanceSection, setAppearanceSection] = useState(initialTab === 'language' ? 'language'
    : resolvedInitialTab === 'appearance' ? initialSection || 'colors' : 'colors');
  const [generalSubTab, setGeneralSubTab] = useState(resolvedInitialTab === 'mail-preferences' ? initialSection || 'behavior' : 'behavior');
  const [accountSection, setAccountSection] = useState(resolvedInitialTab === 'accounts' ? initialSection || 'profile' : 'profile');
  const [subView, setSubView] = useState(null); // null = feature view, 'config' = settings sub-view
  const [selectedFeatureAccountId, setSelectedFeatureAccountId] = useState(initialAccountId || activeAccountId || accounts[0]?.id);
  const [featureDetailActive, setFeatureDetailActive] = useState(false);
  const [backupSubTab, setBackupSubTab] = useState(null);
  const contentRef = useRef(null);
  const [searchNavigation, setSearchNavigation] = useState(0);
  const searchTargetRef = useRef(null);

  // The chosen result disappears. Move keyboard focus into its destination,
  // rather than leaving the user on a detached search-result button. A
  // setting result then lands on the setting itself: scrolled to the middle,
  // briefly highlighted, focus on its control. Its section may render a beat
  // later, so watch the pane for a moment; not found, the page stays open.
  useEffect(() => {
    if (!searchNavigation) return;
    const root = contentRef.current;
    const panel = root?.querySelector('[role="tabpanel"]') || root;
    panel?.focus({ preventScroll: true });
    const labelKey = searchTargetRef.current;
    if (!root || !labelKey) return;
    const label = settingText(t(labelKey));
    const land = () => {
      const row = findSettingRow(root, label);
      if (!row) return false;
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      row.scrollIntoView?.({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
      row.classList.add('settings-search-target');
      setTimeout(() => row.classList.remove('settings-search-target'), 1600);
      // Only while focus is still where the search left it: a late landing
      // must not pull focus back from a minimized Settings or another click.
      if (root.contains(document.activeElement)) {
        (row.matches(FOCUSABLE) ? row : row.querySelector(FOCUSABLE))?.focus({ preventScroll: true });
      }
      return true;
    };
    if (land()) return;
    // Land once the pane goes quiet, after the sub-page's own effects (a
    // sub-tab switch scrolls its pane back to the top).
    let settle;
    const observer = new MutationObserver(() => {
      clearTimeout(settle);
      settle = setTimeout(() => { if (land()) stop(); }, 50);
    });
    const timer = setTimeout(() => stop(), 1500);
    function stop() { observer.disconnect(); clearTimeout(timer); clearTimeout(settle); }
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return stop;
    // `t` follows the language; a language change is not a new search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchNavigation]);

  // Reset subView when switching tabs
  const switchTab = (tabId) => {
    // Language became Appearance's last section; its old page id still leads there.
    if (tabId === 'language') setAppearanceSection('language');
    setActiveTab(normalizeTab(tabId));
    setSubView(null);
    setFeatureDetailActive(false);
  };
  /// Every way off a page, or out of Settings, asks first when an editor on it
  /// holds unsaved changes.
  const leave = action => useUnsavedStore.getState().leave(action);
  const handleTabChange = tabId => leave(() => switchTab(tabId));
  const requestClose = () => leave(() => onClose?.());

  // A working Settings session owns its selected account, including while
  // minimized and the user switches mailboxes behind it. Only replace one
  // that is no longer available.
  useEffect(() => {
    setSelectedFeatureAccountId(current => accounts.some(account => account.id === current)
      ? current : accounts.find(account => account.id === initialAccountId)?.id || activeAccountId || accounts[0]?.id);
  }, [accounts, activeAccountId, initialAccountId]);

  const hasAccountPills = accountPillTabIds.has(activeTab);
  const hasConfigSubView = accountPillTabIds.has(activeTab);
  const currentTab = allTabs.find(t => t.id === activeTab);
  const host = hostOf[activeTab];
  const pageTab = host || currentTab;
  const sectionKey = activeTab === 'appearance'
    ? { colors: 'settings.appearance.section.colors', layout: 'settings.appearance.section.layout', reading: 'settings.appearance.section.reading', 'date-time': 'settings.appearance.section.dateTime', 'quick-actions': 'quickActions.title', language: 'settings.tab.language' }[appearanceSection]
    : activeTab === 'mail-preferences'
      ? { behavior: 'generalSettings.behavior', notifications: 'settings.notifications.notifications', shortcuts: 'shortcuts.keyboardShortcuts', fields: 'fields.section' }[generalSubTab]
      : activeTab === 'accounts'
        ? { profile: 'settings.accounts.sectionProfile', connection: 'settings.accounts.sectionConnection', advanced: 'settings.accounts.sectionAdvanced' }[accountSection]
        : host && host.labelKey !== currentTab.labelKey ? currentTab.labelKey : null;
  const navigationLabel = subView === 'config'
    ? t('settingsPage.tabSettings', { tab: currentTab ? t(currentTab.labelKey) : '' })
    : [pageTab && t(pageTab.labelKey), sectionKey && t(sectionKey)].filter(Boolean).join(' · ');
  useEffect(() => { onNavigationLabelChange?.(navigationLabel); }, [navigationLabel, onNavigationLabelChange]);
  const searchPages = [
    ...allTabs,
    // A host's nav name finds it too, unless its first page already has that name.
    ...Object.values(settingsHosts).filter(({ labelKey, pages }) => labelKey !== tabsById[pages[0]].labelKey)
      .map(({ labelKey, icon, pages }) => ({ ...tabsById[pages[0]], labelKey, icon })),
    ...settingSearchGroups.flatMap(group => group.settings.map(([labelKey, keywords]) => ({
      ...tabsById[group.id], ...group, labelKey, keywords,
    }))),
  ];
  const terms = searchText(query.trim()).split(/\s+/).filter(Boolean);
  const results = searchPages.filter(page => {
    const content = searchText([t(page.labelKey), page.sectionKey ? t(page.sectionKey) : '', page.keywords || ''].join(' '));
    return terms.every(term => content.includes(term));
  });
  const openResult = page => leave(() => {
    if (page.id === 'appearance' && page.section) setAppearanceSection(page.section);
    if (page.id === 'mail-preferences' && page.section) setGeneralSubTab(page.section);
    if (page.id === 'accounts' && page.section) setAccountSection(page.section);
    if (page.id === 'backup' && page.section) setBackupSubTab(page.section);
    switchTab(page.id);
    // Cleanup and Time Capsule keep their settings behind the page's own
    // "Settings" sub-view (see subView above) — handleTabChange just reset it.
    if (accountPillTabIds.has(page.id) && page.section === 'config') setSubView('config');
    // Page results have no keywords: they open the page, nothing to land on.
    searchTargetRef.current = page.keywords ? page.labelKey : null;
    setQuery('');
    setSearchNavigation(value => value + 1);
  });
  const renderSearchField = () => (
    <div className="settings-search">
      <Search size={15} aria-hidden="true" />
      <input value={query} onChange={event => setQuery(event.target.value)}
        aria-label={t('settings.navigation.searchSetting')} placeholder={t('settings.navigation.searchSetting')} />
      {query && <Button variant="ghost" icon size="xs" onClick={() => setQuery('')}
        aria-label={t('common.clear')}><X size={14} /></Button>}
    </div>
  );
  const renderResults = () => (
    <>
      <p className="settings-nav-heading" role="status">{t('settings.navigation.results', { count: results.length })}</p>
      {results.map(page => (
        <button key={`${page.id}-${page.section || ''}-${page.labelKey}`} type="button" className="settings-nav-item settings-search-result"
          onClick={() => openResult(page)}>
          <page.icon size={17} aria-hidden="true" />
          <span className="settings-search-result-copy"><span>{t(page.labelKey)}</span>
            {page.section && <small>{t(tabsById[page.id].labelKey)}{page.sectionKey && ` · ${t(page.sectionKey)}`}</small>}
          </span>
        </button>
      ))}
      {results.length === 0 && <p className="px-3 py-2 text-sm text-mail-text-muted">{t('settings.navigation.searchHint')}</p>}
    </>
  );

  const renderNavItem = tab => (
    <button
      key={tab.id}
      onClick={() => handleTabChange(tab.id)}
      aria-current={(host?.id || activeTab) === tab.id ? 'page' : undefined}
      className="settings-nav-item"
    >
      <tab.icon size={17} aria-hidden="true" />
      <span className="text-sm font-medium">{t(tab.labelKey)}</span>
    </button>
  );
  const renderOption = tab => <option key={tab.id} value={tab.id}>{t(tab.labelKey)}</option>;

  const pageContent = (
    <>
      {activeTab === 'cleanup' && (
        subView === 'config'
          ? <AISettings />
          : <CleanupView active={!minimized} accountId={selectedFeatureAccountId} onDetailChange={setFeatureDetailActive} onUpgrade={() => handleTabChange('billing')} />
      )}

      {activeTab === 'time-capsule' && (
        subView === 'config'
          ? <TimeCapsuleSettings />
          : <TimeCapsuleView accountId={selectedFeatureAccountId} onDetailChange={setFeatureDetailActive} onUpgrade={() => handleTabChange('billing')} />
      )}

      {activeTab === 'tracking' && (
        <TrackerBlockingView onUpgrade={() => handleTabChange('billing')} />
      )}

      {activeTab === 'appearance' && (
        <AppearanceSettings initialSection={appearanceSection} onSectionChange={setAppearanceSection} />
      )}

      {activeTab === 'mail-preferences' && (
        <GeneralSettings active={!minimized} initialSubTab={generalSubTab} onSubTabChange={setGeneralSubTab} accounts={accounts} />
      )}

      {activeTab === 'accounts' && (
        <AccountSettings accounts={accounts} onAddAccount={onAddAccount} onExportAccounts={onExportAccounts} onImportAccounts={onImportAccounts} initialAccountId={initialAccountId}
          initialSection={accountSection} onSectionChange={setAccountSection} />
      )}

      {activeTab === 'templates' && (
        <TemplateSettings />
      )}

      {activeTab === 'ai-providers' && (
        <AiProvidersSettings />
      )}

      {activeTab === 'auto-tags' && (
        <AutoTagSettings />
      )}

      {activeTab === 'views' && (
        <ViewsSettings onUpgrade={() => handleTabChange('billing')} />
      )}

      {activeTab === 'unsubscribe' && (
        <UnsubscribeSettings />
      )}

      {activeTab === 'storage' && (
        <StorageSettings accounts={accounts} onUpgrade={() => handleTabChange('billing')} />
      )}

      {activeTab === 'data-usage' && (
        <DataUsageSettings initialAccountId={initialAccountId} />
      )}

      {activeTab === 'portable' && (
        <PortableSettings onUpgrade={() => handleTabChange('billing')} />
      )}

      {activeTab === 'backup' && (
        <BackupSettings initialAccountId={initialAccountId} initialSubTab={backupSubTab} onSubTabChange={setBackupSubTab}
          onUpgrade={() => handleTabChange('billing')} />
      )}

      {activeTab === 'migration' && (
        <MigrationSettings onUpgrade={() => handleTabChange('billing')} />
      )}

      {activeTab === 'daemon' && (
        <DaemonSettings />
      )}

      {activeTab === 'billing' && (
        <BillingSettings onNavigate={handleTabChange} />
      )}

      {activeTab === 'security' && (
        <SecuritySettings />
      )}

      {activeTab === 'encryption' && (
        <EncryptionSettings />
      )}

      {activeTab === 'logs' && (
        <LogsSettings />
      )}

      {activeTab === 'help' && (
        <HelpSettings onClose={requestClose} onReportBug={onReportBug} />
      )}
    </>
  );

  return (
    <Dialog
      open={!minimized}
      keepMounted
      onClose={requestClose}
      size="custom"
      data-testid="settings-page"
      aria-labelledby={titleId}
      className="p-4"
      panelClassName="settings-window"
    >
        {/* Sidebar */}
        <div className="settings-sidebar">
          <div className="settings-sidebar-heading">
            <h2 id={titleId} className="text-lg font-semibold text-mail-text">{t('settingsPage.settings')}</h2>
          </div>
          <nav className="settings-navigation" aria-label={t('settingsPage.settings')}>
            {renderSearchField()}
            <div className="settings-nav-pages">
            {query.trim() ? renderResults() : sections.map((section) => (
              <React.Fragment key={section.labelKey}>
                <p className="settings-nav-heading">{t(section.labelKey)}</p>
                {section.tabs.map(renderNavItem)}
              </React.Fragment>
            ))}
            </div>
            <div className="settings-nav-footer">{footerTabs.map(renderNavItem)}</div>
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="settings-header">
            <div className="settings-header-context flex items-center gap-3 min-w-0">
              {hasConfigSubView && subView === 'config' && (
                <Button variant="ghost" icon size="sm"
                  onClick={() => setSubView(null)}
                  aria-label={t('common.back')}
                >
                  <ChevronLeft size={18} className="text-mail-text-muted" />
                </Button>
              )}
              <div className="settings-header-title min-w-0"><h3 className="text-lg font-semibold text-mail-text truncate">
                {hasConfigSubView && subView === 'config'
                  ? t('settingsPage.tabSettings', { tab: currentTab ? t(currentTab.labelKey) : '' })
                  : (pageTab ? t(pageTab.labelKey) : '')}
              </h3>
              {currentTab?.descriptionKey && <p className="settings-page-description">{t(currentTab.descriptionKey)}</p>}
              </div>
              <div className="settings-mobile-navigation">
                <label className="sr-only" htmlFor={`${titleId}-page`}>{t('settingsPage.settings')}</label>
                <select id={`${titleId}-page`} value={host?.id || activeTab} onChange={event => handleTabChange(event.target.value)}>
                  {sections.map(section => <optgroup key={section.labelKey} label={t(section.labelKey)}>
                    {section.tabs.map(renderOption)}
                  </optgroup>)}
                  {footerTabs.map(renderOption)}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {hasConfigSubView && subView !== 'config' && (
                <Button variant="secondary" size="sm"
                  onClick={() => setSubView('config')}
                  title={t('settingsPage.settings')}
                >
                  <Settings size={18} className="text-mail-text-muted" />
                  <span>{t('settingsPage.settings')}</span>
                </Button>
              )}
              {onMinimize && <Button variant="ghost" icon size="md"
                aria-label={t('settingsPage.minimize')} title={t('settingsPage.minimize')} onClick={onMinimize}>
                <Minus size={20} aria-hidden="true" />
              </Button>}
              {onDetach && <Button variant="ghost" icon size="md" data-testid="settings-detach"
                aria-label={t('settingsPage.detach')} title={t('settingsPage.detach')}
                // The detached window starts fresh: edits here would not follow.
                onClick={() => leave(() => onDetach({ tab: activeTab, accountId: selectedFeatureAccountId,
                  section: activeTab === 'appearance' ? appearanceSection : activeTab === 'mail-preferences' ? generalSubTab : activeTab === 'accounts' ? accountSection : null }))}>
                <Maximize2 size={18} aria-hidden="true" />
              </Button>}
              <Button variant="ghost" icon size="md"
                aria-label={t('common.close')} title={t('common.close')} onClick={requestClose}
              >
                <X size={20} className="text-mail-text-muted" />
              </Button>
            </div>
          </div>

          <div className="settings-mobile-search">
            {renderSearchField()}
            {query.trim() && <div className="settings-mobile-search-results">{renderResults()}</div>}
          </div>

          {/* Account pills for feature tabs */}
          {hasAccountPills && subView !== 'config' && !featureDetailActive && accounts.length > 1 && (
            <div role="group" aria-label={t('settings.accounts.accounts')} className="settings-account-filter">
              {accounts.map(acc => (
                <button
                  key={acc.id}
                  onClick={() => setSelectedFeatureAccountId(acc.id)}
                  aria-pressed={selectedFeatureAccountId === acc.id}
                  className={`px-3 py-1.5 text-xs rounded-full border transition-colors whitespace-nowrap shrink-0 ${
                    selectedFeatureAccountId === acc.id
                      ? 'bg-mail-accent-fill text-white border-mail-accent'
                      : 'border-mail-border text-mail-text-muted hover:border-mail-accent hover:text-mail-text'
                  }`}
                >
                  {acc.email}
                </button>
              ))}
            </div>
          )}

          {/* Content Area */}
          <div key={`${host?.id || activeTab}-${subView || 'main'}`} ref={contentRef} tabIndex={-1} data-testid="settings-content" data-page={activeTab} className={`settings-content flex-1 min-h-0 min-w-0 ${activeTab === 'accounts' || (hasAccountPills && subView !== 'config') ? 'overflow-hidden' : 'overflow-y-auto'}`}>
            {host ? (
              <SettingsTabs tabs={host.pages.map(id => ({ id, label: t(tabsById[id].labelKey) }))} value={activeTab}
                onChange={handleTabChange} label={t(host.labelKey)}>{pageContent}</SettingsTabs>
            ) : pageContent}
          </div>
        </div>
        <UnsavedChangesDialog />
    </Dialog>
  );
}
