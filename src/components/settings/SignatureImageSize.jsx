import React from 'react';
import { Check, AlertTriangle, AlertCircle } from 'lucide-react';
import { classifySignatureImageSize, signatureImageBytes, signatureImageKb } from '../../utils/signatureImages';
import { useT } from '../../i18n/index.js';

// A logo in the signature goes out with every email, so its size is graded
// where it is added. Warning only: the picture is never resized.
const SIGNATURE_IMAGE_TIERS = {
  good: { labelKey: 'settings.accounts.signatureImageGood', Icon: Check, className: 'text-mail-success' },
  warn: { labelKey: 'settings.accounts.signatureImageWarn', Icon: AlertTriangle, className: 'text-mail-warning' },
  alert: { labelKey: 'settings.accounts.signatureImageAlert', Icon: AlertCircle, className: 'text-mail-danger' },
};

export function SignatureImageSize({ html }) {
  const t = useT();
  const bytes = React.useMemo(() => signatureImageBytes(html), [html]);
  const tier = classifySignatureImageSize(bytes);
  if (!tier) return null;
  const { labelKey, Icon, className } = SIGNATURE_IMAGE_TIERS[tier];
  return (
    <p role="status" aria-live="polite" data-signature-image-size="" data-tier={tier}
      className={`mt-1 flex items-center gap-1.5 text-xs font-medium ${className}`}>
      <Icon size={13} aria-hidden="true" className="flex-shrink-0" />
      {t(labelKey, { size: signatureImageKb(bytes) })}
    </p>
  );
}
