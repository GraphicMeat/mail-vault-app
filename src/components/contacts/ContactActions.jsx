import React, { useEffect, useRef, useState } from 'react';
import { Copy, Mail } from 'lucide-react';
import { useT } from '../../i18n';
import { openCompose } from '../../utils/composeOpener';

const COPIED_MS = 2000;

/** Act on one address: write to it, or copy it. */
export function ContactActions({ address }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!address) return null;

  const copy = async () => {
    try { await navigator.clipboard.writeText(address); } catch { return; }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <div className="flex items-center gap-2" data-testid="contact-actions">
      <button type="button" data-testid="contact-email" onClick={() => openCompose({ initialData: { to: address, _prefill: true } })} className="inline-flex items-center gap-1 text-sm">
        <Mail size={14} /> {t('contacts.action.email')}
      </button>
      <button type="button" data-testid="contact-copy" onClick={copy} className="inline-flex items-center gap-1 text-sm">
        <Copy size={14} /> {copied ? t('contacts.action.copied') : t('contacts.action.copy')}
      </button>
    </div>
  );
}
