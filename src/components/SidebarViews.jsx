import React from 'react';
import { Star, Paperclip, Reply, Bookmark, Inbox } from 'lucide-react';
import { useViewStore, viewLabel } from '../stores/viewStore';
import { useT } from '../i18n/index.js';

const ICONS = { star: Star, paperclip: Paperclip, reply: Reply, tag: Bookmark, inbox: Inbox };

/// Saved views, pinned above the accounts: a view carries its account scope as
/// a property, so it belongs to no one account's folder tree.
export function SidebarViews({ collapsed = false }) {
  const t = useT();
  const views = useViewStore(state => state.views);
  const counts = useViewStore(state => state.counts);
  const activeViewId = useViewStore(state => state.activeViewId);
  const unavailableReason = useViewStore(state => state.unavailableReason);
  const openView = useViewStore(state => state.openView);
  const closeView = useViewStore(state => state.closeView);
  if (!views?.length) return null;

  const row = (view) => {
    const Icon = ICONS[view.icon] || Bookmark;
    const label = viewLabel(view, t);
    const count = counts?.[view.id];
    const active = activeViewId === view.id;
    return <button key={view.id} type="button" data-testid={`view-row-${view.id}`}
      className={`sidebar-view-row${active ? ' is-active' : ''}`}
      aria-current={active ? 'true' : undefined}
      title={label}
      onClick={() => (active ? closeView() : openView(view))}>
      <Icon size={collapsed ? 18 : 14} aria-hidden="true" />
      {!collapsed && <>
        <span className="sidebar-view-name">{label}</span>
        {count ? <span className="sidebar-view-count" data-testid={`view-count-${view.id}`}>{count}</span> : null}
      </>}
    </button>;
  };

  if (collapsed) {
    return <div className="sidebar-collapsed-views w-full py-2 border-b border-mail-border flex flex-col items-center gap-1"
      aria-label={t('views.section')}>
      {views.map(row)}
    </div>;
  }

  return <section className="sidebar-views-section" aria-label={t('views.section')}>
    <div className="sidebar-section-heading"><h2>{t('views.section')}</h2></div>
    <div className="sidebar-view-list">{views.map(row)}</div>
    {activeViewId && unavailableReason && <p className="sidebar-views-unavailable" role="status" data-testid="views-unavailable">
      {t(`views.unavailable.${unavailableReason}`)}
    </p>}
  </section>;
}
