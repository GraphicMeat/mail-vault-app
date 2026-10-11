import React, { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { usePeopleStore } from '../../stores/peopleStore';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

const nameOf = (card, id) => card?.displayName || card?.emails?.[0]?.address || id;

// ids[0] is the contact the dialog was opened from. A second id means the pair
// is known (a duplicate proposal); without one the user picks it from a search.
export function MergeDialog({ ids, onClose }) {
  const t = useT();
  const previewMerge = usePeopleStore((s) => s.previewMerge);
  const merge = usePeopleStore((s) => s.merge);
  const searchPeople = usePeopleStore((s) => s.searchPeople);
  const fetchCard = usePeopleStore((s) => s.fetchCard);
  const first = ids[0];
  const picking = ids.length < 2;
  const [other, setOther] = useState(ids[1] || '');
  const [keepId, setKeepId] = useState(first);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [names, setNames] = useState({});
  const [preview, setPreview] = useState(null);
  const pair = other ? [first, other] : [];
  const pairKey = pair.join(',');

  useEffect(() => {
    if (!picking) return undefined;
    let live = true;
    searchPeople(query).then((list) => { if (live) setResults(list.filter((p) => p.id !== first)); });
    return () => { live = false; };
  }, [picking, query, first, searchPeople]);

  useEffect(() => {
    let live = true;
    pairKey.split(',').filter(Boolean).forEach((id) => {
      fetchCard(id).then((card) => { if (live && card) setNames((n) => ({ ...n, [id]: nameOf(card, id) })); });
    });
    return () => { live = false; };
  }, [pairKey, fetchCard]);

  useEffect(() => {
    if (!pairKey) { setPreview(null); return undefined; }
    let live = true;
    previewMerge(pairKey.split(','), keepId).then((card) => { if (live) setPreview(card); });
    return () => { live = false; };
  }, [pairKey, keepId, previewMerge]);

  const confirm = async () => {
    await merge(pair, keepId);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('contacts.merge.title')}
      footer={(
        <div className="flex justify-end gap-2 w-full">
          <Button data-testid="merge-cancel" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" data-testid="merge-confirm" disabled={!pair.length} onClick={confirm}>{t('contacts.merge.confirm')}</Button>
        </div>
      )}
    >
      {picking && (
        <div className="flex flex-col gap-2">
          <input
            data-testid="merge-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('contacts.search')}
            aria-label={t('contacts.search')}
            className="w-full rounded px-2 py-1 border border-mail-border bg-mail-bg"
          />
          <select
            data-testid="merge-other"
            aria-label={t('contacts.merge.title')}
            value={other}
            onChange={(e) => { setOther(e.target.value); setKeepId(first); }}
            className="w-full rounded border border-mail-border bg-mail-bg px-1 py-1 text-sm"
          >
            <option value="" />
            {results.map((p) => <option key={p.id} value={p.id}>{p.displayName || p.primaryEmail}</option>)}
          </select>
        </div>
      )}
      {pair.length > 0 && (
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="text-xs text-mail-text-secondary">{t('contacts.merge.keep')}</legend>
          {pair.map((id) => (
            <label key={id} className="flex items-center gap-2">
              <input type="radio" name="merge-keep" data-testid={`merge-keep-${id}`} checked={keepId === id} onChange={() => setKeepId(id)} />
              {names[id] || id}
            </label>
          ))}
        </fieldset>
      )}
      {preview && (
        <div className="rounded border border-mail-border p-3 text-sm" data-testid="merge-preview">
          <p className="text-xs text-mail-text-secondary">{t('contacts.merge.preview')}</p>
          <p className="font-semibold" data-testid="merge-preview-name">{nameOf(preview, '')}</p>
          {preview.emails.map((e) => <p key={e.address} data-testid="merge-preview-email">{e.address}</p>)}
          {preview.phones.map((p) => <p key={p.number} data-testid="merge-preview-phone">{p.number}</p>)}
        </div>
      )}
      <p className="text-xs text-mail-text-secondary">{t('contacts.merge.note')}</p>
    </Dialog>
  );
}
