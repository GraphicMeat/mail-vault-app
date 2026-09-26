import React from 'react';
import { Lock } from 'lucide-react';
import { useT } from '../../i18n/index.js';

// `email.pgp` is set by the daemon's read (src-daemon/src/handlers/pgp.rs):
// 'decrypted' when the body came from OpenPGP decryption, 'locked' when the
// message is encrypted and no imported key opens it. Shared by the reader and
// the thread view so both mark encrypted mail the same way.

export function PgpDecryptedBadge({ email }) {
  const t = useT();
  if (email?.pgp !== 'decrypted') return null;
  return (
    <div data-testid="pgp-decrypted" className="flex items-center gap-1.5 text-xs text-mail-text-muted mb-2">
      <Lock size={12} aria-hidden="true" />{t('pgp.decryptedBadge')}
    </div>
  );
}

/** Shown in place of the body: ciphertext is never useful to read. */
export function PgpLockedNotice() {
  const t = useT();
  return (
    <div data-testid="pgp-locked"
      className="rounded-lg p-6 flex flex-col items-center text-center gap-3 border border-mail-border bg-mail-surface">
      <Lock size={28} className="text-mail-text-muted" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-mail-text">{t('pgp.lockedTitle')}</p>
        <p className="text-xs text-mail-text-muted mt-1 max-w-md">{t('pgp.lockedHint')}</p>
      </div>
    </div>
  );
}
