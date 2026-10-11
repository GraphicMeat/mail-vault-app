import { useEffect } from 'react';
import { useT } from '../../i18n';
import { usePeopleStore } from '../../stores/peopleStore';
import { formatDateOnly } from '../../utils/dateFormat';
import { Button } from '../ui/Button';

export function PersonActivity() {
  const t = useT();
  const journal = usePeopleStore((s) => s.journal);
  const loadJournal = usePeopleStore((s) => s.loadJournal);
  const undo = usePeopleStore((s) => s.undo);
  useEffect(() => { loadJournal(); }, [loadJournal]);
  return (
    <div className="p-4 flex flex-col gap-3" data-testid="person-activity">
      <Button className="self-start" data-testid="activity-undo" disabled={!journal.some((j) => !j.undone)} onClick={() => undo()}>
        {t('contacts.activity.undo')}
      </Button>
      {journal.length === 0 ? (
        <p className="text-sm text-mail-text-secondary">{t('contacts.activity.empty')}</p>
      ) : (
        <ul className="divide-y divide-mail-border text-sm">
          {journal.map((j) => (
            <li key={j.id} data-testid={`activity-row-${j.id}`} className="flex items-center gap-3 py-2">
              <span className="flex-1 min-w-0 truncate">{t(`contacts.activity.op.${j.op}`)}</span>
              {j.undone && <span className="text-xs text-mail-text-secondary" data-testid={`activity-undone-${j.id}`}>{t('contacts.activity.undone')}</span>}
              <span className="text-xs text-mail-text-secondary tabular-nums">{formatDateOnly(j.tsMs, { alwaysShowYear: true })}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
