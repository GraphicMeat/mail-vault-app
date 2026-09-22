import React, { useEffect, useState } from 'react';
import { Plus, Bookmark, Star, Paperclip, Reply, Inbox } from 'lucide-react';
import { useViewStore, viewLabel, viewLimitReached, MAX_FREE_VIEWS } from '../../stores/viewStore';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { ViewEditor } from '../ViewEditor';
import { useT } from '../../i18n/index.js';

const ICONS = { star: Star, paperclip: Paperclip, reply: Reply, tag: Bookmark, inbox: Inbox };

/// The views page: one list, one builder, and the builder previews what it
/// would find while it is being typed.
///
/// This is the only place a view's filters can be changed. The sidebar opens
/// views and nothing else — editing a filter from the mail screen meant
/// rewriting the list under the person reading it.
export function ViewsSettings({ onUpgrade }) {
  const t = useT();
  const views = useViewStore(state => state.views);
  const loadViews = useViewStore(state => state.loadViews);
  const createView = useViewStore(state => state.createView);
  // The sidebar's + cannot reach this page's props, so it leaves its intent in
  // the store and this consumes it once.
  const pendingNew = useViewStore(state => state.pendingNew);
  const premium = useSettingsStore(state => hasPremiumAccess(state.billingProfile));
  const [editingId, setEditingId] = useState(null);
  const [refused, setRefused] = useState(false);

  useEffect(() => { void loadViews(); }, [loadViews]);

  const full = viewLimitReached(views, premium);

  const startNew = async () => {
    const view = {
      id: globalThis.crypto?.randomUUID?.() || `view-${Date.now()}`,
      name: t('views.new'),
      icon: 'tag',
      // The daemon puts a new view last on its own; a position sent from here
      // is ignored on an insert, so guessing one would only be a lie on screen.
      position: 0,
      builtin: null,
      def: {},
    };
    // Asked before the builder opens: filling one in only to be refused at
    // Save is the worse order.
    const reply = await createView(view, premium);
    if (!reply.ok) { setRefused(true); return; }
    setRefused(false);
    setEditingId(view.id);
  };

  useEffect(() => {
    if (!pendingNew) return;
    useViewStore.setState({ pendingNew: false });
    void startNew();
    // The intent is consumed the moment it arrives; re-running on every view
    // list change would make a second view out of one press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNew]);

  const editing = views.find(view => view.id === editingId);

  return <section className="views-settings" aria-label={t('views.section')}>
    <div className="sidebar-section-heading">
      <h2>{t('views.section')}</h2>
      <button type="button" data-testid="views-new" className="views-new" disabled={full}
        aria-label={t('views.new')} title={t('views.new')} onClick={startNew}>
        <Plus size={14} />
      </button>
    </div>
    <p className="text-xs text-mail-text-muted">{t('views.explainer')}</p>

    {/* The cap is a fact about the plan, so it is stated before it bites, not
        only when the + refuses. */}
    {!premium && <p className="views-limit text-xs text-mail-text-muted" data-testid="views-limit">
      {t('views.limit', { used: views.length, max: MAX_FREE_VIEWS })}
      {' '}
      <button type="button" className="views-upgrade" data-testid="views-upgrade" onClick={() => onUpgrade?.()}>
        {t('views.upgrade')}
      </button>
    </p>}

    {refused && <p className="views-refused text-xs" role="status" data-testid="views-refused">
      {t('views.limitReached', { max: MAX_FREE_VIEWS })}
    </p>}

    <ul className="views-list" data-testid="views-list">
      {views.map((view) => {
        const Icon = ICONS[view.icon] || Bookmark;
        return <li key={view.id} className="views-row">
          <button type="button" data-testid={`views-row-${view.id}`}
            className={`views-row-button${editingId === view.id ? ' is-editing' : ''}`}
            aria-expanded={editingId === view.id}
            onClick={() => setEditingId(current => (current === view.id ? null : view.id))}>
            <Icon size={14} aria-hidden="true" />
            <span className="views-row-name">{viewLabel(view, t)}</span>
          </button>
        </li>;
      })}
      {views.length === 0 && <li className="views-empty" data-testid="views-empty">{t('views.none')}</li>}
    </ul>

    {editing && <ViewEditor key={editing.id} view={editing} onClose={() => setEditingId(null)} />}
  </section>;
}
