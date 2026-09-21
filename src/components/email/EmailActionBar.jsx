import React, { memo } from 'react';
import { motion } from 'framer-motion';
import {
  Reply, ReplyAll, Forward, Archive, Trash2, FolderInput, MailOpen, Mail, ExternalLink,
  Code, Sun, Moon, ImageDown, Star, ShieldAlert, ShieldX, Tag, MailPlus,
} from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTagStore } from '../../stores/tagStore';
import { useMailStore } from '../../stores/mailStore';
import { selectionKey, resolveEmailLocation } from '../../stores/slices/unifiedHelpers';
import { getAccountCacheMailboxes } from '../../services/cacheManager';
import { openCompose } from '../../utils/composeOpener';
import { replyTarget } from '../../utils/replyTarget';
import { QuickActions } from '../QuickActions';
import { useQuickActionConfiguration } from '../../hooks/useQuickActionConfiguration';
import { useT } from '../../i18n/index.js';
import { DEFAULT_QUICK_ACTIONS } from '../../utils/quickActions';

const ICONS = {
  reply: Reply, replyAll: ReplyAll, forward: Forward, replyTemplate: Reply,
  archive: Archive, unarchive: Archive, delete: Trash2, deleteServer: Trash2,
  deleteEverywhere: ShieldX, move: FolderInput, toggleRead: MailOpen, markRead: MailOpen,
  markUnread: Mail, star: Star, unstar: Star, spam: ShieldAlert, tag: Tag,
  export: ImageDown, open: ExternalLink, source: Code, theme: Sun, newMessage: MailPlus,
};
const EMPTY_ARRAY = Object.freeze([]);

