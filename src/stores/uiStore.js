// ── uiStore — independent domain store for UI state ──
// Creates a real Zustand store scoped to UI fields.
// Components should import from here for UI concerns; workflows use mailStore facade.

import { create } from 'zustand';
import { useMailStore } from './mailStore';

// ── UI field set — defines ownership boundary ──
const UI_FIELDS = [
  'viewMode', '_flagSeq', '_sortedEmailsFingerprint',
  'bulkSaveProgress', 'exportProgress', 'error',
];

const UI_ACTIONS = [
  'setViewMode', 'setExportProgress', 'dismissExportProgress',
  'dismissBulkProgress', 'clearError',
];

const OWNED_KEYS = new Set([...UI_FIELDS, ...UI_ACTIONS]);

function pickUiState(full) {
  const result = {};
  for (const key of OWNED_KEYS) {
    if (key in full) result[key] = full[key];
  }
  return result;
}

// Independent Zustand store — initialized from the facade, kept in sync
export const useUiStore = create(() => pickUiState(useMailStore.getState()));

// Sync: facade -> uiStore
useMailStore.subscribe((state) => {
  useUiStore.setState(pickUiState(state));
});

// Sync: uiStore -> facade
const _origSetState = useUiStore.setState.bind(useUiStore);
useUiStore.setState = (update, replace) => {
  _origSetState(update, replace);
  if (typeof update === 'function') update = update(useUiStore.getState());
  if (update) {
    const facadeUpdate = {};
    let hasAny = false;
    for (const key of UI_FIELDS) {
      if (key in update) { facadeUpdate[key] = update[key]; hasAny = true; }
    }
    if (hasAny) useMailStore.setState(facadeUpdate);
  }
};

// ── Published read contracts (for workflows and cross-store access) ──

export const getViewMode = () => useUiStore.getState().viewMode;
export const getError = () => useUiStore.getState().error;
export const getBulkSaveProgress = () => useUiStore.getState().bulkSaveProgress;
export const getExportProgress = () => useUiStore.getState().exportProgress;
