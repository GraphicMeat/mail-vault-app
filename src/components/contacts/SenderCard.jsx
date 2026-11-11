import React from 'react';
import { Star, UserPlus } from 'lucide-react';
import { useT } from '../../i18n';
import { usePeopleStore } from '../../stores/peopleStore';
import { formatDateOnly } from '../../utils/dateFormat';
import { Avatar } from '../ui/Avatar';
import { ContactActions } from './ContactActions';
import { PersonMail } from './PersonMail';

const date = (ms) => formatDateOnly(ms, { alwaysShowYear: true });

/** The pane for a sender who is not a contact yet: their emails, plus save or favorite. */
export function SenderCard({ onOpenMail }) {
  const t = useT();
  const sender = usePeopleStore((s) => s.sender);
  const stats = usePeopleStore((s) => s.stats);
  const saveSender = usePeopleStore((s) => s.saveSender);
  const favoriteSender = usePeopleStore((s) => s.favoriteSender);
  if (!sender) return null;
  const st = stats[sender.address];
  return (
    <section className="flex-1 flex flex-col min-w-0 min-h-0" data-testid="sender-card">
      <div className="px-4 py-3 border-b border-mail-border">
        <div className="flex items-center gap-3">
          <Avatar name={sender.name || sender.address} size={40} />
          <div className="flex-1 min-w-0">
            <h2 className="truncate text-lg font-semibold">{sender.name || sender.address}</h2>
            {sender.name && <p className="truncate text-sm text-mail-text-secondary" data-testid="sender-address">{sender.address}</p>}
          </div>
          <button type="button" data-testid="sender-favorite" title={t('contacts.vip')} aria-label={t('contacts.vip')} onClick={() => favoriteSender(sender)}><Star size={16} /></button>
          <button type="button" data-testid="sender-save" title={t('contacts.action.save')} aria-label={t('contacts.action.save')} onClick={() => saveSender(sender)}><UserPlus size={16} /></button>
        </div>
        <div className="mt-2"><ContactActions address={sender.address} /></div>
        {st && (
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <div><dt className="text-xs text-mail-text-secondary">{t('contacts.stats.received')}</dt><dd data-testid="stat-received">{st.received}</dd></div>
            <div><dt className="text-xs text-mail-text-secondary">{t('contacts.stats.sent')}</dt><dd data-testid="stat-sent">{st.sentTo}</dd></div>
            {st.lastMs != null && <div><dt className="text-xs text-mail-text-secondary">{t('contacts.stats.last')}</dt><dd data-testid="stat-last">{date(st.lastMs)}</dd></div>}
          </dl>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto"><PersonMail key={sender.address} onOpenMail={onOpenMail} /></div>
    </section>
  );
}
