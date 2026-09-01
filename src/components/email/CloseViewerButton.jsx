import React from 'react';
import { X } from 'lucide-react';
import { Button } from '../ui/Button';
import { useSelectionStore } from '../../stores/selectionStore';
import { useT } from '../../i18n/index.js';

/**
 * Put the reader away and go back to the list.
 *
 * Opening a message was a one-way door: every other way out of the reading
 * pane opens something else (another row, another folder) or destroys the
 * message (delete, archive-and-purge). In the stacked two-column layout that
 * matters most — the list gives up more than half its height the moment a
 * message opens (see `stackedSolo` in App.jsx) and there was no gesture to get
 * it back.
 *
 * One component for both readers: the single-message viewer and the thread
 * view are separate returns of separate files, and a close button on only one
 * of them is a door that exists in half the rooms.
 */
export function CloseViewerButton({ className = '' }) {
  const t = useT();
  const closeEmail = useSelectionStore(s => s.closeEmail);
  return (
    <Button
      data-testid="close-viewer"
      variant="ghost"
      icon
      size="sm"
      aria-label={t('common.close')}
      title={t('common.close')}
      className={`flex-shrink-0 ${className}`}
      onClick={(e) => { e.stopPropagation(); closeEmail(); }}
    >
      <X size={16} />
    </Button>
  );
}
