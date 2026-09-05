import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Undo2 } from 'lucide-react';
import { ToastShell } from './ui/ToastShell';
import { Button } from './ui/Button';
import { useMailStore } from '../stores/mailStore';
import { useComposeStore } from '../stores/composeStore';
import { useT } from '../i18n/index.js';

const SHOW_MS = 8000;

/**
 * The last undoable action, for 8 s.
 *
 * The slot itself outlives the toast: Cmd+Z reaches it until the next action
 * replaces it. So the timer hides THIS slot's toast (by id), and a new slot
 * brings the toast straight back.
 */
export function UndoToast() {
  const t = useT();
  const undo = useMailStore(s => s.undo);
  const runUndo = useMailStore(s => s.runUndo);
  const pendingSend = useComposeStore(s => s.pendingSend);
  const [shownId, setShownId] = useState(null);

  useEffect(() => {
    if (!undo) { setShownId(null); return; }
    setShownId(undo.id);
    const timer = setTimeout(() => setShownId((cur) => (cur === undo.id ? null : cur)), SHOW_MS);
    return () => clearTimeout(timer);
  }, [undo?.id]);

  // Undo-send owns this corner while a send is pending — two toasts on the
  // midline, both saying "Undo", is a coin toss the user should not be offered.
  const visible = !!undo && shownId === undo.id && !pendingSend;

  return (
    <AnimatePresence>
      {visible && (
        <ToastShell position="bottom-center" data-testid="undo-toast" className="flex items-center gap-3 px-4 py-2.5">
          <span className="text-sm text-mail-text">{t(undo.labelKey, undo.labelParams)}</span>
          {undo.canUndo && (
            <Button variant="ghost" size="sm" onClick={() => runUndo()} data-testid="undo-toast-button">
              <Undo2 size={14} />
              {t('undo.action')}
            </Button>
          )}
        </ToastShell>
      )}
    </AnimatePresence>
  );
}
