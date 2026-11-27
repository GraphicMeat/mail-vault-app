// The settings navigation both apps render: desktop's SettingsPage and the phone's Settings shell
// (src/mobile/Settings.jsx). Pages, the nav sections and footer, hosts (one nav entry over several
// pages, shown as tabs), and the setting search index. Pure: React-free, store-free, so the phone
// bundle can import it (src/mobile/__tests__/seam.test.js).
//
// Every page and every searchable setting carries a phone decision (`MOBILE_PAGES`,
// `MOBILE_SETTINGS`): `true`, `'desktopNotice'` (a page: in the phone's navigation, opening a
// notice that the feature is in MailVault on desktop), or the reason it is not on the phone. A
// reason starting with `engine:` names a feature the phone engine does not have yet (to be built);
// any other reason means the phone does not have it for good (window, tray, dock, keyboard,
// desktop folders, desktop-only features). The parity guard
// (src/mobile/__tests__/settingsParity.test.js) holds every `true` to a label the phone renders.
import {
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
  EyeOff,
  Languages,
  HardDriveDownload,
  Bot,
  Tag,
  LayoutList,
  Usb,
  KeyRound,
  MailX,
  Activity,
  Network,
  Gauge,
} from 'lucide-react';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags';

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
  { id: 'network-activity', labelKey: 'settings.tab.networkActivity', icon: Network },
  { id: 'billing', labelKey: 'settings.tab.billing', icon: CreditCard },
  { id: 'language', labelKey: 'settings.tab.language', icon: Languages },
];

const systemTabs = [
  { id: 'daemon', labelKey: 'settings.tab.daemon', icon: Server },
  { id: 'logs', labelKey: 'settings.tab.logs', icon: ScrollText },
  { id: 'help', labelKey: 'settings.tab.help', icon: Mail },
];

export const allTabs = [...featureTabs, ...settingsTabs, ...systemTabs];
export const tabsById = Object.fromEntries(allTabs.map(tab => [tab.id, tab]));

// One nav entry over several pages, shown as tabs. Each page keeps its id as a
// destination: it opens the host with that tab selected.
export const settingsHosts = {
  storage: { labelKey: 'settings.tab.storage', icon: HardDrive, pages: ['storage', 'data-usage'] },
  privacy: { labelKey: 'settings.tab.privacySecurity', icon: Shield, pages: ['security', 'tracking', 'encryption', 'network-activity'] },
  diagnostics: { labelKey: 'settings.tab.diagnostics', icon: Activity, pages: ['daemon', 'logs'] },
};
export const hostOf = Object.fromEntries(Object.entries(settingsHosts)
  .flatMap(([id, host]) => host.pages.map(page => [page, { id, ...host }])));

/** A nav entry: a host (`{ id, labelKey, icon, pages }`) or a page from `allTabs`. */
export const navEntries = ids => ids.map(id => settingsHosts[id] ? { id, ...settingsHosts[id] } : tabsById[id]).filter(Boolean);
export const settingsSections = [
  { labelKey: 'settings.navigation.general', ids: ['appearance', 'mail-preferences'] },
  { labelKey: 'settings.navigation.accountsImport', ids: ['accounts', 'templates', 'migration'] },
  { labelKey: 'settings.navigation.organize', ids: ['views', 'auto-tags', 'ai-providers', 'unsubscribe', 'cleanup'] },
  { labelKey: 'settings.navigation.vaultPrivacy', ids: ['storage', 'backup', 'portable', 'time-capsule', 'privacy'] },
].map(section => ({ ...section, tabs: navEntries(section.ids) }));
// Support and system sit apart, pinned under the groups.
export const footerIds = ['billing', 'diagnostics', 'help'];
export const footerTabs = navEntries(footerIds);

