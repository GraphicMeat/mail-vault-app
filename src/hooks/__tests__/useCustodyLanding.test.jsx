// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { useCustodyLanding } from '../useCustodyLanding';

// Matches --mv-handoff / HOLD_MS.
const HOLD_MS = 620;

describe('useCustodyLanding', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('says nothing on first render — an existing state is not a handoff', () => {
    const { result } = renderHook(() => useCustodyLanding('acc1-INBOX-1001', 'local'));
    expect(result.current).toBeNull();
  });

  it('reports the new tone when the same message changes hands', () => {
    const { result, rerender } = renderHook(
      ({ key, tone }) => useCustodyLanding(key, tone),
      { initialProps: { key: 'acc1-INBOX-1001', tone: 'server' } }
    );
    expect(result.current).toBeNull();

    rerender({ key: 'acc1-INBOX-1001', tone: 'local' });
    expect(result.current).toBe('local');
  });

  it('clears itself after the handoff', () => {
    const { result, rerender } = renderHook(
      ({ key, tone }) => useCustodyLanding(key, tone),
      { initialProps: { key: 'acc1-INBOX-1001', tone: 'server' } }
    );
    rerender({ key: 'acc1-INBOX-1001', tone: 'local' });
    expect(result.current).toBe('local');

    act(() => vi.advanceTimersByTime(HOLD_MS - 1));
    expect(result.current).toBe('local');
    act(() => vi.advanceTimersByTime(2));
    expect(result.current).toBeNull();
  });

  // The reason the hook takes a pair instead of a tone. A virtualized list
  // recycles component instances, so this same instance renders a different
  // message as the user scrolls — and that message's tone routinely differs
  // from the last one drawn here. Animating that would turn a scroll into a
  // light show and would credit one message's handoff to another.
  it('does NOT fire when a recycled row swaps to a different message', () => {
    const { result, rerender } = renderHook(
      ({ key, tone }) => useCustodyLanding(key, tone),
      { initialProps: { key: 'acc1-INBOX-1001', tone: 'server' } }
    );

    rerender({ key: 'acc1-INBOX-2002', tone: 'local' });
    expect(result.current).toBeNull();
  });

  it('does not paint a landing onto the message that replaced it', () => {
    const { result, rerender } = renderHook(
      ({ key, tone }) => useCustodyLanding(key, tone),
      { initialProps: { key: 'acc1-INBOX-1001', tone: 'server' } }
    );
    rerender({ key: 'acc1-INBOX-1001', tone: 'local' });
    expect(result.current).toBe('local');

    // Scrolled away mid-beat: the row now shows someone else's message, and
    // that message's tone differs too — otherwise the tone check clears this
    // on its own and the assertion says nothing about the key guard.
    rerender({ key: 'acc1-INBOX-2002', tone: 'only-copy' });
    expect(result.current).toBeNull();

    // And the in-flight timer must not resurrect it.
    act(() => vi.advanceTimersByTime(HOLD_MS * 2));
    expect(result.current).toBeNull();
  });

  it('reports gold when the server drops the last copy', () => {
    const { result, rerender } = renderHook(
      ({ key, tone }) => useCustodyLanding(key, tone),
      { initialProps: { key: 'acc1-INBOX-1001', tone: 'local' } }
    );
    rerender({ key: 'acc1-INBOX-1001', tone: 'only-copy' });
    expect(result.current).toBe('only-copy');
  });

  // emailScopeKey returns null when a row's location cannot be resolved. A null
  // key is not a key: two unresolvable rows would compare equal and hand off to
  // each other.
  it('never fires on a null scope key', () => {
    const { result, rerender } = renderHook(
      ({ key, tone }) => useCustodyLanding(key, tone),
      { initialProps: { key: null, tone: 'server' } }
    );
    rerender({ key: null, tone: 'local' });
    expect(result.current).toBeNull();
  });

  it('re-arms for a second handoff on the same message', () => {
    const { result, rerender } = renderHook(
      ({ key, tone }) => useCustodyLanding(key, tone),
      { initialProps: { key: 'acc1-INBOX-1001', tone: 'server' } }
    );
    rerender({ key: 'acc1-INBOX-1001', tone: 'local' });
    expect(result.current).toBe('local');
    act(() => vi.advanceTimersByTime(HOLD_MS + 1));
    expect(result.current).toBeNull();

    rerender({ key: 'acc1-INBOX-1001', tone: 'only-copy' });
    expect(result.current).toBe('only-copy');
  });
});
