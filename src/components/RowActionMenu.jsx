import React, { useRef, useState, useLayoutEffect } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { MoreHorizontal } from 'lucide-react';

/**
 * Portal-based action menu for email/thread rows.
 * Renders the dropdown at the document body level to escape virtualizer
 * stacking contexts and scroll container overflow clipping.
 */
export function RowActionMenu({ open, onOpen, onClose, size = 14, children }) {
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
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); open ? onClose() : onOpen(); }}
        className="p-1.5 hover:bg-mail-border rounded transition-colors"
      >
        <MoreHorizontal size={size} className="text-mail-text-muted" />
      </button>

      {ReactDOM.createPortal(
        <AnimatePresence>
          {open && (
            <>
              <div
                className="fixed inset-0"
                style={{ zIndex: 9998 }}
                onClick={(e) => { e.stopPropagation(); onClose(); }}
              />
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-mail-bg border border-mail-border rounded-lg shadow-lg py-1 min-w-[160px]"
                style={{
                  position: 'fixed',
                  top: pos.top,
                  right: pos.right,
                  zIndex: 9999,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {children}
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
