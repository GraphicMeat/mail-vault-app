// The settings screen: a full-screen layer opened from the folder drawer's footer, laid out as
// desktop's Settings is and drawn with desktop's components (src/components/settings): its
// navigation comes from the shared manifest (settingsManifest.js), less the pages a phone has no
// use for or whose feature the phone engine lacks (MOBILE_PAGES says which and why).
//
// - The first screen is desktop's sidebar: the setting search, the section headings and their
//   pages, Billing (while Premium is on), Diagnostics and Help pinned under them. Premium sits
//   above them: "Premium: active until <date> (App Store)" or "Free", opening the Premium screen;
//   a phone whose place another device took says so, with Sign in again.
// - A page opens under desktop's page header (title, description) with Back. A host (Storage,
//   Privacy & security, Diagnostics) shows its pages as desktop's tabs; Appearance and Mail
//   preferences show their sections the same way.
// - Search finds the pages and settings the phone has and lands on the setting, as on desktop.
// - Every page is desktop's view over the phone's preferences and engine (settings/*.jsx):
//   Appearance, Mail preferences (Behavior, Notifications, Fields), Accounts, Templates, Views,
//   AI providers, Unsubscribe, Storage (Storage with the offline window and the search index; Data usage),
//   Privacy & security (Security, Tracking, Encryption, Network Activity), Billing, Diagnostics
//   (unfinished server actions, Logs) and Help. Accounts' "Move to another computer" Export opens
//   the phone's export page (settings/Transfer.jsx), and its Add account hands over to the phone's
//   own sign-in flow (`onAddAccount`). Views (settings/Views.jsx) opens on a new view when the
//   drawer's + asked (`newView`), and its editor's unsaved edits are asked about before the
//   header's Back leaves the page.
// - Cleanup, Backup, Time Capsule and Migration sit in desktop's place with desktop's icon and
//   name, and open one notice: the feature is in MailVault on desktop (DesktopNoticeView).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, CreditCard, Search, X } from 'lucide-react';
import {
  settingsSections, footerTabs, settingsHosts, hostOf, tabsById, navEntryOnPhone, mobileSearchPages, searchSettings,
  settingText, landOnSetting, MOBILE_PAGES, MOBILE_PAGE_LABELS, onPhoneNotice,
} from '../components/settings/settingsManifest';
import { SettingsTabs } from '../components/ui/SettingsTabs';
import { Button } from '../components/ui/Button';
import { SettingsViewProvider } from '../components/settings/views/viewContext';
import { DesktopNoticeView } from '../components/settings/views/DesktopNoticeView';
import { useMobileStore } from './store.js';
import KeyboardLayer from './KeyboardLayer.jsx';
import { useBackLayer } from './backStack.js';
import { useT, getMobileLocale } from './i18n.js';
import { errorKey } from './errors.js';
import { premiumSummary } from './premium.js';
import Storage from './settings/Storage.jsx';
import DataUsage from './settings/DataUsage.jsx';
import { PendingActions, Logs } from './settings/Diagnostics.jsx';
import Billing from './settings/Billing.jsx';
import Help from './settings/Help.jsx';
import Transfer from './settings/Transfer.jsx';
import NetworkActivity from './settings/NetworkActivity.jsx';
import Appearance from './settings/Appearance.jsx';
import { Behavior, Notifications } from './settings/MailPreferences.jsx';
import Fields from './settings/Fields.jsx';
import { Encryption, Security, Tracking } from './settings/Privacy.jsx';
import Templates from './settings/Templates.jsx';
import Unsubscribe from './settings/Unsubscribe.jsx';
import AiProviders from './settings/AiProviders.jsx';
import Accounts from './settings/Accounts.jsx';
import Views from './settings/Views.jsx';

const APP_VERSION = import.meta.env?.MV_APP_VERSION || '';

/** Mail preferences' sections on the phone (desktop's behavior, notifications and fields). */
const MAIL_SECTIONS = [['behavior', 'generalSettings.behavior'], ['notifications', 'settings.notifications.notifications'], ['fields', 'fields.section']];

/**
 * Pages opened from another page, not the navigation: `{ parent, titleKey }`. Back returns to the
 * parent (Move to another computer from Accounts).
 */
const SUB_PAGES = {
  transfer: { parent: { nav: 'accounts' }, titleKey: 'settings.transfer.title' },
};

/**
 * Where a page id leads: a manifest page or nav id, or one of the phone's earlier page ids (a
 * caller's `page`, the tour's links). `{ nav, tab, section, sub }`.
 */
