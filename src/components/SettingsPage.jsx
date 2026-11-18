import React, { useState, useEffect, useId, useRef } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { X, Minus, Settings, ChevronLeft, Search, Maximize2 } from 'lucide-react';
import {
  allTabs, settingsHosts, settingSearchGroups, settingsSections, footerTabs, tabsById, hostOf,
  searchPages, searchSettings, settingText, landOnSetting,
} from './settings/settingsManifest';
import { GeneralSettings } from './settings/GeneralSettings';
import { AppearanceSettings } from './settings/AppearanceSettings';
import { AccountSettings } from './settings/AccountSettings';
import { TemplateSettings } from './settings/TemplateSettings';
import { StorageSettings } from './settings/StorageSettings';
import { DeletedEmailsSettings } from './settings/DeletedEmailsSettings';
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
import { NetworkActivity } from './settings/NetworkActivity';
import { SettingsTabs } from './ui/SettingsTabs';
import { TimeCapsuleView } from './TimeCapsule';
import { useT } from '../i18n/index.js';
import { Private } from './privacy/Private';
import { useUnsavedStore } from '../stores/unsavedStore';
import { useUnsubscribeSendersStore } from '../stores/unsubscribeStore';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';

// The navigation (pages, sections, hosts, search index) lives in settingsManifest.js, which the
// phone's Settings shell renders too. Re-exported here for the guard tests that import it.
export { allTabs, settingsHosts, settingSearchGroups };
// Tabs that show account pills and config sub-views
const accountPillTabIds = new Set(['cleanup', 'time-capsule']);
const sections = settingsSections;

const normalizeTab = tab => tab === 'general' || tab === 'language' ? 'appearance' : tab === 'ai' ? 'cleanup'
  : settingsHosts[tab]?.pages[0] || tab;

export function SettingsPage({ onClose, onAddAccount, onSetupPhone, onExportAccounts, onImportAccounts, onReportBug, initialTab, initialAccountId, initialSection,
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
  // Unsubscribe's senders are kept while this session lives (another page, a
  // minimize) and asked for afresh by the next one.
  useEffect(() => () => useUnsubscribeSendersStore.getState().clear(), []);
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
    return landOnSetting(root, settingText(t(labelKey)));
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
        ? { profile: 'settings.accounts.sectionProfile', aliases: 'settings.accounts.sectionAliases', connection: 'settings.accounts.sectionConnection', advanced: 'settings.accounts.sectionAdvanced' }[accountSection]
        : host && host.labelKey !== currentTab.labelKey ? currentTab.labelKey : null;
  const navigationLabel = subView === 'config'
    ? t('settingsPage.tabSettings', { tab: currentTab ? t(currentTab.labelKey) : '' })
    : [pageTab && t(pageTab.labelKey), sectionKey && t(sectionKey)].filter(Boolean).join(' · ');
  useEffect(() => { onNavigationLabelChange?.(navigationLabel); }, [navigationLabel, onNavigationLabelChange]);
  const results = query.trim() ? searchSettings(t, query, searchPages) : [];
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
        <AccountSettings accounts={accounts} onUpgrade={() => handleTabChange('billing')} onAddAccount={onAddAccount} onSetupPhone={onSetupPhone} onExportAccounts={onExportAccounts} onImportAccounts={onImportAccounts} initialAccountId={initialAccountId}
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
        <UnsubscribeSettings onMinimize={onMinimize} />
      )}

      {activeTab === 'storage' && (<>
        <StorageSettings accounts={accounts} onUpgrade={() => handleTabChange('billing')} />
        <DeletedEmailsSettings />
      </>)}

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
        <DaemonSettings initialSection={resolvedInitialTab === 'daemon' ? initialSection : null} />
      )}

      {activeTab === 'billing' && (
        <BillingSettings onNavigate={handleTabChange} onReportBug={onReportBug} />
      )}

      {activeTab === 'security' && (
        <SecuritySettings />
      )}

      {activeTab === 'encryption' && (
        <EncryptionSettings />
      )}

      {activeTab === 'network-activity' && (
        <NetworkActivity />
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
                  <Private kind="email">{acc.email}</Private>
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
