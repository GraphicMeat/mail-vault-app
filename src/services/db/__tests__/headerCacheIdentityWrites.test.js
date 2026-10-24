import { it, expect, vi, beforeEach } from 'vitest';
const m = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../transport.js', () => ({ send: (...args) => m.send(...args) }));
import { saveEmailHeaders } from '../caches.js';
const identity = {
  accountId: 'a',
  mailbox: 'INBOX',
  uidValidity: 1,
  originHash: 'original-A',
};
beforeEach(() => {
  m.send
    .mockReset()
    .mockImplementation(async (command) =>
      command === 'load_email_cache_meta' ? { nativeIdentity: identity } : null
    );
});
const saved = () =>
  JSON.parse(
    m.send.mock.calls.find(([command]) => command === 'save_email_cache')[1]
      .data
  );
it('omits an identity invalidation on an empty prune instead of clearing untouched native originals', async () => {
  await saveEmailHeaders('a', 'INBOX', [], 2, { removedUids: [3] });
  const payload = saved();
  expect(Object.hasOwn(payload, 'nativeIdentity')).toBe(false);
  expect(Object.hasOwn(payload, 'nativeExpectedIdentity')).toBe(false);
  expect(payload).toMatchObject({
    emails: [],
    totalEmails: 2,
    removedUids: [3],
  });
});
it('still explicitly invalidates when nonempty rows have no original native proof', async () => {
  await saveEmailHeaders('a', 'INBOX', [{ uid: 4 }], 3);
  expect(saved().nativeIdentity).toBeNull();
});
it('keeps the exact original owner and explicit expected-owner CAS value on proved row publication', async () => {
  await saveEmailHeaders(
    'a',
    'INBOX',
    [{ uid: 1, _nativeIdentity: identity, _nativeExpectedIdentity: null }],
    2
  );
  expect(saved().nativeIdentity).toEqual(identity);
  expect(saved().nativeExpectedIdentity).toBeNull();
});
it('does not turn a missing publication expectation into observed absence', async () => {
  await saveEmailHeaders(
    'a',
    'INBOX',
    [{ uid: 1, _nativeIdentity: identity }],
    2
  );
  expect(saved().nativeIdentity).toEqual(identity);
  expect(Object.hasOwn(saved(), 'nativeExpectedIdentity')).toBe(false);
});
