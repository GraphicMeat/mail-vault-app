import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Upload } from 'lucide-react';
import { useT, tErr } from '../../i18n';
import { usePeopleStore, initPeople } from '../../stores/peopleStore';
import { useContactsViewStore } from '../../stores/contactsViewStore';
import { useMailStore } from '../../stores/mailStore';
import { myAddresses } from '../../stores/myAddresses';
import { emailParticipants } from '../../utils/emailParticipants';
import { ContactsList } from './ContactsList';
import { EmailPeopleList } from './EmailPeopleList';
import { PersonCard } from './PersonCard';
import { ReviewQueue } from './ReviewQueue';
import { SenderCard } from './SenderCard';
import { SendersList } from './SendersList';
import { ExportButton } from './ExportButton';

export function ContactsView({ onClose, onOpenMail }) {
  const t = useT();
  const { load, loadReview, loadProposals, review, indexReady, indexing, total, error, importVcf, vipOnly, setVipOnly, sender } = usePeopleStore();
  const { scope, participants, setScope, focus } = useContactsViewStore();
  const fileRef = useRef(null);
  const [imported, setImported] = useState(null);

  useEffect(() => { initPeople(); load(); loadReview(); loadProposals(); }, [load, loadReview, loadProposals]);

  // The reader keeps its message while Contacts is open: its people become the This email tab.
  useEffect(() => {
    const { selectedEmail, selectedThread } = useMailStore.getState();
    focus(emailParticipants(selectedEmail || selectedThread?.lastEmail, myAddresses()));
  }, [focus]);

  // Favorites is the Contacts list narrowed to starred people.
  useEffect(() => {
    if (scope !== 'favorites' && scope !== 'contacts') return;
    if (vipOnly !== (scope === 'favorites')) setVipOnly(scope === 'favorites');
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const report = await importVcf(text);
    setImported(report);
    loadProposals();
    e.target.value = '';
  };

  const tabs = [
    ...(participants.length ? [{ scope: 'email', testId: 'contacts-tab-email', label: `${t('contacts.scope.email')} (${participants.length})` }] : []),
    { scope: 'favorites', testId: 'contacts-tab-favorites', label: t('contacts.scope.favorites') },
    { scope: 'contacts', testId: 'contacts-tab-contacts', label: t('contacts.scope.contacts') },
    { scope: 'senders', testId: 'contacts-tab-senders', label: t('contacts.scope.senders') },
    { scope: 'review', testId: 'contacts-review-tab', label: `${t('contacts.review.title')}${review.length > 0 ? ` (${review.length})` : ''}` },
  ];

  return (
    <div data-testid="contacts-view" className="flex-1 flex flex-col min-w-0 bg-mail-bg">
      <header className="flex items-center gap-3 px-4 h-12 border-b border-mail-border">
        <button type="button" data-testid="contacts-back" onClick={onClose} aria-label={t('contacts.back')}><ArrowLeft size={18} /></button>
        <h1 className="text-base font-semibold">{t('contacts.title')}</h1>
        <span className="text-sm text-mail-text-secondary">{t('contacts.count', { count: total })}</span>
        <div className="flex-1" />
        <button type="button" data-testid="contacts-import" onClick={() => fileRef.current?.click()}><Upload size={16} /> {t('contacts.import')}</button>
        <input ref={fileRef} type="file" accept=".vcf,text/vcard,text/x-vcard" hidden onChange={onFile} data-testid="contacts-import-input" />
        <ExportButton />
      </header>
      {!indexReady && indexing && <div className="px-4 py-1 text-xs text-mail-text-secondary" role="status">{t('contacts.indexing')}</div>}
      {imported && <div className="px-4 py-1 text-xs text-mail-text-secondary" role="status" data-testid="contacts-import-result">{t('contacts.import.done', { created: imported.created, linked: imported.linked, skipped: imported.skipped })}</div>}
      {error && <div className="px-4 py-1 text-xs text-red-600" role="alert">{tErr(error)}</div>}
      <nav role="tablist" aria-label={t('contacts.title')} className="flex gap-1 px-4 border-b border-mail-border overflow-x-auto">
        {tabs.map(({ scope: key, testId, label }) => (
          <button key={key} type="button" role="tab" id={`contacts-tab-${key}`} data-testid={testId} aria-selected={scope === key} onClick={() => setScope(key)}
            className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 ${scope === key ? 'border-mail-accent font-semibold' : 'border-transparent text-mail-text-secondary'}`}>
            {label}
          </button>
        ))}
      </nav>
      {scope === 'review' ? (
        <ReviewQueue />
      ) : (
        <div className="flex-1 flex min-h-0">
          {scope === 'email' && <EmailPeopleList />}
          {scope === 'senders' && <SendersList />}
          {(scope === 'favorites' || scope === 'contacts') && <ContactsList />}
          {sender ? <SenderCard onOpenMail={onOpenMail} /> : <PersonCard onOpenMail={onOpenMail} />}
        </div>
      )}
    </div>
  );
}
