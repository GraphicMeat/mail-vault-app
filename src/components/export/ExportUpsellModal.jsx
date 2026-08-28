import React, { useEffect, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Z } from '../ui/layers';
import { buildExport, SAMPLE } from '../../services/export/exportService';
import { saveOneFile, openInDefaultApp } from '../../services/export/exportSaver';
import { SAMPLE_MESSAGE, SAMPLE_THREAD, SAMPLE_META } from '../../utils/exportSampleData';
import { PremiumFeaturesLink } from '../PremiumFeaturesLink';

// Rendered once per session. The samples go through the real pipeline on
// fixture data — if the renderer breaks, the upsell shows it before a customer
// finds out. Never mirrored: a sample must not reach the network.
let cached = null;

async function renderSamples() {
  if (cached) return cached;
  const common = { ...SAMPLE_META, mirror: false, gate: SAMPLE, layout: 'single' };
  const [single, thread, html] = await Promise.all([
    buildExport({ ...common, messages: [SAMPLE_MESSAGE], format: 'image' }),
    buildExport({ ...common, messages: SAMPLE_THREAD, format: 'image' }),
    buildExport({ ...common, messages: SAMPLE_THREAD, format: 'html' }),
  ]);
  cached = [
    { key: 'single', label: 'One message, as an image', kind: 'image', file: single.files[0] },
    { key: 'thread', label: 'A thread, as one image', kind: 'image', file: thread.files[0] },
    { key: 'html', label: 'A thread, as one HTML file', kind: 'html', file: html.files[0] },
  ];
  return cached;
}

export function ExportUpsellModal({ open, onClose, onUpgrade }) {
  const [samples, setSamples] = useState(cached);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || samples) return;
    let cancelled = false;
    renderSamples()
      .then(result => { if (!cancelled) setSamples(result); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [open, samples]);

  return (
    <Dialog open={open} onClose={onClose} z={Z.alert} portal size="lg"
      title="Export any message or thread"
      panelBg="bg-mail-surface">
      <p className="text-sm text-mail-text-muted">
        Save mail as a dated image, or as a single HTML file that folds a thread into a list you can
        expand — remote images mirrored in, so it still reads with the network unplugged.
      </p>

      {failed && (
        <p className="text-xs text-mail-text-muted">
          Previews could not be generated on this machine, but the export itself is unaffected.
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
                  className="w-full h-28 object-cover object-top rounded bg-white"
                />
              ) : (
                <div className="w-full h-28 rounded bg-mail-surface-hover flex items-center justify-center text-xs text-mail-text-muted text-center px-2">
                  Self-contained HTML
                </div>
              )}
              <span className="text-xs text-mail-text">{sample.label}</span>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => openInDefaultApp(sample.file).catch(() => {})}>Open</Button>
                <Button variant="ghost" size="sm" onClick={() => saveOneFile(sample.file, 'Save sample').catch(() => {})}>Save</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Button variant="primary" size="lg" fullWidth onClick={() => onUpgrade?.()}>Upgrade</Button>
        <Button variant="ghost" size="sm" fullWidth onClick={onClose} data-autofocus>Maybe later</Button>
        <PremiumFeaturesLink className="self-center mt-1" />
      </div>
    </Dialog>
  );
}
