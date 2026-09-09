import { expect, it, vi } from 'vitest';
// indexEntryFor is a pure export; the workflow module's state dependencies are
// intentionally inert because this test exercises serialization only.
vi.mock('../../db', () => ({}));
vi.mock('../../api', () => ({}));
vi.mock('../../../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({}) } }));
vi.mock('../../../stores/connectivityStore', () => ({ useConnectivityStore: { getState: () => ({ online: false }) } }));
vi.mock('../../authUtils', () => ({}));
vi.mock('../../cacheManager', () => ({}));
import { indexEntryFor } from '../messageMutations.js';
it('retains original, received, sent and automation evidence when saving a vault index header', () => {
  const entry = indexEntryFor({ uid: 17, provider: 'graph', date: '2026-09-09T00:30:00Z', messageDate: '2026-09-08T23:00:00Z', receivedAt: '2026-09-09T00:30:00Z', sentAt: '2026-09-08T23:30:00Z', cc: [{ address: 'cc@test' }], bcc: [{ address: 'bcc@test' }], listId: '<list.test>', listUnsubscribe: '<https://list.test/unsub>', precedence: 'bulk' });
  expect(entry).toMatchObject({ provider: 'graph', date: '2026-09-09T00:30:00Z', messageDate: '2026-09-08T23:00:00Z', receivedAt: '2026-09-09T00:30:00Z', sentAt: '2026-09-08T23:30:00Z', cc: [{ address: 'cc@test' }], bcc: [{ address: 'bcc@test' }], listId: '<list.test>', listUnsubscribe: '<https://list.test/unsub>', precedence: 'bulk' });
});
