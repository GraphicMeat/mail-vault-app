import React, { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { usePeopleStore } from '../../stores/peopleStore';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { MergeDialog } from './MergeDialog';

const fromCard = (c) => ({
  name: c?.displayName || '',
  emails: (c?.emails || []).map((e) => e.address),
  phones: (c?.phones || []).map((p) => p.number),
  org: c?.org || '',
  notes: c?.notes || '',
});
const clean = (list) => list.map((v) => v.trim()).filter(Boolean);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function Rows({ kind, values, labels, onChange, addLabel, t }) {
  return (
    <div className="flex flex-col gap-1">
      {values.map((value, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            data-testid={`person-${kind}-${i}`}
            aria-label={t(`contacts.field.${kind}s`)}
            value={value}
            onChange={(e) => onChange(values.map((v, j) => (j === i ? e.target.value : v)))}
            className="flex-1 rounded px-2 py-1 border border-mail-border bg-mail-bg"
          />
          {labels[value] && <span className="text-xs text-mail-text-secondary">{labels[value]}</span>}
        </div>
      ))}
      <Button variant="link" size="xs" data-testid={`person-add-${kind}`} className="self-start" onClick={() => onChange([...values, ''])}>{addLabel}</Button>
    </div>
  );
}

function ProposalRow({ otherId, reason, onMerge, t }) {
  const fetchCard = usePeopleStore((s) => s.fetchCard);
  const [name, setName] = useState('');
  useEffect(() => {
    let live = true;
    fetchCard(otherId).then((c) => { if (live && c) setName(c.displayName || c.emails?.[0]?.address || ''); });
    return () => { live = false; };
  }, [otherId, fetchCard]);
  return (
    <li data-testid={`proposal-${otherId}`} className="flex items-center gap-2 text-sm">
      <span className="flex-1 min-w-0 truncate">{name}</span>
      <span className="text-xs text-mail-text-secondary">{t(`contacts.merge.reason.${reason}`)}</span>
      <Button size="xs" data-testid={`proposal-merge-${otherId}`} onClick={onMerge}>{t('contacts.merge.action')}</Button>
    </li>
  );
}

export function PersonDetails({ draft }) {
  const t = useT();
  const card = usePeopleStore((s) => s.card);
  const { update, create, remove, select } = usePeopleStore();
  const [form, setForm] = useState(() => fromCard(draft ? null : card));
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(null); // the ids the merge dialog was opened with
  const proposals = usePeopleStore((s) => s.proposals);
  useEffect(() => { setForm(fromCard(draft ? null : card)); }, [card, draft]);

  const emails = clean(form.emails);
  const phones = clean(form.phones);
  const base = fromCard(draft ? null : card);
  const patch = {};
  if (form.name.trim() !== base.name) patch.displayName = form.name.trim();
  if (!same(emails, base.emails)) patch.emails = emails;
  if (!same(phones, base.phones)) patch.phones = phones;
  if (form.org.trim() !== base.org) patch.org = form.org.trim();
  if (form.notes !== base.notes) patch.notes = form.notes;
  const dirty = Object.keys(patch).length > 0;
  const canSave = draft ? !!(form.name.trim() || emails.length || phones.length) : dirty;

  const save = async () => {
    if (draft) await create({ displayName: form.name.trim(), emails, phones, org: form.org.trim(), notes: form.notes });
    else await update(card.id, patch);
  };
  const cancel = () => (draft ? select(null) : setForm(base));
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const labels = (list, field) => Object.fromEntries((list || []).filter((x) => x.label).map((x) => [x[field], x.label]));
  const name = card?.displayName || card?.emails?.[0]?.address || '';
  const mine = draft ? [] : proposals.filter((p) => p.a === card?.id || p.b === card?.id);

  return (
    <div className="p-4 flex flex-col gap-4" data-testid="person-details">
      <label className="flex flex-col gap-1 text-sm">
        {t('contacts.field.name')}
        <input data-testid="person-name" value={form.name} onChange={set('name')} className="rounded px-2 py-1 border border-mail-border bg-mail-bg" />
      </label>
      <div className="flex flex-col gap-1 text-sm">
        {t('contacts.field.emails')}
        <Rows kind="email" values={form.emails} labels={labels(card?.emails, 'address')} onChange={(emails) => setForm({ ...form, emails })} addLabel={t('contacts.field.addEmail')} t={t} />
      </div>
      <div className="flex flex-col gap-1 text-sm">
        {t('contacts.field.phones')}
        <Rows kind="phone" values={form.phones} labels={labels(card?.phones, 'number')} onChange={(phones) => setForm({ ...form, phones })} addLabel={t('contacts.field.addPhone')} t={t} />
      </div>
      <label className="flex flex-col gap-1 text-sm">
        {t('contacts.field.org')}
        <input data-testid="person-org" value={form.org} onChange={set('org')} className="rounded px-2 py-1 border border-mail-border bg-mail-bg" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t('contacts.field.notes')}
        <textarea data-testid="person-notes" rows={4} value={form.notes} onChange={set('notes')} className="rounded px-2 py-1 border border-mail-border bg-mail-bg" />
      </label>
      <div className="flex items-center gap-2">
        <Button variant="primary" data-testid="person-save" disabled={!canSave} onClick={save}>{t('contacts.save')}</Button>
        {(draft || dirty) && <Button data-testid="person-cancel" onClick={cancel}>{t('contacts.cancel')}</Button>}
        <div className="flex-1" />
        {!draft && <Button data-testid="person-merge" onClick={() => setMerging([card.id])}>{t('contacts.merge.action')}</Button>}
        {!draft && <Button variant="dangerTint" data-testid="person-delete" onClick={() => setConfirming(true)}>{t('contacts.delete')}</Button>}
      </div>
      {!draft && (
        <Dialog
          open={confirming}
          role="alertdialog"
          onClose={() => setConfirming(false)}
          title={t('contacts.delete')}
          description={t('contacts.deleteConfirm', { name })}
          footer={(
            <div className="flex justify-end gap-2">
              <Button data-testid="person-delete-cancel" onClick={() => setConfirming(false)}>{t('contacts.cancel')}</Button>
              <Button variant="danger" data-testid="person-delete-confirm" onClick={async () => { setConfirming(false); await remove(card.id); }}>{t('contacts.delete')}</Button>
            </div>
          )}
        />
      )}
      {mine.length > 0 && (
        <div data-testid="person-proposals" className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-mail-text-secondary">{t('contacts.merge.proposals')}</h3>
          <ul className="flex flex-col gap-1">
            {mine.map((p) => {
              const otherId = p.a === card.id ? p.b : p.a;
              return <ProposalRow key={otherId} otherId={otherId} reason={p.reason} t={t} onMerge={() => setMerging([card.id, otherId])} />;
            })}
          </ul>
        </div>
      )}
      {merging && <MergeDialog ids={merging} onClose={() => setMerging(null)} />}
    </div>
  );
}
