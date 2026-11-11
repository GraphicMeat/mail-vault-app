import { create } from 'zustand';

/** Whether the Contacts view is open, which list it shows, and the open email's people. */
export const useContactsViewStore = create((set) => ({
  isOpen: false,
  scope: 'contacts', // 'email' | 'favorites' | 'contacts' | 'senders' | 'review'
  participants: [],
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false, scope: 'contacts', participants: [] }),
  setScope: (scope) => set({ scope }),
  // The email's people open on the "This email" list; with none the tab stays as it was.
  focus: (participants) => set(participants.length ? { participants, scope: 'email' } : { participants }),
}));
