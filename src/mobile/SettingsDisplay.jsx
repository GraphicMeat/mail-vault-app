// More of Settings' preference pages, each row one preference (`mobile.prefs.set`, through the
// store's setPrefs), labelled with desktop's own catalog keys:
//
// - Appearance (`AppearanceMore`): text size and font (prefs.js applyLook: the root's font size,
//   which every rem in mobile.css follows, and the --app-font stack; every font ships with the
//   app, the phone downloads none), the message list's density and preview lines (MessageRow.jsx,
//   prefs.js rowHeight), how a message shows signatures (mailFrame.js foldSignatures) and how the
//   viewer's toolbar shows its buttons (Viewer.jsx).
// - Mail preferences (`MailMore`): the sync on opening the app (store.js init, App.jsx, the
//   engine's live catch-up) and attachments fetched as a message opens (AttachmentChip.jsx).
//   Whether rows swipe and, in All Inboxes, staying in the deleted message's account sit with
//   their sections in SettingsPrefs.jsx.
// - Notifications (`NotifyMore`): the system's sound on a new-mail notification and, on iOS, the
//   app icon's badge (the engine counts, the shell's background run sets it; an Android launcher
//   badges from the notifications themselves, so Android has no badge rows).
import React, { useState } from 'react';
import { useMobileStore } from './store.js';
import { useT, getMobileLocale } from './i18n.js';
import { Choice, Toggle } from './SettingsPrefs.jsx';
import {
  TEXT_SCALES, APP_FONTS, LIST_DENSITIES, PREVIEW_LINES, SIGNATURE_DISPLAYS, ACTION_BUTTON_DISPLAYS, BADGE_MODES,
} from './prefs.js';

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

function percent(n) {
  return new Intl.NumberFormat(getMobileLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(n);
}

/** The phone is an Android one (its launcher badges from the notifications, not the app). */
export function isAndroid() {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
}

export function AppearanceMore() {
  const t = useT();
  const prefs = useMobileStore((s) => s.prefs);
  const [set, failed] = useSet();
  const previewLabels = [t('listPreview.off'), t('listPreview.one'), t('listPreview.two'), t('listPreview.three')];
  return (
    <>
      <h2 className="mv-settings__heading">{t('settings.appearance.section.text')}</h2>
      <div className="mv-settings__list" data-mv-settings-text>
        <Choice
          name="textScale"
          label={t('settings.text.size')}
          value={prefs.textScale}
          options={TEXT_SCALES.map((v) => [v, percent(v)])}
          onChange={(textScale) => set({ textScale })}
        />
        <Choice
          name="appFont"
          label={t('settings.text.font')}
          value={prefs.appFont}
          options={APP_FONTS.map((f) => [f.id, f.family || t('settings.text.systemFont')])}
          onChange={(appFont) => set({ appFont })}
        />
      </div>

      <h2 className="mv-settings__heading">{t('workspace.messages')}</h2>
      <div className="mv-settings__list" data-mv-settings-rows>
        <Choice
          name="listDensity"
          label={t('workspace.listDensity')}
          value={prefs.listDensity}
          options={LIST_DENSITIES.map((v) => [v, t(v === 'compact' ? 'workspace.sidebarDensityCompact' : 'workspace.sidebarDensityComfortable')])}
          onChange={(listDensity) => set({ listDensity })}
        />
        <Choice
          name="listPreviewLines"
          label={t('listPreview.title')}
          value={prefs.listPreviewLines}
          options={PREVIEW_LINES.map((n) => [n, previewLabels[n]])}
          onChange={(listPreviewLines) => set({ listPreviewLines })}
        />
        <Choice
          name="signatureDisplay"
          label={t('settings.appearance.signatureDisplay')}
          value={prefs.signatureDisplay}
          options={SIGNATURE_DISPLAYS.map((v) => [v, t({
            smart: 'settings.appearance.smart',
            collapsed: 'settings.appearance.collapsed',
            'always-show': 'settings.appearance.alwaysShow',
            'always-hide': 'settings.appearance.alwaysHide',
          }[v])])}
          onChange={(signatureDisplay) => set({ signatureDisplay })}
        />
        <Choice
          name="actionButtonDisplay"
          label={t('settings.appearance.actionButtonStyle')}
          value={prefs.actionButtonDisplay}
          options={ACTION_BUTTON_DISPLAYS.map((v) => [v, t({
            'icon-only': 'settings.appearance.iconsOnly',
            'icon-label': 'settings.appearance.iconsLabels',
            'text-only': 'settings.appearance.labelsOnly',
          }[v])])}
          onChange={(actionButtonDisplay) => set({ actionButtonDisplay })}
        />
      </div>
      <Failed failed={failed} />
    </>
  );
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
