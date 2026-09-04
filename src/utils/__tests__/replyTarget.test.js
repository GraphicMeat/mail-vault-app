import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveMessageBody = vi.fn();
vi.mock('../../services/export/bodyResolver', () => ({
  resolveMessageBody: (...args) => resolveMessageBody(...args),
}));

import { replyTarget } from '../replyTarget';

// What a reply quotes: the loaded copy when the caller has it, else the header
// merged with what the resolver finds, else the header alone — never a refusal.
describe('replyTarget', () => {
  const header = { uid: 7, subject: 'Hi', from: { address: 'ann@example.com' }, _accountId: 'acct-1' };
  const store = { activeAccountId: 'acct-1' };

  beforeEach(() => { resolveMessageBody.mockClear(); resolveMessageBody.mockResolvedValue({ ok: false }); });

  it('hands back the loaded copy untouched and asks the resolver nothing', async () => {
    const loaded = { ...header, html: '<p>loaded</p>' };
    expect(await replyTarget(header, loaded, store)).toBe(loaded);
    expect(resolveMessageBody).not.toHaveBeenCalled();
  });

  it('merges the resolved body over the header when nothing is loaded yet', async () => {
    resolveMessageBody.mockResolvedValue({ ok: true, email: { html: '<p>fetched</p>' } });
    const target = await replyTarget(header, null, store);
    expect(resolveMessageBody).toHaveBeenCalledWith(header, store);
    expect(target).toEqual({ ...header, html: '<p>fetched</p>' });
  });

  it('keeps the header where the resolved copy is silent', async () => {
    resolveMessageBody.mockResolvedValue({ ok: true, email: { html: '<p>x</p>' } });
    expect((await replyTarget(header, null, store))._accountId).toBe('acct-1');
  });

  it('hands the header back when the resolver answers no', async () => {
    expect(await replyTarget(header, null, store)).toBe(header);
  });

  it('hands the header back when the resolver throws', async () => {
    resolveMessageBody.mockRejectedValue(new Error('offline'));
    expect(await replyTarget(header, null, store)).toBe(header);
  });
});
