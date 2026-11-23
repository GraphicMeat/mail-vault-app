import React from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '../ui/Button';
import { CloseViewerButton } from './CloseViewerButton';
import { KeepButton } from './KeepButton';
import { useT } from '../../i18n/index.js';

/**
 * The tool cluster at the right of a reader header. One place to add a tool,
 * so the single-message reader and the thread reader never drift apart.
 */
export function ReaderHeaderTools({ onOpenInWindow, onClose, keepEmail, className = '' }) {
  const t = useT();
  return (
    <div className={`flex items-center flex-shrink-0 ${className}`}>
      {keepEmail && <KeepButton email={keepEmail} />}
      {onOpenInWindow && <Button variant="ghost" icon size="sm" data-testid="open-in-window" onClick={onOpenInWindow}
        aria-label={t('chat.bubble.openNewWindow')} title={t('chat.bubble.openNewWindow')}>
        <ExternalLink size={16} />
      </Button>}
      <CloseViewerButton onClose={onClose} />
    </div>
  );
}
