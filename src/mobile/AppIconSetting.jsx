// Settings > Appearance > App icon (desktop's AppIconSettings): purple or teal. Picking one
// switches the home screen icon at once (the shell's `mobile_app_icon`), then stores `appIcon`,
// which the store keeps the OS icon following (appIcon.js), so a desktop import applies it too.
// A switch the OS refuses leaves the preference as it was and says so.
import React, { useState } from 'react';
import purple from '../assets/mailvault-icon.png';
import teal from '../assets/mailvault-icon-teal.png';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';
import { setAppIcon } from './transport.js';
import { APP_ICON_NAMES, normalizeAppIcon } from './appIcon.js';

const IMAGES = { purple, teal };

export default function AppIconSetting() {
  const t = useT();
  const selected = useMobileStore((s) => normalizeAppIcon(s.prefs.appIcon));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const choose = async (icon) => {
    if (busy || icon === selected) return;
    setBusy(true);
    setFailed(false);
    try {
      await setAppIcon(icon);
      if (!(await useMobileStore.getState().setPrefs({ appIcon: icon }))) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mv-setting" data-mv-pref="appIcon" style={{ flexWrap: 'wrap' }}>
      <span className="mv-setting__text">
        <span className="mv-setting__label">{t('settings.icons.title')}</span>
        {failed && <span className="mv-setting__hint" role="alert">{t('settings.icons.error')}</span>}
      </span>
      <span role="group" aria-label={t('settings.icons.title')} style={{ display: 'flex', gap: '12px' }}>
        {APP_ICON_NAMES.map((icon) => (
          <button
            key={icon}
            type="button"
            className="mv-textbtn"
            data-mv-app-icon={icon}
            aria-pressed={selected === icon}
            aria-label={t(`settings.icons.${icon}`)}
            disabled={busy}
            onClick={() => choose(icon)}
            style={{
              minHeight: '44px',
              padding: '4px',
              borderRadius: '12px',
              outline: selected === icon ? '2px solid var(--mail-accent)' : 'none',
            }}
          >
            <img src={IMAGES[icon]} width="40" height="40" alt="" style={{ display: 'block' }} />
          </button>
        ))}
      </span>
    </div>
  );
}
