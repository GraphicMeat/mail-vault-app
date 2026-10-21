import { describe, it, expect, vi } from 'vitest';

// A search hit names its account by id only; the row's account badge reads the
// address. `finalize` is the one place every hit passes through.
const harness = vi.hoisted(() => ({ accounts: [{ id: 'a1', email: 'work@example.com' }, { id: 'a2', email: 'home@example.com' }] }));
vi.mock('../mailStore', () => ({ useMailStore: { getState: () => ({ accounts: harness.accounts }) } }));
vi.mock('../settingsStore', () => ({ useSettingsStore: { getState: () => ({}) } }));
vi.mock('../../components/email/MessageStateIcon', () => ({ isBackedUp: () => false }));
vi.mock('../../services/rowVerdicts', () => ({ annotateRowAlerts: rows => rows }));

const { finalize } = await import('../searchRows.js');

const hit = (uid, extra = {}) => ({ uid, _mailbox: 'INBOX', source: 'server-search', date: `2026-08-0${uid}T10:00:00Z`, messageId: `<${uid}@x>`, ...extra });

describe('finalize account stamping', () => {
  it('gives every hit the address of the account it names', () => {
    const rows = finalize([hit(1, { _accountId: 'a1' }), hit(2, { _accountId: 'a2' }), hit(3, { _srcAccountId: 'a1' })]);
    expect(Object.fromEntries(rows.map(r => [r.uid, r._accountEmail]))).toEqual({
      1: 'work@example.com', 2: 'home@example.com', 3: 'work@example.com',
    });
  });

  it('keeps an address a row already carries, and leaves an unknown account unstamped', () => {
    const rows = finalize([hit(1, { _accountId: 'a1', _accountEmail: 'kept@example.com' }), hit(2, { _accountId: 'gone' })]);
    expect(rows.find(r => r.uid === 1)._accountEmail).toBe('kept@example.com');
    expect(rows.find(r => r.uid === 2)._accountEmail).toBeUndefined();
  });

  it('stamps in place, so a re-run row keeps its identity', () => {
    const row = hit(1, { _accountId: 'a1' });
    expect(finalize([row])[0]).toBe(row);
  });
});
