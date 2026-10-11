// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../../../i18n', () => ({
  useT: () => (k, v) => (v?.count != null ? `${k}:${v.count}` : k),
}));
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : () => null),
  has: () => true,
}));
const h = vi.hoisted(() => ({ s: null, fresh: null }));
vi.mock('../../../stores/peopleStore', async () => {
  const { create } = await import('zustand');
  h.fresh = () => ({ review: [], acceptReview: vi.fn(), dismissReview: vi.fn() });
  h.s = create(() => h.fresh());
  return { usePeopleStore: h.s };
});
import { ReviewQueue } from '../ReviewQueue';

const ROWS = [
  { address: 'amy@x.io', name: 'Amy', received: 3, sentTo: 2, lastMs: 10 },
  { address: 'bo@x.io', name: '', received: 1, sentTo: 0, lastMs: 5 },
];

beforeEach(() => h.s.setState(h.fresh(), true));
afterEach(cleanup);

describe('ReviewQueue', () => {
  it('renders one row per candidate with name, address and the email count', () => {
    h.s.setState({ review: ROWS });
    render(<ReviewQueue />);
    const amy = screen.getByTestId('review-row-amy@x.io');
    expect(amy.textContent).toContain('Amy');
    expect(amy.textContent).toContain('amy@x.io');
    expect(amy.textContent).toContain('common.emailCount:5');
    const bo = screen.getByTestId('review-row-bo@x.io');
    expect(bo.textContent).toContain('bo@x.io');
    expect(bo.textContent).toContain('common.emailCount:1');
    expect(screen.getByText('contacts.review.hint')).toBeTruthy();
  });

  it('Add accepts just that address with its name', () => {
    h.s.setState({ review: ROWS });
    render(<ReviewQueue />);
    fireEvent.click(screen.getByTestId('review-add-amy@x.io'));
    expect(h.s.getState().acceptReview).toHaveBeenCalledWith([{ address: 'amy@x.io', name: 'Amy' }]);
  });

  it('Dismiss dismisses just that address', () => {
    h.s.setState({ review: ROWS });
    render(<ReviewQueue />);
    fireEvent.click(screen.getByTestId('review-dismiss-bo@x.io'));
    expect(h.s.getState().dismissReview).toHaveBeenCalledWith(['bo@x.io']);
    expect(h.s.getState().acceptReview).not.toHaveBeenCalled();
  });

  it('Add all accepts every row', () => {
    h.s.setState({ review: ROWS });
    render(<ReviewQueue />);
    fireEvent.click(screen.getByTestId('review-add-all'));
    expect(h.s.getState().acceptReview).toHaveBeenCalledWith([
      { address: 'amy@x.io', name: 'Amy' },
      { address: 'bo@x.io', name: '' },
    ]);
  });

  it('an empty queue shows the empty state and no Add all', () => {
    render(<ReviewQueue />);
    expect(screen.getByText('contacts.review.empty')).toBeTruthy();
    expect(screen.queryByTestId('review-add-all')).toBeNull();
    expect(screen.getByText('contacts.review.hint')).toBeTruthy();
  });
});
