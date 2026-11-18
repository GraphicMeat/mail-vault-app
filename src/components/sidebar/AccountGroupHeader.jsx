import React from 'react';
import { ChevronDown, Inbox } from 'lucide-react';
import { Private } from '../privacy/Private';
import { usePrivateAttr } from '../../hooks/usePrivacy';
import { useT } from '../../i18n/index.js';

export function AccountGroupHeader({ name, collapsed, selected, unread, onOpen, onToggle }) {
  const t = useT();
  const pa = usePrivateAttr();
  return <div className="sidebar-group-header">
    <button type="button" className="sidebar-group-toggle" aria-expanded={!collapsed}
      aria-label={pa(t(collapsed ? 'sidebar.groupExpand' : 'sidebar.groupCollapse', { name }), 'name')}
      onClick={() => onToggle(name)}><ChevronDown size={14} aria-hidden="true" /></button>
    <button type="button" data-account-choice className="sidebar-group-open" aria-current={selected ? 'true' : undefined}
      aria-label={pa(t('sidebar.groupInbox', { name }), 'name')} onClick={() => onOpen(name)}>
      <Inbox size={14} aria-hidden="true" />
      <span className="sidebar-group-label"><Private kind="name">{name}</Private></span>
      {unread > 0 && <span className="sidebar-unread-count">{unread > 99 ? '99+' : unread}</span>}
    </button>
  </div>;
}

export function CollapsedGroupChip({ name, selected, unread, onOpen }) {
  const t = useT();
  const pa = usePrivateAttr();
  const label = pa(t('sidebar.groupInbox', { name }), 'name');
  return <button type="button" className="sidebar-collapsed-group" aria-current={selected ? 'true' : undefined}
    title={label} aria-label={label} onClick={() => onOpen(name)}>
    <Private kind="name">{name.slice(0, 1)}</Private>
    {unread > 0 && <span className="sidebar-collapsed-group-count">{unread > 99 ? '99+' : unread}</span>}
  </button>;
}
