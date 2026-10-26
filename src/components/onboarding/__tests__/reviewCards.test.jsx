// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { setLocale, t } from '../../../i18n/index.js';

vi.mock('../../../services/billingApi', () => ({ openInBrowser: vi.fn().mockResolvedValue(true) }));

const { openInBrowser } = await import('../../../services/billingApi');
const { ReviewCards } = await import('../ReviewCards');

const REVIEWS = [
  { id: 'r1', quote: 'Finally a mail client that keeps my copy.', author: 'Ana', source: 'AlternativeTo', url: 'https://alternativeto.net/software/mailvault/about/' },
  { id: 'r2', quote: 'Backups I can read without MailVault.', author: 'Jonas', source: 'Product Hunt', url: 'https://www.producthunt.com/products/mailvault' },
];

beforeEach(async () => { await setLocale('en'); openInBrowser.mockClear(); });
afterEach(cleanup);

describe('ReviewCards', () => {
  it('renders nothing when there are no reviews, not even the heading', () => {
    const { container } = render(<ReviewCards reviews={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows each quote with its author and a link to where it was said', () => {
    render(<ReviewCards reviews={REVIEWS} />);
    expect(screen.getByRole('heading', { name: t('onboarding.proofTitle') })).toBeTruthy();
    expect(screen.getByText(/keeps my copy/)).toBeTruthy();
    expect(screen.getByText(/Ana/)).toBeTruthy();
    const links = screen.getAllByTestId('onboarding-review-link');
    expect(links.map(a => a.getAttribute('href'))).toEqual(REVIEWS.map(r => r.url));
    expect(links.map(a => a.textContent)).toEqual(['AlternativeTo', 'Product Hunt']);
  });

  it('opens the link in the system browser instead of navigating the app window', () => {
    render(<ReviewCards reviews={REVIEWS} />);
    const link = screen.getAllByTestId('onboarding-review-link')[0];
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false);
    expect(openInBrowser).toHaveBeenCalledWith(REVIEWS[0].url);
  });

  it('marks the links as external for assistive tech and never leaks the opener', () => {
    render(<ReviewCards reviews={REVIEWS} />);
    for (const a of screen.getAllByTestId('onboarding-review-link')) {
      expect(a.getAttribute('rel')).toContain('noopener');
      expect(a.getAttribute('rel')).toContain('noreferrer');
    }
  });
});
