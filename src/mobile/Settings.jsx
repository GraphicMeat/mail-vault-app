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
// - Appearance, Mail preferences (Behavior, Notifications), Accounts, Templates, AI providers,
//   Unsubscribe and Privacy & security (Security, Tracking, Encryption, Network Activity) are
//   desktop's views over the phone's preferences and engine (settings/*.jsx). Accounts adds "Move
//   to another computer" under its list (TransferSettings.jsx), and its Add account hands over to
//   the phone's own sign-in flow (`onAddAccount`). The other pages are still the phone's own (each
//   in its file; `.mv-legacy` keeps them out of the desktop reset) until they move onto the shared
//   views too:
//   - Storage: Storage (with its Offline page: "Download in the background", then per account the
//     window, its room, progress and Download now) and the search index; Data usage.
//   - Diagnostics: unfinished server actions (PendingActions.jsx) and Logs.
//   - Help: desktop's Help & Support links as plain https anchors (the shell's navigation guard
//     hands each to the system browser), Replay tour (`onReplayTour`), the version and the source.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Search, X } from 'lucide-react';
import {
  settingsSections, footerTabs, settingsHosts, hostOf, tabsById, navEntryOnPhone, mobileSearchPages, searchSettings,
  settingText, landOnSetting,
} from '../components/settings/settingsManifest';
import { SettingsTabs } from '../components/ui/SettingsTabs';
import { Button } from '../components/ui/Button';
import { SettingsViewProvider } from '../components/settings/views/viewContext';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import KeyboardLayer from './KeyboardLayer.jsx';
import { useBackLayer } from './backStack.js';
import { useT, getMobileLocale } from './i18n.js';
import { faqUrl } from '../services/faqUrl.js';
import { appLink } from '../services/appLink.js';
import { DISCORD_INVITE } from '../utils/communityLinks.js';
import { errorKey } from './errors.js';
import { premiumSummary } from './premium.js';
import OfflineSettings from './OfflineSettings.jsx';
import Billing from './Billing.jsx';
import SearchIndexSettings from './SearchIndexSettings.jsx';
import PendingActions from './PendingActions.jsx';
import StorageSettings from './StorageSettings.jsx';
import LogsSettings from './LogsSettings.jsx';
import DataUsage from './DataUsage.jsx';
import NetworkActivity from './settings/NetworkActivity.jsx';
import TransferSettings from './TransferSettings.jsx';
import Appearance from './settings/Appearance.jsx';
import { Behavior, Notifications } from './settings/MailPreferences.jsx';
import { Encryption, Security, Tracking } from './settings/Privacy.jsx';
import Templates from './settings/Templates.jsx';
import Unsubscribe from './settings/Unsubscribe.jsx';
import AiProviders from './settings/AiProviders.jsx';
import Accounts, { MoveToComputer } from './settings/Accounts.jsx';

const SOURCE_URL = 'https://github.com/GraphicMeat/mail-vault-app';
const SITE = 'https://mailvaultapp.com/';
const APP_VERSION = import.meta.env?.MV_APP_VERSION || '';

/** Mail preferences' sections on the phone (desktop's behavior and notifications). */
const MAIL_SECTIONS = [['behavior', 'generalSettings.behavior'], ['notifications', 'settings.notifications.notifications']];

/**
 * Pages opened from another page, not the navigation: `{ parent, titleKey }`. Back returns to the
 * parent (Offline from Storage's row, Move to another computer from Accounts).
 */
const SUB_PAGES = {
  offline: { parent: { nav: 'storage', tab: 'storage' }, titleKey: 'mobile.settings.offline' },
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
    offline: { nav: 'storage', tab: 'storage', sub: 'offline' },
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

function Switch({ checked, busy, disabled, label, hint, onChange }) {
  const id = React.useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={`${id}-l`}
      aria-describedby={hint ? `${id}-h` : undefined}
      aria-busy={busy || undefined}
      className="mv-setting"
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
    >
      <span className="mv-setting__text">
        <span className="mv-setting__label" id={`${id}-l`}>{label}</span>
        {hint && <span className="mv-setting__hint" id={`${id}-h`}>{hint}</span>}
      </span>
      <span className="mv-switch" aria-hidden="true"><span className="mv-switch__knob" /></span>
    </button>
  );
}

