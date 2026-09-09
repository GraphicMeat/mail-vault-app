import { describe, it, expect } from 'vitest';
import { graphMessageToEmail } from '../graphConfig.js';

describe('Graph Insights date evidence', () => {
  it('keeps receive time, send time and the original RFC Date distinct', () => {
    const row = graphMessageToEmail({
      id: 'm1', receivedDateTime: '2026-09-09T00:30:00Z', sentDateTime: '2026-09-08T23:30:00Z',
      from: { emailAddress: { address: 'ana@example.test' } },
      bccRecipients: [{ emailAddress: { address: 'hidden@example.test', name: 'Hidden' } }],
      internetMessageHeaders: [{ name: 'date', value: 'Tue, 08 Sep 2026 23:00:00 +0000' }],
    }, 17);
    expect(row.date).toBe('2026-09-09T00:30:00Z');
    expect(row.source).toBe('server');
    expect(row.provider).toBe('graph');
    expect(row.receivedAt).toBe('2026-09-09T00:30:00Z');
    expect(row.sentAt).toBe('2026-09-08T23:30:00Z');
    expect(row.messageDate).toBe('Tue, 08 Sep 2026 23:00:00 +0000');
  });
  it('does not invent missing send or original timestamps', () => {
    const row = graphMessageToEmail({ receivedDateTime: '2026-09-09T00:30:00Z' }, 17);
    expect(row.sentAt).toBeNull();
    expect(row.messageDate).toBeNull();
  });
});

it('retains BCC correspondents in sent Graph messages', () => {
  const row = graphMessageToEmail({ bccRecipients: [{ emailAddress: { address: 'hidden@example.test', name: 'Hidden' } }] }, 17);
  expect(row.bcc).toEqual([{ address: 'hidden@example.test', name: 'Hidden' }]);
});
