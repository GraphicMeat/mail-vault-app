import React from 'react';
import { AnimatePresence } from 'framer-motion';
import { MailX } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { Toast } from './Toast';
import { useUnsubscribeStore } from '../stores/unsubscribeStore';
import { useT } from '../i18n/index.js';

/**
 * The confirm dialog and the outcome toast for every unsubscribe surface
 * (row, reader, Insights, Settings > Unsubscribe). No sender-scoped bulk or
 * cleanup action exists to offer after a success, so the toast only reports.
 */
export function UnsubscribeHost() {
  const t = useT();
  const pending = useUnsubscribeStore(s => s.pending);
  const busy = useUnsubscribeStore(s => s.busy);
  const result = useUnsubscribeStore(s => s.result);
  const { confirm, cancel, dismissResult } = useUnsubscribeStore.getState();
  const sender = result?.sender;
  const message = result?.kind === 'done' ? t('unsubscribe.done', { sender })
    : result?.kind === 'openedMailto' ? t('unsubscribe.openedMailto', { sender })
      : result?.kind === 'openedBrowser' ? t('unsubscribe.openedBrowser', { sender })
        : t('unsubscribe.failed', { sender });
  return <>
    <ConfirmDialog
      isOpen={!!pending}
      onClose={cancel}
      onConfirm={confirm}
      loading={busy}
      title={t('unsubscribe.confirmTitle', { sender: pending?.name || pending?.sender || '' })}
      description={t('unsubscribe.confirmBody')}
      confirmLabel={t('unsubscribe.action')}
      cancelLabel={t('common.cancel')}
      icon={<div className="w-10 h-10 rounded-full flex items-center justify-center bg-mail-accent/10">
        <MailX size={20} className="text-mail-accent-text" />
      </div>}
    />
    <AnimatePresence>
      {result && <Toast message={message} type={result.type} onClose={dismissResult} />}
    </AnimatePresence>
  </>;
}
