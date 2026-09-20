// ── Settings › the server actions MailVault still owes ──
//
// Every delete, move and flag change is journalled before the row is repainted
// and cleared once the server accepts it (services/db/opJournal, replayOps). A
// failure now KEEPS its entry — the row is already gone from the list, so
// dropping it would leave the server holding a message the app has shown as
// deleted. That makes an entry that can never land (a mailbox the provider
// renamed, a uid space reissued) permanent, so this is the escape hatch: what
// is owed, why it last failed, and a way to give up on it.

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Trash2, FolderInput, Flag, Clock } from 'lucide-react';
import * as db from '../../services/db';
import { replayOps } from '../../services/workflows/replayOps';
import { useAccountStore } from '../../stores/accountStore';
import { formatDateTime } from '../../utils/dateFormat';
import { mailboxLabel } from '../../utils/imapUtf7';
import { useT } from '../../i18n/index.js';

const OP_ICON = { delete: Trash2, move: FolderInput, flag: Flag };
const OP_LABEL = {
  delete: 'settings.pendingActions.opDelete',
  move: 'settings.pendingActions.opMove',
  flag: 'settings.pendingActions.opFlag',
};

export function PendingActionsSettings() {
  const t = useT();
  const accounts = useAccountStore(s => s.accounts);
  const [ops, setOps] = useState([]);
  const [failures, setFailures] = useState(() => new Map());
  const [busy, setBusy] = useState(false);

  // Read, never subscribe: the journal lives on disk behind the daemon, and
  // the two things that change it (a replay, a cancel) both refresh here.
  const refresh = useCallback(async () => {
    const list = await db.readOps();
    setOps(Array.isArray(list) ? list : []);
    setFailures(new Map(db.opFailures()));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const retryAll = async () => {
    setBusy(true);
    try {
      await replayOps({ reason: 'manual' });
    } catch {
      // replayOps parks its own outcome; a thrown replay still leaves the
      // journal readable, which is what the refresh below shows.
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const cancel = async (entry) => {
    await db.clearOps({
      op: entry.op,
      accountId: entry.accountId,
      mailbox: entry.mailbox,
      uids: entry.uids,
      arg: entry.arg || {},
    });
    await refresh();
  };

  const emailFor = id => accounts.find(a => a.id === id)?.email || id;
  // One entry can hold several uids; the first one with a reason is the reason.
  const reasonFor = entry => entry.uids
    .map(uid => failures.get(db.failureKey({ op: entry.op, accountId: entry.accountId, mailbox: entry.mailbox, uid })))
    .find(Boolean)?.message;

  return (
    <div className="settings-section">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-mail-text">{t('settings.pendingActions.title')}</h3>
          <p className="text-xs text-mail-text-muted">{t('settings.pendingActions.blurb')}</p>
        </div>
        <button
          onClick={retryAll}
          disabled={busy || ops.length === 0}
          className="text-xs font-medium text-mail-accent-text hover:text-mail-accent/80 disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          <RefreshCw size={12} className={`inline mr-1 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
          {t('settings.pendingActions.retryNow')}
        </button>
      </div>

      {ops.length === 0 ? (
        <p className="text-xs text-mail-text-muted">{t('settings.pendingActions.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {ops.map(entry => {
            const Icon = OP_ICON[entry.op] || Clock;
            const reason = reasonFor(entry);
            return (
              <li key={entry.id} className="flex items-start gap-3 p-3 rounded-lg bg-mail-surface">
                <Icon size={16} className="mt-0.5 text-mail-text-muted shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-mail-text">
                    {t(OP_LABEL[entry.op] || 'settings.pendingActions.opOther')}
                    {' · '}
                    {t('common.messageCount', { count: entry.uids.length })}
                  </p>
                  <p className="text-xs text-mail-text-muted truncate">
                    {emailFor(entry.accountId)} · {mailboxLabel(entry.mailbox)} · {t('settings.pendingActions.queuedAt', { date: formatDateTime(entry.at) })}
                  </p>
                  {reason && <p className="text-xs text-mail-danger mt-1 break-words">{reason}</p>}
                </div>
                <button
                  onClick={() => cancel(entry)}
                  className="text-xs font-medium text-mail-danger hover:opacity-80 transition-opacity shrink-0"
                >
                  {t('common.cancel')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
