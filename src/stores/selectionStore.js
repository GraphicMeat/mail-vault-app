// ── selectionStore — independent domain store for selection state ──
// Creates a real Zustand store scoped to selection fields.
// Components should import from here for selection concerns; workflows use mailStore facade.

import { create } from 'zustand';
import { useMailStore } from './mailStore';

// ── Selection field set — defines ownership boundary ──
const SEL_FIELDS = [
  'selectedEmailId', 'selectedEmail', 'selectedEmailSource',
  'selectedEmailIds', 'selectedThread', 'loadingEmail',
];

const SEL_ACTIONS = [
  'selectThread', '_prefetchAdjacentEmails', 'selectEmail',
  'toggleEmailSelection', 'selectAllEmails', 'clearSelection',
  'getSelectionSummary', 'markSelectedAsRead', 'markSelectedAsUnread',
  'deleteSelectedFromServer', 'moveEmails',
];

const OWNED_KEYS = new Set([...SEL_FIELDS, ...SEL_ACTIONS]);

function pickSelectionState(full) {
  const result = {};
  for (const key of OWNED_KEYS) {
    if (key in full) result[key] = full[key];
  }
  return result;
}

// Independent Zustand store — initialized from the facade, kept in sync
export const useSelectionStore = create(() => pickSelectionState(useMailStore.getState()));

// Sync: facade -> selectionStore
useMailStore.subscribe((state) => {
  useSelectionStore.setState(pickSelectionState(state));
});

// Sync: selectionStore -> facade
const _origSetState = useSelectionStore.setState.bind(useSelectionStore);
useSelectionStore.setState = (update, replace) => {
  _origSetState(update, replace);
  if (typeof update === 'function') update = update(useSelectionStore.getState());
  if (update) {
    const facadeUpdate = {};
    let hasAny = false;
    for (const key of SEL_FIELDS) {
      if (key in update) { facadeUpdate[key] = update[key]; hasAny = true; }
    }
    if (hasAny) useMailStore.setState(facadeUpdate);
  }
};

// ── Published read contracts (for workflows and cross-store access) ──

export const getSelectedEmailId = () => useSelectionStore.getState().selectedEmailId;
export const getSelectedEmail = () => useSelectionStore.getState().selectedEmail;
export const getSelectedEmailIds = () => useSelectionStore.getState().selectedEmailIds;
export const getSelectedThread = () => useSelectionStore.getState().selectedThread;
