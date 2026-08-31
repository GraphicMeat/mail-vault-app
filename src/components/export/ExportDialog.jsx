import React, { useEffect, useState } from 'react';
import { ImageDown, FileCode2, Loader } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Z } from '../ui/layers';
import { hasPremiumAccess, useSettingsStore } from '../../stores/settingsStore';
import { buildExport } from '../../services/export/exportService';
import { saveOneFile, saveFilesToDirectory } from '../../services/export/exportSaver';
import { PremiumFeaturesLink } from '../PremiumFeaturesLink';
import { t, useT  } from '../../i18n/index.js';

// The label reads "Image" over a hint, but the accessible name is just the
// choice: "One tall image" and "Separate images" both contain the word image,
// and a radio group where three options answer to /image/ is one nobody — a
// screen reader user included — can pick from by name.
function Choice({ name, value, checked, onChange, icon: Icon, label, hint }) {
  return (
    <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors
      ${checked ? 'border-mail-accent bg-mail-accent-tint' : 'border-mail-border hover:border-mail-accent/50'}`}>
      <input type="radio" name={name} value={value} checked={checked} aria-label={label}
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

export function ExportDialog({ open, messages, account, mailbox, onClose, onUpgrade, onShowSamples }) {
  const t = useT();
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const isPremium = hasPremiumAccess(billingProfile);

  const [format, setFormat] = useState('image');
  const [layout, setLayout] = useState('single');
  const [mirror, setMirror] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  // The dialog is mounted once in App and only toggles `open`, so its state
  // outlives a close. Format, layout and mirror staying put is the useful half
  // — someone who exports HTML once usually means it again. The notice is the
  // other half: without this, the error from a failed export is still sitting
  // there when the next one opens, describing something that never happened.
  useEffect(() => {
    if (!open) return;
    setNotice(null);
    setBusy(false);
  }, [open]);

  const isThread = messages.length > 1;
  const showLayout = format === 'image' && isThread;

  const run = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await buildExport({ messages, format, layout, mirror, account, mailbox });
      if (!result.ok) {
        setNotice(result.reason === 'premium'
          ? t('export.dialog.exportPremiumFeature')
          : t('export.dialog.messageCouldExported'));
        return;
      }
      if (result.files.length === 1) await saveOneFile(result.files[0], t('common.export'));
      else await saveFilesToDirectory(result.files, t('common.export'));

      if (result.partial) {
        const n = result.failures.length;
        setNotice(t('export.dialog.exportedSomeFailed', {
          count: n,
          failed: result.failures.map(f => f.subject || f.uid).join(', '),
        }));
      } else {
        onClose?.();
      }
    } catch (err) {
      setNotice(t('export.dialog.exportFailed', { err: err.message || err }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} z={Z.dialog} portal size="md"
      title={isThread ? t('export.dialog.exportMessagesTitle', { count: messages.length }) : t('export.dialog.exportMessageTitle')}
      panelBg="bg-mail-surface">
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
          <div className="grid grid-cols-2 gap-2">
            <Choice name="mv-export-format" value="image" checked={format === 'image'} onChange={setFormat}
              icon={ImageDown} label={t('export.dialog.formatImageLabel')} hint={t('export.dialog.formatImageHint')} />
            <Choice name="mv-export-format" value="html" checked={format === 'html'} onChange={setFormat}
              icon={FileCode2} label={t('export.dialog.formatHtmlLabel')} hint={t('export.dialog.formatHtmlHint')} />
          </div>

          {showLayout && (
            <div className="grid grid-cols-2 gap-2">
              <Choice name="mv-export-layout" value="single" checked={layout === 'single'} onChange={setLayout}
                label={t('export.dialog.layoutSingleLabel')} hint={t('export.dialog.layoutSingleHint')} />
              <Choice name="mv-export-layout" value="separate" checked={layout === 'separate'} onChange={setLayout}
                label={t('export.dialog.layoutSeparateLabel')} hint={t('export.dialog.layoutSeparateHint')} />
            </div>
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

          {notice && <p className="text-xs text-mail-danger">{notice}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={run} disabled={busy}>
              {busy ? <Loader size={14} className="animate-spin" /> : t('common.export')}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