function foldersFor(accountId, state) {
  return accountId === state.activeAccountId ? state.mailboxes || [] : getAccountCacheMailboxes(accountId) || [];
}

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
  const config = configOverride || storedConfig;
  const state = useMailStore.getState();
  const location = resolveEmailLocation(email, state);
  const read = isRead ?? !!email?.flags?.includes('\\Seen');
  const flagged = !!email?.flags?.includes('\\Flagged');
  const readOnly = !!email?._insightsReadOnly || !!email?._insightsNoServerActions;
  const accountId = location?.accountId;
  const junk = accountId && foldersFor(accountId, state).find(folder => String(folder.specialUse || '').toLowerCase() === '\\junk');
  const sender = email?.from?.address;

  const labelFor = entry => {
    if (entry.action === 'tag') return localLabels.find(label => label.id === entry.params?.tagId)?.name || t('quickActions.action.tag');
    if (entry.action === 'replyTemplate') return templates.find(template => template.id === entry.params?.templateId)?.name || t('quickActions.action.replyTemplate');
    if (entry.action === 'archive') return isArchived ? t('rowMenu.unarchive') : t('common.archive');
    if (entry.action === 'unarchive') return t('rowMenu.unarchive');
    if (entry.action === 'delete' || entry.action === 'deleteServer') return isLocalOnly ? t('rowMenu.unarchive') : t('common.delete');
    if (entry.action === 'deleteEverywhere') return t('rowMenu.deleteEverywhere');
    if (entry.action === 'toggleRead') return read ? t('emailActionBar.markUnread') : t('emailActionBar.markRead');
    if (entry.action === 'markRead') return t('emailActionBar.markRead');
    if (entry.action === 'markUnread') return t('emailActionBar.markUnread');
    if (entry.action === 'star') return !hasExplicitStarModes && flagged ? t('emailActionBar.unstar') : t('emailActionBar.star');
    if (entry.action === 'unstar') return t('emailActionBar.unstar');
    if (entry.action === 'move') return entry.params?.mailbox ? `${t('emailActionBar.move')}: ${entry.params.mailbox}` : t('emailActionBar.move');
    if (entry.action === 'spam') return t('quickActions.action.spam');
    if (entry.action === 'theme') return emailThemeDark ? t('emailActionBar.light') : t('emailActionBar.dark');
    if (entry.action === 'open') return t('common.open');
    if (entry.action === 'source') return t('emailActionBar.source');
    if (entry.action === 'export') return t('common.export');
    if (entry.action === 'reply') return t('emailActionBar.reply');
    if (entry.action === 'replyAll') return t('emailActionBar.replyAll');
    if (entry.action === 'forward') return t('emailActionBar.forward');
    if (entry.action === 'newMessage') return t('quickActions.action.newMessage');
    return t('quickActions.title');
  };

  const callbacks = {
    reply: onReply, replyAll: onReplyAll, forward: onForward,
    archive: onArchive, unarchive: onArchive,
    delete: onDelete, deleteServer: onDelete, deleteEverywhere: onDeleteEverywhere,
    move: onMove, toggleRead: onToggleRead, markRead: onToggleRead, markUnread: onToggleRead,
    star: onToggleFlag, unstar: onToggleFlag, spam: onSpam,
    export: onExport, open: onOpenInWindow, source: onViewSource, theme: onToggleEmailTheme,
  };

  const hasExplicitStarModes = config.entries.some(item => item.action === 'star') && config.entries.some(item => item.action === 'unstar');
  const hasExplicitArchiveModes = config.entries.some(item => item.action === 'archive') && config.entries.some(item => item.action === 'unarchive');
  const descriptors = config.entries.map(entry => {
    const callback = callbacks[entry.action];
    const template = templates.find(item => item.id === entry.params?.templateId);
    const label = localLabels.find(item => item.id === entry.params?.tagId);
    const folder = entry.params?.mailbox && accountId && foldersFor(entry.params.accountId || accountId, state)
      .some(item => (item.path || item.name) === entry.params.mailbox);
    const hidden = !email || readOnly && ['archive', 'unarchive', 'delete', 'deleteServer', 'deleteEverywhere', 'move', 'toggleRead', 'markRead', 'markUnread', 'star', 'unstar', 'spam'].includes(entry.action)
      || ['reply', 'replyAll'].includes(entry.action) && (isSentEmail || !callbacks[entry.action])
      || entry.action === 'forward' && !onForward
      || entry.action === 'replyAll' && singleRecipient
      || ['archive', 'unarchive'].includes(entry.action) && (!onArchive || !location || (hasExplicitArchiveModes && ((entry.action === 'archive' && isArchived) || (entry.action === 'unarchive' && !isArchived))) || (isLocalOnly && !isArchived))
      || entry.action === 'deleteServer' && isLocalOnly
      || ['delete', 'deleteServer'].includes(entry.action) && (!onDelete || !location)
      || entry.action === 'deleteEverywhere' && (!onDeleteEverywhere || !location)
      || entry.action === 'move' && (!onMove || isLocalOnly || !location)
      || entry.action === 'spam' && (!onSpam && (!junk || !location) || isLocalOnly)
      || ['toggleRead', 'markRead', 'markUnread'].includes(entry.action) && (!onToggleRead || isLocalOnly || (entry.action === 'markRead' && read) || (entry.action === 'markUnread' && !read))
      || ['star', 'unstar'].includes(entry.action) && (!onToggleFlag || isLocalOnly || (hasExplicitStarModes && ((entry.action === 'star' && flagged) || (entry.action === 'unstar' && !flagged))))
      || entry.action === 'tag' && (!onApplyLocalLabel && !applyTag || !location)
      || entry.action === 'export' && !onExport
      || entry.action === 'open' && !onOpenInWindow
      || entry.action === 'source' && !onViewSource
      || entry.action === 'theme' && !onToggleEmailTheme
      || entry.action === 'newMessage';
    const actionDisabled = !hidden && (
      ['archive', 'unarchive'].includes(entry.action) && !!disabled.archive
      || ['delete', 'deleteServer', 'deleteEverywhere'].includes(entry.action) && !!disabled.delete
      || entry.action === 'move' && (!!disabled.move || entry.params?.mailbox && (!folder || (entry.params.accountId && entry.params.accountId !== accountId)))
      || ['toggleRead', 'markRead', 'markUnread'].includes(entry.action) && !!disabled.toggleRead
      || ['star', 'unstar'].includes(entry.action) && !!disabled.toggleFlag
      || entry.action === 'tag' && !label
      || entry.action === 'replyTemplate' && (!template || isSentEmail)
    );
    const special = ['move', 'delete', 'deleteServer', 'deleteEverywhere', 'unarchive', 'reply', 'replyAll', 'forward', 'replyTemplate', 'open', 'source'].includes(entry.action)
      || entry.action === 'archive' && isArchived;
    return {
      id: entry.id, action: entry.action, label: labelFor(entry), Icon: ICONS[entry.action],
      hidden,
      disabled: actionDisabled,
      tone: ['delete', 'deleteServer', 'deleteEverywhere'].includes(entry.action) ? 'danger' : ['archive', 'unarchive'].includes(entry.action) ? 'positive' : undefined,
      isDestructive: ['delete', 'deleteServer', 'deleteEverywhere'].includes(entry.action),
      buttonRef: entry.action === 'move' ? moveButtonRef : undefined,
      expanded: entry.action === 'move' ? moveDropdownOpen : undefined,
      restoreFocus: !special,
      onActivate: async () => {
        if (onActionPreview) return onActionPreview(entry, email);
        if (entry.action === 'tag') {
          if (onApplyLocalLabel) onApplyLocalLabel(email, entry.params.tagId);
          else applyTag(email, location, entry.params.tagId);
        } else if (entry.action === 'replyTemplate') {
          if (onReplyTemplate) onReplyTemplate(email, template);
          else openCompose({ mode: 'reply', replyTo: await replyTarget(email, null, useMailStore.getState()), templateBody: template.body });
        } else if (entry.action === 'move' && entry.params?.mailbox) {
          await useMailStore.getState().moveEmails([selectionKey(email, useMailStore.getState())], entry.params.mailbox);
        } else if (entry.action === 'spam' && onSpam) onSpam(email);
        else if (['markRead', 'markUnread'].includes(entry.action)) onToggleRead?.(email, entry.action === 'markRead');
        else if (['star', 'unstar'].includes(entry.action)) {
          const nextFlagged = hasExplicitStarModes ? entry.action === 'star' : entry.action === 'star' ? !flagged : false;
          onToggleFlag?.(email, nextFlagged);
        }
        else if (callback) callback(email);
        else if (entry.action === 'spam' && junk) {
          const key = selectionKey(email, state);
          await useMailStore.getState().moveEmails([key], junk.path || junk.name);
        }
      },
    };
  }).filter(descriptor => !descriptor.hidden);

  const defaultReaderIds = DEFAULT_QUICK_ACTIONS.defaults.reader.entries.map(item => item.id).join('|');
  const useReaderDefaultGroups = config.mode === 'inline' && config.entries.map(item => item.id).join('|') === defaultReaderIds;
  const mainEntries = config.entries.filter(item => !['open', 'source', 'theme'].includes(item.action));
  const toolEntries = config.entries.filter(item => item.action === 'theme');
  const moreEntries = config.entries.filter(item => ['open', 'source'].includes(item.action));
  const groupedConfig = entries => ({ ...config, entries, favoriteId: null });
  if (variant === 'chat' && useReaderDefaultGroups) return <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: .15 }} className="email-action-bar email-action-chat">
    <div className="email-action-group email-action-main"><QuickActions surface="reader" config={groupedConfig(mainEntries)} descriptors={descriptors} display={display} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} onActionStart={onActionStart} /></div>
    <div className="email-action-group email-action-tools">
      <QuickActions surface="reader" config={groupedConfig(toolEntries)} descriptors={descriptors} display={display} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} />
      <QuickActions surface="reader" config={{ ...groupedConfig(moreEntries), mode: 'menu' }} descriptors={descriptors} display={display} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} onOpenChange={onMenuOpenChange} />
    </div>
  </motion.div>;
  if (variant !== 'chat' && useReaderDefaultGroups) return <div className="email-action-bar">
    <div className="email-action-group email-action-main"><QuickActions surface="reader" config={groupedConfig(mainEntries)} descriptors={descriptors} display={display} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} onActionStart={onActionStart} /></div>
    <div className="email-action-group email-action-tools">
      <QuickActions surface="reader" config={groupedConfig(toolEntries)} descriptors={descriptors} display={display} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} />
      <QuickActions surface="reader" config={{ ...groupedConfig(moreEntries), mode: 'menu' }} descriptors={descriptors} display={display} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} />
    </div>
  </div>;
  if (variant === 'chat') return <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: .15 }} className="email-action-bar email-action-chat">
    <QuickActions surface="reader" config={config} descriptors={descriptors} display={display} preview={preview} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} onOpenChange={onMenuOpenChange} onActionStart={onActionStart} />
  </motion.div>;
  return <div className="email-action-bar">
    <QuickActions surface="reader" config={config} descriptors={descriptors} display={display} preview={preview} buttonClassName="email-action-button" identity={`${email?._accountId}:${email?._mailbox}:${email?.uid}`} onOpenChange={onMenuOpenChange} onActionStart={onActionStart} />
  </div>;
});
