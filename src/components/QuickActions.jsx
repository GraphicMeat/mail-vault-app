import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { MoreHorizontal, ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover } from './ui/Popover';
import { useQuickActionConfiguration } from '../hooks/useQuickActionConfiguration';
import { useT } from '../i18n/index.js';
import '../styles/quick-actions.css';

const DESTRUCTIVE = new Set(['delete', 'deleteServer', 'deleteEverywhere']);
const UNSAFE_FAVORITE = new Set([...DESTRUCTIVE, 'unarchive']);
const PAGE_SIZE = 7;

function QuickActionsConfigured({ surface = 'row', config, descriptors = [], className = '', buttonClassName = '', display = 'icon-label', triggerLabel, renderExtra, identity, onActionStart, onOpenChange }) {
  const t = useT();
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const [anchor, setAnchor] = useState(null);
  const [radialPage, setRadialPage] = useState(0);
  const id = useId();
  const entries = config?.entries || [];
  const available = useMemo(() => new Map(descriptors.map(item => [item.id, item])), [descriptors]);
  const configured = entries.map(entry => ({ entry, descriptor: available.get(entry.id) }))
    .filter(item => item.descriptor && !item.descriptor.hidden);
  const requestedFavorite = configured.find(item => item.entry.id === config.favoriteId);
  const favorite = requestedFavorite || configured.find(item => !UNSAFE_FAVORITE.has(item.entry.action));
  const mode = config?.mode || 'menu';
  const opened = !!anchor;
  const radialFits = typeof window !== 'undefined' && window.innerWidth >= 520 && window.innerHeight >= 480;
  const radial = mode === 'radial' && radialFits;
  const remaining = mode === 'favorite-menu' ? configured.filter(item => item !== favorite) : configured;
  const pageCount = Math.max(1, Math.ceil(remaining.length / PAGE_SIZE));
  const page = Math.min(radialPage, pageCount - 1);
  const visibleRadial = remaining.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const triggerText = triggerLabel || (surface === 'reader' ? t('email.sender.more') : t('quickActions.title'));

  const close = useCallback((restoreFocus = true) => {
    setAnchor(null);
    onOpenChange?.(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, [onOpenChange]);
  useEffect(() => {
    if (!opened) return;
    const first = panelRef.current?.querySelector('button:not(:disabled)');
    first?.focus();
  }, [opened, page]);
  useEffect(() => { setAnchor(null); setRadialPage(0); onOpenChange?.(false); }, [identity, onOpenChange]);

  const open = event => {
    event.stopPropagation();
    onOpenChange?.(true);
    const rect = event.currentTarget.getBoundingClientRect();
    const radialSize = radial ? 288 : 0;
    setRadialPage(0);
    setAnchor({
      top: radial ? Math.max(8, Math.min(window.innerHeight - radialSize - 8, rect.top + rect.height / 2 - radialSize / 2)) : rect.bottom + 6,
      left: radial ? Math.max(8, Math.min(window.innerWidth - radialSize - 8, rect.left + rect.width / 2 - radialSize / 2)) : Math.max(8, Math.min(window.innerWidth - 232, rect.right - 232)),
    });
  };

  const activate = (item, event) => {
    event.stopPropagation();
    if (item.descriptor.disabled) return;
    const confirmationTrigger = panelRef.current?.contains(event.currentTarget)
      ? triggerRef.current || event.currentTarget.closest('.quick-actions')?.querySelector('button')
      : event.currentTarget;
    onActionStart?.(event, confirmationTrigger, item.entry);
    close(item.descriptor.restoreFocus !== false);
    try {
      Promise.resolve(item.descriptor.onActivate?.(event, item.entry))
        .catch(error => console.error(`[QuickActions] ${item.entry.action} failed:`, error));
    } catch (error) { console.error(`[QuickActions] ${item.entry.action} failed:`, error); }
  };
  const onMenuKeyDown = event => {
    if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? (index + 1 + buttons.length) % buttons.length
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? (index - 1 + buttons.length) % buttons.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
    if (next !== null && buttons[next]) { event.preventDefault(); event.stopPropagation(); buttons[next].focus(); }
  };

  const button = (item, radialItem = false, menuEntry = false) => {
    const { descriptor, entry: saved } = item;
    const Icon = descriptor.Icon;
    const color = config.palette === 'custom' ? saved.color
      : config.palette === 'semantic' ? (descriptor.tone === 'danger' ? 'var(--mail-danger)' : descriptor.tone === 'positive' ? 'var(--mail-local)' : descriptor.tone === 'warning' ? 'var(--mail-warning)' : undefined)
        : undefined;
    const semantic = config.palette === 'semantic' && descriptor.tone === 'danger' ? 'quick-action-danger'
      : config.palette === 'semantic' && descriptor.tone === 'positive' ? 'quick-action-positive' : '';
    const classes = [
      radialItem ? 'quick-action-radial-item' : 'quick-action-button',
      buttonClassName,
      config.palette === 'neutral' && (descriptor.isDestructive || DESTRUCTIVE.has(saved.action)) ? 'quick-action-destructive' : '',
      semantic,
    ].filter(Boolean).join(' ');
    return <button key={saved.id} ref={descriptor.buttonRef} type="button" role={menuEntry ? 'menuitem' : undefined}
      className={classes} title={descriptor.label} aria-label={descriptor.label}
      aria-expanded={descriptor.expanded} disabled={!!descriptor.disabled} style={color ? { '--quick-action-color': color } : undefined}
      onClick={event => activate(item, event)}>
      {Icon && display !== 'text-only' && <Icon size={radialItem ? 18 : 15} aria-hidden="true" />}
      {(display !== 'icon-only' || radialItem || menuEntry) && <span>{descriptor.label}</span>}
    </button>;
  };

  if (!configured.length && !renderExtra) return null;
  const shouldShowMenu = mode === 'menu' || mode === 'radial' || mode === 'favorite-menu';
  const point = item => {
    const angle = (2 * Math.PI * item.index) / Math.max(item.count, 1) - Math.PI / 2;
    const radius = 100;
    return { left: `${144 + Math.cos(angle) * radius - 36}px`, top: `${144 + Math.sin(angle) * radius - 36}px` };
  };
  const menuEntries = radial ? visibleRadial : remaining;
  const panelStyle = radial
    ? { top: anchor?.top || 0, left: anchor?.left || 0, width: 288, height: 288 }
    : { top: anchor?.top || 0, left: anchor?.left || 0, width: 224, maxHeight: 'min(70vh, 520px)', overflowY: 'auto' };

  return <>
    <div className={`quick-actions ${className}`} data-layout={mode} data-surface={surface}>
      {mode === 'inline' && configured.map(item => button(item))}
      {mode === 'favorite-menu' && favorite && button(favorite)}
      {shouldShowMenu && <button ref={triggerRef} type="button" className="quick-actions-trigger"
        aria-label={triggerText} title={triggerText} aria-haspopup="menu" aria-expanded={opened}
        aria-controls={opened ? id : undefined} onClick={open}>
        <MoreHorizontal size={16} aria-hidden="true" />
        {mode === 'menu' && <span>{triggerText}</span>}
      </button>}
      {renderExtra}
    </div>
    <Popover ref={panelRef} id={id} open={opened} onClose={close} handlesTab role="menu" aria-label={triggerText}
      onKeyDown={onMenuKeyDown} className={radial ? 'quick-actions-radial' : 'quick-actions-menu'} style={panelStyle}>
      {radial ? <>
        {menuEntries.map((item, index) => <div key={item.entry.id} className="quick-action-radial-position" style={point({ index, count: menuEntries.length })}>
          {button(item, true, true)}
        </div>)}
        {pageCount > 1 && <div className="quick-action-radial-pages">
          <button type="button" role="menuitem" aria-label={t('quickActions.previousPage')} disabled={page === 0} onClick={() => setRadialPage(page - 1)}><ChevronLeft size={16} /></button>
          <span aria-live="polite">{page + 1}/{pageCount}</span>
          <button type="button" role="menuitem" aria-label={t('quickActions.nextPage')} disabled={page >= pageCount - 1} onClick={() => setRadialPage(page + 1)}><ChevronRight size={16} /></button>
        </div>}
      </> : menuEntries.map(item => button(item, false, true))}
      {radial && !radialFits && <span className="sr-only">{t('quickActions.layout.menu')}</span>}
    </Popover>
  </>;
}

export function QuickActions({ surface = 'row', config, scope, descriptors = [], ...rest }) {
  if (config) return <QuickActionsConfigured surface={surface} config={config} descriptors={descriptors} {...rest} />;
  return <StoredQuickActions surface={surface} scope={scope} descriptors={descriptors} {...rest} />;
}

function StoredQuickActions({ surface, scope, descriptors, ...rest }) {
  const resolved = useQuickActionConfiguration(surface, scope);
  return <QuickActionsConfigured surface={surface} config={resolved.config} descriptors={descriptors} {...rest} />;
}
