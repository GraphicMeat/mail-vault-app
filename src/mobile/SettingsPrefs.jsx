// Settings' preference sections (W1a): what a desktop import carries over and the user can change
// here. Each row writes one preference (`mobile.prefs.set`, through the store's setPrefs) and the
// page follows at once: theme and palette on the root element, the rest read where they act
// (viewer, list rows, compose). The language row stores `language` (`mobile.settings.set`) and
// loads that catalog, as the tour's first step does. Labels reuse the desktop's catalog keys.
import React, { useId, useState } from 'react';
import { useMobileStore } from './store.js';
import { useT, getMobileLocale, loadMobileLocale } from './i18n.js';
import { daemonCall } from './transport.js';
import { LOCALES } from '../i18n/languages.js';
import { THEMES, PALETTES, SWIPE_ACTIONS, SEND_DELAYS, MARK_READ_DELAYS } from './prefs.js';

const DATE_FORMATS = ['auto', 'MM/dd/yyyy', 'dd/MM/yyyy', 'yyyy-MM-dd', 'dd MMM yyyy', 'custom'];

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

function Toggle({ label, hint, checked, onChange, name }) {
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

export default function SettingsPrefs() {
  const t = useT();
  const prefs = useMobileStore((s) => s.prefs);
  const [failed, setFailed] = useState(false);
  const [language, setLanguage] = useState(getMobileLocale());
  const set = async (patch) => {
    const ok = await useMobileStore.getState().setPrefs(patch);
    setFailed(!ok);
  };
  const pickLanguage = (code) => {
    setLanguage(code);
    // A failed write still switches this run; the next launch then follows the system.
    daemonCall('mobile.settings.set', { language: code }).catch(() => {});
    loadMobileLocale([code], code);
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
      <h2 className="mv-settings__heading">{t('settings.appearance.section.colors')}</h2>
      <div className="mv-settings__list" data-mv-settings-look>
        <Choice
          name="theme"
          label={t('settings.appearance.theme')}
          value={prefs.theme}
          options={THEMES.map((v) => [v, v === 'system' ? t('settings.section.system') : t(`settings.colors.${v}`)])}
          onChange={(theme) => set({ theme })}
        />
        <Choice
          name="palette"
          label={t('settings.colors.palette')}
          value={prefs.palette}
          options={PALETTES.map((v) => [v, t(`settings.colors.${v}`)])}
          onChange={(palette) => set({ palette })}
        />
        <Choice
          name="language"
          label={t('settings.language.tab')}
          value={language}
          options={LOCALES.map((l) => [l.code, l.native])}
          onChange={pickLanguage}
        />
      </div>

      <h2 className="mv-settings__heading">{t('settings.appearance.section.dateTime')}</h2>
      <div className="mv-settings__list">
        <Choice
          name="dateFormat"
          label={t('settings.appearance.dateFormat')}
          value={prefs.dateFormat}
          options={DATE_FORMATS.map((v) => [v, {
            auto: t('settings.appearance.default'),
            'MM/dd/yyyy': t('settings.appearance.mmDdYyyyUs'),
            'dd/MM/yyyy': t('settings.appearance.ddMmYyyyEurope'),
            'yyyy-MM-dd': t('settings.appearance.yyyyMmDdIso'),
            'dd MMM yyyy': t('settings.appearance.ddMmmYyyyExample'),
            custom: t('settings.appearance.custom'),
          }[v]])}
          onChange={(dateFormat) => set({ dateFormat })}
        />
        {prefs.dateFormat === 'custom' && (
          <label className="mv-setting mv-setting--choice">
            <input
              className="mv-setting__input"
              data-mv-pref="customDateFormat"
              defaultValue={prefs.customDateFormat}
              placeholder={t('settings.appearance.eGDdMmYyyy')}
              aria-label={t('settings.appearance.custom')}
              maxLength={64}
              onBlur={(e) => { if (e.target.value !== prefs.customDateFormat) set({ customDateFormat: e.target.value }); }}
            />
          </label>
        )}
        <Choice
          name="timeFormat"
          label={t('settings.appearance.timeFormat')}
          value={prefs.timeFormat}
          options={[['auto', t('settings.appearance.default')], ['12h', t('settings.appearance.twelveHour')], ['24h', t('settings.appearance.twentyFourHour')]]}
          onChange={(timeFormat) => set({ timeFormat })}
        />
      </div>

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
        <Toggle
          name="holdExternalContent"
          label={t('mobile.prefs.loadImages')}
          hint={t('mobile.prefs.loadImagesHint')}
          checked={!prefs.holdExternalContent}
          onChange={(on) => set({ holdExternalContent: !on })}
        />
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
      </div>

      <h2 className="mv-settings__heading">{t('settings.behavior.swipe.title')}</h2>
      <div className="mv-settings__list">
        <Choice name="swipeLeftAction" label={t('settings.behavior.swipe.left')} value={prefs.swipeLeftAction} options={swipeOptions} onChange={(swipeLeftAction) => set({ swipeLeftAction })} />
        <Choice name="swipeRightAction" label={t('settings.behavior.swipe.right')} value={prefs.swipeRightAction} options={swipeOptions} onChange={(swipeRightAction) => set({ swipeRightAction })} />
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
      </div>
      {failed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p>}
    </>
  );
}
