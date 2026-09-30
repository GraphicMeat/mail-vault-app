import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUnsubscribeStore, unsubscribeTarget } from '../stores/unsubscribeStore';
import { useTagStore } from '../stores/tagStore';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useQuickActionConfiguration } from '../hooks/useQuickActionConfiguration';
import { selectionKey, resolveEmailLocation } from '../stores/slices/unifiedHelpers';
import { describeServerDelete, describeReaderDelete } from '../utils/custodyCopy';
import { replyTarget } from '../utils/replyTarget';
import { openCompose } from '../utils/composeOpener';
import { setDeleteUndo, reloadListInView } from '../services/workflows/messageMutations';
import { isBackedUp, useBackupScan } from './email/MessageStateIcon';
import { MoveToFolderDropdown } from './MoveToFolderDropdown';
import { SnoozePicker } from './SnoozePicker';
import { registerRowActions } from '../utils/rowActionRegistry';
import { rowFacts, savedMailboxes, isLocalOnly } from '../utils/quickActionFacts';
import { describeQuickAction } from '../utils/quickActionCatalog';
import { QuickActions } from './QuickActions';
import { useExportStore } from '../stores/exportStore';
import { useT } from '../i18n/index.js';

const EMPTY_ARRAY = Object.freeze([]);

// `configOverride` shows that set instead of the saved one; `preview` (Settings'
// sample rows) makes every action a no-op and draws a wheel in place.
export function RowQuickActions({ emails, exportEmails = emails, actions, onRequestDelete, onClose, onArchive, onActionStart, disabled = false, identity, openAt, onBusyChange, configOverride, preview = false }) {
  const t = useT();
  const { config: savedConfig } = useQuickActionConfiguration('row');
  const config = configOverride || savedConfig;
  const localLabels = useTagStore(state => state.tags) || EMPTY_ARRAY;
  const templates = useSettingsStore(state => state.emailTemplates) || EMPTY_ARRAY;
  const composeOpenMode = useSettingsStore(state => state.composeOpenMode);
  const applyTagToRows = useTagStore(state => state.applyTagToRows);
  const markRead = useMailStore(state => state.markSelectedAsRead);
  const markUnread = useMailStore(state => state.markSelectedAsUnread);
  const setSelectedFlagged = useMailStore(state => state.setSelectedFlagged);
  const purgeSelected = useMailStore(state => state.purgeSelectedEverywhere);
  const [moveRect, setMoveRect] = useState(null);
  const [snoozeRect, setSnoozeRect] = useState(null);
  useEffect(() => { setMoveRect(null); setSnoozeRect(null); }, [identity]);
  // The row mounts this only while it is live; the menu, or the picker a menu
  // action opened, is what holds it live once the pointer has left the row.
  const [menuOpen, setMenuOpen] = useState(false);
  const busy = menuOpen || !!moveRect || !!snoozeRect;
  useEffect(() => {
    if (!busy) return undefined;
    onBusyChange?.(true);
    return () => onBusyChange?.(false);
  }, [busy]);
  const state = useMailStore.getState();
  const backupScan = useBackupScan();
  const keys = useMemo(() => emails.map(email => selectionKey(email, useMailStore.getState())), [emails, identity]);
  const describeRef = useRef(null);
  const registerMarker = useCallback(node => registerRowActions(node, describeRef), []);
  if (!emails.length) return null;

  const facts = rowFacts(emails, state, {
    backedUp: emails.some(email => isBackedUp(email, backupScan) === true),
    canConfirm: !!onRequestDelete,
    saving: disabled,
  });
  const { primary: newest, locations: locs, localFolder, purge, junkPath } = facts;
  const hasUnread = facts.has.markRead;
  const hasServerBacked = facts.serverBacked;
  const unsubscribe = facts.unsubscribe && unsubscribeTarget(facts.unsubscribe.email, facts.unsubscribe.accountId);
  const serverTargets = emails.map((email, index) => ({ email, location: locs[index] }))
    .filter(target => target.email.source !== 'local-only');
  const serverEmails = serverTargets.map(target => target.email);

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
  const requestServerDelete = () => onRequestDelete?.(deleteFromServer, localFolder ? {
    title: t('viewer.deleteEmail'),
    description: describeReaderDelete({ localFolder }),
    confirmLabel: t('common.delete'),
  } : {
    title: t('rowMenu.deleteServer2'),
    description: describeServerDelete(serverEmails.length, serverEmails.filter(email => email.isArchived).length),
    confirmLabel: t('rowMenu.deleteServer'),
  }, { confirmOptional: true });
  const requestUnarchive = () => {
    const archived = emails.filter(email => email.isArchived);
    const localOnly = archived.some(isLocalOnly);
    onRequestDelete?.(async () => {
      // One call: grouped per (account, mailbox) into one vault delete each.
      const state = useMailStore.getState();
      const targets = archived
        .map(email => ({ uid: email.uid, location: resolveEmailLocation(email, state) }))
        .filter(target => target.location);
      if (targets.length) await actions.removeLocalEmails(targets);
    }, {
      title: t('viewer.unarchiveEmail'),
      description: localOnly ? t('viewer.emailOnlyExistsLocalArchive') : t('viewer.cachedCopyRemovedEmailStill'),
      confirmLabel: t('rowMenu.unarchive'),
    });
  };
  const requestEverywhereDelete = () => onRequestDelete?.(() => runScoped(purgeSelected, { destructive: true }), {
    title: purge.title, description: purge.description, confirmLabel: purge.label,
  });
  // Reply/replyAll open on the header alone right away — the wheel closes and
  // compose appears instantly — then hand in the resolved body once it lands.
  // `_fillFrom: newest` makes that second call fill-only (App.jsx's
  // openCompose): it patches whichever window is still open on this exact
  // header instead of possibly reopening one the user already sent, closed
  // or minimized while the fetch was in flight. Forward inlines the body
  // into the message itself, so it still waits for the fetch before opening.
  // So does any reply when compose opens in a window of its own: that window
  // takes the draft as it stands and never gets the fill (utils/sameReply.js).
  const openReply = async mode => {
    if (mode === 'forward' || composeOpenMode === 'window') {
      openCompose({ mode, replyTo: await replyTarget(newest, null, useMailStore.getState()) });
      return;
    }
    openCompose({ mode, replyTo: newest });
    const resolved = await replyTarget(newest, null, useMailStore.getState());
    if (resolved !== newest) openCompose({ mode, replyTo: resolved, _fillFrom: newest });
  };
  const openNewMessage = () => openCompose({ initialData: { to: facts.sender, _prefill: true, ...(newest._accountId ? { _accountId: newest._accountId } : {}) } });
  const ctx = { tags: localLabels, templates, folders: accountId => savedMailboxes(state, accountId) };
  // One entry's descriptor. Also what a trackpad swipe runs an action through
  // (utils/rowActionRegistry.js), whether or not the row's menu lists it.
  const describe = entry => {
    const template = templates.find(item => item.id === entry.params?.templateId);
    return {
      ...describeQuickAction('row', entry, facts, ctx),
      onActivate: preview ? () => {} : async event => {
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
          await applyTagToRows(emails.map((email, index) => ({ email, location: locs[index] })), entry.params.tagId);
          onClose?.();
        } else if (entry.action === 'move' && entry.params?.mailbox) {
          await useMailStore.getState().moveEmails(keys, entry.params.mailbox); onClose?.();
        } else if (entry.action === 'move') {
          setMoveRect(event.currentTarget.getBoundingClientRect());
        } else if (entry.action === 'snooze') {
          setSnoozeRect(event.currentTarget.getBoundingClientRect());
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
        else if (entry.action === 'unsubscribe') { onClose?.(); useUnsubscribeStore.getState().request(unsubscribe); }
      },
    };
  };
  // A thread's toggle offers both directions, as two entries of their own.
  // Only the menu's copy: describe() keeps toggleRead for the swipe registry.
  const menuConfig = emails.length > 1 && config.entries.some(entry => entry.action === 'toggleRead')
    ? { ...config, entries: config.entries.flatMap(entry => entry.action !== 'toggleRead' ? [entry] : [
      { ...entry, id: `${entry.id}:markRead`, action: 'markRead', thread: true },
      { ...entry, id: `${entry.id}:markUnread`, action: 'markUnread', thread: true },
    ]) }
    : config;
  const descriptors = menuConfig.entries.filter(entry => !['open', 'source', 'theme'].includes(entry.action)).map(describe);
  describeRef.current = describe;

  return <>
    <span hidden data-row-actions ref={registerMarker} />
    <QuickActions surface="row" config={menuConfig} descriptors={descriptors} identity={identity || keys.join('|')} onActionStart={onActionStart} openAt={openAt} onOpenChange={setMenuOpen} preview={preview} />
    {moveRect && <MoveToFolderDropdown uids={keys} anchorRect={moveRect} accountId={locs[0]?.accountId}
      currentMailbox={facts.mailbox}
      onMove={target => useMailStore.getState().moveEmails(keys, target)}
      onClose={() => { setMoveRect(null); onClose?.(); }} />}
    {snoozeRect && <SnoozePicker keys={keys} anchorRect={snoozeRect}
      onClose={() => { setSnoozeRect(null); onClose?.(); }} />}
  </>;
}
