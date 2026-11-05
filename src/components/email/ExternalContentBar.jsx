import React from 'react';
import { ImageOff } from 'lucide-react';
import { allowExternalContent } from '../../services/bodyScan';
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/Button';

// "Ask before loading external content" (Settings > Security): a message whose
// external content is held back offers it here, and only when a click would
// bring something in (`scan.remote`, the daemon's count).
export function ExternalContentBar({ scan, className = '' }) {
  const t = useT();
  if (!scan?.holding || !scan.remote) return null;
  return (
    <div data-testid="external-content-bar" role="status"
      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-mail-border bg-mail-surface px-3 py-1.5 text-xs text-mail-text-muted ${className}`}>
      <span className="flex items-center gap-2">
        <ImageOff size={14} className="shrink-0" aria-hidden="true" />
        {t('viewer.externalContentNotLoaded')}
      </span>
      <Button variant="accentTint" size="xs" className="shrink-0" data-testid="load-external-content"
        onClick={(e) => { e.stopPropagation(); allowExternalContent(scan.holdKey); }}>
        {t('viewer.loadExternalContent')}
      </Button>
    </div>
  );
}
