import { describe, it, expect } from 'vitest';
import { ownAddresses } from '../unifiedHelpers.js';

// "Is this message mine?" In one account's view that is the account's login and
// its send-as address. All inboxes holds every visible account's mail, so a
// reply sent from any of them is yours: answering with the active account alone
// drew another account's replies as a stranger's bubbles in the chat view and
// grouped them under the wrong correspondent.
describe('ownAddresses', () => {
  const accounts = [
    { id: 'luke', email: 'luke@mock.test' },
    { id: 'yoda', email: 'yoda@mock.test' },
    { id: 'vader', email: 'vader@mock.test' },
  ];
  const sendAs = { luke: 'skywalker@mock.test', yoda: 'master@mock.test' };

  it('is the active account and its send-as in one account\'s view', () => {
    const state = { accounts, activeAccountId: 'luke', activeMailbox: 'INBOX' };
    expect(ownAddresses(state, sendAs, {})).toEqual(['luke@mock.test', 'skywalker@mock.test']);
  });

  it('is every visible account and its send-as in All inboxes', () => {
    const state = { accounts, activeAccountId: 'luke', activeMailbox: 'UNIFIED' };
    expect(ownAddresses(state, sendAs, { vader: true })).toEqual([
      'luke@mock.test', 'skywalker@mock.test', 'yoda@mock.test', 'master@mock.test',
    ]);
  });

  it('copes with no settings at all', () => {
    const state = { accounts, activeAccountId: 'yoda', activeMailbox: 'Archive' };
    expect(ownAddresses(state)).toEqual(['yoda@mock.test']);
  });
});
