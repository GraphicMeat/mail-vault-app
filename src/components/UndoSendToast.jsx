import React, { useState, useEffect } from 'react';
import { useMailStore } from '../stores/mailStore';
import { motion, AnimatePresence } from 'framer-motion';
import { Undo2, Check } from 'lucide-react';

export function UndoSendToast({ onUndo }) {
  const pendingSend = useMailStore(s => s.pendingSend);
  const cancelPendingSend = useMailStore(s => s.cancelPendingSend);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [showSent, setShowSent] = useState(false);

  // Update countdown every second
  useEffect(() => {
    if (!pendingSend) return;

    const update = () => {
      const elapsed = (Date.now() - pendingSend.timestamp) / 1000;
      const remaining = Math.max(0, Math.ceil(pendingSend.delay - elapsed));
      setSecondsLeft(remaining);
    };

    update();
    const interval = setInterval(update, 200);
    return () => clearInterval(interval);
  }, [pendingSend]);

  // Show "Sent!" briefly when pendingSend goes from non-null to null (timer expired)
  useEffect(() => {
    if (!pendingSend && secondsLeft === 0) return;
    if (pendingSend) return;

    // pendingSend just became null — timer expired, email was sent
    setShowSent(true);
    const timeout = setTimeout(() => setShowSent(false), 2000);
    return () => clearTimeout(timeout);
  }, [pendingSend]);

  const handleUndo = () => {
    const composeState = cancelPendingSend();
    if (composeState && onUndo) {
      onUndo(composeState);
    }
  };

  const visible = !!pendingSend || showSent;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60]"
        >
          <div data-testid="undo-send-toast" className="flex items-center gap-3 px-5 py-3 bg-mail-surface border border-mail-border
                          rounded-xl shadow-2xl min-w-[280px]">
            {showSent && !pendingSend ? (
              <>
                <Check size={18} className="text-green-500" />
                <span className="text-sm font-medium text-mail-text">Sent!</span>
              </>
            ) : (
              <>
                <span className="text-sm text-mail-text">
                  Sending in <span className="font-semibold tabular-nums">{secondsLeft}s</span>...
                </span>
                <div className="flex-1" />
                <button
                  data-testid="undo-send-btn"
                  onClick={handleUndo}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium
                             text-mail-accent hover:bg-mail-surface-hover rounded-lg
                             transition-colors"
                >
                  <Undo2 size={14} />
                  Undo
                </button>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
