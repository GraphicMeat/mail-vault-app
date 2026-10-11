import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Upload, UserCheck } from 'lucide-react';
import { useT, tErr } from '../../i18n';
import { usePeopleStore, initPeople } from '../../stores/peopleStore';
import { ContactsList } from './ContactsList';
import { PersonCard } from './PersonCard';
import { ReviewQueue } from './ReviewQueue';
import { ExportButton } from './ExportButton';

export function ContactsView({ onClose, onOpenMail }) {
  const t = useT();
  const { load, loadReview, loadProposals, review, indexReady, indexing, total, error, importVcf } = usePeopleStore();
  const fileRef = useRef(null);
  const [mode, setMode] = useState('people'); // 'people' | 'review'

  useEffect(() => { initPeople(); load(); loadReview(); loadProposals(); }, [load, loadReview, loadProposals]);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await importVcf(text);
    e.target.value = '';
  };

  return (
    <div data-testid="contacts-view" className="flex-1 flex flex-col min-w-0 bg-mail-bg">
      <header className="flex items-center gap-3 px-4 h-12 border-b border-mail-border">
        <button type="button" data-testid="contacts-back" onClick={onClose} aria-label={t('contacts.back')}><ArrowLeft size={18} /></button>
        <h1 className="text-base font-semibold">{t('contacts.title')}</h1>
        <span className="text-sm text-mail-text-secondary">{t('contacts.count', { count: total })}</span>
        <div className="flex-1" />
        <button type="button" data-testid="contacts-review-tab" onClick={() => setMode(mode === 'review' ? 'people' : 'review')}>
          <UserCheck size={16} /> {t('contacts.review.title')}{review.length > 0 ? ` (${review.length})` : ''}
        </button>
        <button type="button" data-testid="contacts-import" onClick={() => fileRef.current?.click()}><Upload size={16} /> {t('contacts.import')}</button>
        <input ref={fileRef} type="file" accept=".vcf,text/vcard,text/x-vcard" hidden onChange={onFile} data-testid="contacts-import-input" />
        <ExportButton />
      </header>
      {!indexReady && indexing && <div className="px-4 py-1 text-xs text-mail-text-secondary" role="status">{t('contacts.indexing')}</div>}
      {error && <div className="px-4 py-1 text-xs text-red-600" role="alert">{tErr(error)}</div>}
      {mode === 'review' ? (
        <ReviewQueue />
      ) : (
        <div className="flex-1 flex min-h-0">
          <ContactsList />
          <PersonCard onOpenMail={onOpenMail} />
        </div>
      )}
    </div>
  );
}
