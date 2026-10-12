import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { KeyRound, Copy, Check, Trash2, X } from 'lucide-react';
import { useCodeBubbleStore } from '../stores/codeBubbleStore';
import { useT } from '../i18n/index.js';
import { Private } from './privacy/Private';
import { CODE_FONT } from '../utils/codeLook';

// A one-time code that arrived by mail, in Compose's corner stack like a
// minimized draft: the code, who sent it, Copy, Copy & delete, and an X.
// `onOpen(target)` opens the message; `onDelete(target)` is the list's own
// delete (Trash, with its undo), awaited before the bubble goes.
export function CodeBubbles({ onOpen, onDelete }) {
  const bubbles = useCodeBubbleStore(s => s.bubbles);
  return (
    <AnimatePresence>
      {bubbles.map(bubble => (
        <CodeBubble key={bubble.id} bubble={bubble} onOpen={onOpen} onDelete={onDelete} />
      ))}
    </AnimatePresence>
  );
}

const ACTION = 'flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md transition-colors '
  + 'text-mail-accent-text hover:bg-mail-surface-hover disabled:opacity-50';

function CodeBubble({ bubble, onOpen, onDelete }) {
  const t = useT();
  const dismiss = useCodeBubbleStore(s => s.dismiss);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const copiedTimer = useRef(null);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const target = { accountId: bubble.accountId, mailbox: bubble.mailbox, uid: bubble.uid };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(bubble.code);
    } catch (e) {
      console.warn('[codeBubble] Could not copy the code:', e);
      return false;
    }
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    return true;
  };

  const copyAndDelete = async () => {
    if (!(await copy())) return;
    setDeleting(true);
    try {
      await onDelete(target);
    } catch (e) {
      console.warn('[codeBubble] Could not delete the message:', e);
      setDeleting(false);
      return;
    }
    dismiss(bubble.id);
  };

  return (
    <motion.div
      data-testid="code-bubble"
      initial={{ x: 100, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 100, opacity: 0 }}
      className="flex flex-col gap-1.5 bg-mail-surface border border-mail-strong rounded-lg px-3 py-2 w-[280px]"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onOpen(target)}
          aria-label={t('codeBubble.open')}
          title={t('codeBubble.open')}
          className="flex items-center gap-2 flex-1 min-w-0 text-left rounded-md hover:bg-mail-surface-hover transition-colors"
        >
          <span className="w-7 h-7 rounded-full bg-mail-accent/20 flex items-center justify-center flex-shrink-0">
            <KeyRound size={14} className="text-mail-accent-text" aria-hidden="true" />
          </span>
          <span className="flex-1 min-w-0">
            <span
              data-testid="code-bubble-code"
              className="block text-base font-semibold tracking-[0.15em] text-mail-text truncate"
              style={{ fontFamily: CODE_FONT }}
            >
              <Private kind="text">{bubble.code}</Private>
            </span>
            <span className="block text-[10px] text-mail-text-muted truncate">
              <Private kind="name">{bubble.sender}</Private>
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => dismiss(bubble.id)}
          aria-label={t('codeBubble.dismiss')}
          title={t('codeBubble.dismiss')}
          className="p-0.5 hover:bg-mail-border rounded text-mail-text-muted flex-shrink-0"
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="flex justify-end gap-1">
        <button type="button" onClick={copy} className={ACTION}>
          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
          {copied ? t('codeBubble.copied') : t('codeBubble.copy')}
        </button>
        <button type="button" onClick={copyAndDelete} disabled={deleting} className={ACTION}>
          <Trash2 size={12} aria-hidden="true" />
          {t('codeBubble.copyDelete')}
        </button>
      </div>
    </motion.div>
  );
}
