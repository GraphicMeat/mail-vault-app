import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';

/**
 * Reusable in-app confirmation dialog.
 *
 * The shell (scrim, focus trap, Escape, `aria-modal`) is `ui/Dialog`; what is
 * left here is the confirmation's own shape: a warning glyph, a description,
 * and a Cancel/Confirm pair where Cancel takes the initial focus so Enter on
 * an accidental open does not confirm.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {Function} props.onClose - called on backdrop click, X button, or Cancel
 * @param {Function} props.onConfirm - called when the primary action is clicked
 * @param {string} props.title
 * @param {string|React.ReactNode} props.description
 * @param {string} [props.confirmLabel='Confirm'] - primary action button text
 * @param {string} [props.cancelLabel='Cancel']
 * @param {boolean} [props.destructive=false] - if true, primary button is red
 * @param {boolean} [props.loading=false] - shows spinner and disables buttons
 * @param {React.ReactNode} [props.icon] - custom icon element for the header
 */
export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  loading = false,
  icon,
}) {
  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      role="alertdialog"
      title={title}
      description={description}
      dismissable={!loading}
      closeLabel={cancelLabel}
      icon={icon || (
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${destructive ? 'bg-mail-danger-tint' : 'bg-mail-accent/10'}`}>
          <AlertTriangle size={20} className={destructive ? 'text-mail-danger' : 'text-mail-accent-text'} />
        </div>
      )}
      footer={
        <>
          <Button
            variant="secondary"
            size="lg"
            onClick={onClose}
            disabled={loading}
            data-autofocus
            className="flex-1"
          >
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            size="lg"
            onClick={onConfirm}
            loading={loading}
            className="flex-1"
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
