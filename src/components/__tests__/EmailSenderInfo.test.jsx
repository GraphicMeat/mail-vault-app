// @vitest-environment jsdom

// A collapsed thread row has to answer "who was this sent to" without being
// opened: the recipient line is the second line of every thread message, and
// only `More` (date, message-id, source) waits behind the expand. The
// single-email header keeps its contract — recipient line and More together
// appear on expand.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  motion: { div: React.forwardRef((props, ref) => React.createElement('div', { ...props, ref })) },
  AnimatePresence: ({ children }) => children,
}));

const { EmailSenderInfo } = await import('../email/EmailSenderInfo');

const EMAIL = {
  uid: 1, subject: 'General', date: '2026-09-02T10:00:00Z',
  from: { name: 'prime', address: 'prime@mock.test' },
  to: [{ address: 'me@mock.test' }],
};

afterEach(cleanup);

describe('EmailSenderInfo thread variant', () => {
  it('names the recipient while collapsed, without the More control', () => {
    render(<EmailSenderInfo email={EMAIL} variant="thread" expanded={false} />);
    expect(screen.getByText(/^To: me@mock\.test/)).toBeTruthy();
    expect(screen.queryByText('More')).toBeNull();
  });

  it('adds the More control once expanded', () => {
    render(<EmailSenderInfo email={EMAIL} variant="thread" expanded />);
    expect(screen.getByText(/^To: me@mock\.test/)).toBeTruthy();
    expect(screen.getByText('More')).toBeTruthy();
  });
});

describe('EmailSenderInfo single variant', () => {
  it('keeps the recipient line behind the expand', () => {
    render(<EmailSenderInfo email={EMAIL} variant="single" expanded={false} />);
    expect(screen.queryByText(/^To:/)).toBeNull();
  });
});
