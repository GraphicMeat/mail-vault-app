import React, { useState } from 'react';
import { Bookmark } from 'lucide-react';
import { useViewStore } from '../stores/viewStore';
import { useTagStore } from '../stores/tagStore';
import { useT } from '../i18n/index.js';

/// Turn the search on screen into a saved view. The definition comes from the
/// search itself, so what you get back is what you were looking at.
export function SaveSearchAsView() {
  const t = useT();
  const tags = useTagStore(state => state.tags);
  const saveView = useViewStore(state => state.saveView);
  const openView = useViewStore(state => state.openView);
  const defFromSearch = useViewStore(state => state.defFromSearch);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const view = {
      id: globalThis.crypto?.randomUUID?.() || `view-${Date.now()}`,
      name: trimmed,
      icon: 'tag',
      position: 0,
      builtin: null,
      def: defFromSearch(tags),
    };
    setOpen(false);
    setName('');
    await saveView(view);
    await openView(view);
  };

  if (!open) {
    return <button type="button" className="sidebar-view-save" data-testid="save-search-as-view"
      onClick={() => setOpen(true)} title={t('views.saveSearch')}>
      <Bookmark size={12} aria-hidden="true" />
      {t('views.saveSearch')}
    </button>;
  }

  return <form className="sidebar-view-save-form" data-testid="save-view-form" onSubmit={submit}>
    <input data-testid="save-view-name" value={name} autoFocus maxLength={80}
      aria-label={t('views.saveSearch')} placeholder={t('views.saveSearch')}
      onChange={event => setName(event.target.value)} />
    <button type="submit">{t('common.save')}</button>
  </form>;
}
