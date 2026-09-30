// @vitest-environment jsdom
//
// The search bar's typeahead asks the daemon on each pause in typing. One
// call per pause, never a stale answer over a newer one, and a failure is no
// suggestions, never an error.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const daemonCall = vi.hoisted(() => vi.fn());
vi.mock('../../services/daemonClient', () => ({ daemonCall }));

const { useSearchSuggestions, SUGGEST_DEBOUNCE_MS } = await import('../useSearchSuggestions.js');
const { fetchSearchSuggestions } = await import('../../services/searchSuggestions.js');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.useFakeTimers();
  daemonCall.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('fetchSearchSuggestions', () => {
  it('turns a sender into a from: tag and a word into its own tags', async () => {
    vi.useRealTimers();
    daemonCall.mockResolvedValue([
      { kind: 'sender', address: 'ann@acme.test', name: 'Ann Lee', count: 3 },
      { kind: 'sender', address: '@acme.test', name: '', count: 5 },
      { kind: 'term', term: 'quarterly report', count: 2 },
    ]);
    const found = await fetchSearchSuggestions({ prefix: 'an', accounts: ['a'] });
    expect(daemonCall).toHaveBeenCalledWith('search.suggest', { prefix: 'an', accounts: ['a'], limit: 10 });
    expect(found).toEqual([
      { key: 'sender:ann@acme.test', kind: 'sender', tags: ['from:ann@acme.test'], label: 'Ann Lee', detail: 'ann@acme.test', count: 3 },
      { key: 'sender:@acme.test', kind: 'sender', tags: ['from:@acme.test'], label: '@acme.test', detail: '', count: 5 },
      { key: 'term:quarterly report', kind: 'term', tags: ['quarterly', 'report'], label: 'quarterly report', detail: '', count: 2 },
    ]);
  });

  it('answers nothing, and throws nothing, when the daemon cannot answer', async () => {
    vi.useRealTimers();
    daemonCall.mockRejectedValue(new Error('daemon down'));
    await expect(fetchSearchSuggestions({ prefix: 'an', accounts: [] })).resolves.toEqual([]);
    daemonCall.mockResolvedValue(null);
    await expect(fetchSearchSuggestions({ prefix: 'an', accounts: [] })).resolves.toEqual([]);
  });
});

describe('useSearchSuggestions', () => {
  it('asks once, for what was typed last, after typing pauses', async () => {
    daemonCall.mockResolvedValue([{ kind: 'term', term: 'invoice', count: 1 }]);
    const { result, rerender } = renderHook(({ text }) => useSearchSuggestions(text, ['a']), { initialProps: { text: 'i' } });
    rerender({ text: 'in' });
    rerender({ text: 'inv' });
    act(() => { vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS - 1); });
    expect(daemonCall).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    await settle();
    expect(daemonCall).toHaveBeenCalledTimes(1);
    expect(daemonCall.mock.calls[0][1]).toMatchObject({ prefix: 'inv', accounts: ['a'] });
    expect(result.current.map(s => s.label)).toEqual(['invoice']);
  });

  it('never lets an answer to older text replace the newer one', async () => {
    const slow = deferred();
    const fast = deferred();
    daemonCall.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const { result, rerender } = renderHook(({ text }) => useSearchSuggestions(text, ['a']), { initialProps: { text: 'inv' } });
    act(() => { vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS); });
    rerender({ text: 'invi' });
    act(() => { vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS); });
    expect(daemonCall).toHaveBeenCalledTimes(2);

    fast.resolve([{ kind: 'term', term: 'invitation', count: 1 }]);
    await settle();
    slow.resolve([{ kind: 'term', term: 'invoice', count: 9 }]);
    await settle();
    expect(result.current.map(s => s.label)).toEqual(['invitation']);
  });

  it('asks nothing for under two characters or an operator list, and clears what it showed', async () => {
    daemonCall.mockResolvedValue([{ kind: 'term', term: 'invoice', count: 1 }]);
    const { result, rerender } = renderHook(({ text }) => useSearchSuggestions(text, ['a']), { initialProps: { text: 'inv' } });
    act(() => { vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS); });
    await settle();
    expect(result.current).toHaveLength(1);

    rerender({ text: 'i' });
    expect(result.current).toEqual([]);
    rerender({ text: '/fr' });
    act(() => { vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS * 2); });
    await settle();
    expect(daemonCall).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual([]);
  });

  it('shows no suggestions when the daemon fails', async () => {
    daemonCall.mockRejectedValue(new Error('index closed'));
    const { result } = renderHook(() => useSearchSuggestions('inv', ['a']));
    act(() => { vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS); });
    await settle();
    expect(result.current).toEqual([]);
  });
});
