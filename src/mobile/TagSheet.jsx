// The viewer's local labels (desktop's tags): More > Apply local label opens this sheet over the
// message. The labels it carries are desktop's chips, each removable; every other label is a tap
// to apply; a name typed below makes a label (or finds the one of that name) and applies it. All
// through the phone's tag cache (tags.js), so the list row and the chips follow at once.
import React, { useEffect, useState } from 'react';
import Sheet from './Sheet.jsx';
import TagChips from './TagChips.jsx';
import { useT } from './i18n.js';
import { ensureTags, useRowTags, useTagStore } from './tags.js';
import { Button } from '../components/ui/Button.jsx';

/** `accountId`, `folder`, `uid`: the open message. */
export default function TagSheet({ accountId, folder, uid, onClose }) {
  const t = useT();
  const tags = useTagStore((s) => s.tags);
  const carried = useRowTags(accountId, folder, uid);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { ensureTags(); }, []);
  const row = { accountId, folder, uid };
  const others = tags.filter((tag) => !carried.some((c) => c.id === tag.id));
  const apply = (tagId) => useTagStore.getState().setOnRows([row], tagId, true);
  const create = async (e) => {
    e.preventDefault();
    const typed = name.trim();
    if (!typed || busy) return;
    setBusy(true);
    const id = await useTagStore.getState().createTag(typed);
    if (id) {
      await apply(id);
      setName('');
    }
    setBusy(false);
  };
  return (
    <Sheet kind="sheet" label={t('quickActions.localLabels')} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title">{t('quickActions.localLabels')}</h2>
      <TagChips accountId={accountId} folder={folder} uid={uid} removable className="mv-viewer__tags" />
      {others.length > 0 && (
        <div className="mv-sheet__actions">
          {others.map((tag) => (
            <button key={tag.id} type="button" className="mv-sheet__action" data-mv-tag-apply={tag.id} onClick={() => apply(tag.id)}>
              <span className="local-mail-label" style={tag.color ? { '--tag-color': tag.color } : undefined}><span>{tag.name}</span></span>
            </button>
          ))}
        </div>
      )}
      <form className="mv-tags__new" onSubmit={create}>
        <input className="mv-input" value={name} maxLength={80} aria-label={t('quickActions.param.labelName')}
          placeholder={t('quickActions.param.labelName')} onChange={(e) => setName(e.target.value)} />
        <Button variant="secondary" size="touch" type="submit" disabled={!name.trim() || busy}>{t('common.create')}</Button>
      </form>
      <div className="mv-sheet__actions">
        <button type="button" className="mv-sheet__action" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Sheet>
  );
}