function Chevron() {
  return (
    <svg className="mv-setting__chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** `page`: the page to open on (the first screen, `'root'`, by default): see `placeOf`. */
export default function Settings({ onClose, onReplayTour, onAddAccount, version = APP_VERSION, page: startPage = 'root' }) {
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

  const reauthState = useMobileStore((s) => s.reauthState);
  const premium = useMobileStore((s) => s.premium);
  const premiumLost = useMobileStore((s) => s.premiumLost);
  const [values, setValues] = useState(null); // Offline's `backgroundDownload` (`mobile.settings.*`)
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(null); // the key being saved
  const [problem, setProblem] = useState(null); // 'failed'
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    let live = true;
    daemonCall('mobile.settings.get').then(
      (v) => { if (live) setValues(v); },
      () => { if (live) setLoadFailed(true); },
    );
    return () => { live = false; };
  }, []);

  const save = useCallback(async (key, patch) => {
    setBusy(key);
    try {
      const next = await daemonCall('mobile.settings.set', patch);
      if (mounted.current) {
        setValues(next);
        setProblem(null);
      }
    } catch {
      if (mounted.current) setProblem('failed');
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, []);

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

  const ready = Boolean(values);
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

  const offlinePage = (
    <>
      {loadFailed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.loadFailed')}</p>}
      <div className="mv-settings__list">
        <Switch
          checked={values ? values.backgroundDownload !== false : true}
          busy={busy === 'backgroundDownload'}
          disabled={!ready}
          label={t('mobile.settings.downloadToggle')}
          hint={t('mobile.settings.downloadHint')}
          onChange={(v) => save('backgroundDownload', { backgroundDownload: v })}
        />
      </div>
      {problem === 'failed' && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p>}
      <OfflineSettings />
    </>
  );

  /**
   * A host page's or a section's content: desktop's views (settings/), or the phone's own pages not
   * moved onto views yet, inside `.mv-legacy`.
   */
  const pageContent = (id) => {
    const legacy = (page) => <div className="mv-legacy">{page}</div>;
    switch (id) {
      case 'behavior': return <Behavior />;
      case 'notifications': return <Notifications />;
      case 'storage': return legacy(<><StorageSettings onOpenOffline={() => go({ nav: 'storage', tab: 'storage', sub: 'offline' })} /><SearchIndexSettings /></>);
      case 'data-usage': return legacy(<DataUsage />);
      case 'security': return <Security />;
      case 'tracking': return <Tracking />;
      case 'encryption': return <Encryption />;
      case 'network-activity': return <NetworkActivity />;
      case 'daemon': return legacy(<PendingActions />);
      case 'logs': return legacy(<LogsSettings />);
      default: return null;
    }
  };

  const tabbed = (tabs, value, onChange, label) => (
    <SettingsTabs tabs={tabs} value={value} onChange={onChange} label={label}>
      {pageContent(value)}
    </SettingsTabs>
  );

  let body = null;
  if (place.sub === 'offline') body = <div className="mv-legacy">{offlinePage}</div>;
  else if (place.sub === 'transfer') body = <div className="mv-legacy"><TransferSettings /></div>;
  else if (host) {
    const pages = host.pages.filter((id) => navEntryOnPhone({ id }));
    const tab = pages.includes(place.tab) ? place.tab : pages[0];
    body = tabbed(pages.map((id) => ({ id, label: t(tabsById[id].labelKey) })), tab, (id) => go({ nav, tab: id }), t(host.labelKey));
  } else if (nav === 'appearance') {
    body = <Appearance section={place.section} onSectionChange={(section) => setPlace((p) => ({ ...p, section }))} version={version} />;
  } else if (nav === 'mail-preferences') {
    const section = MAIL_SECTIONS.some(([id]) => id === place.section) ? place.section : 'behavior';
    body = tabbed(MAIL_SECTIONS.map(([id, key]) => ({ id, label: t(key) })), section, (id) => go({ nav, section: id }), t('settings.navigation.mailPreferences'));
  } else if (nav === 'accounts') {
    body = (
      <>
        {reauthCode && <p className="mv-settings__note mv-settings__note--error" role="alert">{t(errorKey(reauthCode))}</p>}
        <Accounts section={place.section} onSectionChange={(section) => setPlace((p) => ({ ...p, section }))} onAddAccount={onAddAccount}
          footer={<MoveToComputer onOpen={() => go({ nav: 'accounts', sub: 'transfer' })} />} />
      </>
    );
  } else if (nav === 'templates') {
    body = <Templates />;
  } else if (nav === 'ai-providers') {
    body = <AiProviders />;
  } else if (nav === 'unsubscribe') {
    body = <Unsubscribe />;
  } else if (nav === 'billing') {
    body = <div className="mv-legacy"><Billing /></div>;
  } else if (nav === 'help') {
    body = (
      <div className="mv-legacy mv-settings__list" data-mv-help>
        {/* Desktop's Help & Support links, as plain https anchors: the shell's navigation guard
            hands each to the system browser. */}
        {[
          ['faq', t('settings.help.faq'), t('settings.help.faqSubtitle'), faqUrl(getMobileLocale(), 'mobile_help')],
          ['bug', t('settings.help.reportBug'), t('settings.help.reportGithubEmailDeveloper'), `${SOURCE_URL}/issues`],
          ['discord', t('bugReport.joinDiscord'), null, DISCORD_INVITE],
          ['website', t('settings.help.mailvaultWebsite'), t('settings.help.docsFaqLatestRelease'), appLink(SITE, 'mobile_help')],
          ['privacy', t('settings.help.privacyPolicy'), t('settings.help.privacyPolicySubtitle'), `${SITE}privacy.html`],
        ].map(([key, label, hint, href]) => (
          <a key={key} className="mv-setting mv-settings__link" data-mv-help-link={key} href={href} target="_blank" rel="noopener noreferrer">
            <span className="mv-setting__text">
              <span className="mv-setting__label">{label}</span>
              {hint && <span className="mv-setting__hint">{hint}</span>}
            </span>
            <Chevron />
          </a>
        ))}
        {onReplayTour && (
          <button type="button" className="mv-setting" data-mv-replay-tour onClick={onReplayTour}>
            <span className="mv-setting__text">
              <span className="mv-setting__label">{t('mobile.settings.replayTour')}</span>
            </span>
          </button>
        )}
        {version && <p className="mv-settings__row">{t('mobile.settings.version', { version })}</p>}
        <a className="mv-settings__row mv-settings__link" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
          {t('mobile.settings.source')}
        </a>
      </div>
    );
  }

  const onKey = place.sub || nav;
  return (
    <KeyboardLayer as="section" className="mv-settings mv-shared-ui" scroll=".mv-settings__body" role="dialog" aria-modal="true" aria-label={t('mobile.settings.title')}>
      <SettingsViewProvider t={t} locale={getMobileLocale()}>
        <header className="settings-header mv-settings__header">
          <div className="settings-header-context flex items-center gap-3 min-w-0">
            <Button variant="ghost" icon size="md" aria-label={t('common.back')} onClick={nav === 'root' ? onClose : back}>
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
                      <div className="mv-legacy">
                        <button type="button" className="mv-setting mv-settings__premium" data-mv-premium-row
                          onClick={() => useMobileStore.getState().openPaywall(null)}>
                          <span className="mv-setting__text"><span className="mv-setting__label">{premiumSummary(premium)}</span></span>
                          <Chevron />
                        </button>
                        {premiumLost === 'DEVICE_REPLACED' && !premium.premium && (
                          <div className="mv-settings__note mv-settings__note--error" role="alert" data-mv-premium-lost>
                            {t('mobile.premium.deviceReplaced')}{' '}
                            <button type="button" className="mv-textbtn" onClick={() => useMobileStore.getState().openPaywall(null, { signIn: true })}>
                              {t('mobile.premium.signInAgain')}
                            </button>
                          </div>
                        )}
                      </div>
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
