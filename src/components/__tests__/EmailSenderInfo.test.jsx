// @vitest-environment jsdom

// A collapsed thread row has to answer "who was this sent to" without being
// opened: the recipient line is the second line of every thread message, and
// only `More` (date, message-id, source) waits behind the expand. The
// single-email header keeps its contract — recipient line and More together
// appear on expand.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

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

describe('EmailSenderInfo click targets', () => {
  // Clicking a message replies to it; only the chevron folds the details.
  it('a click on the row replies and leaves the details folded', () => {
    const onReply = vi.fn();
    const onToggle = vi.fn();
    render(<EmailSenderInfo email={EMAIL} variant="single" expanded={false} onReply={onReply} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('sender-header'));
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('the arrow folds the details and replies to nothing', () => {
    const onReply = vi.fn();
    const onToggle = vi.fn();
    render(<EmailSenderInfo email={EMAIL} variant="single" expanded={false} onReply={onReply} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('header-toggle'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onReply).not.toHaveBeenCalled();
  });

  it('the arrow names the direction it folds', () => {
    const { rerender } = render(<EmailSenderInfo email={EMAIL} variant="single" expanded={false} onToggle={vi.fn()} />);
    const arrow = screen.getByTestId('header-toggle');
    expect(arrow.getAttribute('aria-expanded')).toBe('false');
    expect(arrow.getAttribute('aria-label')).toBe('Show details');
    rerender(<EmailSenderInfo email={EMAIL} variant="single" expanded onToggle={vi.fn()} />);
    expect(screen.getByTestId('header-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('header-toggle').getAttribute('aria-label')).toBe('Hide details');
  });

  it('the arrow click never reaches a thread wrapper that would reply', () => {
    // ThreadView answers a click anywhere on the message by replying to it;
    // the arrow is the one control that must not bubble up to that handler.
    const wrapper = vi.fn();
    render(
      <div onClick={wrapper}>
        <EmailSenderInfo email={EMAIL} variant="thread" expanded={false} onToggle={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByTestId('header-toggle'));
    expect(wrapper).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('sender-header'));
    expect(wrapper).toHaveBeenCalledTimes(1);
  });
});
