import React from 'react';
import { AlertTriangle, Usb } from 'lucide-react';
import { usePortableStore } from '../stores/portableStore';
import { useT } from '../i18n/index.js';

/** Sidebar footer: this copy runs from a drive (the title names which). */
export function PortableBadge({ onClick }) {
  const t = useT();
  const status = usePortableStore(s => s.status);
  if (!status.portable) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      title={status.drive}
      data-testid="portable-badge"
      className="inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-mail-accent/10 text-mail-accent-text"
    >
      <Usb size={10} aria-hidden="true" />
      {t('portable.badge')}
    </button>
  );
}

/** The drive went away under a running portable copy: the daemon has
 *  stopped writing, and only a restart with the drive back resumes. */
export function PortableDriveBanner() {
  const t = useT();
  const disconnected = usePortableStore(s => s.status.portable && s.status.disconnected);
  if (!disconnected) return null;
  return (
    <div role="alert" data-testid="portable-disconnected" className="flex items-start gap-3 px-4 py-3 bg-mail-danger/10 border-b border-mail-danger/30">
      <AlertTriangle size={16} className="text-mail-danger flex-shrink-0 mt-0.5" />
      <p className="text-sm text-mail-danger font-medium">{t('portable.disconnected')}</p>
    </div>
  );
}
