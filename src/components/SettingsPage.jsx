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
import { LanguageSettings } from './settings/LanguageSettings';
import { TrackerBlockingView } from './settings/TrackerBlockingView';
import { TimeCapsuleView } from './TimeCapsule';
import { useT } from '../i18n/index.js';

const featureTabs = [
  { id: 'cleanup', labelKey: 'settings.tab.cleanup', icon: Sparkles },
  { id: 'time-capsule', labelKey: 'settings.tab.timeCapsule', icon: Clock },
  { id: 'tracking', labelKey: 'settings.tab.tracking', icon: EyeOff },
  { id: 'migration', labelKey: 'settings.tab.migration', icon: ArrowLeftRight },
  { id: 'backup', labelKey: 'settings.tab.backup', icon: HardDriveDownload },
];

const settingsTabs = [
  { id: 'appearance', labelKey: 'settings.appearance.appearance', descriptionKey: 'settings.navigation.appearanceSummary', icon: Palette },
  { id: 'mail-preferences', labelKey: 'settings.navigation.mailPreferences', descriptionKey: 'settings.navigation.mailPreferencesSummary', icon: Settings },
  { id: 'accounts', labelKey: 'settings.tab.accounts', icon: User },
  { id: 'templates', labelKey: 'settings.tab.templates', icon: FileText },
  { id: 'storage', labelKey: 'settings.tab.storage', icon: HardDrive },
  { id: 'data-usage', labelKey: 'settings.tab.dataUsage', icon: Gauge },
  { id: 'security', labelKey: 'settings.tab.security', icon: Shield },
  { id: 'billing', labelKey: 'settings.tab.billing', icon: CreditCard },
  { id: 'language', labelKey: 'settings.tab.language', icon: Languages },
];

const systemTabs = [
  { id: 'daemon', labelKey: 'settings.tab.daemon', icon: Server },
  { id: 'logs', labelKey: 'settings.tab.logs', icon: ScrollText },
  { id: 'help', labelKey: 'settings.tab.help', icon: Mail },
];

const allTabs = [...featureTabs, ...settingsTabs, ...systemTabs];
// Tabs that show account pills and config sub-views
const accountPillTabIds = new Set(['cleanup', 'time-capsule']);

const tabsById = Object.fromEntries(allTabs.map(tab => [tab.id, tab]));
const sections = [
  { labelKey: 'settings.navigation.mail', ids: ['appearance', 'mail-preferences', 'accounts', 'templates', 'language'] },
  { labelKey: 'settings.navigation.vaultPrivacy', ids: ['storage', 'backup', 'security', 'tracking', 'cleanup', 'time-capsule', 'data-usage'] },
  { labelKey: 'settings.navigation.supportSystem', ids: ['billing', 'migration', 'daemon', 'logs', 'help'] },
].map(section => ({ ...section, tabs: section.ids.map(id => tabsById[id]) }));