export function placeOf(page) {
  const OLD = {
    mail: { nav: 'mail-preferences', section: 'behavior' },
    notifications: { nav: 'mail-preferences', section: 'notifications' },
    transfer: { nav: 'accounts', sub: 'transfer' },
    ai: { nav: 'ai-providers' },
    // The offline window is Storage's download card now.
    offline: { nav: 'storage', tab: 'storage' },
    search: { nav: 'storage', tab: 'storage' },
    dataUsage: { nav: 'storage', tab: 'data-usage' },
    privacy: { nav: 'privacy', tab: 'security' },
    networkActivity: { nav: 'privacy', tab: 'network-activity' },
    pending: { nav: 'diagnostics', tab: 'daemon' },
    quickActions: { nav: 'appearance', section: 'quick-actions' },
    // Desktop's old ids for Appearance and its Language section (SettingsPage normalizeTab).
    general: { nav: 'appearance' },
    language: { nav: 'appearance', section: 'language' },
  };
  if (!page || page === 'root') return { nav: 'root' };
  if (OLD[page]) return OLD[page];
  if (settingsHosts[page]) return { nav: page, tab: settingsHosts[page].pages[0] };
  if (hostOf[page]) return { nav: hostOf[page].id, tab: page };
  return { nav: page };
}

/**
 * `page`: the page to open on (the first screen, `'root'`, by default): see `placeOf`. `newView`:
 * Views opens on a new view (once).
 */
