import React, { useRef, useState, useLayoutEffect } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Popover } from './ui/Popover';
import { Button } from './ui/Button';
import { useT } from '../i18n/index.js';

/**
 * Portal-based action menu for email/thread rows.
 *
 * The panel, the portal and the outside-click all come from `ui/Popover`;
 * what stays here is the anchor sum — this menu hangs from the bottom-right
 * of its own button, which no other popover in the app does.
 */
export function RowActionMenu({ open, onOpen, onClose, size = 14, children }) {
  const t = useT();
  const btnRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  useLayoutEffect(() => {
    if (open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
  }, [open]);

  return (
    <>
      <Button
        ref={btnRef}
        variant="ghost"
        icon
        size="sm"
        aria-label={t('rowMenu.rowActions')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); open ? onClose() : onOpen(); }}
      >
        <MoreHorizontal size={size} />
      </Button>

      <Popover open={open} onClose={onClose} role="menu" style={{ top: pos.top, right: pos.right }}>
        {children}
      </Popover>
    </>
  );
}
