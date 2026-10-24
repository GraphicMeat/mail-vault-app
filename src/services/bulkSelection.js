import { captureSelectionSnapshot } from './headerIdentity.js';
import { resolvePool, indexRows } from '../stores/messageRows.js';
import {
  selectionKey,
  resolveEmailLocation,
  spansMailboxes,
} from '../stores/slices/unifiedHelpers.js';

// Original evidence is captured synchronously. A selected key with no companion
// stays unproved even if today's cache happens to hold a row under that key.
export function captureBulkScope(keys, state, clickedRows) {
  const rows = indexRows(clickedRows || resolvePool(state), (row) =>
    selectionKey(row, state)
  );
  const targetHints = [];
  for (const key of keys) {
    let hint;
    if (!clickedRows && state.selectedEmailIds?.has(key))
      hint = state.selectedEmailSnapshots?.get(key);
    else {
      const row = rows.get(key);
      const at = resolveEmailLocation(row, state);
      hint = at && captureSelectionSnapshot(row, at.accountId, at.mailbox);
    }
    if (hint) targetHints.push(hint);
  }
  return {
    accountId: state.activeAccountId ?? null,
    mailbox: state.activeMailbox ?? null,
    spans: spansMailboxes(state),
    keys: [...keys],
    targetHints,
  };
}
