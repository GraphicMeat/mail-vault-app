// @vitest-environment jsdom
//
// The info button beside a sender opens what this app knows about them. It
// counted the open folder's list and nothing else, so for a search hit from
// another folder it found nothing and the panel rendered nothing: a button
// that did nothing.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { useMailStore } = await import('../../stores/mailStore');
const { useSearchStore } = await import('../../stores/searchStore');
const { useSenderInsights } = await import('../useSenderInsights');

const hit = (uid, extra = {}) => ({
  uid, _accountId: 'acct-1', _mailbox: 'Archive', subject: `Deal ${uid}`,
  from: { address: 'news@blurb.test' }, date: `2026-0${uid}-01T00:00:00Z`, ...extra,
});

beforeEach(() => {
  useMailStore.setState({ activeAccountId: 'acct-1', emails: [], sentEmails: [] });
  useSearchStore.setState({ searchActive: false, searchResults: [] });
});

describe('useSenderInsights', () => {
  it('counts the search results a hit was opened from', () => {
    useSearchStore.setState({ searchActive: true, searchResults: [hit(1), hit(2), hit(3, { from: { address: 'other@x.test' } })] });
    const { result } = renderHook(() => useSenderInsights('news@blurb.test'));
    expect(result.current.totalReceived).toBe(2);
  });

  it('counts a message once when the folder list and the results both hold it', () => {
    useMailStore.setState({ emails: [hit(1)] });
    useSearchStore.setState({ searchActive: true, searchResults: [hit(1), hit(2)] });
    const { result } = renderHook(() => useSenderInsights('news@blurb.test'));
    expect(result.current.totalReceived).toBe(2);
  });

  it('always counts the open message, so the panel never opens empty', () => {
    const { result } = renderHook(() => useSenderInsights('news@blurb.test', hit(4)));
    expect(result.current.totalReceived).toBe(1);
    expect(result.current.topSubjects).toEqual(['Deal 4']);
  });
});
