// Settings' preference pages not yet on the shared desktop views (Appearance is:
// settings/Appearance.jsx), split the way desktop's pages split them (`section`): 'mail' (Mail
// preferences: reading, deleting, swipes, sending with its attachment reminder), 'security'
// (remote content, and link safety: scanning, and click confirmation while it scans) and
// 'tracking' (tracking pixels, which Premium strips while the switch is on). Each row writes one
// preference (`mobile.prefs.set`, through the store's setPrefs), read where it acts (viewer, list
// rows, compose). Labels reuse the desktop's catalog keys.
import React, { useId, useState } from 'react';
import { useMobileStore } from './store.js';
import { useT, getMobileLocale } from './i18n.js';
import { SWIPE_ACTIONS, SEND_DELAYS, MARK_READ_DELAYS } from './prefs.js';

function seconds(n) {
  return new Intl.NumberFormat(getMobileLocale(), { style: 'unit', unit: 'second', unitDisplay: 'short' }).format(n);
}

/** One preference as a labelled native picker: `options` are `[value, label]`. */
export function Choice({ label, value, options, onChange, disabled, name }) {
  const id = useId();
  return (
    <label className="mv-setting mv-setting--choice" htmlFor={id}>
      <span className="mv-setting__text">
        <span className="mv-setting__label">{label}</span>
      </span>
      <select
        id={id}
        className="mv-setting__select"
        data-mv-pref={name}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const hit = options.find(([v]) => String(v) === e.target.value);
          if (hit) onChange(hit[0]);
        }}
      >
        {options.map(([v, text]) => <option key={String(v)} value={String(v)}>{text}</option>)}
      </select>
    </label>
  );
}

