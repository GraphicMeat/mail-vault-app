import React, { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { useContactsViewStore } from '../../stores/contactsViewStore';
import { usePeopleStore } from '../../stores/peopleStore';
import { ContactRow } from './ContactRow';

const ROLE_LABEL = { from: 'common.from', to: 'common.to', cc: 'contacts.role.cc' };

/** The open email's sender and recipients, grouped by role. A saved one opens its contact. */
export function EmailPeopleList() {
  const t = useT();
  const participants = useContactsViewStore((s) => s.participants);
  const { selectedId, sender, select, selectSender, owners, items: contacts } = usePeopleStore();
  const [owned, setOwned] = useState(null); // null until the first lookup lands

  // Re-resolved when the contacts list reloads, so a star or save made here shows at once.
  useEffect(() => {
    let live = true;
    owners(participants.map((p) => p.address)).then((map) => { if (live) setOwned(map); });
    return () => { live = false; };
  }, [participants, contacts, owners]);

  const open = (p) => {
    const own = owned?.[p.address.toLowerCase()];
    return own ? select(own.personId) : selectSender(p);
  };
  useEffect(() => {
    if (owned && !selectedId && !sender && participants.length) open(participants[0]);
  }, [participants, owned]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="w-80 flex flex-col border-r border-mail-border min-h-0 overflow-y-auto" data-testid="email-people">
      {participants.length === 0 && <p className="p-6 text-sm text-mail-text-secondary text-center">{t('contacts.email.empty')}</p>}
      {Object.keys(ROLE_LABEL).map((role) => {
        const group = participants.filter((p) => p.role === role);
        if (!group.length) return null;
        return (
          <div key={role}>
            <h3 className="px-3 pt-3 pb-1 text-xs font-semibold uppercase text-mail-text-secondary">{t(ROLE_LABEL[role])}</h3>
            {group.map((p) => {
              const own = owned?.[p.address.toLowerCase()];
              const selected = own ? selectedId === own.personId : sender?.address === p.address;
              return (
                <ContactRow
                  key={p.address}
                  testId={`email-person-${p.address}`}
                  name={p.name}
                  address={p.address}
                  favorite={own?.favorite}
                  saved={!!own}
                  selected={selected}
                  onClick={() => open(p)}
                  style={{ height: 56, width: '100%' }}
                />
              );
            })}
          </div>
        );
      })}
    </section>
  );
}
