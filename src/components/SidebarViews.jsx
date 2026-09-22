import React from 'react';
import { Star, Paperclip, Reply, Bookmark, Inbox, Plus, ChevronRight, ChevronDown } from 'lucide-react';
import { useViewStore, viewLabel } from '../stores/viewStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useT } from '../i18n/index.js';

const ICONS = { star: Star, paperclip: Paperclip, reply: Reply, tag: Bookmark, inbox: Inbox };

/// Saved views, pinned above the accounts: a view carries its account scope as
/// a property, so it belongs to no one account's folder tree.
///
/// Nothing here edits a view, and no row carries a way to: views are edited on
/// the Views page in Settings, where the builder can show what a change would
/// find before it is saved. A row only opens its view.
export function SidebarViews({ collapsed = false, onOpenSettings }) {
  const t = useT();
  const views = useViewStore(state => state.views);
  const counts = useViewStore(state => state.counts);
  const activeViewId = useViewStore(state => state.activeViewId);
  const unavailableReason = useViewStore(state => state.unavailableReason);
  const openView = useViewStore(state => state.openView);
  const closeView = useViewStore(state => state.closeView);
  const folded = useSettingsStore(state => state.viewsSectionCollapsed);
  const toggleFold = useSettingsStore(state => state.toggleViewsSection);

  const openSettingsPage = () => onOpenSettings?.('views');
  /// The + makes a view, the way the accounts + adds an account. Settings is
  /// its own window and cannot be handed a prop from here, so the intent goes
  /// through the store and the Views page picks it up as it opens.
  const newView = () => { useViewStore.setState({ pendingNew: true }); openSettingsPage(); };

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
    if (!views?.length) return null;
    return <div className="sidebar-collapsed-views w-full py-2 border-b border-mail-border flex flex-col items-center gap-1"
      aria-label={t('views.section')}>
      {views.map(row)}
    </div>;
  }

  return <section className="sidebar-views-section" aria-label={t('views.section')}>
    <div className="sidebar-section-heading">
      {/* The heading itself folds the section: a separate chevron beside a
          heading that does nothing is two targets for one act. */}
      <button type="button" className="sidebar-views-fold" data-testid="views-fold"
        aria-expanded={!folded} onClick={toggleFold}>
        {folded ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
        <h2>{t('views.section')}</h2>
      </button>
      <button type="button" className="sidebar-view-new" data-testid="view-new"
        aria-label={t('views.new')} title={t('views.new')} onClick={newView}>
        <Plus size={14} />
      </button>
    </div>
    {!folded && <>
      <div className="sidebar-view-list">
        {views.map(row)}
      </div>
      {activeViewId && unavailableReason && <p className="sidebar-views-unavailable" role="status" data-testid="views-unavailable">
        {t(`views.unavailable.${unavailableReason}`)}
      </p>}
    </>}
  </section>;
}
