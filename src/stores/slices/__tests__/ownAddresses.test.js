import { describe, it, expect } from 'vitest';
import { viewOwnAddresses } from '../unifiedHelpers.js';

// "Is this message mine?" In one account's view that is the account's login,
// its default From and its aliases. All inboxes holds every visible account's
// mail, so a reply sent from any of them is yours: answering with the active
// account alone drew another account's replies as a stranger's bubbles in the
// chat view and grouped them under the wrong correspondent.
describe('viewOwnAddresses', () => {
  const accounts = [
    { id: 'luke', email: 'luke@mock.test' },
    { id: 'yoda', email: 'yoda@mock.test' },
    { id: 'vader', email: 'vader@mock.test' },
  ];
  const sendAs = { luke: 'skywalker@mock.test', yoda: 'master@mock.test' };

  it('is the active account and its send-as in one account\'s view', () => {
    const state = { accounts, activeAccountId: 'luke', activeMailbox: 'INBOX' };
    expect(viewOwnAddresses(state, sendAs, {})).toEqual(['luke@mock.test', 'skywalker@mock.test']);
  });

  it('is every visible account and its send-as in All inboxes', () => {
    const state = { accounts, activeAccountId: 'luke', activeMailbox: 'UNIFIED' };
    expect(viewOwnAddresses(state, sendAs, { vader: true })).toEqual([
      'luke@mock.test', 'skywalker@mock.test', 'yoda@mock.test', 'master@mock.test',
    ]);
  });

  it('counts every alias an account holds, not only its default From', () => {
    const aliases = { luke: [{ address: 'jedi@mock.test', name: 'Jedi', source: 'provider' }] };
    const state = { accounts, activeAccountId: 'luke', activeMailbox: 'INBOX' };
    expect(viewOwnAddresses(state, sendAs, {}, aliases)).toEqual([
      'luke@mock.test', 'skywalker@mock.test', 'jedi@mock.test',
    ]);
  });

  it('copes with no settings at all', () => {
    const state = { accounts, activeAccountId: 'yoda', activeMailbox: 'Archive' };
    expect(viewOwnAddresses(state)).toEqual(['yoda@mock.test']);
  });
});
