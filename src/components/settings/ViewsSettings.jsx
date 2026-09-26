import React, { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useViewStore, viewLabel, viewLimitReached, MAX_FREE_VIEWS } from '../../stores/viewStore';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { useUnsavedStore } from '../../stores/unsavedStore';
import { ViewEditor } from '../ViewEditor';
import { Button } from '../ui/Button';
import { SettingsSection, SettingsPageLayout } from '../ui/SettingsForm';
import { useT } from '../../i18n/index.js';
import { ViewIcon } from '../ViewIcon';
import { AccountReorderList } from './AccountReorderList';

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
  const deleteView = useViewStore(state => state.deleteView);
  const reorderViews = useViewStore(state => state.reorderViews);
  // The sidebar's + cannot reach this page's props, so it leaves its intent in
  // the store and this consumes it once.
  const pendingNew = useViewStore(state => state.pendingNew);
  const premium = useSettingsStore(state => hasPremiumAccess(state.billingProfile));
  const [editingId, setEditingId] = useState(null);
  const [newlyCreatedId, setNewlyCreatedId] = useState(null);
  /// The draft's id, read at the moment of discarding: a switch held by the
  /// unsaved-changes prompt runs later than the render that queued it.
  const draft = useRef(null);
  const setDraft = id => { draft.current = id; setNewlyCreatedId(id); };
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState('');
  const switching = useRef(false);

  // Not awaited, so a daemon that cannot answer keeps the list already shown
  // rather than leaking a rejection.
  useEffect(() => {
    loadViews().catch(error => console.warn('[views] could not load the views:', error?.message || error));
  }, [loadViews]);

  const full = viewLimitReached(views, premium);

  /// A new view never saved goes with its editor. Once only: the prompt's
  /// Discard and the switch it lets through both land here.
  const discardUnsaved = async () => {
    const id = draft.current;
    setDraft(null);
    if (id && useViewStore.getState().views.some(view => view.id === id)) await deleteView(id);
  };

  /// Every switch away from an open editor asks first when it holds edits.
  const leave = action => useUnsavedStore.getState().leave(() => { void action(); });

  const startNew = async () => {
    if (switching.current) return;
    switching.current = true;
    try {
      setError('');
      await discardUnsaved();
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
      setDraft(view.id);
    } catch (cause) {
      setError(cause?.message || String(cause));
    } finally { switching.current = false; }
  };

  const selectView = async id => {
    if (switching.current) return;
    switching.current = true;
    try {
      setError('');
      if (draft.current) await discardUnsaved();
      setEditingId(current => current === id ? null : id);
    } catch (cause) {
      setError(cause?.message || String(cause));
    } finally { switching.current = false; }
  };

  useEffect(() => {
    if (!pendingNew) return;
    useViewStore.setState({ pendingNew: false });
    leave(startNew);
    // The intent is consumed the moment it arrives; re-running on every view
    // list change would make a second view out of one press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNew]);

  const editing = views.find(view => view.id === editingId);

  return <SettingsPageLayout as="section" spaced={false} className="views-settings" aria-label={t('views.section')}>
    <SettingsSection>
      <Button variant="secondary" size="sm" type="button" data-testid="views-new" disabled={full}
        aria-label={t('views.new')} onClick={() => leave(startNew)}><Plus size={14} /> {t('views.new')}</Button>

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

    {error && <p className="text-sm text-mail-danger" role="alert">{error}</p>}

    <div className="views-list" data-testid="views-list">
      <AccountReorderList accounts={views.map(view => ({ ...view, email: viewLabel(view, t) }))}
        selectedAccountId={editingId} onReorder={ids => { void reorderViews(ids).catch(cause => setError(cause?.message || String(cause))); }}
        labels={{ list: t('views.section'), instructions: t('views.reorderInstructions'),
          reorder: name => t('views.reorder', { name }) }}>
      {view => <button type="button" data-testid={`views-row-${view.id}`}
            className={`views-row-button account-settings-account-button${editingId === view.id ? ' is-editing' : ''}`}
            aria-expanded={editingId === view.id}
            onClick={() => leave(() => selectView(view.id))}>
            <ViewIcon icon={view.icon} size={14} />
            <span className="views-row-name">{viewLabel(view, t)}</span>
          </button>}
      </AccountReorderList>
      {views.length === 0 && <p className="views-empty" data-testid="views-empty">{t('views.none')}</p>}
    </div>

    </SettingsSection>

    {editing && <ViewEditor key={editing.id} view={editing} isNew={editing.id === newlyCreatedId}
      onSaved={() => setDraft(null)} onDiscard={discardUnsaved} onClose={async saved => {
      if (switching.current) return;
      switching.current = true;
      try {
        if (!saved) await discardUnsaved();
        else setDraft(null);
        setEditingId(null);
      } catch (cause) {
        setError(cause?.message || String(cause));
      } finally { switching.current = false; }
    }} />}
  </SettingsPageLayout>;
}
