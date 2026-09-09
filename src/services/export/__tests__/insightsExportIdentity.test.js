// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ local: vi.fn(), remote: vi.fn() }));
vi.mock('../../db', () => ({ getLocalEmailLight: (...args) => h.local(...args) }));
vi.mock('../../api', () => ({ fetchEmailLight: (...args) => h.remote(...args), graphCacheMime: vi.fn() }));
vi.mock('../../authUtils', () => ({ ensureFreshToken: async account => account }));
vi.mock('../../attachmentUtils', () => ({
  hydrateInlineImages: async email => email, replaceCidUrls: html => html, getRealAttachments: () => [],
}));
vi.mock('../../../stores/settingsStore', () => ({
  hasPremiumAccess: () => true, useSettingsStore: { getState: () => ({ billingProfile: {} }) },
}));
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: { getState: () => ({ accounts: [{ id: 'account-b' }], activeAccountId: 'other', activeMailbox: 'INBOX' }) },
  getGraphMessageId: () => null, graphMessageToEmail: message => message,
}));

const { buildExport } = await import('../exportService');
const message = { uid: 7, _accountId: 'account-b', _mailbox: 'Archive/2026', _insightsReadOnly: true,
  messageId: '<copied@test>', from: { address: 'ana@example.test' }, subject: 'Correct message',
  date: '2026-09-08T10:00:00Z', messageDate: '2026-09-08T10:00:00Z', text: 'Verified reader body', attachments: [] };
const options = { account: 'me@example.test', mailbox: 'Archive/2026', mirror: false, format: 'html', layout: 'separate' };
const decode = file => new TextDecoder().decode(Uint8Array.from(atob(file.base64), character => character.charCodeAt(0)));
beforeEach(() => { h.local.mockReset(); h.remote.mockReset(); });

it('exports the matching plain-text Insights message when the local copy has a conflicting shared ID', async () => {
  h.local.mockResolvedValue({ ...message, from: { address: 'other@example.test' }, subject: 'Wrong message', text: 'WRONG VAULT BODY' });
  h.remote.mockResolvedValue({ ...message, text: 'CORRECT SERVER BODY' });
  const out = await buildExport({ ...options, messages: [message] });
  expect(out.ok).toBe(true);
  const html = decode(out.files[0]);
  expect(html).not.toContain('WRONG VAULT BODY');
  expect(html).toContain('CORRECT SERVER BODY');
});

it('reports failure when an Insights export server answer conflicts despite a shared Message-ID', async () => {
  h.local.mockResolvedValue(null);
  h.remote.mockResolvedValue({ ...message, subject: 'Another message', text: 'WRONG SERVER BODY' });
  const out = await buildExport({ ...options, messages: [message] });
  expect(out.ok).toBe(false);
  expect(out.files || []).toHaveLength(0);
  expect(out.failures).toHaveLength(1);
});
