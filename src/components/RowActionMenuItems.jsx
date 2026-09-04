import React, { useState } from 'react';
import { MailOpen, Mail, Archive, ArchiveRestore, FolderSymlink, Trash2, ShieldX, ImageDown, Reply, MailPlus } from 'lucide-react';
import { useMailStore } from '../stores/mailStore';
import { selectionKey, resolveEmailLocation } from '../stores/slices/unifiedHelpers';
import { describeServerDelete, describePurge } from '../utils/custodyCopy';
import { isBackedUp, useBackupScan } from './email/MessageStateIcon';
import { MoveToFolderDropdown } from './MoveToFolderDropdown';
import { MenuItem } from './ui/Popover';
import { useExportStore } from '../stores/exportStore';
import { openCompose } from '../utils/composeOpener';
import { replyTarget } from '../utils/replyTarget';
import { getSenderName } from '../utils/emailParser';
import { t, useT  } from '../i18n/index.js';

/**
 * Contents of a row's 3-dot menu.
 *
 * One component, four consumers (EmailRow, CompactEmailRow, ThreadRow,
 * CompactThreadRow). `emails` is every message the row's own checkbox would
 * select — one message for EmailRow/CompactEmailRow, every message in the
 * thread for ThreadRow/CompactThreadRow — so the menu acts on exactly what
 * checking that checkbox selects. Gating is derived from the whole set the
 * same way SelectionActionBar derives Archive/Unarchive from
 * hasArchived/hasUnarchived over the bulk selection, instead of off one
 * representative message. The top section is the exception: it composes
 * (Reply to the newest member, a new message to its sender), so it acts on
 * `newest`, not on the whole set.
 */
