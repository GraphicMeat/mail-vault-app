// @vitest-environment jsdom
// Change server on a JMAP account: the session URL and the secret, never the
// IMAP/SMTP hosts. Discovery runs again, and a session host off the address's
// domain waits for the user's tick before anything is verified.
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { resolveEmailSettings, changeServer } = vi.hoisted(() => ({
  resolveEmailSettings: vi.fn(),
  changeServer: vi.fn(),
}));
vi.mock('../../services/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveEmailSettings: (...a) => resolveEmailSettings(...a),
  dnsMailHealth: vi.fn(async () => ({ warnings: [] })),
}));
vi.mock('../../services/restoreDetection.js', () => ({ gatherLocalFolders: vi.fn(async () => []) }));

import ChangeServerModal from '../ChangeServerModal';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { t } from '../../i18n';

const JMAP = {
  id: 'jm', email: 'me@example.org', authType: 'password', password: 'tok', imapHost: 'mail.example.org',
  jmapSessionUrl: 'https://mail.example.org/jmap/session', jmapAuth: 'bearer',
};
const verify = () => screen.getByRole('button', { name: t('changeServer.verifySave') });

beforeEach(() => {
  resolveEmailSettings.mockReset();
  changeServer.mockReset().mockResolvedValue({ ok: true, hostChanged: true });
  useMailStore.setState({ accounts: [JMAP], changeServer });
  useSettingsStore.setState({ changeServerAccountId: 'jm', activeRestore: null });
});
afterEach(() => { cleanup(); useSettingsStore.setState({ changeServerAccountId: null }); });

it('shows the session URL and the token, never the IMAP or SMTP host', async () => {
  resolveEmailSettings.mockResolvedValue({ source: 'mx', imapHost: 'imap.example.org', smtpHost: 'smtp.example.org' });
  render(<ChangeServerModal />);
  await act(async () => {});

  expect(screen.queryByLabelText(t('changeServer.imapHost'))).toBeNull();
  expect(screen.queryByLabelText(t('changeServer.smtpHost'))).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: t('account.jmapAdvanced') }));
  expect(screen.getByLabelText(t('account.jmapSessionUrl')).value).toBe(JMAP.jmapSessionUrl);

  fireEvent.change(screen.getByLabelText(t('account.jmapApiToken')), { target: { value: 'new-tok' } });
  fireEvent.click(verify());
  await waitFor(() => expect(changeServer).toHaveBeenCalledTimes(1));
  expect(changeServer).toHaveBeenCalledWith('jm', { jmapSessionUrl: JMAP.jmapSessionUrl, jmapUsername: '', password: 'new-tok' });
});

it('a rediscovered session off the address\'s domain waits for the tick', async () => {
  resolveEmailSettings.mockResolvedValue({
    source: 'jmap', jmapSessionUrl: 'https://jmap.hoster.net/jmap/session', jmapHost: 'jmap.hoster.net',
    jmapNeedsHostConfirmation: true, jmapSource: 'srv',
  });
  render(<ChangeServerModal />);
  await waitFor(() => expect(resolveEmailSettings).toHaveBeenCalledWith('example.org'));
  await act(async () => {});

  fireEvent.change(screen.getByLabelText(t('account.jmapApiToken')), { target: { value: 'new-tok' } });
  const confirm = screen.getByRole('checkbox', { name: /Sign in at jmap\.hoster\.net\?/ });
  expect(verify().disabled).toBe(true);
  fireEvent.click(confirm);
  expect(verify().disabled).toBe(false);
  fireEvent.click(verify());
  await waitFor(() => expect(changeServer).toHaveBeenCalledTimes(1));
  expect(changeServer.mock.calls[0][1]).toMatchObject({ jmapSessionUrl: 'https://jmap.hoster.net/jmap/session' });
});

it('the handler itself refuses an unconfirmed foreign host, not only the disabled button', async () => {
  resolveEmailSettings.mockResolvedValue({
    source: 'jmap', jmapSessionUrl: 'https://jmap.hoster.net/jmap/session', jmapHost: 'jmap.hoster.net',
    jmapNeedsHostConfirmation: true, jmapSource: 'srv',
  });
  render(<ChangeServerModal />);
  await waitFor(() => expect(resolveEmailSettings).toHaveBeenCalledWith('example.org'));
  await act(async () => {});

  fireEvent.change(screen.getByLabelText(t('account.jmapApiToken')), { target: { value: 'new-tok' } });
  expect(verify().disabled).toBe(true);

  // React drops clicks on a disabled button, so reach the handler directly.
  const btn = verify();
  const propsKey = Object.keys(btn).find((k) => k.startsWith('__reactProps'));
  await act(async () => { await btn[propsKey].onClick(); });
  expect(changeServer).not.toHaveBeenCalled();
});
