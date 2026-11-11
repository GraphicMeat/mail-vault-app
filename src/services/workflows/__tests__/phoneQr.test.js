import { it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ status: 'granted', accounts: [] }));
const mockDaemonCall = vi.fn(async () => ({ frames: ['<svg/>'], count: 1, skipped: [] }));
vi.mock('../../daemonClient', () => ({ daemonCall: (...a) => mockDaemonCall(...a) }));
vi.mock('../../db', () => ({
  getAccounts: vi.fn(async () => h.accounts),
  saveAccounts: vi.fn(),
  accountLogicalKey: () => '',
}));
vi.mock('../../keychainSession', () => ({ getStatus: () => h.status, E_KEYCHAIN_UNAVAILABLE: 'E_KEYCHAIN_UNAVAILABLE' }));
vi.mock('../../transfer/settingsTransfer', () => ({ collectSettings: vi.fn(), applySettings: vi.fn() }));

const { phoneQr } = await import('../transferAccounts');

beforeEach(() => {
  mockDaemonCall.mockClear();
  h.status = 'granted';
  h.accounts = [{ id: 'a', email: 'a@x.test', imapHost: 'imap.x.test', password: 'pw' }];
});

it('hands every account and the password to transfer.phone_qr and returns its reply', async () => {
  const out = await phoneQr({ password: 'correct horse battery' });
  expect(mockDaemonCall).toHaveBeenCalledWith('transfer.phone_qr', { password: 'correct horse battery', accounts: h.accounts });
  expect(out).toEqual({ frames: ['<svg/>'], count: 1, skipped: [] });
});

it('reads an empty keychain as fine', async () => {
  h.status = 'empty';
  await expect(phoneQr({ password: 'correct horse battery' })).resolves.toBeTruthy();
});

it('refuses before the daemon when the keychain could not be read', async () => {
  h.status = 'denied';
  await expect(phoneQr({ password: 'correct horse battery' })).rejects.toThrow('E_KEYCHAIN_UNAVAILABLE');
  expect(mockDaemonCall).not.toHaveBeenCalled();
});

it('never logs the password or an account', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await phoneQr({ password: 'correct horse battery' });
  const printed = JSON.stringify(log.mock.calls);
  expect(printed).not.toContain('correct horse');
  expect(printed).not.toContain('a@x.test');
  log.mockRestore();
});
