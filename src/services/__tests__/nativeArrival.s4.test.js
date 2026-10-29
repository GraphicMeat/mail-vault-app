import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockNotify = vi.fn(async () => {});
const mockOffer = vi.fn();
vi.mock('../../i18n/index.js', () => ({ t: (key, data = {}) => ({
  'notify.arrival.unknownSender': 'Unknown sender',
  'common.noSubject': '(No subject)',
  'notify.arrival.newEmail': 'New Email',
  'notify.arrival.newEmails': `${data.count} New Emails`,
  'notify.arrival.batchPreviewBody': `${data.sender}: ${data.subject} (and ${data.more} more)`,
  'notify.arrival.singlePrivateBody': `New email in ${data.accountEmail}`,
  'notify.arrival.batchPrivateBody': `${data.count} new emails in ${data.accountEmail}`,
})[key] ?? key }));
vi.mock('../../stores/focusStore.js', () => ({ notify: (...args) => mockNotify(...args) }));
vi.mock('../../stores/codeBubbleStore.js', () => ({ useCodeBubbleStore: { getState: () => ({
  offer: (...args) => mockOffer(...args),
}) } }));

const { renderPreparedNotice, deliverPreparedNotice, offerPreparedCode } = await import('../nativeArrival.js');
const base = { id: 'native-1', accountId: 'a', mailbox: 'INBOX', fromAddress: 's@test',
  deliver: true, banner: true, reason: 'delivered-default', sound: 'Ping',
  presentation: { kind: 'singlePreview', key: 'notify.arrival.singlePreview',
    data: { count: 1, sender: 'Sender', subject: 'Subject', accountEmail: 'a@test' } },
  target: { accountId: 'a', mailbox: 'INBOX', uid: 5 } };

beforeEach(() => { mockNotify.mockClear(); mockOffer.mockClear(); });

describe('prepared arrival display', () => {
  it('uses native kind, target, sound and decision through the Focus chokepoint', async () => {
    await deliverPreparedNotice(base);
    expect(mockNotify).toHaveBeenCalledWith('Sender', 'Subject', 'Ping',
      { accountId: 'a', mailbox: 'INBOX', uid: 5 },
      { accountId: 'a', folder: 'INBOX', from: 's@test', viewIds: [] },
      { deliver: true, reason: 'delivered-default' });
  });

  it('keeps the private no-preview target at folder level', () => {
    expect(renderPreparedNotice({ ...base, presentation: {
      kind: 'singlePrivate', key: 'notify.arrival.singlePrivate',
      data: { count: 1, accountEmail: 'a@test' },
    }, target: { ...base.target, uid: null, code: null } })).toEqual({
      title: 'New Email', body: 'New email in a@test',
      target: { accountId: 'a', mailbox: 'INBOX' },
    });
  });

  it('does not turn late code into another banner or accept an invalid UID', async () => {
    expect(offerPreparedCode({ accountId: 'a', mailbox: 'INBOX', uid: 0, code: '123456' })).toBe(false);
    expect(offerPreparedCode({ accountId: 'a', mailbox: 'INBOX', uid: 5, code: '123456' })).toBe(true);
    expect(mockOffer).toHaveBeenCalledWith({ accountId: 'a', mailbox: 'INBOX', uid: 5,
      code: '123456', sender: '', subject: '' });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('logs a prepared muted decision without asking JS to decide policy', async () => {
    await deliverPreparedNotice({ ...base, banner: false, logPolicy: true,
      deliver: false, reason: 'account-muted' });
    expect(mockNotify.mock.calls[0].at(-1)).toEqual({ deliver: false, reason: 'account-muted' });
  });
});