export function RowActionMenuItems({ emails, actions, onRequestDelete, onClose }) {
  const t = useT();
  const { saveEmailsLocally, removeLocalEmail, deleteEmailFromServer } = actions;
  const setSelection = useMailStore(s => s.setSelection);
  const markSelectedAsRead = useMailStore(s => s.markSelectedAsRead);
  const markSelectedAsUnread = useMailStore(s => s.markSelectedAsUnread);
  const purgeSelectedEverywhere = useMailStore(s => s.purgeSelectedEverywhere);
  const [showMove, setShowMove] = useState(false);

  // The key the store's bulk workflows expect — the one the checkbox writes.
  // Every message the checkbox would select, in the same order.
  const keys = emails.map(e => selectionKey(e, useMailStore.getState()));

  // Reply goes to the newest message the row holds — the one the row shows —
  // with its body loaded first so the quote is the message, not the row. A
  // thread row's members are the folder's own messages (threadRowMembers),
  // so an INBOX thread answers the partner, not our own Sent copy.
  const newest = emails.reduce((a, b) => (new Date(b.date) > new Date(a.date) ? b : a));
  const senderAddress = newest.from?.address || '';

  const replyToNewest = async () => {
    openCompose({ mode: 'reply', replyTo: await replyTarget(newest, null, useMailStore.getState()) });
  };

  const newMessageToSender = () => {
    // A fresh conversation, not a reply: no subject, no quote, no
    // In-Reply-To — just the address, from the account the row lives in.
    openCompose({
      initialData: {
        to: senderAddress,
        _prefill: true,
        ...(newest._accountId ? { _accountId: newest._accountId } : {}),
      },
    });
  };

  const hasUnread = emails.some(e => !e.flags?.includes('\\Seen'));
  const hasRead = emails.some(e => e.flags?.includes('\\Seen'));
  const hasUnarchived = emails.some(e => !e.isArchived);
  const hasArchived = emails.some(e => e.isArchived);
  const hasServerBacked = emails.some(e => e.source !== 'local-only');

  // Where this row's messages actually are, ORed over the whole set — the
  // purge clears every place any of them is, so the copy has to name every
  // place any of them is. The vault axis is `isArchived` (the same field the
  // row glyph reads); the backup axis is the mirror scan, which answers
  // true / false / null and only `true` is a copy we can promise to delete.
  const backupScan = useBackupScan();
  const purge = describePurge({
    server: hasServerBacked,
    vault: hasArchived,
    backup: emails.some(e => isBackedUp(e, backupScan) === true),
  }, emails.length);

  // markSelectedAsRead/Unread and purgeSelectedEverywhere act on the global
  // selectedEmailIds — and, as part of finishing, unconditionally reset it to
  // empty (messageMutations.js _markSelected / purgeEverywhere). Scoping it
  // to just this row's keys would silently blow away an unrelated bulk
  // selection the user still has active elsewhere. Stash it, scope, run,
  // then restore — dropping this row's own keys from the restore set for
  // destructive actions, since those messages no longer exist to stay
  // selected. Non-destructive actions restore the prior set untouched, so a
  // row that wasn't previously selected ends up not selected.
  //
  // `fn` itself unconditionally clears selectedEmailIds as part of its own
  // completion (messageMutations.js _markSelected/purgeEverywhere both
  // `setState({ selectedEmailIds: new Set() })` before any awaited network
  // work) — so by the time `await fn()` resolves, live is normally empty,
  // not "still equal to keys". That's the workflow's own side effect, not
  // someone else taking ownership, and still needs a restore. `fn` can also
  // be slow enough (a per-key network loop, a multi-step purge) for the user
  // to toggle a different row's checkbox or fire another row's action while
  // still in flight — that write lands as a non-empty, non-matching live
  // value, and must be left alone rather than stomped with the stale prior.
  const runScoped = async (fn, { destructive = false } = {}) => {
    const prior = [...useMailStore.getState().selectedEmailIds];
    setSelection(keys);
    try {
      await fn();
    } finally {
      const live = useMailStore.getState().selectedEmailIds;
      const keySet = new Set(keys);
      const matchesScoped = live.size === keys.length && keys.every(k => live.has(k));
      const stillOurs = live.size === 0 || matchesScoped;
      if (stillOurs) {
        setSelection(destructive ? prior.filter(k => !keySet.has(k)) : prior);
      }
    }
  };

  const runOnThisRow = (fn) => runScoped(fn).finally(onClose);

  return (
    <>
      <MenuItem onClick={(e) => { e.stopPropagation(); onClose(); replyToNewest(); }}>
        <Reply size={14} />
        {t('emailActionBar.reply')}
      </MenuItem>
      {senderAddress && (
        <MenuItem onClick={(e) => { e.stopPropagation(); onClose(); newMessageToSender(); }}>
          <MailPlus size={14} />
          {t('rowMenu.newMessageTo', { name: getSenderName(newest) })}
        </MenuItem>
      )}
      <div role="separator" className="my-1 border-t border-mail-border" />

      {hasUnread && (
        <MenuItem onClick={(e) => { e.stopPropagation(); runOnThisRow(markSelectedAsRead); }}>
          <MailOpen size={14} />
          {t('rowMenu.markRead')}
        </MenuItem>
      )}
      {hasRead && (
        <MenuItem onClick={(e) => { e.stopPropagation(); runOnThisRow(markSelectedAsUnread); }}>
          <Mail size={14} />
          {t('rowMenu.markUnread')}
        </MenuItem>
      )}

      {hasUnarchived && (
        <MenuItem
          onClick={async (e) => {
            e.stopPropagation();
            await saveEmailsLocally(emails.filter(em => !em.isArchived));
            onClose();
          }}
        >
          <Archive size={14} />
          {t('common.archive')}
        </MenuItem>
      )}
      {hasArchived && (
        <MenuItem
          onClick={async (e) => {
            e.stopPropagation();
            for (const em of emails.filter(m => m.isArchived)) await removeLocalEmail(em.uid);
            onClose();
          }}
        >
          <ArchiveRestore size={14} />
          {t('rowMenu.unarchive')}
        </MenuItem>
      )}

      <MenuItem onClick={(e) => {
        e.stopPropagation();
        useExportStore.getState().openExport({ messages: emails });
        onClose();
      }}>
        <ImageDown size={14} />
        Export…
      </MenuItem>

      <div className="relative">
        <MenuItem onClick={(e) => { e.stopPropagation(); setShowMove(v => !v); }}>
          <FolderSymlink size={14} />
          {t('rowMenu.moveFolder')}
        </MenuItem>
        {showMove && (
          <div className="absolute left-full top-0 ml-1">
            <MoveToFolderDropdown uids={keys} onClose={() => { setShowMove(false); onClose(); }} anchorRect={null} />
          </div>
        )}
      </div>

      {hasServerBacked && (
        <MenuItem
          tone="danger"
          onClick={(e) => {
            e.stopPropagation();
            const serverEmails = emails.filter(em => em.source !== 'local-only');
            onRequestDelete(
              async () => {
                if (serverEmails.length === 1) {
                  await deleteEmailFromServer(serverEmails[0].uid);
                  return;
                }
                // Multiple messages: each needs its own folder resolved — the
                // same uid in another folder is a different message, and
                // this delete is irreversible. skipRefresh + one trailing
                // loadEmails avoids N redundant reloads.
                const state = useMailStore.getState();
                for (const em of serverEmails) {
                  const mailbox = resolveEmailLocation(em, state)?.mailbox;
                  if (!mailbox) {
                    console.error(`[RowActionMenuItems] Unknown mailbox for email ${em.uid} — skipped`);
                    continue;
                  }
                  try {
                    await deleteEmailFromServer(em.uid, { skipRefresh: true, mailboxOverride: mailbox });
                  } catch (err) {
                    console.error(`[RowActionMenuItems] Failed to delete email ${em.uid} from ${mailbox}:`, err);
                  }
                }
                useMailStore.getState().loadEmails();
              },
              {
                title: t('rowMenu.deleteServer2'),
                description: describeServerDelete(
                  serverEmails.length,
                  serverEmails.filter(em => em.isArchived).length,
                ),
                confirmLabel: t('rowMenu.deleteServer'),
              }
            );
          }}
        >
          <Trash2 size={14} />
          {t('rowMenu.deleteServer')}
        </MenuItem>
      )}

      {/* Only where a copy of our own exists. On a message that is nothing but
          a server message, this item used to render as "Delete everywhere" and
          did exactly what the item above it does — a second, scarier-sounding
          spelling of Delete from server. `describePurge` returns null for that
          scope, which is the gate; every scope it names has a vault or backup
          copy to destroy, and the item says which. */}
      {purge && (
        <MenuItem
          tone="danger"
          onClick={(e) => {
            e.stopPropagation();
            onRequestDelete(
              () => runScoped(purgeSelectedEverywhere, { destructive: true }),
              { title: purge.title, description: purge.description, confirmLabel: purge.label },
            );
          }}
        >
          <ShieldX size={14} />
          {purge.label}
        </MenuItem>
      )}
    </>
  );
}
