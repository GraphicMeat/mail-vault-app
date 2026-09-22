// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('../../i18n/index.js', () => ({
  t: key => key,
  useT: () => (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

let useViewStoreMock;
vi.mock('../../stores/viewStore', () => ({
  useViewStore: Object.assign(selector => useViewStoreMock(selector), {
    getState: () => useViewStoreMock.getState(),
  }),
}));

const { ViewPreview } = await import('../ViewPreview');

const row = uid => ({
  uid, subject: `subject ${uid}`, from: { address: 'ann@x.test' },
  date: '2026-09-19T12:00:00Z', _accountId: 'acct-1', _mailbox: 'INBOX',
});

const withReply = reply => { useViewStoreMock = create(() => ({ previewDef: vi.fn(async () => reply) })); };

beforeEach(() => withReply({ available: true, reason: null, rows: [row(1), row(2)], total: 2 }));
afterEach(cleanup);

describe('the builder preview', () => {
  it('shows what the definition would find', async () => {
    render(<ViewPreview def={{ starred: true }} />);
    const rows = await screen.findByTestId('view-preview-rows');
    expect(rows.querySelectorAll('li').length).toBe(2);
    expect(screen.getByTestId('view-preview-total').textContent).toContain('2');
  });

  /// Zero is a claim about the mail. An index that could not answer has made
  /// no claim at all, and "no matches" there would be a lie about the archive.
  it('says the index could not answer rather than showing no matches', async () => {
    withReply({ available: false, reason: 'building', rows: [], total: 0 });
    render(<ViewPreview def={{}} />);
    expect((await screen.findByTestId('view-preview-unavailable')).textContent)
      .toContain('views.unavailable.building');
    expect(screen.queryByTestId('view-preview-empty')).toBeNull();
  });

  it('says nothing matches only when the index actually answered', async () => {
    withReply({ available: true, reason: null, rows: [], total: 0 });
    render(<ViewPreview def={{}} />);
    expect(await screen.findByTestId('view-preview-empty')).toBeTruthy();
  });

  /// A builder is typed into. One request per keystroke would ask the index
  /// about definitions nobody ever meant.
  it('waits out the typing instead of asking once per keystroke', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<ViewPreview def={{ query: 'a' }} />);
    rerender(<ViewPreview def={{ query: 'ab' }} />);
    rerender(<ViewPreview def={{ query: 'abc' }} />);
    await vi.advanceTimersByTimeAsync(300);
    expect(useViewStoreMock.getState().previewDef).toHaveBeenCalledTimes(1);
    expect(useViewStoreMock.getState().previewDef.mock.calls[0][0]).toEqual({ query: 'abc' });
    vi.useRealTimers();
  });
});
