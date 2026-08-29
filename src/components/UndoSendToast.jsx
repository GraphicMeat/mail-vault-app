import React, { useState, useEffect } from 'react';
import { ToastShell } from './ui/ToastShell';
import { Button } from './ui/Button';
import { useComposeStore } from '../stores/composeStore';
import { AnimatePresence } from 'framer-motion';
import { Undo2, Check, Mail } from 'lucide-react';
import { t as tr, useT  } from '../i18n/index.js';

function formatCountdown(seconds) {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  return tr('undoSend.s', { seconds });
}

export function UndoSendToast({ onUndo }) {
  const t = useT();
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
        <ToastShell
          position="bottom-center"
          data-testid="undo-send-toast"
          className="flex items-center gap-3 px-5 py-3 min-w-[320px] max-w-[480px]"
        >
            {showSent && !pendingSend ? (
              <>
                <Check size={18} className="text-mail-success" />
                <span className="text-sm font-medium text-mail-text">{t('undoSend.sent')}</span>
              </>
            ) : (
              <>
                <div className="w-8 h-8 rounded-full bg-mail-accent/20 flex items-center justify-center flex-shrink-0">
                  <Mail size={14} className="text-mail-accent-text" />
                </div>
                <div className="flex-1 min-w-0">
                  {subject && (
                    <p className="text-xs font-medium text-mail-text truncate">{subject}</p>
                  )}
                  <p className="text-xs text-mail-text-muted">
                    {recipient ? tr('undoSend.to', { recipient }) : ''}Sending in{' '}
                    <span className="font-semibold tabular-nums text-mail-text">{formatCountdown(secondsLeft)}</span>
                  </p>
                </div>
                <Button
                  variant="link"
                  size="sm"
                  data-testid="undo-send-btn"
                  onClick={handleUndo}
                  className="font-medium hover:bg-mail-surface-hover flex-shrink-0"
                >
                  <Undo2 size={14} />
                  {t('undoSend.undo')}
                </Button>
              </>
            )}
        </ToastShell>
      )}
    </AnimatePresence>
  );
}
