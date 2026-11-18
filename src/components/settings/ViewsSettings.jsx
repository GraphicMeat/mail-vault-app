import React, { useEffect, useRef, useState } from 'react';
import { useViewStore, viewLimitReached, MAX_FREE_VIEWS } from '../../stores/viewStore';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { useUnsavedStore } from '../../stores/unsavedStore';
import { ViewEditor } from '../ViewEditor';
import { useT } from '../../i18n/index.js';
import { PremiumFeaturesLink } from '../PremiumFeaturesLink';
import { DesktopViewEnv } from './DesktopViewEnv';
import { ViewsSettingsView } from './views/ViewsSettingsView';

/// The views page (views/ViewsSettingsView.jsx) over the view and settings
/// stores: one list, one builder, and the builder previews what it would find
/// while it is being typed.
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

  return <DesktopViewEnv>
    <ViewsSettingsView views={views} editingId={editingId} premium={premium} full={full} max={MAX_FREE_VIEWS}
      refused={refused} error={error} upgradeLink={<PremiumFeaturesLink />} onUpgrade={onUpgrade}
      onNew={() => leave(startNew)} onSelect={id => leave(() => selectView(id))}
      onReorder={ids => { void reorderViews(ids).catch(cause => setError(cause?.message || String(cause))); }}>
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
    </ViewsSettingsView>
  </DesktopViewEnv>;
}
