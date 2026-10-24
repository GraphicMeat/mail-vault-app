import React from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, X } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { DockSlot } from '../../components/ui/ToastDock';

// Corner bubble in the style of RestoreTray/OutboxTray: this message could not
// be drawn by Blitz; one click switches the app to the standard renderer. The
// caller wraps it in AnimatePresence so the exit animation runs.
export default function FailureBubble({ onSwitch, onDismiss }) {
  const t = useT();
  return (
    <DockSlot position="bottom-left">
      <motion.div
        initial={{ y: 30, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 30, opacity: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl min-w-[280px] max-w-[380px] border bg-mail-surface border-mail-strong"
        data-testid="blitz-failure-bubble"
        role="status"
      >
        <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 bg-mail-warning-tint">
          <AlertTriangle size={14} className="text-mail-warning" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-mail-text">{t('blitz.failed.title')}</p>
          <p className="text-[11px] mt-0.5 text-mail-text-muted">{t('blitz.failed.body')}</p>
          <button
            type="button"
            data-testid="blitz-failure-switch"
            onClick={onSwitch}
            className="mt-2 text-xs font-medium text-mail-accent-text hover:underline"
          >
            {t('blitz.failed.switch')}
          </button>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-mail-text-muted hover:text-mail-text flex-shrink-0"
          aria-label={t('blitz.failed.dismiss')}
        >
          <X size={14} />
        </button>
      </motion.div>
    </DockSlot>
  );
}
