import React, { useCallback, useEffect, useRef } from 'react';
import { bulkOperationManager } from '../services/BulkOperationManager';
import { useMailStore } from '../stores/mailStore';
import { tErr, useT } from '../i18n/index.js';
import { decodeImapUtf7 } from '../utils/imapUtf7';
import { formatCount } from '../utils/formatCount';

// Native status owns the live pending choice; buttons only act on its exact id.
export function BulkPendingOperationBanner({ pending, onPendingChange }) {
  const t = useT();
  const revision = useRef(0);
  const mounted = useRef(true);
  const refreshPending = useCallback(async () => {
    const request = ++revision.current;
    try {
      const status = await bulkOperationManager.status();
      if (mounted.current && request === revision.current)
        onPendingChange(status.pending || null);
    } catch (error) {
      if (mounted.current && request === revision.current)
        useMailStore.setState({ error: tErr(error) });
    }
  }, [onPendingChange]);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = bulkOperationManager.subscribe(
      (_operation, lifecycle) => {
        if (lifecycle?.settled) void refreshPending();
      }
    );
    return () => {
      mounted.current = false;
      revision.current++;
      unsubscribe();
    };
  }, [refreshPending]);
  if (!pending) return null;
  return (
    <div className="fixed top-4 right-4 z-50 bg-mail-surface border border-mail-strong rounded-xl p-4 max-w-sm">
      <p className="text-sm text-mail-text mb-3">
        {t('app.unfinishedOperationRemaining', {
          type: pending.type.replace(/_/g, ' '),
          count: formatCount(pending.remaining || 0),
          mailbox: decodeImapUtf7(pending.mailbox || ''),
        })}
      </p>
      <div className="flex gap-2">
        <button
          onClick={async () => {
            revision.current++;
            try {
              await bulkOperationManager.resume(pending, null, () => {});
            } catch (error) {
              useMailStore.setState({ error: tErr(error) });
            } finally {
              await refreshPending();
            }
          }}
          className="px-3 py-1.5 text-sm font-medium bg-mail-accent-fill text-white rounded-lg hover:bg-mail-accent/90 transition-colors"
        >
          {t('common.resume')}
        </button>
        <button
          onClick={async () => {
            revision.current++;
            try {
              await bulkOperationManager.discard(pending.id);
            } catch (error) {
              useMailStore.setState({ error: tErr(error) });
            } finally {
              await refreshPending();
            }
          }}
          className="px-3 py-1.5 text-sm text-mail-text-muted hover:bg-mail-border rounded-lg transition-colors"
        >
          {t('common.discard')}
        </button>
      </div>
    </div>
  );
}