// The colour tile behind each navigation icon (SettingsNavIcon draws it in both apps). Fixed hues,
// not theme tokens: a tile says "which page", never "where your mail lives", so each keeps clear of
// vault emerald, server blue and only-copy gold in both themes (settingsTileColors.test.js measures
// it) and holds a white glyph at 3:1. The spread is iOS Settings': orange, amber, green (a leaf
// green, not vault emerald), teal, cyan, sky (a deep sky, not server blue), indigo, purple, pink,
// red and gray, and neighbours in one group never share a hue.
const TILE = Object.freeze({
  pink: '#db2777', purple: '#9333ea', indigo: '#4f46e5', sky: '#0369a1', cyan: '#0e7490', teal: '#0f766e',
  green: '#15803d', amber: '#d97706', orange: '#ea580c', red: '#dc2626', gray: '#6b7280',
});
export const SETTINGS_TILE_COLORS = Object.freeze({
  appearance: TILE.pink,
  'mail-preferences': TILE.gray,
  language: TILE.teal,
  accounts: TILE.sky,
  templates: TILE.orange,
  migration: TILE.teal,
  views: TILE.indigo,
  'auto-tags': TILE.amber,
  'ai-providers': TILE.purple,
  unsubscribe: TILE.red,
  cleanup: TILE.cyan,
  storage: TILE.gray,
  'data-usage': TILE.cyan,
  backup: TILE.green,
  portable: TILE.amber,
  'time-capsule': TILE.indigo,
  privacy: TILE.sky,
  security: TILE.sky,
  tracking: TILE.red,
  encryption: TILE.indigo,
  'network-activity': TILE.cyan,
  billing: TILE.green,
  diagnostics: TILE.gray,
  daemon: TILE.gray,
  logs: TILE.gray,
  help: TILE.sky,
});
export const settingsTileColor = id => SETTINGS_TILE_COLORS[id] || TILE.gray;

