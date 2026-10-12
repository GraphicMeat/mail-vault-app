import { create } from 'zustand';

// The account a list row is pointing at. A row in a view that spans accounts
// sets it on hover and the sidebar lights that account's row, so "which
// mailbox received this" is answered without reading an address. Not a
// selection: nothing reads it but the two sidebar account rows.
export const useAccountHoverStore = create(() => ({ accountId: null }));

export const setHoveredAccount = accountId => useAccountHoverStore.setState({ accountId });

// Only the row that set it clears it, so a row leaving cannot wipe the
// highlight the next row has already taken.
export const clearHoveredAccount = accountId => {
  if (useAccountHoverStore.getState().accountId === accountId) useAccountHoverStore.setState({ accountId: null });
};
