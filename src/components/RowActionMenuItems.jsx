import React, { useState } from 'react';
import { MailOpen, Mail, Archive, ArchiveRestore, FolderSymlink, Trash2, ShieldX, ImageDown } from 'lucide-react';
import { useMailStore } from '../stores/mailStore';
import { _selKey, resolveEmailLocation } from '../stores/slices/unifiedHelpers';
import { describeServerDelete, describeDeleteEverywhere } from '../utils/custodyCopy';
import { MoveToFolderDropdown } from './MoveToFolderDropdown';
import { MenuItem } from './ui/Popover';
import { useExportStore } from '../stores/exportStore';
import { useT } from '../i18n/index.js';

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
 * representative message.
 */
export function RowActionMenuItems({ emails, actions, onRequestDelete, onClose }) {
  const t = useT();
  const { saveEmailsLocally, removeLocalEmail, deleteEmailFromServer } = actions;
  const setSelection = useMailStore(s => s.setSelection);
  const markSelectedAsRead = useMailStore(s => s.markSelectedAsRead);
  const markSelectedAsUnread = useMailStore(s => s.markSelectedAsUnread);
  const purgeSelectedEverywhere = useMailStore(s => s.purgeSelectedEverywhere);
  const isUnified = useMailStore(s => s.activeMailbox === 'UNIFIED');
  const [showMove, setShowMove] = useState(false);

  // Selection key format the store's bulk workflows expect — accountId:uid in
  // unified inbox (cross-account uid collisions), plain uid otherwise. Every
  // message the checkbox would select, in the same order.
  const keys = emails.map(e => (isUnified ? _selKey(e) : e.uid));

  const hasUnread = emails.some(e => !e.flags?.includes('\\Seen'));
  const hasRead = emails.some(e => e.flags?.includes('\\Seen'));
  const hasUnarchived = emails.some(e => !e.isArchived);
  const hasArchived = emails.some(e => e.isArchived);
  const hasServerBacked = emails.some(e => e.source !== 'local-only');

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
            await saveEmailsLocally(emails.filter(em => !em.isArchived).map(em => em.uid));
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
                title: 'Delete from server?',
                description: describeServerDelete(
                  serverEmails.length,
                  serverEmails.filter(em => em.isArchived).length,
                ),
                confirmLabel: 'Delete from server',
              }
            );
          }}
        >
          <Trash2 size={14} />
          {t('rowMenu.deleteServer')}
        </MenuItem>
      )}

      {/* hasArchived || hasServerBacked is a verified tautology, not a live
          gate: the display-row derivation forces isArchived: true
          on every row whose source becomes 'local-only' (deriveDisplayRows in
          messageListSlice.js), so isLocalOnly always implies isArchived and
          this never evaluates false for a real email. Kept explicit as the
          documented reason Delete everywhere is always safe to show, rather
          than simplified to an unconditional render. */}
      {(hasArchived || hasServerBacked) && (
        <MenuItem
          tone="danger"
          onClick={(e) => {
            e.stopPropagation();
            onRequestDelete(
              () => runScoped(purgeSelectedEverywhere, { destructive: true }),
              {
                title: 'Delete everywhere?',
                description: describeDeleteEverywhere(emails.length),
                confirmLabel: 'Delete everywhere',
              }
            );
          }}
        >
          <ShieldX size={14} />
          {t('rowMenu.deleteEverywhere')}
        </MenuItem>
      )}
    </>
  );
}
