import React, { useState } from 'react';
import { Ban, Pin, Star } from 'lucide-react';
import { useT } from '../../i18n';
import { usePeopleStore } from '../../stores/peopleStore';
import { formatDateOnly } from '../../utils/dateFormat';
import { Avatar } from '../ui/Avatar';
import { SegmentedChoice } from '../ui/SegmentedChoice';
import { PersonDetails } from './PersonDetails';
import { PersonMail } from './PersonMail';
import { PersonActivity } from './PersonActivity';

const date = (ms) => formatDateOnly(ms, { alwaysShowYear: true });

function Header({ card }) {
  const t = useT();
  const stats = usePeopleStore((s) => s.stats);
  const update = usePeopleStore((s) => s.update);
  if (!card) return <div className="px-4 py-3 border-b border-mail-border font-semibold">{t('contacts.new')}</div>;
  const st = stats[card.id];
  const none = st && !st.received && !st.sentTo && !st.cc;
  const toggle = (key, Icon, label) => (
    <button type="button" data-testid={`toggle-${key}`} aria-pressed={!!card[key]} title={label} aria-label={label}
      onClick={() => update(card.id, { [key]: !card[key] })}>
      <Icon size={16} />
    </button>
  );
  return (
    <div className="px-4 py-3 border-b border-mail-border">
      <div className="flex items-center gap-3">
        <Avatar name={card.displayName || card.emails[0]?.address} size={40} />
        <h2 className="flex-1 min-w-0 truncate text-lg font-semibold">{card.displayName || card.emails[0]?.address}</h2>
        {toggle('vip', Star, t('contacts.vip'))}
        {toggle('pinned', Pin, t('contacts.pinned'))}
        {toggle('blocked', Ban, t('contacts.blocked'))}
      </div>
      {st && (none ? (
        <p className="mt-2 text-sm text-mail-text-secondary">{t('contacts.stats.none')}</p>
      ) : (
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div><dt className="text-xs text-mail-text-secondary">{t('contacts.stats.received')}</dt><dd data-testid="stat-received">{st.received}</dd></div>
          <div><dt className="text-xs text-mail-text-secondary">{t('contacts.stats.sent')}</dt><dd data-testid="stat-sent">{st.sentTo}</dd></div>
          <div><dt className="text-xs text-mail-text-secondary">{t('contacts.stats.cc')}</dt><dd data-testid="stat-cc">{st.cc}</dd></div>
          {st.firstMs != null && <div><dt className="text-xs text-mail-text-secondary">{t('contacts.stats.first')}</dt><dd data-testid="stat-first">{date(st.firstMs)}</dd></div>}
          {st.lastMs != null && <div><dt className="text-xs text-mail-text-secondary">{t('contacts.stats.last')}</dt><dd data-testid="stat-last">{date(st.lastMs)}</dd></div>}
        </dl>
      ))}
    </div>
  );
}

export function PersonCard({ onOpenMail }) {
  const t = useT();
  const selectedId = usePeopleStore((s) => s.selectedId);
  const card = usePeopleStore((s) => s.card);
  const [tab, setTab] = useState('details');
  if (!selectedId) return <div className="flex-1" />;
  const draft = selectedId === 'new';
  if (!draft && !card) return <div className="flex-1" />;
  return (
    <section className="flex-1 flex flex-col min-w-0 min-h-0" data-testid="person-card">
      <Header card={draft ? null : card} />
      {!draft && (
        <SegmentedChoice
          className="mx-4 my-2"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'details', label: t('contacts.tab.details') },
            { value: 'mail', label: t('contacts.tab.mail') },
            { value: 'activity', label: t('contacts.tab.activity') },
          ]}
        />
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {draft || tab === 'details' ? <PersonDetails draft={draft} />
          : tab === 'mail' ? <PersonMail key={selectedId} onOpenMail={onOpenMail} />
            : <PersonActivity />}
      </div>
    </section>
  );
}
