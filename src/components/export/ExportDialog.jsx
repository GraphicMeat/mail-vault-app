import React, { useEffect, useState } from 'react';
import { ImageDown, FileCode2, Share2 } from 'lucide-react';
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
import { Choice } from './ExportChoice';
import { useExportOptions } from './useExportOptions';

// `social` / `files`: the choices of the Social or the Image and HTML export
// coming back from their own window; the dialog opens on that format with them.
// `onPopOut(choices)` moves the open format there (`choices.format` says which).
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
    if (social) setFormat('social');
    if (files) { setFormat(files.format); opts.restore(files); }
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
          <div className="grid grid-cols-3 gap-2">
            <Choice name="mv-export-format" value="image" checked={activeFormat === 'image'} onChange={setFormat}
              icon={ImageDown} label={t('export.dialog.formatImageLabel')} hint={t('export.dialog.formatImageHint')} />
            <Choice name="mv-export-format" value="html" checked={activeFormat === 'html'} onChange={setFormat}
              icon={FileCode2} label={t('export.dialog.formatHtmlLabel')} hint={t('export.dialog.formatHtmlHint')} />
            <Choice name="mv-export-format" value="social" checked={isSocial} onChange={setFormat} disabled={isThread}
              icon={Share2} label={t('export.social.formatLabel')}
              hint={isThread ? t('export.social.singleOnly') : t('export.social.formatHint')} />
          </div>

          {isSocial ? (
            <SocialExportPanel fill message={messages[0]} account={account} mailbox={mailbox} onDone={onClose}
              initial={social} onPopOut={onPopOut && (choices => onPopOut({ ...choices, format: 'social' }))}
              headerSlot={offerWindow ? popOutSlot : undefined} />
          ) : (
            <ExportFilesPanel opts={opts} format={activeFormat} messages={messages} account={account} mailbox={mailbox}
              onDone={onClose} onPopOut={onPopOut} headerSlot={offerWindow ? popOutSlot : undefined} />
          )}
        </div>
      )}
    </Dialog>
  );
}
