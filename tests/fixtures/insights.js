export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';

export function copy(overrides = {}) {
  return {
    accountId: A, mailbox: 'INBOX', uid: 1, uidValidity: 4,
    source: 'server-cache', origin: null, messageId: '<ana-1@test>',
    from: { address: 'ana@example.test', name: 'Ana' },
    to: [{ address: 'me@example.test', name: '' }], cc: [], bcc: [],
    subject: 'Project dates', messageDate: '2026-09-08T20:00:00Z',
    receivedAt: '2026-09-08T21:30:00Z', sentAt: null,
    dateEvidence: { received: 'imap-internaldate', sent: 'unknown' },
    flags: [], specialUse: '\\Inbox', listId: null,
    listUnsubscribe: null, precedence: null,
    serverDeleted: false, serverAbsent: false,
    ...overrides,
  };
}

export const COUNT_FIXTURE = [
  copy(),
  copy({ source: 'vault', origin: 'local' }),
  copy({ uid: 2, messageId: '<ana-2@test>', subject: 'Second project date' }),
  copy({ uid: 3, messageId: '<ben-1@test>', from: { address: 'ben@example.test', name: 'Ben' } }),
  copy({ uid: 1, mailbox: 'Sent', specialUse: '\\Sent', messageId: '<sent-1@test>',
    from: { address: 'me@example.test', name: 'Me' },
    to: [{ address: 'ana@example.test' }, { address: 'ben@example.test' }],
    cc: [{ address: 'ana@example.test' }],
    receivedAt: null, sentAt: '2026-09-08T21:40:00Z',
    dateEvidence: { received: 'unknown', sent: 'rfc-date' } }),
  copy({ uid: 1, mailbox: 'Drafts', specialUse: '\\Drafts',
    messageId: '<draft-1@test>', origin: 'local_draft', flags: ['draft'] }),
  copy({ accountId: B, uid: 1, messageId: '<account-b-1@test>',
    from: { address: 'other@example.test', name: 'Other' } }),
];
