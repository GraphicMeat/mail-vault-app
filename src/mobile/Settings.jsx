// The settings screen: a full-screen layer opened from the folder drawer's footer. Laid out as
// desktop's Settings is: a first screen listing the pages under desktop's groups (General:
// Appearance, Mail preferences, Notifications; Accounts & import: Accounts; Vault & privacy:
// Offline, Privacy & security; Help: About), Premium above them, and each page on its own screen
// with Back to the list (`SETTINGS_PAGES`). What each page holds:
//
// - Accounts: each with "Sign in again" when its provider sign-in lapsed (the store's one reauth),
//   and Edit (AccountEditor.jsx: name, signature, hidden, and Remove after an inline confirm, as
//   desktop keeps it on the account's own page; no remove button sits next to an account). A hidden account is
//   listed here, marked, so it can be shown again.
// - Preferences (SettingsPrefs.jsx): look, date and time, reading, deleting, swipes, sending.
// - Notifications: the switch asks the system's permission before it turns on, and stays off with
//   a pointer to the system settings when the answer is no. Each time the screen shows (and when
//   the app comes back to the front) it reads the system's current answer without asking: turned
//   off there, notifications show off here too, with the same pointer. "Show preview" decides
//   whether a notification names sender and subject, so it can only change while they are on.
//   Both live in the engine (`mobile.settings.*`): the background run has no page, and reads the
//   same rows.
// - Offline: "Download in the background" (`backgroundDownload`, on by default): background runs
//   keep the offline window up to date, so mail opens without a connection; then, per account,
//   the window, the room it takes, the progress and "Download now" (OfflineSettings.jsx).
// - Premium (first): "Premium: active until <date> (App Store)" or "Free", opening the Premium
//   screen; a phone whose place another device took says so, with Sign in again.
// - Replay tour (`onReplayTour`): the first-run tour again, without its account step (App.jsx).
// - About: the version (a build constant) and the source link, a plain https anchor. The shell's
//   navigation guard cancels it in the webview and hands it to the system browser, the one path
//   every link takes; the page never opens a window itself.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { daemonCall, notificationPermission, requestNotificationPermission } from './transport.js';
import { useMobileStore } from './store.js';
import KeyboardLayer from './KeyboardLayer.jsx';
import { useBackLayer } from './backStack.js';
import { useT, getMobileLocale } from './i18n.js';
import { faqUrl } from '../services/faqUrl.js';
import { appLink } from '../services/appLink.js';
import { DISCORD_INVITE } from '../utils/communityLinks.js';
import { Avatar } from './AccountSwitcher.jsx';
import { errorKey } from './errors.js';
import { premiumSummary } from './premium.js';
import OfflineSettings from './OfflineSettings.jsx';
import SettingsPrefs from './SettingsPrefs.jsx';
import AccountEditor from './AccountEditor.jsx';

const SOURCE_URL = 'https://github.com/GraphicMeat/mail-vault-app';
const SITE = 'https://mailvaultapp.com/';
const APP_VERSION = import.meta.env?.MV_APP_VERSION || '';

function Switch({ checked, busy, disabled, label, hint, onChange }) {
  const id = useId();
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

/**
 * One account's notifications (`acct.<id>.notify`, `mobile.accountSettings.*`): on unless turned
 * off. Usable only while notifications are on (`enabled`): the switch above decides first.
 */
function AccountNotify({ account, enabled }) {
  const t = useT();
  const [on, setOn] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    daemonCall('mobile.accountSettings.get', { accountId: account.id }).then(
      (v) => { if (live) setOn(v?.notify !== false); },
      () => { if (live) setOn(true); },
    );
    return () => { live = false; };
  }, [account.id]);
  const change = useCallback(async (next) => {
    setBusy(true);
    try {
      const v = await daemonCall('mobile.accountSettings.set', { accountId: account.id, values: { notify: next } });
      setOn(v?.notify !== false);
    } catch {
      // The switch stays where it was.
    } finally {
      setBusy(false);
    }
  }, [account.id]);
  return (
    <Switch
      checked={on !== false}
      busy={busy}
      disabled={!enabled || on == null}
      label={t('mobile.settings.notifyAccount', { account: account.email })}
      onChange={change}
    />
  );
}

