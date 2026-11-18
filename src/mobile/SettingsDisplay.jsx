// More of Settings' preference pages, each row one preference (`mobile.prefs.set`, through the
// store's setPrefs), labelled with desktop's own catalog keys (Appearance's rows are desktop's
// views now: settings/Appearance.jsx):
//
// - Mail preferences (`MailMore`): the sync on opening the app (store.js init, App.jsx, the
//   engine's live catch-up) and attachments fetched as a message opens (AttachmentChip.jsx).
//   Whether rows swipe and, in All Inboxes, staying in the deleted message's account sit with
//   their sections in SettingsPrefs.jsx.
// - Notifications (`NotifyMore`): the system's sound on a new-mail notification and, on iOS, the
//   app icon's badge (the engine counts, the shell's background run sets it; an Android launcher
//   badges from the notifications themselves, so Android has no badge rows).
import React, { useState } from 'react';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';
import { Choice, Toggle } from './SettingsPrefs.jsx';
import { BADGE_MODES } from './prefs.js';

function useSet() {
  const [failed, setFailed] = useState(false);
  const set = async (patch) => {
    const ok = await useMobileStore.getState().setPrefs(patch);
    setFailed(!ok);
  };
  return [set, failed];
}

function Failed({ failed }) {
  const t = useT();
  return failed ? <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p> : null;
}

/** The phone is an Android one (its launcher badges from the notifications, not the app). */
export function isAndroid() {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
}

export function MailMore() {
  const t = useT();
  const prefs = useMobileStore((s) => s.prefs);
  const [set, failed] = useSet();
  return (
    <>
      <h2 className="mv-settings__heading">{t('settings.behavior.emailSync')}</h2>
      <div className="mv-settings__list" data-mv-settings-mail-more>
        <Toggle
          name="refreshOnLaunch"
          label={t('settings.behavior.refreshAppLaunch')}
          checked={prefs.refreshOnLaunch}
          onChange={(refreshOnLaunch) => set({ refreshOnLaunch })}
        />
        <Toggle
          name="autoDownloadAttachments"
          label={t('settings.behavior.autoDownloadAttachments')}
          hint={t('mobile.prefs.autoDownloadHint')}
          checked={prefs.autoDownloadAttachments}
          onChange={(autoDownloadAttachments) => set({ autoDownloadAttachments })}
        />
      </div>
      <Failed failed={failed} />
    </>
  );
}

/** `enabled`: notifications are on (the rows show only then). */
export function NotifyMore({ enabled }) {
  const t = useT();
  const prefs = useMobileStore((s) => s.prefs);
  const [set, failed] = useSet();
  const badges = !isAndroid();
  // Both act through notifications (the badge's permission comes with theirs): shown while on.
  if (!enabled) return null;
  return (
    <>
      <div className="mv-settings__list" data-mv-settings-notify-more>
        <Toggle
          name="notificationSound"
          label={t('settings.notifications.newEmailSound')}
          hint={t('mobile.prefs.soundHint')}
          checked={prefs.notificationSound}
          onChange={(notificationSound) => set({ notificationSound })}
        />
        {badges && (
          <Toggle
            name="badgeEnabled"
            label={t('settings.notifications.showBadgeCount')}
            hint={t('mobile.prefs.badgeHint')}
            checked={prefs.badgeEnabled}
            onChange={(badgeEnabled) => set({ badgeEnabled })}
          />
        )}
        {badges && prefs.badgeEnabled && (
          <Choice
            name="badgeMode"
            label={t('settings.notifications.badgeShows')}
            value={prefs.badgeMode}
            options={BADGE_MODES.map((v) => [v, t(v === 'total' ? 'settings.notifications.totalMessages' : 'settings.notifications.unreadMessages')])}
            onChange={(badgeMode) => set({ badgeMode })}
          />
        )}
      </div>
      <Failed failed={failed} />
    </>
  );
}
