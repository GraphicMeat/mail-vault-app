import React from 'react';
import { useT } from '../../i18n/index.js';

/** Stands in for the raw message source while privacy mode is on. */
export function SourceBlocked() {
  const t = useT();
  return <p role="status" data-testid="privacy-source-blocked"
    className="flex flex-1 items-center justify-center p-6 text-center text-sm text-mail-text-muted">
    {t('privacy.sourceBlocked')}
  </p>;
}