function AccountRow({ account, reauthBusy }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  // System Back closes the account's page first, as its Cancel does.
  const stopEditing = useCallback(() => setEditing(false), []);
  useBackLayer(editing, stopEditing);
  const name = account.displayName && account.displayName !== account.email ? account.displayName : null;

  if (editing) {
    return (
      <li className="mv-setrow mv-acct--confirm">
        <AccountEditor account={account} onDone={stopEditing} />
      </li>
    );
  }

  return (
    <li className="mv-setrow" data-mv-hidden={account.hidden ? '' : undefined}>
      <Avatar account={account} />
      <span className="mv-acct__text">
        {name && <span className="mv-acct__name" dir="auto">{name}</span>}
        <span className={name ? 'mv-acct__email mv-acct__email--sub' : 'mv-acct__email'} dir="auto">{account.email}</span>
        {account.hidden && <span className="mv-setting__hint">{t('mobile.accounts.hidden')}</span>}
      </span>
      <button type="button" className="mv-textbtn" data-mv-acct-edit onClick={() => setEditing(true)}>
        {t('outbox.edit')}
      </button>
      {account.needsAuth && account.oauth !== false && (
        <button
          type="button"
          className="mv-textbtn mv-acct__reauth"
          disabled={reauthBusy}
          onClick={() => useMobileStore.getState().reauth(account.id)}
        >
          {t('mobile.reauth.action')}
        </button>
      )}
    </li>
  );
}

/**
 * The first screen's pages in desktop's order and groups (SettingsPage.jsx's navigation), less
 * what a phone has no use for (vault, backup, daemon, shortcuts, ...). `[group, [page, title]]`.
 */
export const SETTINGS_PAGES = [
  ['settings.navigation.general', [['appearance', 'settings.appearance.appearance'], ['mail', 'settings.navigation.mailPreferences'], ['notifications', 'mobile.settings.notifications']]],
  ['settings.navigation.accountsImport', [['accounts', 'settings.tab.accounts']]],
  ['settings.navigation.vaultPrivacy', [['offline', 'mobile.settings.offline'], ['privacy', 'settings.tab.privacySecurity']]],
  ['settings.tab.help', [['help', 'settings.tab.help']]],
];
const PAGE_TITLES = Object.fromEntries(SETTINGS_PAGES.flatMap(([, pages]) => pages));

