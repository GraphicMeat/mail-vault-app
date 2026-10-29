import React, { useId } from 'react';
import { Clock } from 'lucide-react';
import { useMailStore } from '../stores/mailStore';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { useT } from '../i18n/index.js';

/**
 * The once-a-day reminder that server actions are still owed
 * (services/workflows/pendingActionsReminder.js). One modal for all of them,
 * however many failed, with the way to the list that shows each one and lets
 * the user give up on it.
 */
export function PendingActionsReminder() {
  const t = useT();
  const descId = useId();
  const reminder = useMailStore(s => s.pendingActionsReminder);
  const dismiss = () => useMailStore.getState().dismissPendingActionsReminder();
  const open = () => {
    dismiss();
    useMailStore.getState().requestSettingsTab('daemon', { section: 'pending-actions' });
  };

  return (
    <Dialog
      open={Boolean(reminder)}
      onClose={dismiss}
      portal
      size="sm"
      aria-describedby={descId}
      panelClassName="min-w-[320px] max-w-[420px]"
      footer={
        <div className="flex justify-end gap-2 w-full">
          <Button variant="secondary" size="sm" onClick={dismiss}>
            {t('pendingActions.reminder.later')}
          </Button>
          <Button variant="primary" size="sm" onClick={open} data-autofocus>
            {t('pendingActions.reminder.open')}
          </Button>
        </div>
      }
    >
      <div className="flex items-start gap-3">
        <Clock size={20} aria-hidden="true" className="text-mail-warning flex-shrink-0 mt-0.5" />
        <div>
          <h3 className="text-base font-semibold text-mail-text mb-1">{t('pendingActions.reminder.title')}</h3>
          <p id={descId} className="text-sm text-mail-text-muted">
            {t('pendingActions.reminder.body', { count: reminder?.count || 0 })}
          </p>
        </div>
      </div>
    </Dialog>
  );
}
