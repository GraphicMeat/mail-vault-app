// The settings screen: a full-screen layer opened from the folder drawer's footer.
//
// - Accounts: each with "Sign in again" when its provider sign-in lapsed (the store's one reauth)
//   and Remove after an inline confirm (the store's removeAccount; a refusal keeps the question).
// - Notifications: the switch asks the system's permission before it turns on, and stays off with
//   a pointer to the system settings when the answer is no. Each time the screen shows (and when
//   the app comes back to the front) it reads the system's current answer without asking: turned
//   off there, notifications show off here too, with the same pointer. "Show preview" decides
//   whether a notification names sender and subject, so it can only change while they are on.
//   Both live in the engine (`mobile.settings.*`): the background run has no page, and reads the
//   same rows.
// - Offline: "Download in the background" (`backgroundDownload`, on by default): background runs
//   fetch new mail and the bodies of recent INBOX mail, so it opens without a connection.
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
import { useT } from './i18n.js';
import { Avatar } from './AccountSwitcher.jsx';
import { errorKey } from './errors.js';
import { premiumSummary } from './premium.js';

const SOURCE_URL = 'https://github.com/GraphicMeat/mail-vault-app';
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

function AccountRow({ account, reauthBusy }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const name = account.displayName && account.displayName !== account.email ? account.displayName : null;

  if (confirming) {
    return (
      <li className="mv-setrow mv-acct--confirm">
        <p className="mv-acct__question" dir="auto">{t('mobile.switcher.removeConfirm', { email: account.email })}</p>
        <div className="mv-acct__actions">
          <button type="button" className="mv-textbtn" disabled={removing} onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="mv-textbtn mv-textbtn--danger"
            disabled={removing}
            onClick={async () => {
              setRemoving(true);
              try {
                await useMobileStore.getState().removeAccount(account.id);
              } catch {
                // Refused: the row stays, with its question, for another try (the store told the user).
              } finally {
                if (mounted.current) setRemoving(false);
              }
            }}
          >
            {t('common.remove')}
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="mv-setrow">
      <Avatar account={account} />
      <span className="mv-acct__text">
        {name && <span className="mv-acct__name" dir="auto">{name}</span>}
        <span className={name ? 'mv-acct__email mv-acct__email--sub' : 'mv-acct__email'} dir="auto">{account.email}</span>
      </span>
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
      <button
        type="button"
        className="mv-iconbtn mv-acct__remove"
        aria-label={t('mobile.switcher.remove', { email: account.email })}
        onClick={() => setConfirming(true)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M9 4h6m-9 3h12m-10 0 .7 12h6.6L16 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </li>
  );
}

export default function Settings({ onClose, onReplayTour, version = APP_VERSION }) {
  const t = useT();
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

  return (
    <KeyboardLayer as="section" className="mv-settings" scroll=".mv-settings__body" role="dialog" aria-modal="true" aria-label={t('mobile.settings.title')}>
      <header className="mv-compose__bar">
        <button type="button" className="mv-compose__back" onClick={onClose}>{t('common.back')}</button>
        <h1 className="mv-compose__title">{t('mobile.settings.title')}</h1>
      </header>
      <div className="mv-settings__body">
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

        <h2 className="mv-settings__heading">{t('mobile.settings.accounts')}</h2>
        {reauthCode && <p className="mv-settings__note mv-settings__note--error" role="alert">{t(errorKey(reauthCode))}</p>}
        <ul className="mv-settings__list">
          {accounts.map((a) => <AccountRow key={a.id} account={a} reauthBusy={reauthBusy} />)}
        </ul>

        <h2 className="mv-settings__heading">{t('mobile.settings.notifications')}</h2>
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
        </div>
        {problem === 'denied' && <p className="mv-settings__note" role="status">{t('mobile.settings.notifyDenied')}</p>}
        {problem === 'failed' && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p>}

        <h2 className="mv-settings__heading">{t('mobile.settings.offline')}</h2>
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

        <h2 className="mv-settings__heading">{t('mobile.settings.about')}</h2>
        <div className="mv-settings__list">
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
      </div>
    </KeyboardLayer>
  );
}
