// @vitest-environment jsdom
// Fix wave, small pieces: the drawer's account folders after a collapse mid-read, the billing plan
// line shows a date (no time, as desktop), and a dead catalog key is gone from every catalog.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pending = vi.hoisted(() => ({ calls: [] }));
vi.mock('../transport.js', () => ({
  daemonCall: vi.fn((method, params) => new Promise((resolve) => { pending.calls.push({ method, params, resolve }); })),
  listen: vi.fn(() => () => {}),
}));

const { useAccountFolders } = await import('../drawer/useAccountFolders.js');
const { premiumSummary } = await import('../premium.js');
const { formatDateOnly } = await import('../format.js');

afterEach(() => { cleanup(); pending.calls = []; });

describe('useAccountFolders', () => {
  it('a collapse before the list answers does not leave it loading forever', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useAccountFolders('a1', enabled), { initialProps: { enabled: true } });
    expect(result.current.status).toBe('loading');
    rerender({ enabled: false });
    expect(result.current.status).toBe('idle');
    // The late answer of the first read is ignored.
    await act(async () => { pending.calls[0].resolve({ folders: [{ path: 'STALE' }] }); });
    expect(result.current.status).toBe('idle');
    // Opened again: it asks again, and shows what that read says.
    rerender({ enabled: true });
    expect(pending.calls).toHaveLength(2);
    await act(async () => { pending.calls[1].resolve({ folders: [{ path: 'INBOX' }] }); });
    expect(result.current).toEqual({ status: 'ready', folders: [{ path: 'INBOX' }] });
  });

  it('a read that answered is kept across a collapse', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useAccountFolders('a1', enabled), { initialProps: { enabled: true } });
    await act(async () => { pending.calls[0].resolve({ folders: [{ path: 'INBOX' }] }); });
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(pending.calls).toHaveLength(1);
    expect(result.current.status).toBe('ready');
  });
});

describe('the billing plan line', () => {
  it('shows the day the plan runs until, with no time of day', () => {
    const expiresMs = Date.UTC(2027, 5, 15, 2, 39);
    const line = premiumSummary({ premium: true, source: 'apple', expiresMs });
    expect(line).toContain(formatDateOnly(expiresMs, null, { alwaysShowYear: true }));
    expect(line).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('keeps the year when the plan runs until a day of this year, as desktop does', () => {
    const soon = new Date();
    soon.setMonth(soon.getMonth() + 1, 15);
    soon.setHours(12, 0, 0, 0);
    const line = premiumSummary({ premium: true, source: 'google', expiresMs: soon.getTime() });
    expect(line).toContain(String(soon.getFullYear()));
  });
});

describe('catalogs', () => {
  it('no locale carries the unused Sign in again key', () => {
    const dir = `${resolve('src/i18n/locales')}/`;
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of files) {
      expect(readFileSync(dir + f, 'utf8'), f).not.toContain('mobile.premium.signInAgain');
    }
  });
});
