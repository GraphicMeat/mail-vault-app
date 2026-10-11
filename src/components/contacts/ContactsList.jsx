import { useT } from '../../i18n';
import { usePeopleStore } from '../../stores/peopleStore';

// Stub: Task 19 replaces this with the real virtualised list.
export function ContactsList() {
  const t = useT();
  const total = usePeopleStore((s) => s.total);
  return (
    <section className="w-80 flex flex-col border-r border-mail-border min-h-0">
      {total === 0 && (
        <div className="p-6 text-sm text-mail-text-secondary text-center">
          <p className="font-medium">{t('contacts.empty')}</p>
          <p className="mt-1">{t('contacts.emptyHint')}</p>
        </div>
      )}
    </section>
  );
}
