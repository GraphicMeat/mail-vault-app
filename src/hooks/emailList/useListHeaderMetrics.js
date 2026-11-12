import { formatDateOnly } from '../../utils/dateFormat';
import { useMemo } from 'react';
import { useViewHideStore } from '../../stores/viewHideStore';
import { useMessageListStore } from '../../stores/messageListStore';
import { rowIdentity } from '../../stores/slices/unifiedHelpers';

function getDateRange(emails) {
  if (!emails || emails.length === 0) return null;
  let oldest = null;
  let newest = null;
  for (const e of emails) {
    const d = e.date ? new Date(e.date) : null;
    if (!d || isNaN(d)) continue;
    if (!oldest || d < oldest) oldest = d;
    if (!newest || d > newest) newest = d;
  }
  if (!oldest || !newest) return null;
  const fmt = (d) => formatDateOnly(d, { alwaysShowYear: true });
  if (oldest.toDateString() === newest.toDateString()) return fmt(newest);
  return `${fmt(oldest)} – ${fmt(newest)}`;
}

export function useListHeaderMetrics({ displayEmails, sortedEmails, hideViewMail, activeViewId, searchActive, unifiedInbox, activeMailbox, activeAccountId, mailboxScope, totalEmails, viewMode }) {
  const dateRange = useMemo(() => getDateRange(displayEmails), [displayEmails]);

  // What share of the loaded window is already on this machine. A claim about
  // the rows the list is holding, never about the server total — the meter and
  // the sentence beside it read off the same two numbers, so colour is never
  // the only carrier. Null (renders nothing) when nothing is loaded.
  const vaultShare = useMemo(() => {
    const loaded = sortedEmails.length;
    if (!loaded) return null;
    let inVault = 0;
    for (const e of sortedEmails) if (e.isArchived) inVault++;
    return { loaded, inVault, pct: Math.round((inVault / loaded) * 100) };
  }, [sortedEmails]);

  // "Hide view mail": how many of the folder's messages the switch keeps off
  // this list, so the header's total is the folder as shown. The header only:
  // store `totalEmails` stays the server's. Never inside a view or a search,
  // whose rows nothing hides, and unknown membership (null) subtracts nothing.
  const hiddenByMailbox = useViewHideStore(s => s.hiddenByMailbox);
  const viewHeldKeys = useViewHideStore(s => s.keys);
  const loadedEmails = useMessageListStore(s => s.emails);
  // Inside a view by its id, as the toggle reads it: a view whose row is not
  // loaded yet is still open.
  const hidingViewMail = hideViewMail && !activeViewId && !searchActive;
  const hiddenFromTotal = useMemo(() => {
    if (!hidingViewMail) return 0;
    // All Inboxes counts what its accounts' inboxes loaded, so it gives back
    // only the loaded rows the daemon's key set holds (each message once).
    // Spanning as rowVisibility reads it.
    if (unifiedInbox || activeMailbox === 'UNIFIED') {
      if (!viewHeldKeys?.size || !loadedEmails?.length) return 0;
      const view = { activeAccountId, activeMailbox };
      const held = new Set();
      for (const e of loadedEmails) {
        const id = rowIdentity(e, view);
        const key = id && `${id.accountId}|${id.mailbox}|${id.uid}`;
        if (key && viewHeldKeys.has(key)) held.add(key);
      }
      return held.size;
    }
    // A folder (or a folder branch, whose total is its folders' sum) gives
    // back what the daemon says it hides in each of them.
    if (!hiddenByMailbox) return 0;
    const paths = mailboxScope?.paths?.length ? mailboxScope.paths : [activeMailbox];
    return paths.reduce((sum, path) => sum + (hiddenByMailbox[`${activeAccountId}|${path}`] || 0), 0);
  }, [hidingViewMail, unifiedInbox, activeMailbox, activeAccountId, mailboxScope, viewHeldKeys, loadedEmails, hiddenByMailbox]);
  // The folder's total as this list shows it.
  const shownTotal = hidingViewMail ? totalEmails - hiddenFromTotal : totalEmails;

  // ponytail: the "loaded" suffix only earns its place while the server still
  // holds rows this window hasn't paged in — otherwise it invites a scroll that
  // can never move either number. Vault view is never partial in that sense:
  // its rows come off disk, while totalEmails keeps counting the server.
  // A hidden message is not one still to page in: measured against the
  // total less what "hide view mail" keeps off.
  const windowIsPartial = viewMode !== 'local' && sortedEmails.length < shownTotal;

  return { dateRange, vaultShare, hidingViewMail, shownTotal, windowIsPartial };
}
