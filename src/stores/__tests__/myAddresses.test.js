import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../mailStore', () => ({
  useMailStore: { getState: () => ({ accounts: [{ id: 'a', email: 'me@h.io' }, { id: 'b', email: 'work@w.io' }] }) },
}));

const { myAddresses } = await import('../myAddresses');
const { useSettingsStore } = await import('../settingsStore');

beforeEach(() => useSettingsStore.setState({ aliases: {}, sendAsAddresses: {} }));

describe('myAddresses', () => {
  it('lists every own address across accounts, aliases included, once', () => {
    useSettingsStore.setState({ aliases: { a: [{ address: 'alias@h.io' }] } });
    const all = myAddresses();
    expect(all).toEqual(expect.arrayContaining(['me@h.io', 'work@w.io', 'alias@h.io']));
    expect(new Set(all).size).toBe(all.length);
  });
});
