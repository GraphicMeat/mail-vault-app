// After the daemon's body pass for the folder on screen settled, read which
// messages the vault holds now and show it. This is the only part of the old
// download-ahead engine's finish step the screen still needs: the saved and
// archived sets. The visible rows are NEVER written back to a header cache here
// (a list can hold rows from several folders; the daemon owns those caches).
import * as db from '../db';
import { useMailStore } from '../../stores/mailStore';
import { setArchivedGroup } from '../../stores/slices/messageListSlice';
import { spansMailboxes, vaultKeys, vaultUids } from '../../stores/slices/unifiedHelpers';

const onThisFolder = (state, accountId, mailbox) => state.activeAccountId === accountId
  && state.activeMailbox === mailbox && !spansMailboxes(state);

export async function refreshVaultSets(accountId, mailbox) {
  // Only a view of that one folder: a spanning list's rows come from several, and
  // treating one as the whole would paint the others' vault state into it.
  if (!onThisFolder(useMailStore.getState(), accountId, mailbox)) return false;
  try {
    const vault = await db.getVaultUidSets(accountId, mailbox);
    // The read yielded: a view switched to since owns the store now.
    const live = useMailStore.getState();
    if (!onThisFolder(live, accountId, mailbox)) return false;
    // An unknown read (`null`) keeps the store's current values instead of
    // adopting "nothing is in the vault".
    const archived = vault?.archived ?? vaultUids(live.archivedEmailIds, accountId, mailbox);
    setArchivedGroup(accountId, mailbox, vault?.archived ?? null);
    useMailStore.setState({
      savedEmailIds: vaultKeys(accountId, mailbox, vault?.saved) ?? live.savedEmailIds,
      archivedEmailIds: vaultKeys(accountId, mailbox, vault?.archived) ?? live.archivedEmailIds,
    });
    if (archived.size > 0) {
      db.getArchivedEmails(accountId, mailbox, archived, (batch) => {
        if (useMailStore.getState().activeAccountId !== accountId) return;
        useMailStore.setState({ localEmails: batch });
        useMailStore.getState().updateSortedEmails();
      }).catch(() => {});
    }
    useMailStore.getState().updateSortedEmails();
    return true;
  } catch (error) {
    console.warn('[pipeline] Could not refresh the saved ids:', error);
    return false;
  }
}