// Labels are resolved at render time, so search follows the current language.
// A result points to the same page and section that contain its real control.
// A guard test asserts every setting label in src/components/settings is
// indexed here (see settingsSearchCoverage.test.jsx).
export const settingSearchGroups = [
  { id: 'appearance', section: 'colors', sectionKey: 'settings.appearance.section.colors', settings: [
    ['settings.appearance.theme', 'theme light dark mode'],
    ['settings.colors.palette', 'palette color colour indigo graphite teal'],
    ['settings.icons.title', 'app icon dock taskbar purple teal launcher'],
    ['settings.appearance.emailViewerTheme', 'email message theme light dark background'],
  ] },
  { id: 'appearance', section: 'text', sectionKey: 'settings.appearance.section.text', settings: [
    ['settings.text.size', 'text size font size zoom bigger larger smaller scale accessibility'],
    ['settings.text.font', 'font typeface family monospace coding developer dyslexia legibility'],
  ] },
  { id: 'appearance', section: 'layout', sectionKey: 'settings.appearance.section.layout', settings: [
    ['workspace.mailExperience', 'mail view email chat'],
    ['workspace.readingPane', 'reading pane layout columns beside below'],
    ['workspace.sidebarLayout', 'sidebar accounts folders split stacked account switcher'],
    ['workspace.backupStatusLocation', 'backup status location indicator icon badge avatar green check info hide hidden sidebar'],
    ['workspace.navigation', 'sidebar navigation folders bubbles list'],
    ['workspace.messageRows', 'message rows density compact single two lines'],
    ['workspace.listDensity', 'message list rows density compact comfortable spacing dense tight'],
    ['listPreview.title', 'preview snippet excerpt body text lines message list rows'],
    ['workspace.folderIcons', 'folder icons color colorful theme accent drawer sidebar'],
    ['workspace.menuBar', 'menu bar menubar file logs hide linux title bar'],
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
    ['quickActions.presets', 'preset action set gmail outlook thunderbird mailvault default switch from another app'],
    ['quickActions.layout','quick action toolbar button layout inline menu radial favorite order customize appearance'],
    ['quickActions.surface.row', 'list row message thread actions archive move label star'],
    ['quickActions.surface.selection', 'selected bulk toolbar actions delete archive move'],
    ['quickActions.surface.reader', 'reader email toolbar actions reply forward'],
    ['quickActions.scope', 'mailbox account unified search archive explorer scoped per-view reset'],
    ['quickActions.palette', 'neutral semantic custom color color palette'],
  ] },
  { id: 'mail-preferences', section: 'behavior', sectionKey: 'generalSettings.behavior', settings: [
    ['settings.behavior.defaultMail.title', 'default email app mailto links'],
    ['settings.behavior.closeToTray', 'close window quit exit tray keep running background x button'],
    ['settings.behavior.refreshAppLaunch', 'sync refresh startup launch'],
    ['settings.behavior.autoRefreshInterval', 'sync refresh interval automatic check'],
    ['settings.behavior.autoDownloadAttachments', 'attachments download automatic'],
    ['settings.behavior.attachmentReminder', 'attachment reminder forgot missing send'],
    ['settings.behavior.sendDelay', 'undo send delay sending'],
    ['settings.behavior.markEmailsRead', 'mark read unread delay'],
    ['settings.behavior.delayBeforeMarkingRead', 'mark read delay seconds'],
    ['settings.behavior.whenAnEmailIsDeleted', 'after delete next previous unread email selection'],
    ['settings.behavior.afterDeleteSameAccount', 'after delete same account all inboxes unified'],
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
    ['settings.accounts.group', 'personal work study sidebar section'],
    ['settings.accounts.emailSignature', 'signature email sign off footer'],
    ['settings.accounts.enableSignature', 'signature enable toggle on off'],
  ] },
  { id: 'accounts', section: 'aliases', sectionKey: 'settings.accounts.sectionAliases', settings: [
    ['settings.accounts.aliases.listTitle', 'aliases list send as alias address addresses identity from proxy look for find'],
    ['settings.accounts.aliases.addAddress', 'add new alias send as address identity from proxy'],
    ['settings.accounts.aliases.defaultAddress', 'default from send mail as alias address identity sending'],
    ['settings.accounts.aliases.nameLabel', 'alias name display name send as identity from sender proxy'],
  ] },
  { id: 'accounts', section: 'connection', sectionKey: 'settings.accounts.sectionConnection', settings: [
    ['settings.accounts.password', 'password update reset authentication login reconnect oauth'],
    ['googleClient.settingsLabel', 'google gmail sign in sign-in app client thunderbird mailvault own oauth verification switch reconnect'],
    ['account.msTransport', 'microsoft outlook hotmail office 365 graph imap connect over transport switch protocol'],
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
    ['settings.storage.downloadMode', 'download mode on demand keep recent index only hoarder offline cache duration local email caching how long keep'],
    ['settings.storage.keepWindow', 'keep mail months year window cache duration how long'],
    ['settings.storage.advancedCustomStorageFolder', 'storage location folder custom move vault where files kept'],
    ['settings.storage.addCleanupRule', 'cleanup rule automatic delete archive old emails age folder schedule'],
    ['settings.storage.storageStatus', 'storage usage space used disk size'],
    ['settings.storage.formatLabel', 'message format maildir jmap eml json records blobs convert conversion old files kept aside reclaim space'],
    ['settings.storage.dangerZone', 'empty vault delete everything reset erase all mail'],
    ['deletedBin.title', 'deleted emails recover restore undelete bin trash'],
    ['deletedBin.retention', 'deleted emails keep how long days retention purge'],
  ] },
  { id: 'security', settings: [
    ['settings.security.linkSafetyScanning', 'security link safety scanning phishing malicious url check'],
    ['settings.security.clickConfirmation', 'security click confirmation links warn before opening'],
    ['settings.security.askBeforeExternalContent', 'security privacy external content remote images pictures load block ask automatically'],
  ] },
  { id: 'encryption', settings: [
    ['pgp.keyLabel', 'openpgp pgp gpg gnupg encryption encrypted decrypt secret private key import armored'],
    ['pgp.passphraseLabel', 'openpgp pgp key passphrase password keychain'],
    ['pgp.removeKey', 'openpgp pgp remove delete key'],
  ] },
  { id: 'billing', settings: [
    ['settings.billing.manageSubscription', 'billing subscription manage cancel plan payment'],
    ['settings.billing.devices', 'billing devices premium license manage remove'],
    ['lifecycle.setting.label', 'billing premium messages reminders trial inbox notes from mailvault turn off'],
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
    ['settings.dataUsage.account.pauseBackgroundDownloads', 'data usage pause background downloads backup hoarder download ahead stop limit reached'],
  ] },
  { id: 'logs', settings: [
    ['settings.logs.verbosityTitle', 'log detail level standard verbose verbosity'],
    ['settings.logs.clearLog2', 'clear delete diagnostic logs'],
  ] },
  // Backup's own sub-tabs: section names the one that holds the setting.
  { id: 'backup', section: 'restore', sectionKey: 'settings.backup.importExport.tab', settings: [
    ['settings.backup.importExport.zipHeading', 'import export one time zip archive vault snapshot copy once'],
    ['settings.backup.restore.exportBackup', 'export backup zip vault download'],
    ['settings.backup.restore.importBackup', 'import backup zip vault restore'],
    ['settings.backup.restore.exportMbox', 'export mbox file standard format'],
    ['settings.backup.restore.importMbox', 'import mbox file standard format'],
  ] },
  { id: 'backup', section: 'config', sectionKey: 'settings.backup.backupSettings', settings: [
    ['settings.mailLocation.whereMailStored', 'storage location where mail stored folder move backup'],
    ['settings.backup.config.scopeLabel', 'backup scope what back up archived all emails'],
    ['settings.backup.config.storageLabel', 'backup storage where folder drive second copy external'],
  ] },
  { id: 'backup', section: 'schedule', sectionKey: 'settings.backup.backupSchedule', settings: [
    ['settings.backup.schedule.automaticBackup', 'automatic backup schedule enable'],
    ['settings.backup.schedule.backupFrequency', 'backup frequency how often hourly daily weekly'],
    ['settings.backup.schedule.pickHours', 'backup hours pick specific times set hours schedule'],
    ['settings.backup.schedule.mailboxConcurrency', 'backup mailboxes processed at once concurrency speed performance'],
  ] },
  { id: 'backup', section: 'abd', sectionKey: 'settings.backup.abd.tab', settings: [
    ['settings.backup.abd.backupCard.title', 'archive back up backup delete remove server free space vault drive premium'],
    ['settings.backup.abd.archiveCard.title', 'archive delete remove server free space vault only copy premium'],
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
  { id: 'network-activity', settings: [
    ['netActivity.protocol', 'network activity connections traffic hosts servers requests privacy protocol filter imap smtp https dns'],
    ['netActivity.purpose', 'network activity connections purpose filter sync send sign-in backup'],
    ['netActivity.account', 'network activity connections account filter'],
    ['netActivity.retention', 'network activity history keep retention delete saved days weeks month'],
    ['netActivity.range', 'network activity time range period last hour day week month'],
    ['netActivity.map.label', 'network activity map world countries where geolocation location'],
    ['netActivity.map.countries', 'network activity countries list where connections went local network'],
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

// ---- The phone's decisions ------------------------------------------------------------------

/** Each page: on the phone (`true`), or why not. */
export const MOBILE_PAGES = {
  appearance: true,
  'mail-preferences': true,
  accounts: true,
  templates: true,
  'ai-providers': true,
  unsubscribe: true,
  // The phone's views run over its own index: they find the mail it keeps offline.
  views: true,
  storage: true,
  'data-usage': true,
  security: true,
  tracking: true,
  encryption: true,
  'network-activity': true,
  billing: true,
  language: true,
  daemon: true,
  logs: true,
  help: true,
  portable: 'runs from a portable drive, which a phone cannot',
  // Desktop features the phone will not have: in the phone's navigation in desktop's place, each
  // opening one notice that the feature is in MailVault on desktop (DesktopNoticeView).
  cleanup: 'desktopNotice',
  'time-capsule': 'desktopNotice',
  migration: 'desktopNotice',
  backup: 'desktopNotice',
  // The phone's rules run on its AI endpoint, over the mail it keeps.
  'auto-tags': true,
};

/** A page the phone shows as "<Feature> is available in MailVault on desktop". */
export const DESKTOP_NOTICE = 'desktopNotice';
const DESKTOP_FEATURE = 'desktop feature';

const NOT_ON_PHONE = {
  'window or tray: a phone app has no window to close to a tray': ['settings.behavior.closeToTray'],
  'the default mail app is chosen in the phone system settings': ['settings.behavior.defaultMail.title'],
  'compose opens in its own window, a phone has one screen': ['settings.behavior.composeOpen.title'],
  'reading pane position: a phone shows the list and the message one at a time': ['workspace.readingPane'],
  'sidebar layout: the phone has a drawer, not a sidebar': ['workspace.sidebarLayout', 'workspace.navigation'],
  'menu bar (Linux desktop window)': ['workspace.menuBar'],
  'keyboard shortcuts': ['shortcuts.keyboardShortcuts', 'settings.shortcuts.enableKeyboardShortcuts'],
  'update track: the phone updates through its app store': ['settings.behavior.updateTrackTitle', 'settings.behavior.updateTrackLabel', 'settings.behavior.updateTrackCheckNow'],
  'daemon always on: the phone has no background daemon to keep running': ['settings.daemon.alwaysOn.label'],
  'custom storage folder: the phone keeps mail in its app container': ['settings.storage.advancedCustomStorageFolder'],
  'pointer hover: a phone has no pointer': ['settings.appearance.rowHighlight', 'settings.dataUsage.showUsageHover'],
  'row layout: the phone list has one row layout': ['workspace.messageRows'],
  'storage format: the phone keeps mail in SQLite, there is no on-disk format to choose': ['settings.storage.formatLabel'],
  'empty vault: the phone keeps no vault to empty; removing an account removes its mail': ['settings.storage.dangerZone'],
  'image text (OCR) runs on desktop only': ['settings.searchIndex.imageText'],
  'mailbox concurrency: a desktop search speed setting; the phone searches its own index': ['settings.searchIndex.concurrency'],
  'download modes: the phone keeps a window of recent mail per account (Keep mail from the last)': ['settings.storage.downloadMode'],
  'a view on the phone lists its mail newest first in one list: no grouping, sort or timeline': ['views.showTimeline'],
  'runs from a portable drive, which a phone cannot': [
    'portable.title', 'portable.copyConfig', 'portable.copyMail', 'portable.removeFromHost', 'portable.newPassword',
    'settings.transfer.confirmPassword', 'portable.running.title', 'portable.currentPassword',
  ],
  // Cleanup, backup, time capsule and migration are desktop-only (their pages are notices on the
  // phone); so are their settings that live on other pages.
  [DESKTOP_FEATURE]: [
    'workspace.backupStatusLocation',
    'settings.notifications.backupNotifications', 'settings.notifications.notifyWhenBackupCompletes', 'settings.notifications.notifyWhenBackupFails',
    'settings.storage.addCleanupRule', 'settings.ai.customCategories', 'settings.ai.learnedRules',
    'settings.backup.importExport.zipHeading', 'settings.backup.restore.exportBackup', 'settings.backup.restore.importBackup',
    'settings.backup.restore.exportMbox', 'settings.backup.restore.importMbox', 'settings.mailLocation.whereMailStored',
    'settings.backup.config.scopeLabel', 'settings.backup.config.storageLabel', 'settings.backup.schedule.automaticBackup',
    'settings.backup.schedule.backupFrequency', 'settings.backup.schedule.pickHours', 'settings.backup.schedule.mailboxConcurrency',
    'settings.backup.abd.backupCard.title', 'settings.backup.abd.archiveCard.title',
    'settings.timeCapsule.enableAutomaticSnapshots',
    'settings.migration.selectSourceAccount', 'settings.migration.migrationHistory',
  ],
};
const ENGINE_GAPS = {
  'engine: search history and popular filters (the phone search keeps no history)': ['settings.behavior.search', 'settings.behavior.searchHistoryLimit', 'settings.behavior.popularFiltersPeriod', 'settings.behavior.numberPopularFiltersShow'],
  'engine: notification decision log (the background run decides and records nothing)': ['notifyPolicy.log.title'],
  'engine: playing the new-mail sound on demand (no shell call plays it)': ['settings.notifications.previewSound'],
  'engine: account groups (the phone keeps no group per account, and its switcher and drawer have no group sections)': ['settings.accounts.group'],
  'engine: choosing the Google sign-in app (the phone keeps the client an account was signed in or imported with, and has no switch between them)': ['googleClient.settingsLabel'],
  'engine: switching a Microsoft account between Graph and IMAP (the phone keeps the transport it was added or imported with; a switch signs in again and re-files the mail)': ['account.msTransport'],
  'engine: AI provider choice (the phone has one endpoint)': ['ai.settings.provider'],
  'engine: lifecycle messages': ['lifecycle.setting.label'],
  'engine: hiding auto-tagged mail from the Inbox (the phone list does not hide tagged mail; a rule keeps its Inbox action for desktop)': ['autoTag.inboxAction'],
};
const ON_PHONE = [
  'settings.appearance.theme', 'settings.colors.palette', 'settings.icons.title', 'settings.appearance.emailViewerTheme',
  'settings.text.size', 'settings.text.font',
  'workspace.mailExperience', 'workspace.listDensity', 'listPreview.title', 'workspace.folderIcons',
  'settings.appearance.threadMode', 'settings.appearance.threadSortOrder', 'settings.appearance.signatureDisplay', 'settings.appearance.actionButtonStyle',
  'settings.appearance.dateFormat', 'settings.appearance.timeFormat',
  'quickActions.presets', 'quickActions.surface.reader', 'quickActions.layout', 'quickActions.surface.row', 'quickActions.surface.selection',
  'quickActions.scope', 'quickActions.palette',
  'settings.behavior.refreshAppLaunch', 'settings.behavior.autoRefreshInterval', 'settings.behavior.autoDownloadAttachments', 'settings.behavior.attachmentReminder',
  'settings.behavior.sendDelay', 'settings.behavior.markEmailsRead', 'settings.behavior.delayBeforeMarkingRead',
  'settings.behavior.whenAnEmailIsDeleted', 'settings.behavior.afterDeleteSameAccount', 'settings.behavior.confirmBeforeDelete',
  'settings.behavior.swipe.title', 'settings.behavior.swipe.enabled', 'settings.behavior.swipe.left', 'settings.behavior.swipe.right',
  'settings.notifications.enableDesktopNotifications', 'settings.notifications.showEmailPreview', 'settings.notifications.newEmailSound',
  'settings.notifications.perAccountSettings', 'settings.notifications.badge', 'settings.notifications.showBadgeCount', 'settings.notifications.badgeShows',
  'notifyPolicy.quietHours.title', 'notifyPolicy.allowlist.title',
  'fields.section', 'fields.newName', 'fields.newKind', 'fields.copyFrom',
  'views.section', 'views.new',
  'autoTag.name', 'autoTag.instruction', 'autoTag.tag', 'autoTag.hasAttachments', 'autoTag.listIdPresent', 'autoTag.fromAddress', 'autoTag.fromDomain',
  'autoTag.minConfidence', 'autoTag.allowRemote', 'autoTag.enabledLabel',
  'settings.accounts.displayName', 'settings.accounts.emailSignature', 'settings.accounts.enableSignature',
  'settings.accounts.aliases.listTitle', 'settings.accounts.aliases.addAddress', 'settings.accounts.aliases.defaultAddress', 'settings.accounts.aliases.nameLabel',
  'settings.accounts.password', 'settings.accounts.mailServer', 'settings.accounts.sentFolder',
  'settings.accounts.avatarColor', 'settings.accounts.accountVisible', 'settings.accounts.removeAccount',
  'settings.transfer.title',
  'settings.pendingActions.title',
  'settings.searchIndex.bodies', 'settings.searchIndex.attachments', 'settings.searchIndex.rebuild',
  'settings.storage.keepWindow', 'settings.storage.storageStatus',
  'deletedBin.title', 'deletedBin.retention',
  'settings.security.linkSafetyScanning', 'settings.security.clickConfirmation', 'settings.security.askBeforeExternalContent',
  'pgp.keyLabel', 'pgp.passphraseLabel', 'pgp.removeKey',
  'settings.billing.manageSubscription', 'settings.billing.devices',
  'settings.templates.templateName', 'settings.templates.templateBody',
  'settings.language.report.title',
  'ai.settings.enable', 'ai.settings.endpointUrl', 'ai.settings.endpointModel', 'ai.settings.endpointKey', 'ai.settings.skipPreview',
  'unsubscribe.subscriptions', 'unsubscribe.history',
  'settings.dataUsage.account.dailyDownloadLimitMb', 'settings.dataUsage.account.dailyUploadLimitMb',
  'settings.dataUsage.account.warnWhenNearingDailyLimit', 'settings.dataUsage.account.pauseBackgroundDownloads',
  'settings.logs.verbosityTitle', 'settings.logs.clearLog2',
  'settings.tracking.blockTrackingPixels',
  'netActivity.protocol', 'netActivity.purpose', 'netActivity.account', 'netActivity.retention', 'netActivity.range',
  'netActivity.map.label', 'netActivity.map.countries',
];

/** Each searchable setting (`labelKey`): on the phone (`true`), or why not. */
export const MOBILE_SETTINGS = Object.freeze({
  ...Object.fromEntries(ON_PHONE.map(key => [key, true])),
  ...Object.fromEntries(Object.entries(NOT_ON_PHONE).flatMap(([reason, keys]) => keys.map(key => [key, reason]))),
  ...Object.fromEntries(Object.entries(ENGINE_GAPS).flatMap(([reason, keys]) => keys.map(key => [key, reason]))),
});
/** Every key listed in more than one of the three lists above (a guard test keeps it empty). */
export const MOBILE_SETTINGS_DUPLICATES = (() => {
  const all = [...ON_PHONE, ...Object.values(NOT_ON_PHONE).flat(), ...Object.values(ENGINE_GAPS).flat()];
  return all.filter((key, i) => all.indexOf(key) !== i);
})();

/**
 * A setting the phone labels in its own words, where desktop's label names the desktop or a
 * trackpad (`desktop key: phone key`): the phone's search shows and lands on the phone's label.
 */
export const MOBILE_LABELS = Object.freeze({
  'settings.notifications.enableDesktopNotifications': 'mobile.settings.notifyToggle',
  'settings.behavior.swipe.enabled': 'mobile.prefs.swipeRows',
});

/**
 * A page the phone names in its own words (`page id: phone key`): Diagnostics' first page holds
 * only the unfinished server actions on the phone (it has no daemon to show).
 */
export const MOBILE_PAGE_LABELS = Object.freeze({
  daemon: 'settings.pendingActions.title',
});

/** The phone has this page or setting (a desktop-notice page is not a phone feature). */
export const onPhone = decision => decision === true;
/** The page is a desktop-notice page on the phone. */
export const onPhoneNotice = decision => decision === DESKTOP_NOTICE;
/** The page is in the phone's navigation: on the phone, or its desktop notice. */
export const inPhoneNav = decision => onPhone(decision) || onPhoneNotice(decision);
/** A nav entry is in the phone's navigation when any of its pages is. */
export const navEntryOnPhone = entry => (entry.pages || [entry.id]).some(id => inPhoneNav(MOBILE_PAGES[id]));

// ---- Search ---------------------------------------------------------------------------------

/** Folds case and accents, so "resume" finds "Résumé". */
export const searchText = value => value.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
/** A label as the page shows it: whitespace collapsed. */
export const settingText = value => value.replace(/\s+/g, ' ').trim();

/**
 * Every search destination: each page, each host under its own name (unless its first page
 * already has that name), and each setting with its group's page and section.
 */
export const searchPages = [
  ...allTabs,
  ...Object.values(settingsHosts).filter(({ labelKey, pages }) => labelKey !== tabsById[pages[0]].labelKey)
    .map(({ labelKey, icon, pages }) => ({ ...tabsById[pages[0]], labelKey, icon })),
  ...settingSearchGroups.flatMap(group => group.settings.map(([labelKey, keywords]) => ({
    ...tabsById[group.id], ...group, labelKey, keywords,
  }))),
];

/** The destinations matching `query` in the current language (`t`), in index order. */
export function searchSettings(t, query, pages = searchPages) {
  const terms = searchText(query.trim()).split(/\s+/).filter(Boolean);
  return pages.filter(page => {
    const content = searchText([t(page.labelKey), page.sectionKey ? t(page.sectionKey) : '', page.keywords || ''].join(' '));
    return terms.every(term => content.includes(term));
  });
}

/**
 * The destinations the phone has: its page is on the phone, and so is the setting, under the
 * phone's label (`MOBILE_LABELS`; `settingKey` then keeps desktop's key, the decision's). A
 * desktop-notice page is found by its own name and opens its notice; its settings are not.
 */
export const mobileSearchPages = searchPages.filter(page => (page.keywords
  ? onPhone(MOBILE_PAGES[page.id]) && onPhone(MOBILE_SETTINGS[page.labelKey])
  : inPhoneNav(MOBILE_PAGES[page.id])))
  .map(page => {
    if (page.keywords) {
      return MOBILE_LABELS[page.labelKey] ? { ...page, settingKey: page.labelKey, labelKey: MOBILE_LABELS[page.labelKey] } : page;
    }
    return MOBILE_PAGE_LABELS[page.id] && page.labelKey === tabsById[page.id]?.labelKey
      ? { ...page, labelKey: MOBILE_PAGE_LABELS[page.id] } : page;
  })
  // A page renamed after its one setting is found once, as that setting.
  .filter((page, _, all) => page.keywords || !all.some(other => other.keywords && other.id === page.id && other.labelKey === page.labelKey));

const CONTROL = 'input, select, textarea, button, [tabindex]';
export const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex="0"]';

// Where a searched setting sits on its page: the leaf-most element that reads
// exactly as its label, else the control named by it. Tab rows are page
// navigation, not the setting. Returns the row around it: the nearest
// ancestor that holds a control, so the highlight frames label and control.
export function findSettingRow(root, label) {
  const inTabs = el => el.closest('[role="tablist"]');
  const texts = [...root.querySelectorAll('*')].filter(el => !inTabs(el) && settingText(el.textContent) === label);
  const hit = texts.find(el => !texts.some(other => other !== el && el.contains(other)))
    || [...root.querySelectorAll('[aria-label]')].find(el => !inTabs(el) && el.getAttribute('aria-label') === label);
  let row = hit;
  while (row && row !== root && !row.matches(CONTROL) && !row.querySelector(CONTROL)) row = row.parentElement;
  return row === root ? hit : row;
}

/**
 * Lands a search result on its setting in `root`: scrolled to the middle, briefly highlighted,
 * focus on its control while focus is still inside `root`. The page may render a beat later, so
 * it watches `root` for a moment. Returns the stop function (an effect's cleanup).
 */
export function landOnSetting(root, label) {
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
  if (land()) return () => {};
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
}
