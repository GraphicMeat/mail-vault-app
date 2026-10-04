import React, { useEffect, useState } from 'react';
import { ImageDown, FileCode2, Share2, Loader } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Z } from '../ui/layers';
import { hasPremiumAccess, useSettingsStore } from '../../stores/settingsStore';
import { buildExport } from '../../services/export/exportService';
import { saveOneFile, saveFilesToDirectory } from '../../services/export/exportSaver';
import { sidecarName } from '../../services/export/exportNaming';
import { EMAIL_WIDTH } from '../../services/export/social/socialLayout';
import { PremiumFeaturesLink } from '../PremiumFeaturesLink';
import { t, useT  } from '../../i18n/index.js';
import { usePrivateAttr } from '../../hooks/usePrivacy';
import { usePrivacyStore } from '../../stores/privacyStore';
import { useThemeStore } from '../../stores/themeStore';
import { ensurePrivacyDictionary } from '../../utils/privacy/privacyDictionary';
import { SocialExportPanel } from './SocialExportPanel';
import { ExportPreview, useExportPreview } from './ExportPreview';

// The label reads "Image" over a hint, but the accessible name is just the
// choice: "One tall image" and "Separate images" both contain the word image,
// and a radio group where three options answer to /image/ is one nobody — a
// screen reader user included — can pick from by name.
function Choice({ name, value, checked, onChange, icon: Icon, label, hint, disabled = false }) {
  return (
    <label className={`flex items-start gap-2 p-3 rounded-lg border transition-colors
      ${disabled ? 'opacity-50 cursor-not-allowed border-mail-border' : 'cursor-pointer'}
      ${checked ? 'border-mail-accent bg-mail-accent-tint' : disabled ? '' : 'border-mail-border hover:border-mail-accent/50'}`}>
      <input type="radio" name={name} value={value} checked={checked} aria-label={label} disabled={disabled}
        onChange={() => onChange(value)} className="mt-0.5" />
      <span className="flex-1">
        <span className="flex items-center gap-1.5 text-sm text-mail-text font-medium">
          {Icon && <Icon size={14} />}{label}
        </span>
        {hint && <span className="block text-xs text-mail-text-muted mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

// `social`: the Social panel's choices coming back from its own window; the
// dialog opens on Social with them. `onPopOut(choices)` moves the panel there.
export function ExportDialog({ open, messages, account, mailbox, social, onClose, onUpgrade, onShowSamples, onPopOut }) {
  const t = useT();
  // The capture can flip the page theme under the dialog (a Light/Dark app shot):
  // pinning the real theme on the panel re-declares its variables for its subtree.
  const liveTheme = useThemeStore(s => s.theme);
  const palette = useThemeStore(s => s.palette);
  const pa = usePrivateAttr();
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const isPremium = hasPremiumAccess(billingProfile);

  const [format, setFormat] = useState('image');
  const [layout, setLayout] = useState('single');
  const [mirror, setMirror] = useState(true);
  const [attachments, setAttachments] = useState(true);
  const [redact, setRedact] = useState(false);
  const [redactStyle, setRedactStyle] = useState('blur');
  // The PNG's email column, CSS px. Per dialog, like the other choices.
  const [width, setWidth] = useState(EMAIL_WIDTH.default);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  // Where the Social panel puts its Open in window button: the dialog's header.
  const [popOutSlot, setPopOutSlot] = useState(null);

  // The dialog is mounted once in App and only toggles `open`, so its state
  // outlives a close. Format, layout and mirror staying put is the useful half
  // — someone who exports HTML once usually means it again. The notice is the
  // other half: without this, the error from a failed export is still sitting
  // there when the next one opens, describing something that never happened.
  // Redacting starts without attachments: their contents are not redacted.
  // Only on the switch to redacting, so a re-enabled checkbox stays on.
  const turnRedact = (on) => {
    setRedact(on);
    if (on && !redact) setAttachments(false);
  };

  useEffect(() => {
    if (!open) return;
    setNotice(null);
    setBusy(false);
    if (social) setFormat('social');
    // Someone recording with privacy mode on means a shareable export too.
    if (usePrivacyStore.getState().enabled) turnRedact(true);
  }, [open, social]);

  const isThread = messages.length > 1;
  // The dialog outlives a close: Social picked for one message must not stick
  // when it reopens on a thread, where Social is not offered.
  const activeFormat = isThread && format === 'social' ? 'image' : format;
  const isSocial = activeFormat === 'social';
  const showLayout = activeFormat === 'image' && isThread;
  const offerWindow = isPremium && isSocial && !!onPopOut;
  const showPreview = isPremium && !isSocial;
  // Privacy mode on (someone may be recording): the preview is masked whatever the checkbox says.
  const privacyOn = usePrivacyStore(s => s.enabled);
  // Turned on mid-dialog: the export follows, as it does when the dialog opens with it on.
  useEffect(() => {
    if (open && privacyOn) turnRedact(true);
  }, [privacyOn]);
  const preview = useExportPreview({
    enabled: open && showPreview, messages, format: activeFormat, layout: showLayout ? layout : 'single',
    mirror, redact: redact || privacyOn, redactStyle, width, account, mailbox,
  });

  const run = async () => {
    setBusy(true);
    setNotice(null);
    try {
      let redactOpts = null;
      if (redact) {
        // Not captureMask: that would mask the live UI too. The host builds the
        // dictionary while the export waits for it.
        // HTML always gets bars: a blur needs a stylesheet the file cannot promise.
        redactOpts = { style: activeFormat === 'html' ? 'bar' : redactStyle, dict: await ensurePrivacyDictionary() };
      }
      const result = await buildExport({
        messages, format: activeFormat, layout, mirror, attachments, account, mailbox, redact: redactOpts,
        ...(activeFormat === 'image' ? { width } : {}),
      });
      if (!result.ok) {
        setNotice(result.reason === 'premium'
          ? t('export.dialog.exportPremiumFeature')
          : t('export.dialog.messageCouldExported'));
        return;
      }
      const sidecars = result.sidecars || [];
      let unwritten;
      if (result.files.length === 1) {
        // Beside the one file, under the name the user picked for it — only the
        // saver knows that name, so only the saver can compose theirs.
        const saved = await saveOneFile(result.files[0], t('common.export'), sidecars);
        unwritten = saved?.failed || [];
      } else {
        // Into a directory there is no "beside": each one carries its full name.
        const named = sidecars.map(s => ({ name: sidecarName(s.stem, s.name), base64: s.base64 }));
        const saved = await saveFilesToDirectory([...result.files, ...named], t('common.export'));
        const isSidecar = new Set(named.map(f => f.name));
        unwritten = (saved?.failed || []).filter(n => isSidecar.has(n));
      }

      // Two independent failures — an attachment that never loaded and a
      // message that never rendered — so the dialog states both, not whichever
      // it checked first, and stays open while either is on screen.
      const notices = [];
      if (result.partial) {
        notices.push(t('export.dialog.exportedSomeFailed', {
          count: result.failures.length,
          failed: result.failures.map(f => pa(f.subject, 'text') || f.uid).join(', '),
        }));
      }
      const lost = [...(result.attachmentFailures || []), ...unwritten];
      if (lost.length) {
        notices.push(t('export.dialog.attachmentsFailed', { count: lost.length, failed: lost.map(name => pa(name, 'filename')).join(', ') }));
      }
      if (notices.length) setNotice(notices.join(' '));
      else onClose?.();
    } catch (err) {
      setNotice(t('export.dialog.exportFailed', { err: err.message || err }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} dismissable={!busy} z={Z.dialog} portal size={isSocial || showPreview ? 'xl' : 'md'}
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
        <>
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
            <SocialExportPanel message={messages[0]} account={account} mailbox={mailbox} onDone={onClose}
              initial={social} onPopOut={onPopOut} headerSlot={offerWindow ? popOutSlot : undefined} />
          ) : (<>
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-5">
              <ExportPreview preview={preview} />
              <div className="space-y-4 min-w-0">
                {showLayout && (
                  <div className="grid grid-cols-2 gap-2">
                    <Choice name="mv-export-layout" value="single" checked={layout === 'single'} onChange={setLayout}
                      label={t('export.dialog.layoutSingleLabel')} hint={t('export.dialog.layoutSingleHint')} />
                    <Choice name="mv-export-layout" value="separate" checked={layout === 'separate'} onChange={setLayout}
                      label={t('export.dialog.layoutSeparateLabel')} hint={t('export.dialog.layoutSeparateHint')} />
                  </div>
                )}

                {activeFormat === 'image' && (
                  <label className="block space-y-1">
                    <span className="flex justify-between text-xs font-medium text-mail-text-muted">
                      <span>{t('export.social.width')}</span><span>{`${width}px`}</span>
                    </span>
                    <input type="range" min={EMAIL_WIDTH.min} max={EMAIL_WIDTH.max} step={EMAIL_WIDTH.step} value={width} className="w-full"
                      aria-label={t('export.social.width')} onChange={e => setWidth(Number(e.target.value))} />
                  </label>
                )}

                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="checkbox" checked={mirror} onChange={e => setMirror(e.target.checked)} className="mt-0.5" />
                  <span>
                    <span className="block text-sm text-mail-text">{t('export.dialog.mirrorRemoteContent')}</span>
                    <span className="block text-xs text-mail-text-muted">
                      {t('export.dialog.fetchesImagesSendersServersSo')}
                    </span>
                  </span>
                </label>

                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="checkbox" checked={attachments} onChange={e => setAttachments(e.target.checked)} className="mt-0.5" />
                  <span>
                    <span className="block text-sm text-mail-text">{t('export.dialog.includeAttachments')}</span>
                    <span className="block text-xs text-mail-text-muted">
                      {t('export.dialog.includeAttachmentsHint')}
                    </span>
                  </span>
                </label>

                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="checkbox" checked={redact} onChange={e => turnRedact(e.target.checked)} className="mt-0.5" />
                  <span>
                    <span className="block text-sm text-mail-text">{t('export.dialog.redactLabel')}</span>
                    <span className="block text-xs text-mail-text-muted">
                      {t('export.dialog.redactHint')}
                    </span>
                  </span>
                </label>

                {redact && activeFormat === 'image' && (
                  <div className="grid grid-cols-2 gap-2">
                    <Choice name="mv-export-redact-style" value="blur" checked={redactStyle === 'blur'} onChange={setRedactStyle}
                      label={t('export.dialog.redactStyleBlur')} />
                    <Choice name="mv-export-redact-style" value="bar" checked={redactStyle === 'bar'} onChange={setRedactStyle}
                      label={t('export.dialog.redactStyleBar')} />
                  </div>
                )}
              </div>
            </div>

            {notice && <p className="text-xs text-mail-danger">{notice}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
              <Button variant="primary" size="sm" onClick={run} disabled={busy}>
                {busy && <Loader size={14} className="animate-spin" />}{t('common.export')}
              </Button>
            </div>
          </>)}
        </>
      )}
    </Dialog>
  );
}
