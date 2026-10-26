import React from 'react';
import { REVIEWS } from '../../data/reviews.js';
import { useT } from '../../i18n/index.js';
import { ExternalLink } from '../ui/ExternalLink';

/**
 * Quotes from real reviews, each linked to where it was said. Renders nothing
 * (no heading either) while `data/reviews.js` is empty.
 */
export function ReviewCards({ reviews = REVIEWS }) {
  const t = useT();
  if (!reviews.length) return null;
  return (
    <section data-testid="onboarding-reviews" className="mb-6 text-left">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-mail-text-muted mb-2 text-center">
        {t('onboarding.proofTitle')}
      </h3>
      <ul className="flex flex-col gap-2">
        {reviews.map((review) => (
          <li key={review.id}>
            <figure className="rounded-xl border border-mail-border bg-mail-surface px-4 py-3">
              <blockquote className="text-sm text-mail-text leading-relaxed">“{review.quote}”</blockquote>
              <figcaption className="mt-1.5 text-xs text-mail-text-muted">
                {review.author} ·{' '}
                <ExternalLink href={review.url} data-testid="onboarding-review-link"
                  className="text-mail-accent-text hover:underline">
                  {review.source}
                </ExternalLink>
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </section>
  );
}
