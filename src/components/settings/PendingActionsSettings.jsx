// ── Settings › the server actions MailVault still owes ──
//
// Every delete, move and flag change is journalled before the row is repainted
// and cleared once the server accepts it (services/db/opJournal, replayOps). A
// failure now KEEPS its entry — the row is already gone from the list, so
// dropping it would leave the server holding a message the app has shown as
// deleted. That makes an entry that can never land (a mailbox the provider
// renamed, a uid space reissued) permanent, so this is the escape hatch: what
// is owed, why it last failed, and a way to give up on it.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Trash2, FolderInput, Flag, Clock, Eraser } from 'lucide-react';
import * as db from '../../services/db';
import { replayOps } from '../../services/workflows/replayOps';
import { showQueuedRows } from '../../services/workflows/messageMutations';
import { useAccountStore } from '../../stores/accountStore';
import { formatDateTime } from '../../utils/dateFormat';
import { mailboxLabel } from '../../utils/imapUtf7';
import { useT, tErr } from '../../i18n/index.js';

const OP_ICON = { delete: Trash2, purge: Eraser, move: FolderInput, flag: Flag };
const OP_LABEL = {
  delete: 'settings.pendingActions.opDelete',
  purge: 'settings.pendingActions.opPurge',
  move: 'settings.pendingActions.opMove',
  flag: 'settings.pendingActions.opFlag',
};

// `focus`: opened from the daily reminder's link, so the list is scrolled to.
export function PendingActionsSettings({ focus = false }) {
  const t = useT();
  const sectionRef = useRef(null);
  useEffect(() => {
    if (focus) sectionRef.current?.scrollIntoView?.({ block: 'start' });
  }, [focus]);
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
    // Given up on: a delete's rows show again, as the server still has them.
    await showQueuedRows(entry);
    await refresh();
  };

  const emailFor = id => accounts.find(a => a.id === id)?.email || id;
  // One entry can hold several uids; the first one with a reason is the reason.
  const failureOf = (entry, uid) => failures.get(db.failureKey({ op: entry.op, accountId: entry.accountId, mailbox: entry.mailbox, uid }));
  const reasonFor = entry => entry.uids.map(uid => failureOf(entry, uid)).find(Boolean)?.message;
  // A delete of several messages keeps all of them listed (messageMutations
  // `_queuedList`): its `uids` are what is still owed, the rest went, unless
  // a reason says the server refused it.
  const statusOf = (entry, uid) => {
    if (entry.uids.includes(uid)) return { key: 'settings.pendingActions.statusWaiting', tone: 'text-mail-danger' };
    const refused = failureOf(entry, uid)?.message;
    return refused
      ? { key: 'settings.pendingActions.statusRefused', tone: 'text-mail-danger', reason: refused }
      : { key: 'settings.pendingActions.statusDeleted', tone: 'text-mail-success' };
  };

  return (
    <div className="settings-section" id="pending-actions" ref={sectionRef}>
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
            const total = Math.max(entry.arg?.total || 0, entry.uids.length);
            const gone = total - entry.uids.length;
            const messages = Array.isArray(entry.arg?.messages) ? entry.arg.messages : null;
            return (
              <li key={entry.id} className="flex items-start gap-3 p-3 rounded-lg bg-mail-surface">
                <Icon size={16} className="mt-0.5 text-mail-text-muted shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-mail-text">
                    {t(OP_LABEL[entry.op] || 'settings.pendingActions.opOther')}
                    {' · '}
                    {t('common.messageCount', { count: total })}
                    {gone > 0 && ` · ${t('settings.pendingActions.progress', { deleted: gone, left: entry.uids.length })}`}
                  </p>
                  <p className="text-xs text-mail-text-muted truncate">
                    {emailFor(entry.accountId)} · {mailboxLabel(entry.mailbox)} · {t('settings.pendingActions.queuedAt', { date: formatDateTime(entry.at) })}
                  </p>
                  {/* tErr: a JMAP refusal (no Trash, say) in the app's words. */}
                  {reason && <p className="text-xs text-mail-danger mt-1 break-words">{tErr(reason)}</p>}
                  {messages && (
                    <details className="mt-1">
                      <summary className="text-xs text-mail-text-muted cursor-pointer select-none">
                        {t('settings.pendingActions.showMessages')}
                      </summary>
                      <ul className="mt-1 space-y-0.5">
                        {messages.map(m => {
                          const status = statusOf(entry, m.uid);
                          return (
                            <li key={m.uid} className="flex items-baseline gap-2 text-xs">
                              <span className="min-w-0 flex-1 truncate text-mail-text">
                                {m.subject || t('common.noSubject')}
                                {m.from && <span className="text-mail-text-muted"> · {m.from}</span>}
                              </span>
                              <span className={`shrink-0 ${status.tone}`} title={status.reason ? tErr(status.reason) : undefined}>
                                {t(status.key)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  )}
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
