// @vitest-environment node
// A refused Graph <-> IMAP switch tells the user why: the daemon's catalog
// key reaches Settings instead of the generic "account change could not be
// completed".
import { it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ switchError: null }));
vi.mock('../../transport.js', () => ({
  send: vi.fn(async (cmd) => {
    if (cmd === 'accounts_switch_transport') throw new Error(h.switchError);
    return cmd === 'get_app_data_dir' ? '/data' : {};
  }),
}));
vi.mock('../../graphConfig.js', () => ({ isPersonalMicrosoftEmail: () => true }));
vi.mock('../../../i18n/index.js', () => ({ t: (k) => k }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: vi.fn(async () => true), mkdir: vi.fn(async () => {}) }));
globalThis.window = { __TAURI__: { event: { listen: () => Promise.resolve(() => {}) } } };

const { switchAccountTransport } = await import('../accounts.js');

it.each([
  'errors.transportSwitchImapRefused',
  'errors.bulkIdentityChanged',
  'errors.transportSwitchPending',
])('a switch refused with %s keeps that reason', async (key) => {
  h.switchError = key;
  await expect(switchAccountTransport('m1', 'imap', {})).rejects.toThrow(key);
});

it('an unknown failure stays the generic write failure', async () => {
  h.switchError = 'something internal';
  await expect(switchAccountTransport('m1', 'imap', {})).rejects.toThrow('errors.accountsWriteFailed');
});