export default function Settings({ onClose, onReplayTour, onAddAccount, version = APP_VERSION, page: startPage = 'root', newView = false }) {
  const t = useT();
  const [place, setPlace] = useState(() => placeOf(startPage));
  const [query, setQuery] = useState('');
  const contentRef = useRef(null);
  const searchTarget = useRef(null);
  const [searchNavigation, setSearchNavigation] = useState(0);

  const go = useCallback((next) => setPlace(next), []);
  // System Back on a page goes up one step, as the header's Back does: a page opened from another
  // page to that page, a page to the first screen.
  const back = useCallback(() => {
    setPlace((p) => (p.sub ? SUB_PAGES[p.sub].parent : { nav: 'root' }));
  }, []);
  useBackLayer(place.nav !== 'root', back);
  // A page that holds unsaved edits (Views' editor) asks before the header's Back leaves it.
  const leaveGuard = useRef(null);
  const setLeaveGuard = useCallback((check) => { leaveGuard.current = check; }, []);
  const headerBack = useCallback(() => (leaveGuard.current ? leaveGuard.current(back) : back()), [back]);
  const [pendingNewView, setPendingNewView] = useState(newView);

  const reauthState = useMobileStore((s) => s.reauthState);
  const premium = useMobileStore((s) => s.premium);
  const premiumLost = useMobileStore((s) => s.premiumLost);
  // A search result lands on its setting once its page is open, as desktop's does.
  useEffect(() => {
    if (!searchNavigation) return undefined;
    const root = contentRef.current;
    const labelKey = searchTarget.current;
    if (!root || !labelKey) return undefined;
    return landOnSetting(root, settingText(t(labelKey)));
    // `t` follows the language; a language change is not a new search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchNavigation]);

  const reauthCode = reauthState && !reauthState.busy ? reauthState.code : null;
  const nav = place.nav;
  const host = settingsHosts[nav] ? { id: nav, ...settingsHosts[nav] } : null;
  const entry = host || tabsById[nav];
  const visible = (e) => navEntryOnPhone(e) && (e.id !== 'billing' || premium.premium);

  const openResult = (page) => {
    const to = placeOf(page.id);
    if (page.section && (page.id === 'appearance' || page.id === 'mail-preferences' || page.id === 'accounts')) to.section = page.section;
    searchTarget.current = page.keywords ? page.labelKey : null;
    setQuery('');
    setPlace(to);
    setSearchNavigation((n) => n + 1);
  };
  const results = query.trim() ? searchSettings(t, query, mobileSearchPages) : [];

  const navItem = (tab) => (
    <button key={tab.id} type="button" className="settings-nav-item" data-mv-settings-page={tab.id} onClick={() => go(placeOf(tab.id))}>
      <tab.icon size={17} aria-hidden="true" />
      <span className="text-sm font-medium">{t(tab.labelKey)}</span>
    </button>
  );

  const title = place.sub ? t(SUB_PAGES[place.sub].titleKey) : nav === 'root' ? t('mobile.settings.title') : entry ? t(entry.labelKey) : '';
  const description = !place.sub && !host && entry?.descriptionKey ? t(entry.descriptionKey) : null;

  /** A host page's or a section's content: desktop's views (settings/). */
  const pageContent = (id) => {
    switch (id) {
      case 'behavior': return <Behavior />;
      case 'notifications': return <Notifications />;
      case 'fields': return <Fields />;
      case 'storage': return <Storage />;
      case 'data-usage': return <DataUsage />;
      case 'security': return <Security />;
      case 'tracking': return <Tracking />;
      case 'encryption': return <Encryption />;
      case 'network-activity': return <NetworkActivity />;
      case 'daemon': return <PendingActions />;
      case 'logs': return <Logs />;
      default: return null;
    }
  };

  const tabbed = (tabs, value, onChange, label) => (
    <SettingsTabs tabs={tabs} value={value} onChange={onChange} label={label}>
      {pageContent(value)}
    </SettingsTabs>
  );

  let body = null;
  if (place.sub === 'transfer') body = <Transfer />;
  else if (host) {
    const pages = host.pages.filter((id) => navEntryOnPhone({ id }));
    const tab = pages.includes(place.tab) ? place.tab : pages[0];
    body = tabbed(pages.map((id) => ({ id, label: t(MOBILE_PAGE_LABELS[id] || tabsById[id].labelKey) })), tab, (id) => go({ nav, tab: id }), t(host.labelKey));
  } else if (entry && onPhoneNotice(MOBILE_PAGES[nav])) {
    body = <DesktopNoticeView feature={t(entry.labelKey)} icon={entry.icon} />;
  } else if (nav === 'appearance') {
    body = <Appearance section={place.section} onSectionChange={(section) => setPlace((p) => ({ ...p, section }))} version={version} />;
  } else if (nav === 'mail-preferences') {
    const section = MAIL_SECTIONS.some(([id]) => id === place.section) ? place.section : 'behavior';
    body = tabbed(MAIL_SECTIONS.map(([id, key]) => ({ id, label: t(key) })), section, (id) => go({ nav, section: id }), t('settings.navigation.mailPreferences'));
  } else if (nav === 'accounts') {
    body = (
      <>
        {reauthCode && <p className="settings-form text-sm text-mail-danger" role="alert">{t(errorKey(reauthCode))}</p>}
        <Accounts section={place.section} onSectionChange={(section) => setPlace((p) => ({ ...p, section }))} onAddAccount={onAddAccount}
          onExport={() => go({ nav: 'accounts', sub: 'transfer' })} />
      </>
    );
  } else if (nav === 'templates') {
    body = <Templates />;
  } else if (nav === 'views') {
    body = <Views startNew={pendingNewView} onStarted={() => setPendingNewView(false)} onLeaveGuard={setLeaveGuard} />;
  } else if (nav === 'ai-providers') {
    body = <AiProviders />;
  } else if (nav === 'unsubscribe') {
    body = <Unsubscribe />;
  } else if (nav === 'billing') {
    body = <Billing />;
  } else if (nav === 'help') {
    body = <Help onReplayTour={onReplayTour} version={version} />;
  }

  const onKey = place.sub || nav;
  return (
    <KeyboardLayer as="section" className="mv-settings mv-shared-ui" scroll=".mv-settings__body" role="dialog" aria-modal="true" aria-label={t('mobile.settings.title')}>
      <SettingsViewProvider t={t} locale={getMobileLocale()}>
        <header className="settings-header mv-settings__header">
          <div className="settings-header-context flex items-center gap-3 min-w-0">
            <Button variant="ghost" icon size="md" aria-label={t('common.back')} onClick={nav === 'root' ? onClose : headerBack}>
              <ChevronLeft size={20} className="text-mail-text-muted" aria-hidden="true" />
            </Button>
            <div className="settings-header-title min-w-0">
              <h1 className="text-lg font-semibold text-mail-text truncate">{title}</h1>
              {description && <p className="settings-page-description">{description}</p>}
            </div>
          </div>
        </header>
        <div className="mv-settings__body settings-content" ref={contentRef} key={onKey} data-mv-settings-on={onKey} data-page={place.tab || nav}>
          {nav === 'root' ? (
            <div className="settings-sidebar mv-settings__nav">
              <nav className="settings-navigation" aria-label={t('mobile.settings.title')}>
                <div className="settings-search">
                  <Search size={15} aria-hidden="true" />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} type="search"
                    aria-label={t('settings.navigation.searchSetting')} placeholder={t('settings.navigation.searchSetting')} />
                  {query && <Button variant="ghost" icon size="xs" onClick={() => setQuery('')} aria-label={t('common.clear')}><X size={14} /></Button>}
                </div>
                <div className="settings-nav-pages">
                  {query.trim() ? (
                    <>
                      <p className="settings-nav-heading" role="status">{t('settings.navigation.results', { count: results.length })}</p>
                      {results.map((page) => (
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
                  ) : (
                    <>
                      <p className="settings-nav-heading">{t('common.premium')}</p>
                      <button type="button" className="settings-nav-item" data-mv-premium-row
                        onClick={() => useMobileStore.getState().openPaywall(null)}>
                        <CreditCard size={17} aria-hidden="true" />
                        <span className="text-sm font-medium">{premiumSummary(premium)}</span>
                      </button>
                      {premiumLost === 'DEVICE_REPLACED' && !premium.premium && (
                        <p className="px-3 py-2 text-xs text-mail-danger" role="alert" data-mv-premium-lost>
                          {t('mobile.premium.deviceReplaced')}{' '}
                          <Button variant="link" size="xs" onClick={() => useMobileStore.getState().openPaywall(null, { signIn: true })}>
                            {t('mobile.premium.signInAgain')}
                          </Button>
                        </p>
                      )}
                      {settingsSections.map((section) => {
                        const tabs = section.tabs.filter(visible);
                        return tabs.length ? (
                          <React.Fragment key={section.labelKey}>
                            <p className="settings-nav-heading">{t(section.labelKey)}</p>
                            {tabs.map(navItem)}
                          </React.Fragment>
                        ) : null;
                      })}
                    </>
                  )}
                </div>
                {!query.trim() && <div className="settings-nav-footer">{footerTabs.filter(visible).map(navItem)}</div>}
              </nav>
            </div>
          ) : body}
        </div>
      </SettingsViewProvider>
    </KeyboardLayer>
  );
}
