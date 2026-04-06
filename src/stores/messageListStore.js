// ── messageListStore — independent domain store for message list state ──
// Creates a real Zustand store scoped to message list fields.
// Components should import from here for email list concerns; workflows use mailStore facade.

import { create } from 'zustand';
import { useMailStore } from './mailStore';

// ── Message list field set — defines ownership boundary ──
const ML_FIELDS = [
  'emails', 'localEmails', 'sortedEmails', 'sentEmails', 'totalEmails',
  'currentPage', 'hasMoreEmails', 'loadedRanges', 'loadingRanges',
  'savedEmailIds', 'archivedEmailIds', 'serverUidSet',
];

const ML_ACTIONS = [
  'updateSortedEmails', 'loadEmails', '_loadEmailsViaGraph',
  'loadMoreEmails', 'loadEmailRange', 'loadSentHeaders',
  'isIndexLoaded', 'getEmailAtIndex', 'getCombinedEmails',
  'getSentMailboxPath', 'getChatEmails', 'getThreads',
];

const OWNED_KEYS = new Set([...ML_FIELDS, ...ML_ACTIONS]);

function pickMessageListState(full) {
  const result = {};
  for (const key of OWNED_KEYS) {
    if (key in full) result[key] = full[key];
  }
  return result;
}

// Independent Zustand store — initialized from the facade, kept in sync
export const useMessageListStore = create(() => pickMessageListState(useMailStore.getState()));

// Sync: facade -> messageListStore
useMailStore.subscribe((state) => {
  useMessageListStore.setState(pickMessageListState(state));
});

// Sync: messageListStore -> facade
const _origSetState = useMessageListStore.setState.bind(useMessageListStore);
useMessageListStore.setState = (update, replace) => {
  _origSetState(update, replace);
  if (typeof update === 'function') update = update(useMessageListStore.getState());
  if (update) {
    const facadeUpdate = {};
    let hasAny = false;
    for (const key of ML_FIELDS) {
      if (key in update) { facadeUpdate[key] = update[key]; hasAny = true; }
    }
    if (hasAny) useMailStore.setState(facadeUpdate);
  }
};

// ── Published read contracts (for workflows and cross-store access) ──

export const getEmails = () => useMessageListStore.getState().emails;
export const getSortedEmails = () => useMessageListStore.getState().sortedEmails;
export const getSentEmails = () => useMessageListStore.getState().sentEmails;
export const getLocalEmails = () => useMessageListStore.getState().localEmails;
export const getSavedEmailIds = () => useMessageListStore.getState().savedEmailIds;
export const getArchivedEmailIds = () => useMessageListStore.getState().archivedEmailIds;
export const getTotalEmails = () => useMessageListStore.getState().totalEmails;
export const getHasMoreEmails = () => useMessageListStore.getState().hasMoreEmails;
export const getServerUidSet = () => useMessageListStore.getState().serverUidSet;
