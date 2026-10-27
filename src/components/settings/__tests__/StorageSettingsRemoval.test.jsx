// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(), errors: [] }));
vi.mock('../../../services/db.js', () => ({
  getStorageUsage: async () => null, getVaultOrphanStats: async () => null,
  getCachedMailboxes: async () => [], saveAccount: async () => {}, readOps: async () => [], opFailures: () => [],
  getAccountsWithoutPasswords: (...args) => data.list(...args),
  listAccountsForRemoval: (...args) => data.list(...args),
  deleteAccount: (...args) => data.remove(...args),
}));
vi.mock('../../../services/db/index.js', () => ({
  getStorageUsage: async () => null, getVaultOrphanStats: async () => null,
  getCachedMailboxes: async () => [], saveAccount: async () => {}, readOps: async () => [], opFailures: () => [],
  getAccountsWithoutPasswords: (...args) => data.list(...args),
  listAccountsForRemoval: (...args) => data.list(...args),
  deleteAccount: (...args) => data.remove(...args),
}));
vi.mock('../../../services/cleanupApi', () => ({
  cleanupStatus: async () => null, cleanupRules: async () => ({ rules: [] }),
  onCleanupRun: async () => () => {}, runCleanupNow: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('../../../hooks/usePremiumPricing.js', () => ({ usePremiumPriceBlurb: () => '' }));

const { StorageSettings } = await import('../StorageSettings');
const { useSettingsStore } = await import('../../../stores/settingsStore');

beforeEach(() => {
  vi.clearAllMocks();
  data.errors = [];
  data.list.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
  data.remove.mockImplementation(async id => ({ outcome: 'complete', accountId: id }));
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {} })));
  useSettingsStore.setState({ billingProfile: { hasSubscription: true, status: 'active', premiumAccess: true }, cleanupRules: [] });
  localStorage.setItem('s24-preserve', 'yes');
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    data.errors.push(args.map(value => value?.message || String(value)).join(' '));
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function confirmClear() {
  render(<StorageSettings accounts={[]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Empty the vault' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Empty the vault' }));
  try {
    await waitFor(() => expect(data.list).toHaveBeenCalledTimes(1));
  } catch {
    throw new Error(`S24_STORAGE_FIXTURE: listCalls=${data.list.mock.calls.length}, caught=${data.errors.join(' | ')}`);
  }
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

it('failed authoritative listing starts no deletion and keeps local settings', async () => {
  data.list.mockRejectedValue(new Error('synthetic authoritative list failure'));
  await confirmClear();
  const retained = localStorage.getItem('s24-preserve');
  if (retained !== 'yes' || data.remove.mock.calls.length) {
    throw new Error(`S24_CLEARALL_LIST_ACTUAL: retained=${retained}, deleteCalls=${data.remove.mock.calls.length}`);
  }
  expect(within(screen.getByRole('alertdialog')).getByRole('alert')).toBeTruthy();
});

it('a native Busy result stops clear-all before settings are erased', async () => {
  data.remove.mockResolvedValue({ outcome: 'busy', accountId: 'a', effects: 'none' });
  await confirmClear();
  const retained = localStorage.getItem('s24-preserve');
  if (retained !== 'yes' || data.remove.mock.calls.length !== 1) {
    throw new Error(`S24_CLEARALL_BUSY_ACTUAL: retained=${retained}, deleteCalls=${data.remove.mock.calls.length}`);
  }
  expect(within(screen.getByRole('alertdialog')).getByRole('alert')).toBeTruthy();
});

it('a malformed or unknown listing never starts account deletion', async () => {
  data.list.mockResolvedValue([{ id: 'a' }, { id: 'a' }]);
  await confirmClear();
  expect(data.remove).not.toHaveBeenCalled();
  expect(localStorage.getItem('s24-preserve')).toBe('yes');
  expect(within(screen.getByRole('alertdialog')).getByRole('alert')).toBeTruthy();
});

it('iterates every authoritative ID even when two accounts share a logical identity', async () => {
  data.list.mockResolvedValue([{ id: 'a', email: 'same@example.test' },
    { id: 'b', email: 'same@example.test' }]);
  await confirmClear();
  expect(data.remove.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  expect(localStorage.getItem('s24-preserve')).toBeNull();
});

it('an authoritative empty listing may clear local settings without account deletion', async () => {
  data.list.mockResolvedValue([]);
  await confirmClear();
  expect(data.remove).not.toHaveBeenCalled();
  expect(localStorage.getItem('s24-preserve')).toBeNull();
});
