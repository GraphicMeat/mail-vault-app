import React from 'react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Z } from './ui/layers';
import { KB } from '../utils/signatureImages';
import { useT } from '../i18n/index.js';

const kb = bytes => Math.max(1, Math.round(bytes / KB));
const px = ({ width, height }) => `${width} × ${height}`;

/// Asked after a picture in a signature is resized: scale the file to 3x the
/// size it is shown at? Both sizes, and the picture at the size it will be
/// seen, so the answer is not a guess. `offer` is `scaleOffer()`'s result.
export function ImageScaleDialog({ offer, onScale, onKeep }) {
  const t = useT();
  if (!offer) return null;
  const { display, natural, target } = offer;
  return <Dialog open portal z={Z.alert} onClose={onKeep} title={t('editor.image.title')}
    description={t('editor.image.body', { display: px(display), target: px(target) })}
    data-testid="image-scale"
    footer={<>
      <Button variant="secondary" size="lg" className="flex-1" data-autofocus data-testid="image-scale-keep"
        onClick={onKeep}>{t('editor.image.keep')}</Button>
      <Button variant="primary" size="lg" className="flex-1" data-testid="image-scale-apply"
        onClick={onScale}>{t('editor.image.scale', { target: px(target) })}</Button>
    </>}>
    <ul className="text-sm text-mail-text space-y-1 mb-3" data-testid="image-scale-sizes">
      <li>{t('editor.image.now', { size: px(natural), kb: kb(natural.bytes) })}</li>
      <li>{t('editor.image.after', { size: px(target), kb: kb(target.bytes) })}</li>
    </ul>
    <p className="text-xs text-mail-text-muted mb-1">{t('editor.image.preview', { display: px(display) })}</p>
    <div className="rounded-lg border border-mail-border bg-white p-3 flex items-center justify-center">
      <img src={target.src} alt="" width={display.width} height={display.height} data-testid="image-scale-preview"
        style={{ width: display.width, height: display.height }} />
    </div>
  </Dialog>;
}
