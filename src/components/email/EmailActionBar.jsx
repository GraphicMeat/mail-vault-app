import React, { memo, useState } from 'react';
import { motion } from 'framer-motion';
import { useUnsubscribeStore, unsubscribeTarget } from '../../stores/unsubscribeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTagStore } from '../../stores/tagStore';
import { useMailStore } from '../../stores/mailStore';
import { selectionKey } from '../../stores/slices/unifiedHelpers';
import { openCompose } from '../../utils/composeOpener';
import { replyTarget } from '../../utils/replyTarget';
import { QuickActions } from '../QuickActions';
import { SnoozePicker } from '../SnoozePicker';
import { useQuickActionConfiguration } from '../../hooks/useQuickActionConfiguration';
import { useT } from '../../i18n/index.js';
import { DEFAULT_QUICK_ACTIONS } from '../../utils/quickActions';
import { readerFacts, savedMailboxes } from '../../utils/quickActionFacts';
import { describeQuickAction } from '../../utils/quickActionCatalog';
import { runMessageAction } from '../../utils/messageActions';

const EMPTY_ARRAY = Object.freeze([]);

export const EmailActionBar = memo(function EmailActionBar({
  email, variant = 'single', onReply, onReplyAll, onForward, onArchive, onDelete,
  onDeleteEverywhere, onMove, onToggleRead, onToggleFlag, onSpam, onApplyLocalLabel,
  onReplyTemplate, onOpenInWindow, onViewSource, onExport, onToggleEmailTheme,
  emailThemeDark, isArchived, isRead, isLocalOnly, isSentEmail, singleRecipient,
  configOverride, onActionPreview, preview = false,
  disabled = {}, moveButtonRef, moveDropdownOpen = false, onMenuOpenChange, onActionStart,
}) {
  const t = useT();
  const display = useSettingsStore(s => s.actionButtonDisplay);
  const localLabels = useTagStore(s => s.tags) || EMPTY_ARRAY;
  const templates = useSettingsStore(s => s.emailTemplates) || EMPTY_ARRAY;
  const applyTag = useTagStore(s => s.applyTag);
  const { config: storedConfig } = useQuickActionConfiguration('reader');
  const [snoozeRect, setSnoozeRect] = useState(null);
  const config = configOverride || storedConfig;
  const state = useMailStore.getState();
  // Which actions are on offer follows from the handlers this host wired: a
  // missing one hides its action.
  const facts = readerFacts(email, state, {
    onReply, onReplyAll, onForward, onArchive, onDelete, onDeleteEverywhere, onMove, onToggleRead, onToggleFlag,
    onSpam, onApplyLocalLabel, onOpenInWindow, onViewSource, onExport, onToggleEmailTheme,
    isRead, isArchived, isLocalOnly, isSentEmail, singleRecipient, emailThemeDark, disabled,
  }, config.entries, { canTag: !!applyTag });
  const [location] = facts.locations;
  const { accountId } = facts;
  const read = !facts.has.markRead;
  const flagged = facts.has.unstar;
  const hasExplicitStarModes = facts.explicit.star;
  const ctx = { tags: localLabels, templates, folders: id => savedMailboxes(state, id) };

  // What each action does here, for runMessageAction: this one message, and
  // the handlers its host wired (a missing one does nothing).
  const call = (handler, ...args) => (handler ? () => handler(email, ...args) : undefined);
  const actionCtx = {
    hasUnread: !read, flagged, starToggles: !hasExplicitStarModes,
    compose: mode => ({ reply: onReply, replyAll: onReplyAll, forward: onForward }[mode]?.(email)),
    replyTemplate: async (templateId) => {
      const template = templates.find(item => item.id === templateId);
      if (onReplyTemplate) onReplyTemplate(email, template);
      else openCompose({ mode: 'reply', replyTo: await replyTarget(email, null, useMailStore.getState()), templateBody: template.body });
    },
    archive: call(onArchive), unarchive: call(onArchive),
    delete: call(onDelete), deleteServer: call(onDelete), deleteEverywhere: call(onDeleteEverywhere),
    // The direction the button shows, not one each handler re-reads off an
    // email copy that may be older than `read`.
    setRead: onToggleRead && (value => onToggleRead(email, value)),
    setFlagged: onToggleFlag && (value => onToggleFlag(email, value)),
    moveTo: mailbox => useMailStore.getState().moveEmails([selectionKey(email, useMailStore.getState())], mailbox),
    pickFolder: call(onMove),
    spam: onSpam ? () => onSpam(email) : facts.junkPath ? () => useMailStore.getState().moveEmails([selectionKey(email, state)], facts.junkPath) : undefined,
    pickSnooze: (event) => setSnoozeRect(event.currentTarget.getBoundingClientRect()),
    tag: tagId => (onApplyLocalLabel ? onApplyLocalLabel(email, tagId) : applyTag(email, location, tagId)),
    export: call(onExport),
    unsubscribe: () => useUnsubscribeStore.getState().request(unsubscribeTarget(email, accountId)),
    openInWindow: call(onOpenInWindow), viewSource: call(onViewSource), toggleTheme: call(onToggleEmailTheme),
  };

  const descriptors = config.entries.map(entry => ({
    ...describeQuickAction('reader', entry, facts, ctx),
    buttonRef: entry.action === 'move' ? moveButtonRef : undefined,
    expanded: entry.action === 'move' ? moveDropdownOpen : undefined,
    onActivate: (event) => (onActionPreview ? onActionPreview(entry, email) : runMessageAction(entry, actionCtx, event)),
  })).filter(descriptor => !descriptor.hidden);

  const snoozePicker = snoozeRect && email && (
    <SnoozePicker keys={[selectionKey(email, useMailStore.getState())]} anchorRect={snoozeRect} onClose={() => setSnoozeRect(null)} />
  );
  const defaultReaderIds = DEFAULT_QUICK_ACTIONS.defaults.reader.entries.map(item => item.id).join('|');
  const useReaderDefaultGroups = config.mode === 'inline' && config.entries.map(item => item.id).join('|') === defaultReaderIds;
  const mainEntries = config.entries.filter(item => !['open', 'source', 'theme'].includes(item.action));
  const toolEntries = config.entries.filter(item => item.action === 'theme');
  const moreEntries = config.entries.filter(item => ['open', 'source'].includes(item.action));
  const groupedConfig = entries => ({ ...config, entries, favoriteId: null });
  if (variant === 'chat' && useReaderDefaultGroups) return <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: .15 }} className="email-action-bar email-action-chat">
    <div className="email-action-group email-action-main"><QuickActions surface="reader" config={groupedConfig(mainEntries)} descriptors={descriptors} display={display} preview={preview} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} onActionStart={onActionStart} /></div>
    <div className="email-action-group email-action-tools">
      <QuickActions surface="reader" config={groupedConfig(toolEntries)} descriptors={descriptors} display={display} preview={preview} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} />
      <QuickActions surface="reader" config={{ ...groupedConfig(moreEntries), mode: 'menu' }} descriptors={descriptors} display={display} preview={preview} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} onOpenChange={onMenuOpenChange} />
    </div>
    {snoozePicker}
  </motion.div>;
  if (variant !== 'chat' && useReaderDefaultGroups) return <div className="email-action-bar">
    <div className="email-action-group email-action-main"><QuickActions surface="reader" config={groupedConfig(mainEntries)} descriptors={descriptors} display={display} preview={preview} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} onActionStart={onActionStart} /></div>
    <div className="email-action-group email-action-tools">
      <QuickActions surface="reader" config={groupedConfig(toolEntries)} descriptors={descriptors} display={display} preview={preview} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} />
      <QuickActions surface="reader" config={{ ...groupedConfig(moreEntries), mode: 'menu' }} descriptors={descriptors} display={display} preview={preview} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} />
    </div>
    {snoozePicker}
  </div>;
  if (variant === 'chat') return <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: .15 }} className="email-action-bar email-action-chat">
    <QuickActions surface="reader" config={config} descriptors={descriptors} display={display} preview={preview} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} onOpenChange={onMenuOpenChange} onActionStart={onActionStart} />
    {snoozePicker}
  </motion.div>;
  return <div className="email-action-bar">
    <QuickActions surface="reader" config={config} descriptors={descriptors} display={display} preview={preview} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} onOpenChange={onMenuOpenChange} onActionStart={onActionStart} />
    {snoozePicker}
  </div>;
});
