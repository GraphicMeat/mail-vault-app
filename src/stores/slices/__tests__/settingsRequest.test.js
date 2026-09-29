// @vitest-environment jsdom
// A leaf asking App for a Settings page: compose's "Add address..." also names
// the account and the section (Accounts > Aliases); every other caller names
// only the tab, and its request keeps the shape it always had.
import { expect, it, vi } from 'vitest';

vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));

const { useMailStore } = await import('../../mailStore');

it('carries only the tab when that is all a caller names', () => {
  useMailStore.getState().requestSettingsTab('tracking');
  expect(Object.keys(useMailStore.getState().settingsRequest).sort()).toEqual(['at', 'tab']);
  expect(useMailStore.getState().settingsRequest.tab).toBe('tracking');
  useMailStore.getState().clearSettingsRequest();
});

it('carries the account and section a request names', () => {
  useMailStore.getState().requestSettingsTab('accounts', { accountId: 'studio', section: 'aliases' });
  expect(useMailStore.getState().settingsRequest).toMatchObject({ tab: 'accounts', accountId: 'studio', section: 'aliases' });
  useMailStore.getState().clearSettingsRequest();
  expect(useMailStore.getState().settingsRequest).toBeNull();
});
