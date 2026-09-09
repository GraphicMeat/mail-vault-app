import React, { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Reply, ReplyAll, Forward, Archive, Trash2, FolderInput, MailOpen, Mail, ExternalLink, Code, Sun, Moon, ImageDown, Star, MoreHorizontal } from 'lucide-react';
import { motion } from 'framer-motion';
import { useSettingsStore } from '../../stores/settingsStore';
import { Popover, MenuItem } from '../ui/Popover';
import { useT } from '../../i18n/index.js';

function ActionButton({ icon: Icon, label, onClick, disabled, isDestructive, primary, buttonRef, expanded }) {
  const display = useSettingsStore(s => s.actionButtonDisplay);
  return (
    <button ref={buttonRef} type="button" onClick={event => { event.stopPropagation(); onClick?.(); }} disabled={disabled}
      title={label} aria-label={label} aria-expanded={expanded}
      className={`email-action-button ${primary ? 'email-action-primary' : ''} ${isDestructive ? 'email-action-danger' : ''}`}>
      {display !== 'text-only' && <Icon size={15} aria-hidden="true" />}
      {display !== 'icon-only' && <span>{label}</span>}
    </button>
  );
}

export const EmailActionBar = memo(function EmailActionBar({
  email, variant = 'single', onReply, onReplyAll, onForward, onArchive, onDelete,
  onMove, onToggleRead, onToggleFlag, onOpenInWindow, onViewSource, onExport,
  onToggleEmailTheme, emailThemeDark, isArchived, isRead, isLocalOnly, isSentEmail,
  singleRecipient, disabled = {}, moveButtonRef, moveDropdownOpen = false,
}) {
  const t = useT();
  const display = useSettingsStore(s => s.actionButtonDisplay);
  const [anchor, setAnchor] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();
  const isFlagged = email?.flags?.includes('\\Flagged');
  const closeMenu = useCallback(() => {
    setAnchor(null);
    triggerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (anchor) menuRef.current?.querySelector('button:not(:disabled)')?.focus();
  }, [anchor]);
  // A newly selected message never inherits an open menu from the previous one.
  useEffect(() => setAnchor(null), [email?.uid, email?._accountId, email?._mailbox]);

  const readOnly = !!email?._insightsReadOnly || !!email?._insightsNoServerActions;
  const primary = [
    !isSentEmail && onReply && { icon: Reply, label: t('emailActionBar.reply'), action: onReply, primary: true },
    !isSentEmail && !singleRecipient && onReplyAll && { icon: ReplyAll, label: t('emailActionBar.replyAll'), action: onReplyAll },
    onForward && { icon: Forward, label: t('emailActionBar.forward'), action: onForward },
    !readOnly && (!isLocalOnly || isArchived) && onArchive && { icon: Archive, label: isArchived ? t('rowMenu.unarchive') : t('common.archive'), action: onArchive, disabled: disabled.archive },
    !readOnly && onDelete && { icon: Trash2, label: t('common.delete'), action: onDelete, disabled: disabled.delete, isDestructive: true },
    !readOnly && !isLocalOnly && onMove && { icon: FolderInput, label: t('emailActionBar.move'), action: onMove, disabled: disabled.move, buttonRef: moveButtonRef, expanded: moveDropdownOpen },
    !readOnly && !isLocalOnly && onToggleRead && { icon: isRead ? Mail : MailOpen, label: isRead ? t('emailActionBar.markUnread') : t('emailActionBar.markRead'), action: onToggleRead, disabled: disabled.toggleRead },
    !readOnly && !isLocalOnly && onToggleFlag && { icon: Star, label: isFlagged ? t('emailActionBar.unstar') : t('emailActionBar.star'), action: onToggleFlag, disabled: disabled.toggleFlag },
    onExport && { icon: ImageDown, label: t('common.export'), action: onExport },
  ].filter(Boolean);
  const secondary = [
    onOpenInWindow && { Icon: ExternalLink, label: t('common.open'), action: onOpenInWindow },
    onViewSource && { Icon: Code, label: t('emailActionBar.source'), action: onViewSource },
  ].filter(Boolean);
  const onMenuKey = event => {
    const items = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length
      : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
    if (next !== null && items[next]) { event.preventDefault(); event.stopPropagation(); items[next].focus(); }
    if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); closeMenu(); }
  };
  if (!primary.length && !secondary.length && !onToggleEmailTheme) return null;
  const contents = <>
    <div className="email-action-group email-action-main">
      {primary.map(({ action, ...props }) => <ActionButton key={props.label} {...props} onClick={() => action(email)} />)}
    </div>
    <div className="email-action-group email-action-tools">
      {onToggleEmailTheme && <ActionButton icon={emailThemeDark ? Sun : Moon}
        label={emailThemeDark ? t('emailActionBar.light') : t('emailActionBar.dark')} onClick={onToggleEmailTheme} />}
      {secondary.length > 0 && <button type="button" ref={triggerRef}
        className="email-action-button" aria-label={t('email.sender.more')} aria-haspopup="menu"
        aria-expanded={!!anchor} aria-controls={anchor ? menuId : undefined}
        onClick={event => { event.stopPropagation(); setAnchor(anchor ? null : event.currentTarget.getBoundingClientRect()); }}>
        {display !== 'text-only' && <MoreHorizontal size={16} aria-hidden="true" />}{display !== 'icon-only' && <span>{t('email.sender.more')}</span>}
      </button>}
    </div>
    <Popover ref={menuRef} id={menuId} open={!!anchor} onClose={closeMenu} role="menu"
      aria-label={t('email.sender.more')} onKeyDown={onMenuKey}
      style={{ top: (anchor?.bottom || 0) + 6, left: Math.max(8, (anchor?.right || 0) - 196), width: 196 }}>
      {secondary.map(({ Icon, label, action, disabled: inactive }) => (
        <MenuItem key={label} disabled={inactive} onClick={() => { closeMenu(); action(email); }}>
          <Icon size={16} aria-hidden="true" />{label}
        </MenuItem>
      ))}
    </Popover>
  </>;
  return variant === 'chat'
    ? <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: .15 }} className="email-action-bar email-action-chat">{contents}</motion.div>
    : <div className="email-action-bar">{contents}</div>;
});