function Chevron() {
  return (
    <svg className="mv-setting__chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** `page`: the page to open on (the first screen, `'root'`, by default). */
export default function Settings({ onClose, onReplayTour, version = APP_VERSION, page: startPage = 'root' }) {
  const t = useT();
  const [page, setPage] = useState(startPage);
  // System Back on a page goes to the list first, as the header's Back does.
  const toList = useCallback(() => setPage('root'), []);
  useBackLayer(page !== 'root', toList);
  const accounts = useMobileStore((s) => s.accounts);
  const reauthState = useMobileStore((s) => s.reauthState);
  const [values, setValues] = useState(null); // { notifications: 'on'|'off', notificationPreview: bool }
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(null); // the key being saved
  const [problem, setProblem] = useState(null); // 'denied' | 'failed'
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

  // The system's answer against the stored "on": turned off in the system settings, they are off.
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const reconcile = useCallback(async () => {
    if (valuesRef.current?.notifications !== 'on') return;
    let granted = true;
    try {
      ({ granted } = await notificationPermission());
    } catch {
      return; // No answer: leave it as it is.
    }
    if (granted || !mounted.current || valuesRef.current?.notifications !== 'on') return;
    setProblem('denied');
    try {
      const next = await daemonCall('mobile.settings.set', { notifications: 'off' });
      if (mounted.current) setValues(next);
    } catch {
      if (mounted.current) setValues((v) => (v ? { ...v, notifications: 'off' } : v));
    }
  }, []);
  const checkedOnce = useRef(false);
  useEffect(() => {
    if (!values || checkedOnce.current) return;
    checkedOnce.current = true;
    reconcile();
  }, [values, reconcile]);
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onVisible = () => { if (document.visibilityState !== 'hidden') reconcile(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reconcile]);

  const onNotifications = useCallback(async (on) => {
    if (!on) return save('notifications', { notifications: 'off' });
    setBusy('notifications');
    let granted = false;
    try {
      ({ granted } = await requestNotificationPermission());
    } catch {
      if (mounted.current) { setProblem('failed'); setBusy(null); }
      return undefined;
    }
    if (!mounted.current) return undefined;
    if (!granted) {
      setProblem('denied');
      setBusy(null);
      return undefined;
    }
    return save('notifications', { notifications: 'on' });
  }, [save]);

  const premium = useMobileStore((s) => s.premium);
  const premiumLost = useMobileStore((s) => s.premiumLost);
  const ready = Boolean(values);
  const reauthBusy = Boolean(reauthState?.busy);
  const reauthCode = reauthState && !reauthState.busy ? reauthState.code : null;

  const title = page === 'root' ? t('mobile.settings.title') : t(PAGE_TITLES[page]);
  return (
    <KeyboardLayer as="section" className="mv-settings" scroll=".mv-settings__body" role="dialog" aria-modal="true" aria-label={t('mobile.settings.title')}>
      <header className="mv-compose__bar">
        <button type="button" className="mv-compose__back" onClick={page === 'root' ? onClose : toList}>{t('common.back')}</button>
        <h1 className="mv-compose__title">{title}</h1>
      </header>
      <div className="mv-settings__body" key={page} data-mv-settings-on={page}>
        {page === 'root' && (
          <>
            <h2 className="mv-settings__heading">{t('common.premium')}</h2>
            <div className="mv-settings__list">
              <button
                type="button"
                className="mv-setting"
                data-mv-premium-row
                onClick={() => useMobileStore.getState().openPaywall(null)}
              >
                <span className="mv-setting__text">
                  <span className="mv-setting__label">{premiumSummary(premium)}</span>
                </span>
                <Chevron />
              </button>
            </div>
            {premiumLost === 'DEVICE_REPLACED' && !premium.premium && (
              <div className="mv-settings__note mv-settings__note--error" role="alert" data-mv-premium-lost>
                {t('mobile.premium.deviceReplaced')}{' '}
                <button type="button" className="mv-textbtn" onClick={() => useMobileStore.getState().openPaywall(null, { signIn: true })}>
                  {t('mobile.premium.signInAgain')}
                </button>
              </div>
            )}
            {SETTINGS_PAGES.map(([group, pages]) => (
              <React.Fragment key={group}>
                <h2 className="mv-settings__heading">{t(group)}</h2>
                <div className="mv-settings__list">
                  {pages.map(([key, label]) => (
                    <button key={key} type="button" className="mv-setting" data-mv-settings-page={key} onClick={() => setPage(key)}>
                      <span className="mv-setting__text">
                        <span className="mv-setting__label">{t(label)}</span>
                      </span>
                      <Chevron />
                    </button>
                  ))}
                </div>
              </React.Fragment>
            ))}
          </>
        )}

        {page === 'appearance' && <SettingsPrefs section="appearance" />}
        {page === 'mail' && <SettingsPrefs section="mail" />}
        {page === 'privacy' && <SettingsPrefs section="privacy" />}

        {page === 'accounts' && (
          <>
            {reauthCode && <p className="mv-settings__note mv-settings__note--error" role="alert">{t(errorKey(reauthCode))}</p>}
            <ul className="mv-settings__list">
              {accounts.map((a) => <AccountRow key={a.id} account={a} reauthBusy={reauthBusy} />)}
            </ul>
          </>
        )}

        {page === 'notifications' && (
          <>
            {loadFailed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.loadFailed')}</p>}
            <div className="mv-settings__list">
              <Switch
                checked={values?.notifications === 'on'}
                busy={busy === 'notifications'}
                disabled={!ready}
                label={t('mobile.settings.notifyToggle')}
                hint={t('mobile.settings.notifyHint')}
                onChange={onNotifications}
              />
              <Switch
                checked={values ? values.notificationPreview !== false : true}
                busy={busy === 'notificationPreview'}
                disabled={!ready || values.notifications !== 'on'}
                label={t('mobile.settings.preview')}
                hint={t('mobile.settings.previewHint')}
                onChange={(v) => save('notificationPreview', { notificationPreview: v })}
              />
              {accounts.map((a) => <AccountNotify key={a.id} account={a} enabled={ready && values.notifications === 'on'} />)}
            </div>
            {problem === 'denied' && <p className="mv-settings__note" role="status">{t('mobile.settings.notifyDenied')}</p>}
            {problem === 'failed' && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p>}
          </>
        )}

        {page === 'offline' && (
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
        )}

        {page === 'help' && (
          <div className="mv-settings__list" data-mv-help>
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
        )}
      </div>
    </KeyboardLayer>
  );
}
