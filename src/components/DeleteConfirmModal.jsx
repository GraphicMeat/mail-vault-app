import React, { useId } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { displayText } from '../utils/bidiText';
import { useMailStore } from '../stores/mailStore';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Z } from './ui/layers';
import { useT } from '../i18n/index.js';

/**
 * One confirm for every delete verb — the row menu's and the thread view's.
 *
 * `pending` is `{ executor, copy: { title, description, confirmLabel } }` or
 * null. Confirming closes the modal first and runs the executor unawaited:
 * every delete behind this button pulls its rows from the list before it
 * touches the network (deleteEmailFromServer, purgeEverywhere) and puts them
 * back if the server refuses, so holding a modal open over a backdrop for the
 * seconds an IMAP round trip takes bought the user nothing but a frozen
 * window. A refusal lands as the list's own error toast.
 */
export function DeleteConfirmModal({ pending, onClose }) {
  const t = useT();
  const descId = useId();

  const confirm = () => {
    const exec = pending?.executor;
    onClose();
    if (!exec) return;
    Promise.resolve()
      .then(exec)
      .catch((err) => {
        console.error('[DeleteConfirmModal] delete failed:', err);
        // Plain `error`: resolveErrorToastProps defaults an unmatched
        // message to the error-styled toast (utils/errorToast.js).
        useMailStore.setState({ error: t('list.deleteFailed', { err: err?.message || err }) });
      });
  };

  return (
    <Dialog
      open={Boolean(pending)}
      onClose={onClose}
      role="alertdialog"
      // Portal + the top layer: this is raised from inside a virtualized row,
      // whose ancestor `transform` would otherwise be its containing block.
      portal
      z={Z.fatal}
      size="sm"
      aria-describedby={descId}
      panelClassName="min-w-[320px] max-w-[420px]"
      footer={
        <div className="flex justify-end gap-2 w-full">
          {/* Cancel takes first focus: nothing destructive is ever one stray
              Return away. */}
          <Button variant="ghost" size="sm" onClick={onClose} data-autofocus>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" size="sm" onClick={confirm}>
            <Trash2 size={14} /> {pending?.copy.confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={20} aria-hidden="true" className="text-mail-danger flex-shrink-0 mt-0.5" />
        <div>
          {/* Both delete verbs open this one modal. The title used to be
              hardcoded to "Delete from server?", so Delete everywhere
              asked about an action it was not about to perform. */}
          <h3 className="text-base font-semibold text-mail-text mb-1">{pending?.copy.title}</h3>
          <p id={descId} className="text-sm text-mail-text-muted" dir="auto">{displayText(pending?.copy.description)}</p>
        </div>
      </div>
    </Dialog>
  );
}
