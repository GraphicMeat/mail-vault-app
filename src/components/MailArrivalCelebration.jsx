import React, { useId } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import mailDrawer from '../assets/onboarding/thank-you-mail-drawer-graphic-meat.webp';
import accountVault from '../assets/onboarding/account-safe-mailbox.webp';
import voxelEnvelope from '../assets/onboarding/voxel-envelope.webp';
import { useDialogA11y } from '../hooks/useDialogA11y';
import { useT } from '../i18n/index.js';

// These start beyond different viewport edges, then converge on the drawer.
// Fixed paths make the arrival feel composed and keep repeat visits consistent.
const ENVELOPES = [
  [-54, -36, -24, 0], [53, -32, 18, 0.08], [-66, 5, 14, 0.16],
  [67, 9, -16, 0.22], [-41, 44, 26, 0.28], [42, 47, -27, 0.34],
  [-22, -57, -10, 0.4], [25, -59, 12, 0.46], [-69, -21, -18, 0.53],
  [70, -13, 21, 0.59], [-17, 61, 17, 0.64], [19, 64, -13, 0.7],
];

export function MailArrivalCelebration({ kind = 'onboarding', onClose }) {
  const t = useT();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useDialogA11y(true, onClose);

  return createPortal(
    <div
      ref={dialogRef}
      className="mail-arrival"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="mail-arrival"
    >
      <button type="button" className="mail-arrival-close" onClick={onClose} aria-label={t('common.close')}>
        <X size={20} />
      </button>

      <div className="mail-arrival-content">
        <div className="mail-arrival-stage" aria-hidden="true">
          <div className="mail-arrival-ground" />
          {ENVELOPES.map(([x, y, rotation, delay], index) => (
            <span
              className={`mail-arrival-envelope${kind === 'account' && index >= 9 ? ' mail-arrival-envelope-outside' : ''}`}
              data-testid="flying-email"
              key={index}
              style={{
                '--from-x': `${x}vw`,
                '--from-y': `${y}vh`,
                '--rotation': `${rotation}deg`,
                '--delay': `${delay}s`,
                '--stay-x': `${[-155, 160, 100][index - 9] || 0}px`,
                '--stay-y': `${[-75, -65, 75][index - 9] || 0}px`,
              }}
            >
              <img src={voxelEnvelope} alt="" width="1536" height="1024" />
            </span>
          ))}
          <img
            src={kind === 'account' ? accountVault : mailDrawer}
            alt=""
            data-testid="mail-arrival-hero"
            className={`mail-arrival-drawer${kind === 'account' ? ' mail-arrival-drawer-account' : ''}`}
            width={kind === 'account' ? 1536 : 1312}
            height={kind === 'account' ? 1024 : 1199}
          />
        </div>

        <div className="mail-arrival-copy">
          <h2 id={titleId}>{t('celebration.heading')}</h2>
          <p id={descriptionId}>{t('onboarding.readMailKeepMail')}</p>
          <button type="button" data-autofocus onClick={onClose} className="mail-arrival-continue">
            {t('celebration.continue')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
