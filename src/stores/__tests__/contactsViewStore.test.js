import { describe, it, expect, beforeEach } from 'vitest';
import { useContactsViewStore } from '../contactsViewStore';

beforeEach(() => useContactsViewStore.setState(useContactsViewStore.getInitialState(), true));

describe('contactsViewStore', () => {
  it('focus with participants switches to the email tab', () => {
    const people = [{ address: 'a@x.io', name: '', role: 'from' }];
    useContactsViewStore.getState().focus(people);
    expect(useContactsViewStore.getState()).toMatchObject({ scope: 'email', participants: people });
  });

  it('focus with none keeps the current tab', () => {
    useContactsViewStore.getState().setScope('senders');
    useContactsViewStore.getState().focus([]);
    expect(useContactsViewStore.getState()).toMatchObject({ scope: 'senders', participants: [] });
  });

  it('close resets tab and participants', () => {
    useContactsViewStore.getState().open();
    useContactsViewStore.getState().focus([{ address: 'a@x.io', name: '', role: 'to' }]);
    useContactsViewStore.getState().close();
    expect(useContactsViewStore.getState()).toMatchObject({ isOpen: false, scope: 'contacts', participants: [] });
  });
});
