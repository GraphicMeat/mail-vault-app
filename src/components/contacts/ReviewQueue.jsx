import { useT } from '../../i18n';
import { usePeopleStore } from '../../stores/peopleStore';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';

export function ReviewQueue() {
  const t = useT();
  const review = usePeopleStore((s) => s.review);
  const acceptReview = usePeopleStore((s) => s.acceptReview);
  const dismissReview = usePeopleStore((s) => s.dismissReview);
  const item = (r) => ({ address: r.address, name: r.name });
  return (
    <section className="flex-1 overflow-y-auto p-4" data-testid="review-queue">
      <p className="text-sm text-mail-text-secondary mb-3">{t('contacts.review.hint')}</p>
      {review.length === 0 ? (
        <p>{t('contacts.review.empty')}</p>
      ) : (
        <>
          <Button variant="primary" data-testid="review-add-all" onClick={() => acceptReview(review.map(item))}>
            {t('contacts.review.addAll')}
          </Button>
          <ul className="mt-3 divide-y divide-mail-border">
            {review.map((r) => (
              <li key={r.address} data-testid={`review-row-${r.address}`} className="flex items-center gap-3 py-2">
                <Avatar name={r.name || r.address} size={32} />
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{r.name || r.address}</span>
                  <span className="block truncate text-xs text-mail-text-secondary">
                    {r.address} · {t('contacts.review.seen', { count: r.received + r.sentTo })}
                  </span>
                </span>
                <Button size="sm" data-testid={`review-add-${r.address}`} onClick={() => acceptReview([item(r)])}>{t('contacts.review.add')}</Button>
                <Button size="sm" variant="ghost" data-testid={`review-dismiss-${r.address}`} onClick={() => dismissReview([r.address])}>{t('contacts.review.dismiss')}</Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
