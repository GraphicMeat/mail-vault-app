// ── Settings › the server actions MailVault still owes ──
//
// Every delete, move and flag change is journalled before the row is repainted
// and cleared once the server accepts it. A failure KEEPS its entry — the row
// is already gone from the list, so dropping it would leave the server holding
// a message the app has shown as deleted. That makes an entry that can never
// land (a mailbox the provider renamed, a uid space reissued) permanent, so
// this is the escape hatch: what is owed, why it last failed, and a way to
// give up on it.
//
// Deletes are the daemon's queue (`delete_queue.list`): it sends and retries
// them itself, and keeps how often it tried and why each message was refused,
// so both survive a restart. Moves, flags and purges are the app's journal
// (services/db/opJournal, replayOps), with this session's reasons.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Trash2, FolderInput, Flag, Clock, Eraser } from 'lucide-react';
import * as db from '../../services/db';
import * as api from '../../services/api';
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
  // The delete queue's last answer, kept when a later read fails, and whether
  // that read failed: an unreachable daemon is not "nothing is waiting".
  const queueRef = useRef([]);
  const [queueUnreadable, setQueueUnreadable] = useState(false);

  // Both lists live on disk behind the daemon. The journal is re-read after a
  // replay or a cancel from here; the delete queue also when the daemon says
  // it changed (its worker runs with or without this window).
  const refresh = useCallback(async () => {
    const [list, queue] = await Promise.all([
      db.readOps(),
      api.deleteQueueList().then(
        (entries) => { setQueueUnreadable(false); return Array.isArray(entries) ? entries : []; },
        (error) => {
          console.warn('[pendingActions] Could not read the delete queue:', error);
          setQueueUnreadable(true);
          return null;
        },
      ),
    ]);
    if (queue) queueRef.current = queue;
    const journal = (Array.isArray(list) ? list : []).filter(entry => entry.op !== 'delete');
    setOps([...queueRef.current, ...journal].sort((a, b) => (a.at || 0) - (b.at || 0)));
    setFailures(new Map(db.opFailures()));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    let stops = [];
    let live = true;
    import('@tauri-apps/api/event')
      .then(({ listen }) => Promise.all(['delete-queue-changed', 'delete-queue-landed'].map(name => listen(name, () => { refresh(); }))))
      .then((unlisten) => { if (live) stops = unlisten; else unlisten.forEach(stop => stop()); })
      .catch(() => {});
    return () => { live = false; stops.forEach(stop => stop()); };
  }, [refresh]);

  // The daemon's pass can take minutes (every owed delete, one at a time): it
  // is started, not awaited, and its events refresh the list as it goes.
  const retryAll = async () => {
    setBusy(true);
    Promise.resolve().then(() => api.deleteQueueRun({ reason: 'manual' })).then(refresh, (error) => {
      console.warn('[pendingActions] The delete queue could not run now:', error);
      refresh();
    });
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
    if (entry.op === 'delete') {
      await api.deleteQueueCancel(entry.id, [...entry.uids, ...stoppedOf(entry)]);
    } else {
      await db.clearOps({
        op: entry.op,
        accountId: entry.accountId,
        mailbox: entry.mailbox,
        uids: entry.uids,
        arg: entry.arg || {},
      });
    }
    // Given up on: a delete's rows show again, as the server still has them.
    await showQueuedRows(entry);
    await refresh();
  };

  const emailFor = id => accounts.find(a => a.id === id)?.email || id;
  // A queued delete the daemon stopped for good with nothing sent (the server
  // renumbered the folder): no longer owed, so its rows show again, but kept
  // here with the reason until it is cancelled.
  const stoppedOf = entry => (entry.op === 'delete'
    ? Object.entries(entry.failures || {}).filter(([uid, f]) => f?.stopped && !entry.uids.includes(Number(uid))).map(([uid]) => Number(uid))
    : []);
  // One entry can hold several uids; the first one with a reason is the reason.
  // A queued delete carries its own (`failures`, by uid, kept by the daemon);
  // anything else, and a delete the bulk tool queued and noted itself, has
  // this session's reason from the app.
  const failureOf = (entry, uid) => (entry.op === 'delete' ? entry.failures?.[uid] : null)
    ?? failures.get(db.failureKey({ op: entry.op, accountId: entry.accountId, mailbox: entry.mailbox, uid }));
  const reasonFor = entry => [...entry.uids, ...stoppedOf(entry)].map(uid => failureOf(entry, uid)).find(Boolean)?.message;
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

      {queueUnreadable && (
        <p role="status" className="text-xs text-mail-danger mb-2">{t('settings.pendingActions.queueUnreadable')}</p>
      )}
      {ops.length === 0 ? (
        !queueUnreadable && <p className="text-xs text-mail-text-muted">{t('settings.pendingActions.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {ops.map(entry => {
            const Icon = OP_ICON[entry.op] || Clock;
            const reason = reasonFor(entry);
            const stopped = stoppedOf(entry).length;
            const total = Math.max(entry.arg?.total || 0, entry.uids.length + stopped);
            const gone = total - entry.uids.length - stopped;
            const messages = Array.isArray(entry.arg?.messages) ? entry.arg.messages : null;
            // A queued delete the daemon has not sent once, and has no reason
            // for: it waits for the link, or for the account's password to be
            // readable without asking.
            const tries = entry.op === 'delete' && typeof entry.attempts === 'number' ? entry.attempts : null;
            const untried = tries === 0 && !reason;
            return (
              <li key={`${entry.op}-${entry.id}`} className="flex items-start gap-3 p-3 rounded-lg bg-mail-surface">
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
                  {tries > 0 && (
                    <p className="text-xs text-mail-text-muted">{t('settings.pendingActions.attempts', { count: tries })}</p>
                  )}
                  {untried && <p className="text-xs text-mail-text-muted mt-1">{t('settings.pendingActions.notTriedYet')}</p>}
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
