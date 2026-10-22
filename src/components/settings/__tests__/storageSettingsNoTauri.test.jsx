// @vitest-environment jsdom
/**
 * Storage settings follows the daemon's cleanup runs through Tauri events.
 * Without a Tauri runtime (vitest, the browser dev server, the demo) every
 * `listen()` rejects, or throws, and an unhandled rejection fails the whole
 * vitest run and CI. Mounting the page with no runtime must leave none.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const mode = vi.hoisted(() => ({ value: 'reject' }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => {
    // The real listen() reads window.__TAURI_INTERNALS__ and fails without it.
    if (mode.value === 'throw') throw new TypeError("Cannot read properties of undefined (reading 'transformCallback')");
    return Promise.reject(new TypeError("Cannot read properties of undefined (reading 'transformCallback')"));
  }),
}));
vi.mock('../../../services/db', () => ({
  getStorageUsage: async () => null, getVaultOrphanStats: async () => null,
  getCachedMailboxes: async () => [], saveAccount: async () => {}, readOps: async () => [], opFailures: () => [],
}));

const { StorageSettings } = await import('../StorageSettings');
const { useSettingsStore } = await import('../../../stores/settingsStore');

let unhandled = [];
const onUnhandled = (reason) => { unhandled.push(String(reason?.message || reason)); };

beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  useSettingsStore.setState({ billingProfile: { hasSubscription: true, status: 'active', premiumAccess: true }, cleanupRules: [] });
});

afterEach(() => {
  cleanup();
  process.off('unhandledRejection', onUnhandled);
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

describe('Storage settings with no Tauri runtime', () => {
  it.each(['reject', 'throw'])('leaves no unhandled rejection when listen() %ss', async (how) => {
    mode.value = how;
    render(<StorageSettings accounts={[]} />);
    await settle();
    expect(unhandled).toEqual([]);
  });
});
