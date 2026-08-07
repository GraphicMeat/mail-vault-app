// Folder-list recovery after a failed first fetch.
//
// The first fetch of a session can land before credentials finish loading
// ("Password missing"). Nothing retried it and nothing re-applied the folder
// list that the background prefetch later cached, so the account kept the
// INBOX placeholder — sidebar and Move dropdown both stuck at one folder.
import { describe, it, expect, vi } from 'vitest';
import {
  countMailboxes,
  isMailboxTreeComplete,
  pickMailboxList,
  INBOX_PLACEHOLDER,
  retryOnce,
} from '../mailboxTree';

const full = [
  { name: 'INBOX', path: 'INBOX', children: [] },
  { name: 'Archive', path: 'Archive', children: [] },
  { name: 'Sent', path: 'Sent', children: [] },
];
const placeholder = [{ name: 'INBOX', path: 'INBOX', specialUse: null, children: [] }];

describe('isMailboxTreeComplete', () => {
  it('rejects the INBOX-only placeholder', () => {
    expect(isMailboxTreeComplete(placeholder)).toBe(false);
  });

  it('rejects empty and missing lists', () => {
    expect(isMailboxTreeComplete([])).toBe(false);
    expect(isMailboxTreeComplete(null)).toBe(false);
    expect(isMailboxTreeComplete(undefined)).toBe(false);
  });

  it('accepts a real folder list', () => {
    expect(isMailboxTreeComplete(full)).toBe(true);
  });

  it('accepts a single folder that is not INBOX', () => {
    expect(isMailboxTreeComplete([{ name: 'Sent', path: 'Sent', children: [] }])).toBe(true);
  });

  it('rejects the old nested tree format so it gets refetched', () => {
    expect(isMailboxTreeComplete([
      { name: 'INBOX', path: 'INBOX', children: [{ name: 'Sub', path: 'INBOX/Sub', children: [] }] },
    ])).toBe(false);
  });
});

describe('countMailboxes', () => {
  it('counts nested children', () => {
    expect(countMailboxes([
      { path: 'a', children: [{ path: 'a/b', children: [{ path: 'a/b/c' }] }] },
      { path: 'd' },
    ])).toBe(4);
  });

  it('treats nothing as zero', () => {
    expect(countMailboxes(null)).toBe(0);
    expect(countMailboxes(undefined)).toBe(0);
  });
});

describe('pickMailboxList', () => {
  it('prefers a complete list over a stale placeholder — the restore-descriptor bug', () => {
    // Descriptor snapshotted the placeholder while the fetch was failing; the
    // cache has since been filled by the background prefetch.
    expect(pickMailboxList(placeholder, full)).toBe(full);
  });

  it('keeps the descriptor list when it is the complete one', () => {
    expect(pickMailboxList(full, placeholder)).toBe(full);
  });

  it('falls back to any non-empty list when none is complete', () => {
    expect(pickMailboxList(null, placeholder)).toBe(placeholder);
  });

  it('ends at the INBOX placeholder when there is nothing at all', () => {
    expect(pickMailboxList(null, undefined, [])).toEqual(INBOX_PLACEHOLDER);
  });
});

describe('retryOnce', () => {
  it('retries a failed fetch once and returns the second result', async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new Error('Password missing'))
      .mockResolvedValueOnce(full);

    await expect(retryOnce(fetchFn, { delayMs: 0 })).resolves.toBe(full);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a call that succeeded', async () => {
    const fetchFn = vi.fn().mockResolvedValue(full);

    await expect(retryOnce(fetchFn, { delayMs: 0 })).resolves.toBe(full);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rethrows when the retry fails too', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('still down'));

    await expect(retryOnce(fetchFn, { delayMs: 0 })).rejects.toThrow('still down');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('skips the retry when the activation was aborted meanwhile', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('Password missing'));

    await expect(retryOnce(fetchFn, { delayMs: 0, isAborted: () => true })).resolves.toBe(null);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
