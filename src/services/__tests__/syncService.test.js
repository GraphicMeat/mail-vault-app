import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDaemonCall = vi.fn().mockResolvedValue({});
vi.mock('../daemonClient.js', () => ({ daemonCall: (...a) => mockDaemonCall(...a) }));
vi.mock('../../stores/settingsStore.js', () => ({
  useSettingsStore: { getState: () => ({ billingProfile: null }) },
  hasPremiumAccess: () => true,
}));

const { syncNow, waitForSync } = await import('../syncService.js');

describe('syncService', () => {
  beforeEach(() => {
    mockDaemonCall.mockReset();
    mockDaemonCall.mockResolvedValue({});
  });

  it('hands back the ticket sync.now issued', async () => {
    mockDaemonCall.mockResolvedValue({ started: true, accountId: 'acc-1', mailbox: 'INBOX', ticket: 7 });

    const result = await syncNow({ id: 'acc-1' }, 'INBOX');

    expect(mockDaemonCall).toHaveBeenCalledWith('sync.now', {
      account: { id: 'acc-1' }, mailbox: 'INBOX', autoClassify: true,
    });
    expect(result.ticket).toBe(7);
  });

  it('waits on the ticket, not on the account', async () => {
    await waitForSync(7, 5000);

    expect(mockDaemonCall).toHaveBeenCalledWith('sync.wait', { ticket: 7, timeoutMs: 5000 });
  });

  // A caller that forgot the ticket used to wait on an accountId and get the
  // previous sync's result. Failing loudly beats answering with stale data.
  it('refuses to wait without a ticket', async () => {
    await expect(waitForSync(undefined)).rejects.toThrow(/ticket/);
    expect(mockDaemonCall).not.toHaveBeenCalled();
  });
});
