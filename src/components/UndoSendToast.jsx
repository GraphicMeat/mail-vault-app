import React, { useState, useEffect } from 'react';
import { useComposeStore } from '../stores/composeStore';
import { motion, AnimatePresence } from 'framer-motion';
import { Undo2, Check, Mail } from 'lucide-react';

function formatCountdown(seconds) {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  return `${seconds}s`;
}

export function UndoSendToast({ onUndo }) {
  const pendingSend = useComposeStore(s => s.pendingSend);
  const cancelPendingSend = useComposeStore(s => s.cancelPendingSend);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [showSent, setShowSent] = useState(false);

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

  useEffect(() => {
    if (!pendingSend && secondsLeft === 0) return;
    if (pendingSend) return;
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
  const subject = pendingSend?.composeState?.initialData?.subject;
  const recipient = pendingSend?.composeState?.initialData?.to;

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
                          rounded-xl shadow-2xl min-w-[320px] max-w-[480px]">
            {showSent && !pendingSend ? (
              <>
                <Check size={18} className="text-green-500" />
                <span className="text-sm font-medium text-mail-text">Sent!</span>
              </>
            ) : (
              <>
                <div className="w-8 h-8 rounded-full bg-mail-accent/20 flex items-center justify-center flex-shrink-0">
                  <Mail size={14} className="text-mail-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  {subject && (
                    <p className="text-xs font-medium text-mail-text truncate">{subject}</p>
                  )}
                  <p className="text-xs text-mail-text-muted">
                    {recipient ? `To: ${recipient} · ` : ''}Sending in{' '}
                    <span className="font-semibold tabular-nums text-mail-text">{formatCountdown(secondsLeft)}</span>
                  </p>
                </div>
                <button
                  data-testid="undo-send-btn"
                  onClick={handleUndo}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium
                             text-mail-accent hover:bg-mail-surface-hover rounded-lg
                             transition-colors flex-shrink-0"
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
