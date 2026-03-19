import React, { useEffect, useRef, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Cloud,
  HardDrive,
  Info,
} from 'lucide-react';
import { SenderVerificationBadge } from './EmailHeaderComponent';
import { getSenderName } from '../../utils/emailParser';

/**
 * Portal-based sender info popover for chat view.
 * Displays full sender details when clicking avatar/name in chat bubbles.
 * Positioned relative to the anchor element, with viewport edge detection.
 */
export const SenderInfoPopover = memo(function SenderInfoPopover({
  email,
  anchorRect,
  onClose,
  archivedEmailIds,
}) {
  const popoverRef = useRef(null);
  const previousFocusRef = useRef(null);

  const senderName = getSenderName(email);
  const initial = senderName ? senderName[0].toUpperCase() : '?';
  const hasDistinctName = email?.from?.name && email.from.name !== email.from.address;

  // Extract mailing list name
  const listId = email?.listId || email?.headers?.['list-id'];
  let listName = null;
  if (listId) {
    const match = listId.match(/^"?([^"<]+)"?\s*</);
    if (match) listName = match[1].trim();
  }

  // Calculate position based on anchor rect, with viewport edge detection
  const position = useMemo(() => {
    if (!anchorRect) return { top: 0, left: 0 };

    const POPOVER_WIDTH = 280; // estimated
    const POPOVER_HEIGHT = 200; // estimated
    const MARGIN = 8;

    let top = anchorRect.bottom + MARGIN;
    let left = anchorRect.left;

    // Flip above if would overflow bottom
    if (top + POPOVER_HEIGHT > window.innerHeight) {
      top = anchorRect.top - POPOVER_HEIGHT - MARGIN;
    }

    // Flip left if would overflow right
    if (left + POPOVER_WIDTH > window.innerWidth) {
      left = window.innerWidth - POPOVER_WIDTH - MARGIN;
    }

    // Clamp to viewport
    if (left < MARGIN) left = MARGIN;
    if (top < MARGIN) top = MARGIN;

    return { top, left };
  }, [anchorRect]);

  // Focus trap: capture previous focus and focus popover on mount
  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    popoverRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

  // Dismiss on click outside
  useEffect(() => {
    const handleMouseDown = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  // Dismiss on Escape
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const content = (
    <AnimatePresence>
      <motion.div
        ref={popoverRef}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.15 }}
        className="fixed z-50 bg-mail-surface border border-mail-border rounded-xl shadow-lg p-4 min-w-[240px] max-w-[320px] outline-none"
        style={{ top: position.top, left: position.left }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Heading */}
        <div className="text-xs font-semibold text-mail-text mb-2">Sender Details</div>

        {/* Avatar + sender name + email row */}
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 bg-mail-accent rounded-full flex items-center justify-center flex-shrink-0">
            <span className="text-white font-semibold text-xs">{initial}</span>
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-mail-text truncate">
              {senderName}
            </div>
            {hasDistinctName && (
              <div className="text-xs text-mail-text-muted truncate">
                {email.from.address}
              </div>
            )}
          </div>
        </div>

        {/* Storage icon + DKIM shield + insights row */}
        <div className="flex items-center gap-2 mb-2">
          {email.source === 'local-only' ? (
            <HardDrive size={12} className="text-mail-warning flex-shrink-0" title="Local only" />
          ) : archivedEmailIds?.has(email.uid) ? (
            <HardDrive size={12} className="text-mail-local flex-shrink-0" title="Archived" />
          ) : (
            <Cloud size={12} className="flex-shrink-0" style={{ color: 'rgba(59, 130, 246, 0.5)' }} title="Server" />
          )}
          <SenderVerificationBadge email={email} size={14} />
        </div>

        {/* To/CC */}
        <div className="text-xs text-mail-text-muted space-y-0.5">
          <div>
            To: {(Array.isArray(email.to) ? email.to : []).map(t => t.name || t.address).join(', ') || 'Unknown'}
          </div>
          {email.cc?.length > 0 && (
            <div>CC: {email.cc.map(c => c.name || c.address).join(', ')}</div>
          )}
        </div>

        {/* "via" mailing list indicator */}
        {listName && (
          <div className="text-[10px] text-mail-text-muted italic mt-1">
            via {listName}
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );

  return createPortal(content, document.body);
});
