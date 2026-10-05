import React from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Loader, PictureInPicture2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { saveOneFile, saveFilesToDirectory } from '../../services/export/exportSaver';
import { sidecarName } from '../../services/export/exportNaming';
import { buildLocal } from '../../services/export/exportSource';
import { EMAIL_WIDTH } from '../../services/export/social/socialLayout';
import { useT } from '../../i18n/index.js';
import { usePrivateAttr } from '../../hooks/usePrivacy';
import { usePrivacyStore } from '../../stores/privacyStore';
import { Choice } from './ExportChoice';
import { ExportPreview, useExportPreview } from './ExportPreview';

/**
 * The Image and HTML export: the options, the preview beside them, the save.
 * `opts` is useExportOptions, owned by the dialog or the export window.
 * `build` is where the files come from: here, or the main window when this
 * is the window (ExportWindow). `onPopOut` offers it in a window of its own,
 * `onPopIn` brings it back; either is portaled into `headerSlot` (an element
 * of the dialog or window header), or sits in the footer when that is undefined.
 */
export function ExportFilesPanel({ opts, format, messages, account, mailbox, build = buildLocal, detached = false, onDone, onPopOut, onPopIn, headerSlot }) {
  const t = useT();
  const pa = usePrivateAttr();
  const { layout, mirror, attachments, redact, redactStyle, width, busy, notice } = opts;
  const isThread = messages.length > 1;
  const showLayout = format === 'image' && isThread;
  // Privacy mode on (someone may be recording): the preview is masked whatever the checkbox says.
  const privacyOn = usePrivacyStore(s => s.enabled);
  const preview = useExportPreview({
    enabled: true, messages, format, layout: showLayout ? layout : 'single',
    mirror, redact: redact || privacyOn, redactStyle, width, account, mailbox, build,
  });

  const run = async () => {
    opts.setBusy(true);
    opts.setNotice(null);
    try {
      // HTML always gets bars: a blur needs a stylesheet the file cannot promise.
      const redactOpts = redact ? { style: format === 'html' ? 'bar' : redactStyle } : null;
      const result = await build({
        messages, format, layout, mirror, attachments, account, mailbox, redact: redactOpts,
        ...(format === 'image' ? { width } : {}),
      });
      if (!result.ok) {
        opts.setNotice(result.reason === 'premium'
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
      if (notices.length) opts.setNotice(notices.join(' '));
      else onDone?.();
    } catch (err) {
      opts.setNotice(t('export.dialog.exportFailed', { err: err.message || err }));
    } finally {
      opts.setBusy(false);
    }
  };

  const handOff = onPopOut ?? onPopIn;
  const windowButton = handOff && (
    <Button variant="ghost" size="sm" className={headerSlot ? '' : 'mr-auto'} disabled={busy}
      onClick={() => handOff(opts.choices(format))}>
      {onPopOut ? <ExternalLink size={14} aria-hidden="true" /> : <PictureInPicture2 size={14} aria-hidden="true" />}
      {onPopOut ? t('export.social.popOut') : t('export.social.popIn')}
    </Button>
  );

  return (
    <>
      {headerSlot && windowButton && createPortal(windowButton, headerSlot)}
      <div className="flex-1 min-h-80 flex gap-5">
        <ExportPreview preview={preview} />
        <div className="w-80 shrink-0 space-y-4 min-w-0 overflow-y-auto pr-1">
          {showLayout && (
            <div className="grid grid-cols-2 gap-2">
              <Choice name="mv-export-layout" value="single" checked={layout === 'single'} onChange={opts.setLayout}
                label={t('export.dialog.layoutSingleLabel')} hint={t('export.dialog.layoutSingleHint')} />
              <Choice name="mv-export-layout" value="separate" checked={layout === 'separate'} onChange={opts.setLayout}
                label={t('export.dialog.layoutSeparateLabel')} hint={t('export.dialog.layoutSeparateHint')} />
            </div>
          )}

          {format === 'image' && (
            <label className="block space-y-1">
              <span className="flex justify-between text-xs font-medium text-mail-text-muted">
                <span>{t('export.social.width')}</span><span>{`${width}px`}</span>
              </span>
              <input type="range" min={EMAIL_WIDTH.min} max={EMAIL_WIDTH.max} step={EMAIL_WIDTH.step} value={width} className="w-full"
                aria-label={t('export.social.width')} onChange={e => opts.setWidth(Number(e.target.value))} />
            </label>
          )}

          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={mirror} onChange={e => opts.setMirror(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="block text-sm text-mail-text">{t('export.dialog.mirrorRemoteContent')}</span>
              <span className="block text-xs text-mail-text-muted">
                {t('export.dialog.fetchesImagesSendersServersSo')}
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={attachments} onChange={e => opts.setAttachments(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="block text-sm text-mail-text">{t('export.dialog.includeAttachments')}</span>
              <span className="block text-xs text-mail-text-muted">
                {t('export.dialog.includeAttachmentsHint')}
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={redact} onChange={e => opts.turnRedact(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="block text-sm text-mail-text">{t('export.dialog.redactLabel')}</span>
              <span className="block text-xs text-mail-text-muted">
                {t('export.dialog.redactHint')}
              </span>
            </span>
          </label>

          {redact && format === 'image' && (
            <div className="grid grid-cols-2 gap-2">
              <Choice name="mv-export-redact-style" value="blur" checked={redactStyle === 'blur'} onChange={opts.setRedactStyle}
                label={t('export.dialog.redactStyleBlur')} />
              <Choice name="mv-export-redact-style" value="bar" checked={redactStyle === 'bar'} onChange={opts.setRedactStyle}
                label={t('export.dialog.redactStyleBar')} />
            </div>
          )}
        </div>
      </div>

      {notice && <p className="text-xs text-mail-danger">{notice}</p>}

      <div className="flex items-center justify-end gap-2">
        {headerSlot === undefined && windowButton}
        <Button variant="ghost" size="sm" onClick={onDone} disabled={busy}>{detached ? t('common.close') : t('common.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={run} disabled={busy}>
          {busy && <Loader size={14} className="animate-spin" />}{t('common.export')}
        </Button>
      </div>
    </>
  );
}
