// @vitest-environment jsdom

// A one-time code that arrived by mail sits in the corner stack like a
// minimized draft: the code, who sent it, Copy, Copy & delete, and an X.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));

import { CodeBubbles } from '../CodeBubble';
import { useCodeBubbleStore } from '../../stores/codeBubbleStore';

const BUBBLE = { accountId: 'a1', mailbox: 'INBOX', uid: 42, code: '364758', sender: 'Acme', subject: 'Your verification code' };
const TARGET = { accountId: 'a1', mailbox: 'INBOX', uid: 42 };

describe('CodeBubbles', () => {
  let writeText, onOpen, onDelete;
  beforeEach(() => {
    useCodeBubbleStore.getState().clear();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    onOpen = vi.fn();
    onDelete = vi.fn().mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  const show = () => {
    act(() => { useCodeBubbleStore.getState().offer(BUBBLE); });
    return render(<CodeBubbles onOpen={onOpen} onDelete={onDelete} />);
  };

  it('renders nothing without a code', () => {
    const { container } = render(<CodeBubbles onOpen={onOpen} onDelete={onDelete} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the code and who sent it', () => {
    show();
    expect(screen.getByTestId('code-bubble-code').textContent).toBe('364758');
    expect(screen.getByTestId('code-bubble').textContent).toContain('Acme');
  });

  it('copies the code and says so, keeping the bubble', async () => {
    show();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^copy$/i })); });
    expect(writeText).toHaveBeenCalledWith('364758');
    expect(screen.getByRole('button', { name: /copied/i })).toBeTruthy();
    expect(useCodeBubbleStore.getState().bubbles).toHaveLength(1);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('copies the code, deletes the message and drops the bubble', async () => {
    show();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /copy & delete/i })); });
    expect(writeText).toHaveBeenCalledWith('364758');
    expect(onDelete).toHaveBeenCalledWith(TARGET);
    expect(useCodeBubbleStore.getState().bubbles).toHaveLength(0);
  });

  it('keeps the bubble when the delete fails', async () => {
    onDelete.mockRejectedValue(new Error('offline'));
    show();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /copy & delete/i })); });
    expect(writeText).toHaveBeenCalledWith('364758');
    expect(useCodeBubbleStore.getState().bubbles).toHaveLength(1);
  });

  it('dismisses without touching the message', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(useCodeBubbleStore.getState().bubbles).toHaveLength(0);
    expect(onDelete).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('opens the message from the bubble itself', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /open the email/i }));
    expect(onOpen).toHaveBeenCalledWith(TARGET);
  });
});