export function Toggle({ label, hint, checked, onChange, name }) {
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={`${id}-l`}
      aria-describedby={hint ? `${id}-h` : undefined}
      className="mv-setting"
      data-mv-pref={name}
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

export default function SettingsPrefs({ section }) {
  const t = useT();
  const prefs = useMobileStore((s) => s.prefs);
  const [failed, setFailed] = useState(false);
  const set = async (patch) => {
    const ok = await useMobileStore.getState().setPrefs(patch);
    setFailed(!ok);
  };
  const swipeLabels = {
    toggleRead: t('settings.behavior.swipe.toggleRead'),
    delete: t('common.delete'),
    flag: t('mobile.actions.flag'),
    move: t('mobile.actions.move'),
    none: t('settings.behavior.swipe.none'),
  };
  const swipeOptions = SWIPE_ACTIONS.map((a) => [a, swipeLabels[a]]);
  const markDelays = MARK_READ_DELAYS.includes(prefs.markAsReadDelay) ? MARK_READ_DELAYS : [...MARK_READ_DELAYS, prefs.markAsReadDelay].sort((a, b) => a - b);
  const sendDelays = SEND_DELAYS.includes(prefs.sendDelay) ? SEND_DELAYS : [...SEND_DELAYS, prefs.sendDelay].sort((a, b) => a - b);

  return (
    <>
      {section === 'mail' && (
        <>
          <h2 className="mv-settings__heading">{t('settings.appearance.section.reading')}</h2>
          <div className="mv-settings__list">
            <Choice
              name="markAsReadMode"
              label={t('settings.behavior.markEmailsRead')}
              value={prefs.markAsReadMode}
              options={[
                ['auto', t('settings.behavior.immediatelyWhenOpened')],
                ['delay', t('settings.behavior.afterShortDelay')],
                ['manual', t('settings.behavior.manuallyOnly')],
              ]}
              onChange={(markAsReadMode) => set({ markAsReadMode })}
            />
            {prefs.markAsReadMode === 'delay' && (
              <Choice
                name="markAsReadDelay"
                label={t('settings.behavior.delayBeforeMarkingRead')}
                value={prefs.markAsReadDelay}
                options={markDelays.map((n) => [n, seconds(n)])}
                onChange={(markAsReadDelay) => set({ markAsReadDelay })}
              />
            )}
          </div>

          <h2 className="mv-settings__heading">{t('settings.behavior.deleting')}</h2>
          <div className="mv-settings__list">
            <Toggle
              name="confirmBeforeDelete"
              label={t('settings.behavior.confirmBeforeDelete')}
              checked={prefs.confirmBeforeDelete}
              onChange={(confirmBeforeDelete) => set({ confirmBeforeDelete })}
            />
            <Choice
              name="afterDeleteSelect"
              label={t('settings.behavior.afterDeleting')}
              value={prefs.afterDeleteSelect}
              options={[
                ['next', t('settings.behavior.afterDeleteSelectNext')],
                ['previous', t('settings.behavior.afterDeleteSelectPrevious')],
                ['none', t('settings.behavior.afterDeleteSelectNothing')],
              ]}
              onChange={(afterDeleteSelect) => set({ afterDeleteSelect })}
            />
            {prefs.afterDeleteSelect !== 'none' && (
              <Toggle
                name="afterDeleteSameAccount"
                label={t('settings.behavior.afterDeleteSameAccount')}
                hint={t('settings.behavior.afterDeleteSameAccountDesc')}
                checked={prefs.afterDeleteSameAccount}
                onChange={(afterDeleteSameAccount) => set({ afterDeleteSameAccount })}
              />
            )}
          </div>

          <h2 className="mv-settings__heading">{t('settings.behavior.swipe.title')}</h2>
          <div className="mv-settings__list">
            <Toggle
              name="trackpadSwipeEnabled"
              label={t('mobile.prefs.swipeRows')}
              hint={t('mobile.prefs.swipeRowsHint')}
              checked={prefs.trackpadSwipeEnabled}
              onChange={(trackpadSwipeEnabled) => set({ trackpadSwipeEnabled })}
            />
            {prefs.trackpadSwipeEnabled && (
              <>
                <Choice name="swipeLeftAction" label={t('settings.behavior.swipe.left')} value={prefs.swipeLeftAction} options={swipeOptions} onChange={(swipeLeftAction) => set({ swipeLeftAction })} />
                <Choice name="swipeRightAction" label={t('settings.behavior.swipe.right')} value={prefs.swipeRightAction} options={swipeOptions} onChange={(swipeRightAction) => set({ swipeRightAction })} />
              </>
            )}
          </div>

          <h2 className="mv-settings__heading">{t('settings.behavior.sending')}</h2>
          <div className="mv-settings__list">
            <Choice
              name="sendDelay"
              label={t('settings.behavior.sendDelay')}
              value={prefs.sendDelay}
              options={sendDelays.map((n) => [n, n === 0 ? t('settings.behavior.offSendImmediately') : seconds(n)])}
              onChange={(sendDelay) => set({ sendDelay })}
            />
            <Toggle
              name="defaultSignatureEnabled"
              label={t('settings.accounts.automaticallyAddOutgoingEmails')}
              checked={prefs.defaultSignatureEnabled}
              onChange={(defaultSignatureEnabled) => set({ defaultSignatureEnabled })}
            />
            <Toggle
              name="attachmentReminder"
              label={t('settings.behavior.attachmentReminder')}
              hint={t('settings.behavior.attachmentReminderDesc')}
              checked={prefs.attachmentReminder}
              onChange={(attachmentReminder) => set({ attachmentReminder })}
            />
          </div>
        </>
      )}
      {section === 'security' && (
        <div className="mv-settings__list">
          <Toggle
            name="holdExternalContent"
            label={t('mobile.prefs.loadImages')}
            hint={t('mobile.prefs.loadImagesHint')}
            checked={!prefs.holdExternalContent}
            onChange={(on) => set({ holdExternalContent: !on })}
          />
          <Toggle
            name="linkSafetyEnabled"
            label={t('settings.security.linkSafetyScanning')}
            hint={t('settings.security.detectSuspiciousLinksEmailsDon')}
            checked={prefs.linkSafetyEnabled}
            onChange={(linkSafetyEnabled) => set({ linkSafetyEnabled })}
          />
          {prefs.linkSafetyEnabled && (
            <Toggle
              name="linkSafetyClickConfirm"
              label={t('settings.security.clickConfirmation')}
              hint={t('settings.security.showWarningModalBeforeOpening')}
              checked={prefs.linkSafetyClickConfirm}
              onChange={(linkSafetyClickConfirm) => set({ linkSafetyClickConfirm })}
            />
          )}
        </div>
      )}
      {section === 'tracking' && (
        <div className="mv-settings__list">
          <Toggle
            name="trackerBlockingEnabled"
            label={t('settings.tracking.blockTrackingPixels')}
            hint={t('mobile.prefs.trackersPremiumHint')}
            checked={prefs.trackerBlockingEnabled}
            onChange={(trackerBlockingEnabled) => set({ trackerBlockingEnabled })}
          />
        </div>
      )}
      {failed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p>}
    </>
  );
}
