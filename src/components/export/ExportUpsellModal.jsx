import React, { useEffect, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Z } from '../ui/layers';
import { buildExport, SAMPLE } from '../../services/export/exportService';
import { saveOneFile, openInDefaultApp } from '../../services/export/exportSaver';
import { SAMPLE_MESSAGE, SAMPLE_THREAD, SAMPLE_META } from '../../utils/exportSampleData';
import { PremiumFeaturesLink } from '../PremiumFeaturesLink';
import { t as tr, t, useT, getLocale } from '../../i18n/index.js';

// Rendered once per session. The samples go through the real pipeline on
// fixture data — if the renderer breaks, the upsell shows it before a customer
// finds out. Never mirrored: a sample must not reach the network.
// Keyed by locale: the fixtures are translated, so one cache entry would pin
// the samples to whichever language rendered them first.
const cached = new Map();

async function renderSamples(locale) {
  if (cached.has(locale)) return cached.get(locale);
  const common = { ...SAMPLE_META, mirror: false, gate: SAMPLE, layout: 'single' };
  // SAMPLE_MESSAGE / SAMPLE_THREAD are factories, not values — they read t()
  // when called. Passing the function itself hands buildExport a message with
  // no `html`, which fails the whole render and blanks every sample.
  const [single, thread, html] = await Promise.all([
    buildExport({ ...common, messages: [SAMPLE_MESSAGE()], format: 'image' }),
    buildExport({ ...common, messages: SAMPLE_THREAD(), format: 'image' }),
    buildExport({ ...common, messages: SAMPLE_THREAD(), format: 'html' }),
  ]);
  const built = [
    { key: 'single', label: tr('export.upsell.oneMessageImage'), kind: 'image', file: single.files[0] },
    { key: 'thread', label: tr('export.upsell.threadOneImage'), kind: 'image', file: thread.files[0] },
    { key: 'html', label: tr('export.upsell.threadOneHtmlFile'), kind: 'html', file: html.files[0] },
  ];
  cached.set(locale, built);
  return built;
}

export function ExportUpsellModal({ open, onClose, onUpgrade }) {
  const t = useT();
  const locale = getLocale();
  const [samples, setSamples] = useState(() => cached.get(getLocale()) || null);
  const [failed, setFailed] = useState(false);
  // A dead Open button with a swallowed error is indistinguishable from one
  // that was never wired up: the shell plugin refused the file path and the
  // `.catch(() => {})` around it meant nothing ever said so.
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!open) return;
    const ready = cached.get(locale);
    if (ready) { setSamples(ready); return; }
    let cancelled = false;
    setSamples(null);
    renderSamples(locale)
      .then(result => { if (!cancelled) setSamples(result); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [open, locale]);

  return (
    <Dialog open={open} onClose={onClose} z={Z.alert} portal size="xl"
      title={t('export.upsell.exportAnyMessageThread')}
      panelBg="bg-mail-surface">
      <p className="text-sm text-mail-text-muted">
        {t('export.upsell.saveMailAsDatedImage')}
      </p>

      {failed && (
        <p className="text-xs text-mail-text-muted">
          {t('export.upsell.previewsCouldNotGeneratedMachine')}
        </p>
      )}

      {samples && (
        <div className="grid grid-cols-3 gap-3">
          {samples.map(sample => (
            <div key={sample.key} className="border border-mail-border rounded-lg p-2 flex flex-col gap-2">
              {sample.kind === 'image' ? (
                <img
                  src={`data:image/png;base64,${sample.file.base64}`}
                  alt={`${sample.label} sample`}
                  className="w-full h-44 object-cover object-top rounded bg-white"
                />
              ) : (
                <div className="w-full h-44 rounded bg-mail-surface-hover flex flex-col items-center justify-center gap-2 text-xs text-mail-text-muted text-center px-2">
                  <FileCode2 size={28} className="text-mail-text-muted/70" />
                  {t('export.upsell.selfContainedHtml')}
                </div>
              )}
              <span className="text-xs text-mail-text">{sample.label}</span>
              {/* Two real buttons on one line, not ghost text: these are the
                  only way to actually look at a sample before paying. */}
              <div className="grid grid-cols-2 gap-1.5 mt-auto">
                <Button variant="secondary" size="sm" fullWidth
                  onClick={() => { setNotice(null); openInDefaultApp(sample.file).catch(e => setNotice(t('export.upsell.couldOpenSample', { e: e?.message || e }))); }}>{t('common.open')}</Button>
                <Button variant="secondary" size="sm" fullWidth
                  onClick={() => { setNotice(null); saveOneFile(sample.file, t('export.upsell.saveSample')).catch(e => setNotice(t('export.upsell.couldSaveSample', { e: e?.message || e }))); }}>{t('common.save')}</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {notice && <p className="text-xs text-mail-danger">{notice}</p>}

      <div className="flex flex-col gap-2">
        <Button variant="primary" size="lg" fullWidth onClick={() => onUpgrade?.()}>{t('common.upgrade')}</Button>
        <Button variant="ghost" size="sm" fullWidth onClick={onClose} data-autofocus>{t('export.upsell.maybeLater')}</Button>
        <PremiumFeaturesLink className="self-center mt-1" />
      </div>
    </Dialog>
  );
}
