import { beforeEach, expect, it, vi } from 'vitest';

const native = vi.fn();
vi.mock('../../transport.js', () => ({ send: (...args) => native(...args) }));
vi.mock('../accounts.js', () => ({ initDB: async () => {}, initBasic: async () => {}, accountDir: () => '' }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readDir: vi.fn(), exists: vi.fn(), BaseDirectory: {} }));
const { getVerifiedRawSource } = await import('../emails.js');
const accountId = '00000000-0000-4000-8000-000000000002';
const header = { uid: 7, _accountId: accountId, _mailbox: 'Archive/2026', _insightsReadOnly: true,
  messageId: '<shared@test>', from: { address: 'ana@example.test' }, subject: 'Original', messageDate: '2026-09-08T10:00:00Z' };
const raw = Buffer.from('From: Ana <ana@example.test>\r\nSubject: Original\r\nDate: Tue, 08 Sep 2026 10:00:00 +0000\r\nMessage-ID: <shared@test>\r\n\r\nCorrect raw body').toString('base64');
let stored;
beforeEach(() => {
  stored = { ...header, date: header.messageDate };
  native.mockReset().mockImplementation(async command => command === 'maildir_read_light' ? stored : raw);
});

for (const [name, change] of [
  ['sender', { from: { address: 'bob@example.test' } }],
  ['subject', { subject: 'Different' }],
  ['original date', { messageDate: '2026-09-09T10:00:00Z', date: '2026-09-09T10:00:00Z' }],
]) {
  it(`refuses Insights raw source with the same Message-ID but a conflicting ${name}`, async () => {
    stored = { ...stored, ...change };
    const result = await getVerifiedRawSource(accountId, header._mailbox, 7, header);
    expect(result.b64).toBeNull();
    expect(result.error).toBeTruthy();
  });
}
it('returns verified original bytes for a compatible Insights source', async () => {
  expect(await getVerifiedRawSource(accountId, header._mailbox, 7, header)).toEqual({ b64: raw, error: null });
});
