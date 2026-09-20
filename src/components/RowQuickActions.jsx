import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive, ArchiveRestore, Forward, FolderInput, ImageDown, Mail, MailOpen,
  MailPlus, Reply, ReplyAll, ShieldAlert, ShieldX, Star, StarOff, Tag, Trash2,
} from 'lucide-react';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useQuickActionConfiguration } from '../hooks/useQuickActionConfiguration';
import { selectionKey, resolveEmailLocation, spansMailboxes } from '../stores/slices/unifiedHelpers';
import { describePurge, describeServerDelete } from '../utils/custodyCopy';
import { replyTarget } from '../utils/replyTarget';
import { getSenderName } from '../utils/emailParser';
import { openCompose } from '../utils/composeOpener';
import { setDeleteUndo, reloadListInView } from '../services/workflows/messageMutations';
import { getAccountCacheMailboxes } from '../services/cacheManager';
import { isBackedUp, useBackupScan } from './email/MessageStateIcon';
import { MoveToFolderDropdown } from './MoveToFolderDropdown';
import { QuickActions } from './QuickActions';
import { useExportStore } from '../stores/exportStore';
import { useT } from '../i18n/index.js';

const ICONS = {
  archive: Archive, unarchive: ArchiveRestore, delete: Trash2, deleteServer: Trash2,
  deleteEverywhere: ShieldX, toggleRead: MailOpen, markRead: MailOpen, markUnread: Mail,
  star: Star, unstar: StarOff, tag: Tag, move: FolderInput, spam: ShieldAlert,
  reply: Reply, replyAll: ReplyAll, forward: Forward, replyTemplate: Reply,
  export: ImageDown, newMessage: MailPlus,
};
const DESTRUCTIVE = new Set(['delete', 'deleteServer', 'deleteEverywhere']);
const EMPTY_ARRAY = Object.freeze([]);
const isLocalOnly = email => email?.source === 'local-only' || email?._origin === 'local-only';

function savedMailboxes(state, accountId) {
  return accountId === state.activeAccountId ? state.mailboxes || [] : getAccountCacheMailboxes(accountId) || [];
}

function locationsFor(emails, state) {
  return emails.map(email => resolveEmailLocation(email, state));
}

function sameResolvedAccount(locations) {
  return locations.length > 0 && locations.every(Boolean) && new Set(locations.map(location => location.accountId)).size === 1;
}

function folderPath(folder) { return folder?.path || folder?.name || null; }

