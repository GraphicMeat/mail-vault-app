import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useCodeBubbleStore, CODE_BUBBLE_TTL_MS } from '../codeBubbleStore';

// The corner bubbles holding one-time codes that arrived by mail. A code is
// good for minutes, so a bubble leaves on its own; one message is one bubble.
const arrival = (uid, extra = {}) => ({
  accountId: 'a1', mailbox: 'INBOX', uid, code: `${uid}00000`.slice(0, 6), sender: 'Acme', subject: 'Your code', ...extra,
});

describe('codeBubbleStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCodeBubbleStore.getState().clear();
  });
  afterEach(() => vi.useRealTimers());

  it('offers a bubble keyed on the message, stamped with when it expires', () => {
    vi.setSystemTime(1_000_000);
    useCodeBubbleStore.getState().offer(arrival(7));
    const [bubble] = useCodeBubbleStore.getState().bubbles;
    expect(bubble.id).toBe('a1|INBOX|7');
    expect(bubble.code).toBe('700000');
    expect(bubble.expiresAt).toBe(1_000_000 + CODE_BUBBLE_TTL_MS);
  });

  it('keeps one bubble per message', () => {
    const { offer } = useCodeBubbleStore.getState();
    offer(arrival(7));
    offer(arrival(7));
    expect(useCodeBubbleStore.getState().bubbles).toHaveLength(1);
  });

  it('shows the newest first and keeps at most three', () => {
    const { offer } = useCodeBubbleStore.getState();
    [1, 2, 3, 4].forEach(uid => offer(arrival(uid)));
    expect(useCodeBubbleStore.getState().bubbles.map(b => b.uid)).toEqual([4, 3, 2]);
  });

  it('dismisses one bubble and leaves the others', () => {
    const { offer, dismiss } = useCodeBubbleStore.getState();
    offer(arrival(1));
    offer(arrival(2));
    dismiss('a1|INBOX|1');
    expect(useCodeBubbleStore.getState().bubbles.map(b => b.uid)).toEqual([2]);
  });

  it('leaves on its own once the code has gone stale', () => {
    useCodeBubbleStore.getState().offer(arrival(7));
    vi.advanceTimersByTime(CODE_BUBBLE_TTL_MS - 1);
    expect(useCodeBubbleStore.getState().bubbles).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useCodeBubbleStore.getState().bubbles).toHaveLength(0);
  });
});
