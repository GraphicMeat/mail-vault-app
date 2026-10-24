import { describe, it, expect, vi, beforeEach } from 'vitest';
const send = vi.hoisted(() => vi.fn());
vi.mock('../transport.js', () => ({ send }));
const db = await import('../db/caches.js');
const proof = { accountId: 'a', mailbox: 'INBOX', uidValidity: 7, originHash: 'origin-A' };
beforeEach(() => send.mockReset());
describe('original native cache batches', () => {
  it.each(['getEmailHeaders', 'getEmailHeadersPartial'])('binds %s rows only to the returned native batch', async (method) => {
    send.mockResolvedValue({ emails: [{ uid: 7, _jmapId: 'provider-original' }], uidValidity: 99, nativeIdentity: proof });
    const batch = await db[method]('a', 'INBOX');
    expect(batch.nativeIdentity).toEqual(proof);
    expect(batch.emails[0]._nativeIdentity).toEqual(proof);
    expect(batch.emails[0]._nativeIdentity.uidValidity).toBe(7);
    expect(batch.emails[0]._jmapId).toBe('provider-original');
    expect(Object.isFrozen(batch.emails[0]._nativeIdentity)).toBe(true);
  });
  it('keeps legacy cache visible without attaching current metadata', async () => {
    send.mockResolvedValue({ emails: [{ uid: 7 }], uidValidity: 7 });
    const batch = await db.getEmailHeaders('a', 'INBOX');
    expect(batch.emails).toEqual([{ uid: 7 }]);
    expect(batch.nativeIdentity ?? null).toBeNull();
  });
  it('does not relabel an older retained row in a fresh batch', async () => {
    const older = { ...proof, uidValidity: 6 };
    send.mockResolvedValue({ emails: [{ uid: 7, _nativeIdentity: older }, { uid: 8 }], nativeIdentity: proof });
    const batch = await db.getEmailHeaders('a', 'INBOX');
    expect(batch.emails[0]._nativeIdentity).toEqual(older);
    expect(batch.emails[1]._nativeIdentity).toEqual(proof);
  });
  it('uses the additive by-UID envelope and preserves the old array return', async () => {
    send.mockResolvedValue({ emails: [{ uid: 7 }], nativeIdentity: proof });
    const rows = await db.getEmailHeadersByUids('a', 'INBOX', [7]);
    expect(send).toHaveBeenCalledWith('load_email_cache_by_uids', { accountId: 'a', mailbox: 'INBOX', uids: [7], envelope: true });
    expect(rows).toEqual([{ uid: 7, _nativeIdentity: proof }]);
  });
});
