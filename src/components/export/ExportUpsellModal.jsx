import React, { useEffect, useState } from 'react';
import { FileCode2 } from 'lucide-react';
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
  // A dead Open button with a swallowed error is indistinguishable from one
  // that was never wired up: the shell plugin refused the file path and the
  // `.catch(() => {})` around it meant nothing ever said so.
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!open || samples) return;
    let cancelled = false;
    renderSamples()
      .then(result => { if (!cancelled) setSamples(result); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [open, samples]);

  return (
    <Dialog open={open} onClose={onClose} z={Z.alert} portal size="xl"
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
                  className="w-full h-44 object-cover object-top rounded bg-white"
                />
              ) : (
                <div className="w-full h-44 rounded bg-mail-surface-hover flex flex-col items-center justify-center gap-2 text-xs text-mail-text-muted text-center px-2">
                  <FileCode2 size={28} className="text-mail-text-muted/70" />
                  Self-contained HTML
                </div>
              )}
              <span className="text-xs text-mail-text">{sample.label}</span>
              {/* Two real buttons on one line, not ghost text: these are the
                  only way to actually look at a sample before paying. */}
              <div className="grid grid-cols-2 gap-1.5 mt-auto">
                <Button variant="secondary" size="sm" fullWidth
                  onClick={() => { setNotice(null); openInDefaultApp(sample.file).catch(e => setNotice(`Could not open the sample. (${e?.message || e})`)); }}>Open</Button>
                <Button variant="secondary" size="sm" fullWidth
                  onClick={() => { setNotice(null); saveOneFile(sample.file, 'Save sample').catch(e => setNotice(`Could not save the sample. (${e?.message || e})`)); }}>Save</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {notice && <p className="text-xs text-mail-danger">{notice}</p>}

      <div className="flex flex-col gap-2">
        <Button variant="primary" size="lg" fullWidth onClick={() => onUpgrade?.()}>Upgrade</Button>
        <Button variant="ghost" size="sm" fullWidth onClick={onClose} data-autofocus>Maybe later</Button>
        <PremiumFeaturesLink className="self-center mt-1" />
      </div>
    </Dialog>
  );
}