// Labels are resolved at render time, so search follows the current language.
// A result points to the same page and section that contain its real control.
const settingSearchGroups = [
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
  ] },
  { id: 'mail-preferences', section: 'shortcuts', settings: [
    ['shortcuts.keyboardShortcuts', 'keyboard shortcuts hotkeys keys'],
  ] },
  { id: 'accounts', section: 'profile', sectionKey: 'settings.accounts.sectionProfile', settings: [
    ['settings.accounts.displayName', 'name sender from identity'],
    ['settings.accounts.sendMail', 'send as alias address identity'],
    ['settings.accounts.emailSignature', 'signature email sign off footer'],
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
];

const normalizeTab = tab => tab === 'general' ? 'appearance' : tab === 'ai' ? 'cleanup' : tab;
const searchText = value => value.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

export function SettingsPage({ onClose, onAddAccount, onReportBug, initialTab, initialAccountId, initialSection,
  minimized = false, onMinimize, onNavigationLabelChange }) {
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
  const [appearanceSection, setAppearanceSection] = useState(resolvedInitialTab === 'appearance' ? initialSection || 'colors' : 'colors');
  const [generalSubTab, setGeneralSubTab] = useState(resolvedInitialTab === 'mail-preferences' ? initialSection || 'behavior' : 'behavior');
  const [accountSection, setAccountSection] = useState(resolvedInitialTab === 'accounts' ? initialSection || 'profile' : 'profile');
  const [subView, setSubView] = useState(null); // null = feature view, 'config' = settings sub-view
  const [selectedFeatureAccountId, setSelectedFeatureAccountId] = useState(initialAccountId || activeAccountId || accounts[0]?.id);
  const [featureDetailActive, setFeatureDetailActive] = useState(false);
  const contentRef = useRef(null);
  const [searchNavigation, setSearchNavigation] = useState(0);

  // The chosen result disappears. Move keyboard focus into its destination,
  // rather than leaving the user on a detached search-result button.
  useEffect(() => {
    if (!searchNavigation) return;
    const panel = contentRef.current?.querySelector('[role="tabpanel"]') || contentRef.current;
    panel?.focus({ preventScroll: true });
  }, [searchNavigation]);

  // Reset subView when switching tabs
  const handleTabChange = (tabId) => {
    setActiveTab(normalizeTab(tabId));
    setSubView(null);
    setFeatureDetailActive(false);
  };

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
  const sectionKey = activeTab === 'appearance'
    ? { colors: 'settings.appearance.section.colors', layout: 'settings.appearance.section.layout', reading: 'settings.appearance.section.reading', 'date-time': 'settings.appearance.section.dateTime' }[appearanceSection]
    : activeTab === 'mail-preferences'
      ? { behavior: 'generalSettings.behavior', notifications: 'settings.notifications.notifications', shortcuts: 'shortcuts.keyboardShortcuts' }[generalSubTab]
      : activeTab === 'accounts'
        ? { profile: 'settings.accounts.sectionProfile', connection: 'settings.accounts.sectionConnection', advanced: 'settings.accounts.sectionAdvanced' }[accountSection]
        : null;
  const navigationLabel = subView === 'config'
    ? t('settingsPage.tabSettings', { tab: currentTab ? t(currentTab.labelKey) : '' })
    : [currentTab && t(currentTab.labelKey), sectionKey && t(sectionKey)].filter(Boolean).join(' · ');
  useEffect(() => { onNavigationLabelChange?.(navigationLabel); }, [navigationLabel, onNavigationLabelChange]);
  const searchPages = [
    ...allTabs,
    ...settingSearchGroups.flatMap(group => group.settings.map(([labelKey, keywords]) => ({
      ...tabsById[group.id], ...group, labelKey, keywords,
    }))),
  ];
  const terms = searchText(query.trim()).split(/\s+/).filter(Boolean);
  const results = searchPages.filter(page => {
    const content = searchText([t(page.labelKey), page.sectionKey ? t(page.sectionKey) : '', page.keywords || ''].join(' '));
    return terms.every(term => content.includes(term));
  });
  const openResult = page => {
    if (page.id === 'appearance' && page.section) setAppearanceSection(page.section);
    if (page.id === 'mail-preferences' && page.section) setGeneralSubTab(page.section);
    if (page.id === 'accounts' && page.section) setAccountSection(page.section);
    handleTabChange(page.id);
    setQuery('');
    setSearchNavigation(value => value + 1);
  };
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

  return (
    <Dialog
      open={!minimized}
      keepMounted
      onClose={onClose}
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
                {section.tabs.map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => handleTabChange(tab.id)}
                    aria-current={activeTab === tab.id ? 'page' : undefined}
                    className="settings-nav-item"
                  >
                    <tab.icon size={17} aria-hidden="true" />
                    <span className="text-sm font-medium">{t(tab.labelKey)}</span>
                  </button>
                ))}
              </React.Fragment>
            ))}
            </div>
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
                  : (currentTab ? t(currentTab.labelKey) : '')}
              </h3>
              {currentTab?.descriptionKey && <p className="settings-page-description">{t(currentTab.descriptionKey)}</p>}
              </div>
              <div className="settings-mobile-navigation">
                <label className="sr-only" htmlFor={`${titleId}-page`}>{t('settingsPage.settings')}</label>
                <select id={`${titleId}-page`} value={activeTab} onChange={event => handleTabChange(event.target.value)}>
                  {sections.map(section => <optgroup key={section.labelKey} label={t(section.labelKey)}>
                    {section.tabs.map(tab => <option key={tab.id} value={tab.id}>{t(tab.labelKey)}</option>)}
                  </optgroup>)}
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
              <Button variant="ghost" icon size="md"
                aria-label={t('common.close')} title={t('common.close')} onClick={onClose}
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
          <div key={`${activeTab}-${subView || 'main'}`} ref={contentRef} tabIndex={-1} data-testid="settings-content" data-page={activeTab} className={`settings-content flex-1 min-h-0 min-w-0 ${activeTab === 'accounts' || (hasAccountPills && subView !== 'config') ? 'overflow-hidden' : 'overflow-y-auto'}`}>
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
              <AccountSettings accounts={accounts} onAddAccount={onAddAccount} initialAccountId={initialAccountId}
                initialSection={accountSection} onSectionChange={setAccountSection} />
            )}

            {activeTab === 'templates' && (
              <TemplateSettings />
            )}

            {activeTab === 'storage' && (
              <StorageSettings accounts={accounts} onUpgrade={() => handleTabChange('billing')} />
            )}

            {activeTab === 'data-usage' && (
              <DataUsageSettings initialAccountId={initialAccountId} />
            )}

            {activeTab === 'backup' && (
              <BackupSettings initialAccountId={initialAccountId} onUpgrade={() => handleTabChange('billing')} />
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

            {activeTab === 'language' && (
              <LanguageSettings />
            )}

            {activeTab === 'security' && (
              <SecuritySettings />
            )}

            {activeTab === 'logs' && (
              <LogsSettings />
            )}

            {activeTab === 'help' && (
              <HelpSettings onClose={onClose} onReportBug={onReportBug} />
            )}
          </div>
        </div>
    </Dialog>
  );
}
