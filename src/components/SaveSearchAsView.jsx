import React, { useState } from 'react';
import { Bookmark } from 'lucide-react';
import { useViewStore, MAX_FREE_VIEWS } from '../stores/viewStore';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { useTagStore } from '../stores/tagStore';
import { useT } from '../i18n/index.js';

/// Turn the search on screen into a saved view. The definition comes from the
/// search itself, so what you get back is what you were looking at.
export function SaveSearchAsView() {
  const t = useT();
  const tags = useTagStore(state => state.tags);
  // The same door the + on the Views page goes through: the cap is decided in
  // one place, or saving a search would quietly be the way around it.
  const createView = useViewStore(state => state.createView);
  const openView = useViewStore(state => state.openView);
  const defFromSearch = useViewStore(state => state.defFromSearch);
  const premium = useSettingsStore(state => hasPremiumAccess(state.billingProfile));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [refused, setRefused] = useState(false);

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
    const reply = await createView(view, premium);
    if (!reply.ok) { setRefused(true); return; }
    setOpen(false);
    setName('');
    setRefused(false);
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
    {refused && <p role="status" data-testid="save-view-refused">{t('views.limitReached', { max: MAX_FREE_VIEWS })}</p>}
  </form>;
}
