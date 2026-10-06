import React, { useEffect, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Z } from '../ui/layers';
import { hasPremiumAccess, useSettingsStore } from '../../stores/settingsStore';
import { PremiumFeaturesLink } from '../PremiumFeaturesLink';
import { useT } from '../../i18n/index.js';
import { usePrivacyStore } from '../../stores/privacyStore';
import { useThemeStore } from '../../stores/themeStore';
import { SocialExportPanel } from './SocialExportPanel';
import { ExportFilesPanel } from './ExportFilesPanel';
import { ExportFormatTabs } from './ExportFormatTabs';
import { useExportOptions } from './useExportOptions';

// `social` / `files`: the choices of the Social and of the Image and HTML export
// coming back from the export window; the dialog opens on Social when it sent
// those, else on `files.format`, with each panel's choices under its own name
// (the two disagree: redact is on by default in one, off in the other).
// `onPopOut({ format, files, social? })` moves the open format there, with the
// choices of the Image and HTML export beside the open format's own.
// Premium fills the window with 32px around it: three formats' worth of preview
// and options do not fit a 672px column.
export function ExportDialog({ open, messages, account, mailbox, social, files, onClose, onUpgrade, onShowSamples, onPopOut }) {
  const t = useT();
  // The capture can flip the page theme under the dialog (a Light/Dark app shot):
  // pinning the real theme on the panel re-declares its variables for its subtree.
  const liveTheme = useThemeStore(s => s.theme);
  const palette = useThemeStore(s => s.palette);
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const isPremium = hasPremiumAccess(billingProfile);

  const [format, setFormat] = useState('image');
  const opts = useExportOptions();
  // Where the open format puts its Open in window button: the dialog's header.
  const [popOutSlot, setPopOutSlot] = useState(null);

  // The dialog is mounted once in App and only toggles `open`, so its state
  // outlives a close. Format, layout and mirror staying put is the useful half
  // — someone who exports HTML once usually means it again. The notice is the
  // other half: without this, the error from a failed export is still sitting
  // there when the next one opens, describing something that never happened.
  useEffect(() => {
    if (!open) return;
    opts.setNotice(null);
    opts.setBusy(false);
    if (files) opts.restore(files);
    if (social) setFormat('social');
    else if (files) setFormat(files.format);
    // Someone recording with privacy mode on means a shareable export too.
    if (usePrivacyStore.getState().enabled) opts.turnRedact(true);
  }, [open, social, files]);

  const isThread = messages.length > 1;
  // The dialog outlives a close: Social picked for one message must not stick
  // when it reopens on a thread, where Social is not offered.
  const activeFormat = isThread && format === 'social' ? 'image' : format;
  const isSocial = activeFormat === 'social';
  const offerWindow = isPremium && !!onPopOut;
  // Turned on mid-dialog: the export follows, as it does when the dialog opens with it on.
  const privacyOn = usePrivacyStore(s => s.enabled);
  useEffect(() => {
    if (open && privacyOn) opts.turnRedact(true);
  }, [privacyOn]);

  return (
    <Dialog open={open} onClose={onClose} dismissable={!opts.busy} z={Z.dialog} portal
      size={isPremium ? 'custom' : 'md'}
      className={isPremium ? 'p-8' : ''}
      panelClassName={isPremium ? 'w-full h-full overflow-y-auto rounded-2xl p-6 flex flex-col' : ''}
      title={isThread ? t('export.dialog.exportMessagesTitle', { count: messages.length }) : t('export.dialog.exportMessageTitle')}
      headerActions={offerWindow ? <span ref={setPopOutSlot} className="contents" /> : null}
      panelBg="bg-mail-surface" data-capture-exclude="" data-theme={liveTheme} data-palette={palette}>
      {!isPremium ? (
        <>
          <p className="text-sm text-mail-text-muted">
            {t('export.dialog.saveMessageOrThreadOffline')}
          </p>
          <div className="flex flex-col gap-2">
            <Button variant="primary" size="lg" fullWidth onClick={() => onUpgrade?.()}>{t('common.upgrade')}</Button>
            <Button variant="ghost" size="sm" fullWidth onClick={() => onShowSamples?.()}>{t('export.dialog.seeSamples')}</Button>
            <PremiumFeaturesLink className="self-center mt-1" />
          </div>
        </>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col gap-4">
          <ExportFormatTabs value={activeFormat} onChange={setFormat} socialDisabled={isThread} />

          {isSocial ? (
            <SocialExportPanel fill message={messages[0]} account={account} mailbox={mailbox} onDone={onClose}
              initial={social} onPopOut={onPopOut && (choices => onPopOut({ format: 'social', files: opts.choices('image'), social: choices }))}
              headerSlot={offerWindow ? popOutSlot : undefined} />
          ) : (
            <ExportFilesPanel opts={opts} format={activeFormat} messages={messages} account={account} mailbox={mailbox}
              onDone={onClose} onPopOut={onPopOut && (choices => onPopOut({ format: choices.format, files: choices }))} headerSlot={offerWindow ? popOutSlot : undefined} />
          )}
        </div>
      )}
    </Dialog>
  );
}
