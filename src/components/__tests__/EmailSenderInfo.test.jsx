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
  // A message is a line in a list of messages: clicking the line opens or
  // shuts it. Only the sender's ADDRESS writes back to him.
  it('a click on the row folds the message and composes nothing', () => {
    const onReply = vi.fn();
    const onToggle = vi.fn();
    render(<EmailSenderInfo email={EMAIL} variant="single" expanded={false} onReply={onReply} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('sender-header'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onReply).not.toHaveBeenCalled();
  });

  it('a click on the address composes and leaves the message as it was', () => {
    const onReply = vi.fn();
    const onToggle = vi.fn();
    render(<EmailSenderInfo email={EMAIL} variant="thread" expanded={false} onReply={onReply} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('sender-address'));
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('the address is the address, not the display name', () => {
    render(<EmailSenderInfo email={EMAIL} variant="thread" expanded={false} onReply={vi.fn()} />);
    expect(screen.getByTestId('sender-address').textContent).toContain('prime@mock.test');
  });

  it('the sender name opens the details, it does not compose', () => {
    const onReply = vi.fn();
    render(<EmailSenderInfo email={EMAIL} variant="thread" expanded={false} onReply={onReply} onToggle={vi.fn()} />);
    fireEvent.click(screen.getByText('prime'));
    expect(onReply).not.toHaveBeenCalled();
    expect(screen.getByText('Sender Details')).toBeTruthy();
  });

  it('a sender with no display name shows one line, and it is the address', () => {
    // Nothing else on the header carries his address, so that line IS the
    // compose target — otherwise this sender has none.
    const onReply = vi.fn();
    const bare = { ...EMAIL, from: { address: 'bare@mock.test' } };
    render(<EmailSenderInfo email={bare} variant="thread" expanded={false} onReply={onReply} onToggle={vi.fn()} />);
    fireEvent.click(screen.getByTestId('sender-address'));
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('the details popover composes from the address it prints', () => {
    const onReply = vi.fn();
    render(<EmailSenderInfo email={EMAIL} variant="thread" expanded={false} onReply={onReply} onToggle={vi.fn()} />);
    fireEvent.click(screen.getByText('prime'));
    fireEvent.click(screen.getByTestId('popover-address'));
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('the arrow folds the details and composes nothing', () => {
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

  it('neither the arrow nor the row reaches a thread wrapper twice', () => {
    // ThreadView's wrapper answers a click on the snippet line by folding the
    // message; the header handles its own clicks and must not bubble one up,
    // or a single click would fold and unfold in the same frame.
    const wrapper = vi.fn();
    render(
      <div onClick={wrapper}>
        <EmailSenderInfo email={EMAIL} variant="thread" expanded={false} onToggle={vi.fn()} onReply={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByTestId('header-toggle'));
    fireEvent.click(screen.getByTestId('sender-header'));
    fireEvent.click(screen.getByTestId('sender-address'));
    expect(wrapper).not.toHaveBeenCalled();
  });

  it('a click that ends a text selection copies, it neither folds nor composes', () => {
    const onReply = vi.fn();
    const onToggle = vi.fn();
    const spy = vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false });
    render(<EmailSenderInfo email={EMAIL} variant="thread" expanded={false} onReply={onReply} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('sender-header'));
    fireEvent.click(screen.getByTestId('sender-address'));
    expect(onReply).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
