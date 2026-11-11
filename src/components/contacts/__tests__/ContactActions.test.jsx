// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../../../i18n', () => ({ useT: () => (k) => k }));
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : () => null),
  has: () => true,
}));
vi.mock('../../../utils/composeOpener', () => ({ openCompose: vi.fn() }));
import { ContactActions } from '../ContactActions';
import { openCompose } from '../../../utils/composeOpener';

afterEach(() => { cleanup(); vi.useRealTimers(); openCompose.mockReset(); });

describe('ContactActions', () => {
  it('Email opens compose to the address', () => {
    render(<ContactActions address="bo@x.io" />);
    fireEvent.click(screen.getByTestId('contact-email'));
    expect(openCompose).toHaveBeenCalledWith({ initialData: { to: 'bo@x.io', _prefill: true } });
  });

  it('Copy writes the address and shows Copied', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ContactActions address="bo@x.io" />);
    expect(screen.getByTestId('contact-copy').textContent).toContain('contacts.action.copy');
    await act(async () => { fireEvent.click(screen.getByTestId('contact-copy')); });
    expect(writeText).toHaveBeenCalledWith('bo@x.io');
    expect(screen.getByTestId('contact-copy').textContent).toContain('contacts.action.copied');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByTestId('contact-copy').textContent).toContain('contacts.action.copy');
    expect(screen.getByTestId('contact-copy').textContent).not.toContain('copied');
  });

  it('renders nothing without an address', () => {
    render(<ContactActions address={undefined} />);
    expect(screen.queryByTestId('contact-actions')).toBeNull();
  });
});