export function RowQuickActions({ emails, exportEmails = emails, actions, onRequestDelete, onClose, onArchive, onActionStart, disabled = false, identity }) {
  const t = useT();
  const { config } = useQuickActionConfiguration('row');
  const localLabels = useSettingsStore(state => state.localMailLabels) || EMPTY_ARRAY;
  const templates = useSettingsStore(state => state.emailTemplates) || EMPTY_ARRAY;
  const addLabel = useSettingsStore(state => state.applyLocalMailLabel);
  const markRead = useMailStore(state => state.markSelectedAsRead);
  const markUnread = useMailStore(state => state.markSelectedAsUnread);
  const setSelectedFlagged = useMailStore(state => state.setSelectedFlagged);
  const purgeSelected = useMailStore(state => state.purgeSelectedEverywhere);
  const [moveRect, setMoveRect] = useState(null);
  useEffect(() => setMoveRect(null), [identity]);
  const state = useMailStore.getState();
  const backupScan = useBackupScan();
  const keys = useMemo(() => emails.map(email => selectionKey(email, useMailStore.getState())), [emails, identity]);
  if (!emails.length) return null;

  const newest = emails.reduce((a, b) => new Date(b.date) > new Date(a.date) ? b : a);
  const senderAddress = newest.from?.address || '';
  const locs = locationsFor(emails, state);
  const hasUnread = emails.some(email => !email.flags?.includes('\\Seen'));
  const hasRead = emails.some(email => email.flags?.includes('\\Seen'));
  const hasUnflagged = emails.some(email => !email.flags?.includes('\\Flagged'));
  const hasFlagged = emails.some(email => email.flags?.includes('\\Flagged'));
  const hasUnarchived = emails.some(email => !email.isArchived);
  const hasArchived = emails.some(email => email.isArchived);
  const serverTargets = emails.map((email, index) => ({ email, location: locs[index] }))
    .filter(target => target.email.source !== 'local-only');
  const serverEmails = serverTargets.map(target => target.email);
  const hasServerBacked = serverEmails.length > 0;
  const purge = describePurge({
    server: hasServerBacked,
    vault: hasArchived,
    backup: emails.some(email => isBackedUp(email, backupScan) === true),
  }, emails.length);
  const locationsResolved = locs.length > 0 && locs.every(Boolean);
  const oneAccount = sameResolvedAccount(locs);
  const oneMailbox = locs.length > 0 && locs.every(location => location?.mailbox === locs[0]?.mailbox);
  const canServerAction = locationsResolved && emails.every(email => email.source !== 'local-only'
    && !email._insightsReadOnly && !email._insightsNoServerActions);
  const accountIds = locationsResolved ? [...new Set(locs.map(location => location.accountId))] : [];
  const junkTargets = accountIds.map(accountId => {
    const junk = savedMailboxes(state, accountId).find(folder => String(folder.specialUse || '').toLowerCase() === '\\junk');
    return junk ? folderPath(junk) : null;
  });
  const junkPath = junkTargets.length && junkTargets.every(Boolean) && new Set(junkTargets).size === 1 ? junkTargets[0] : null;

  const runScoped = async (fn, { destructive = false } = {}) => {
    const prior = [...useMailStore.getState().selectedEmailIds];
    useMailStore.getState().setSelection(keys);
    try { await fn(); }
    finally {
      const live = useMailStore.getState().selectedEmailIds;
      const keySet = new Set(keys);
      const matchesScoped = live.size === keys.length && keys.every(key => live.has(key));
      if (live.size === 0 || matchesScoped) useMailStore.getState().setSelection(destructive ? prior.filter(key => !keySet.has(key)) : prior);
    }
  };
  const deleteFromServer = async () => {
    if (serverTargets.length === 1) {
      const { email, location } = serverTargets[0];
      return actions.deleteEmailFromServer(email.uid, { accountId: location?.accountId, mailboxOverride: location?.mailbox });
    }
    const outcomes = [];
    for (const { email, location } of serverTargets) {
      if (!location) continue;
      try { outcomes.push(await actions.deleteEmailFromServer(email.uid, { skipRefresh: true, accountId: location.accountId, mailboxOverride: location.mailbox })); }
      catch (error) { console.error(`[RowQuickActions] Failed to delete email ${email.uid} from ${location.mailbox}:`, error); }
    }
    await reloadListInView();
    setDeleteUndo(outcomes.filter(Boolean));
  };
  const requestServerDelete = () => onRequestDelete?.(deleteFromServer, {
    title: t('rowMenu.deleteServer2'),
    description: describeServerDelete(serverEmails.length, serverEmails.filter(email => email.isArchived).length),
    confirmLabel: t('rowMenu.deleteServer'),
  });
  const requestUnarchive = () => {
    const archived = emails.filter(email => email.isArchived);
    const localOnly = archived.some(isLocalOnly);
    onRequestDelete?.(async () => {
      for (const email of archived) {
        const location = resolveEmailLocation(email, useMailStore.getState());
        if (location) await actions.removeLocalEmail(email.uid, location);
      }
    }, {
      title: t('viewer.unarchiveEmail'),
      description: localOnly ? t('viewer.emailOnlyExistsLocalArchive') : t('viewer.cachedCopyRemovedEmailStill'),
      confirmLabel: t('rowMenu.unarchive'),
    });
  };
  const requestEverywhereDelete = () => onRequestDelete?.(() => runScoped(purgeSelected, { destructive: true }), {
    title: purge.title, description: purge.description, confirmLabel: purge.label,
  });
  const openReply = async mode => openCompose({ mode, replyTo: await replyTarget(newest, null, useMailStore.getState()) });
  const openNewMessage = () => openCompose({ initialData: { to: senderAddress, _prefill: true, ...(newest._accountId ? { _accountId: newest._accountId } : {}) } });
  const actionLabel = entry => {
    if (entry.action === 'tag') return localLabels.find(label => label.id === entry.params?.labelId)?.name || t('quickActions.action.tag');
    if (entry.action === 'move' && entry.params?.mailbox) return `${t('quickActions.action.move')}: ${entry.params.mailbox}`;
    if (entry.action === 'replyTemplate') return templates.find(template => template.id === entry.params?.templateId)?.name || t('quickActions.action.replyTemplate');
    if (entry.action === 'toggleRead') return hasUnread ? t('rowMenu.markRead') : t('rowMenu.markUnread');
    if (entry.action === 'archive') return t('common.archive');
    if (entry.action === 'delete') return t('common.delete');
    if (entry.action === 'deleteServer') return t('rowMenu.deleteServer');
    if (entry.action === 'deleteEverywhere') return purge?.label || t('rowMenu.deleteEverywhere');
    if (entry.action === 'unarchive') return t('rowMenu.unarchive');
    if (entry.action === 'markRead') return t('rowMenu.markRead');
    if (entry.action === 'markUnread') return t('rowMenu.markUnread');
    if (entry.action === 'star') return t('rowMenu.star');
    if (entry.action === 'unstar') return t('rowMenu.unstar');
    if (entry.action === 'move') return t('rowMenu.moveFolder');
    if (entry.action === 'spam') return t('quickActions.action.spam');
    if (entry.action === 'reply') return t('emailActionBar.reply');
    if (entry.action === 'replyAll') return t('emailActionBar.replyAll');
    if (entry.action === 'forward') return t('emailActionBar.forward');
    if (entry.action === 'export') return t('common.export');
    if (entry.action === 'newMessage') return t('rowMenu.newMessageTo', { name: getSenderName(newest) });
    return t('quickActions.title');
  };
  const descriptors = config.entries.filter(entry => !['open', 'source', 'theme'].includes(entry.action)).map(entry => {
    const template = templates.find(item => item.id === entry.params?.templateId);
    const label = localLabels.find(item => item.id === entry.params?.labelId);
    const savedTargetAccount = entry.params?.accountId || (oneAccount ? locs[0].accountId : null);
    const destination = savedTargetAccount && savedMailboxes(state, savedTargetAccount)
      .some(folder => folderPath(folder) === entry.params?.mailbox);
    const targetMatches = entry.params?.accountId ? locs.every(location => location?.accountId === entry.params.accountId) : oneAccount;
    const disabledAction = entry.action === 'archive' && (!hasUnarchived || disabled)
      || entry.action === 'unarchive' && (!hasArchived || !locationsResolved || !onRequestDelete)
      || entry.action === 'delete' && (!onRequestDelete || hasServerBacked && !canServerAction || !hasServerBacked && !emails.every(isLocalOnly))
      || entry.action === 'deleteServer' && (!hasServerBacked || !canServerAction || !onRequestDelete)
      || entry.action === 'deleteEverywhere' && (!purge || !locationsResolved || !onRequestDelete)
      || entry.action === 'toggleRead' && !locationsResolved
      || entry.action === 'markRead' && !hasUnread
      || entry.action === 'markUnread' && !hasRead
      || entry.action === 'star' && !hasUnflagged
      || entry.action === 'unstar' && !hasFlagged
      || entry.action === 'tag' && (!label || !locationsResolved)
      || entry.action === 'move' && (!canServerAction || (entry.params?.mailbox ? !targetMatches || !destination : !oneAccount))
      || entry.action === 'spam' && (!junkPath || !oneAccount || !canServerAction)
      || entry.action === 'replyTemplate' && !template
      || entry.action === 'newMessage' && !senderAddress;
    return {
      id: entry.id, action: entry.action, label: actionLabel(entry), Icon: ICONS[entry.action],
      disabled: !!disabledAction,
      hidden: entry.action === 'deleteServer' && !hasServerBacked,
      tone: DESTRUCTIVE.has(entry.action) ? 'danger' : ['archive', 'unarchive'].includes(entry.action) ? 'positive' : undefined,
      isDestructive: DESTRUCTIVE.has(entry.action),
      restoreFocus: !['move', 'delete', 'deleteServer', 'deleteEverywhere', 'unarchive', 'reply', 'replyAll', 'forward', 'replyTemplate', 'newMessage'].includes(entry.action),
      onActivate: async event => {
        if (entry.action === 'archive') { await (onArchive ? onArchive(event) : actions.saveEmailsLocally?.(emails.filter(email => !email.isArchived))); onClose?.(); }
        else if (entry.action === 'unarchive') { onClose?.(); requestUnarchive(); }
        else if (entry.action === 'delete') { onClose?.(); hasServerBacked ? requestServerDelete() : requestUnarchive(); }
        else if (entry.action === 'deleteServer') { onClose?.(); requestServerDelete(); }
        else if (entry.action === 'deleteEverywhere') { onClose?.(); requestEverywhereDelete(); }
        else if (entry.action === 'toggleRead') { await runScoped(hasUnread ? markRead : markUnread); onClose?.(); }
        else if (entry.action === 'markRead') { await runScoped(markRead); onClose?.(); }
        else if (entry.action === 'markUnread') { await runScoped(markUnread); onClose?.(); }
        else if (entry.action === 'star') { await runScoped(() => setSelectedFlagged(true)); onClose?.(); }
        else if (entry.action === 'unstar') { await runScoped(() => setSelectedFlagged(false)); onClose?.(); }
        else if (entry.action === 'tag') {
          for (let index = 0; index < emails.length; index++) if (locs[index]) addLabel(emails[index], locs[index], entry.params.labelId);
          onClose?.();
        } else if (entry.action === 'move' && entry.params?.mailbox) {
          await useMailStore.getState().moveEmails(keys, entry.params.mailbox); onClose?.();
        } else if (entry.action === 'move') {
          setMoveRect(event.currentTarget.getBoundingClientRect());
        } else if (entry.action === 'spam') {
          await useMailStore.getState().moveEmails(keys, junkPath); onClose?.();
        } else if (entry.action === 'reply') { onClose?.(); await openReply('reply'); }
        else if (entry.action === 'replyAll') { onClose?.(); await openReply('replyAll'); }
        else if (entry.action === 'forward') { onClose?.(); await openReply('forward'); }
        else if (entry.action === 'replyTemplate') {
          onClose?.();
          openCompose({ mode: 'reply', replyTo: await replyTarget(newest, null, useMailStore.getState()), templateBody: template.body });
        } else if (entry.action === 'export') {
          useExportStore.getState().openExport({ messages: exportEmails }); onClose?.();
        } else if (entry.action === 'newMessage') { onClose?.(); openNewMessage(); }
      },
    };
  });

  return <>
    <QuickActions surface="row" config={config} descriptors={descriptors} identity={identity || keys.join('|')} onActionStart={onActionStart} />
    {moveRect && <MoveToFolderDropdown uids={keys} anchorRect={moveRect} accountId={locs[0]?.accountId}
      currentMailbox={oneMailbox ? locs[0]?.mailbox : null}
      onMove={target => useMailStore.getState().moveEmails(keys, target)}
      onClose={() => { setMoveRect(null); onClose?.(); }} />}
  </>;
}
