// What a quick-action target is, in one shape for every surface: a list row
// (one message or a thread), the selection bar (ticked keys resolved back to
// rows) and the reader (one open message and the handlers its host wired).
// quickActionAvailability.js and quickActionCatalog.js read only this shape;
// each builder below says what its surface's facts mean.
import { resolveEmailLocation, inLocalFolder, selectionKey } from '../stores/slices/unifiedHelpers';
import { getAccountCacheMailboxes } from '../services/cacheManager';
import { canSnooze } from '../services/workflows/snooze';
import { actionVisibility } from './actionVisibility';
import { describePurge } from './custodyCopy';
import { getSenderName } from './emailParser';
import { resolveQuickActionSelectionTarget } from './quickActions';
import { folderPath } from './quickActionAvailability';

export const isLocalOnly = email => email?.source === 'local-only' || email?._origin === 'local-only';
const insightsOnly = email => !!email?._insightsReadOnly || !!email?._insightsNoServerActions;

/** The folders saved for `accountId`: the live list for the active account, the cache for any other. */
export function savedMailboxes(state, accountId) {
  return (accountId === state.activeAccountId ? state.mailboxes : getAccountCacheMailboxes(accountId)) || [];
}

/** The account's Junk folder path, or null when it has none saved. */
export function junkPathOf(state, accountId) {
  return folderPath(savedMailboxes(state, accountId).find(folder => String(folder.specialUse || '').toLowerCase() === '\\junk'));
}

// The fields every builder fills. `has` is actionVisibility's shape: which
// side of each read/star/archive pair applies to some target.
const BASE = {
  present: true, count: 0, primary: null,
  has: { markRead: false, markUnread: false, star: false, unstar: false, archive: false, unarchive: false },
  resolved: false, fullyResolved: true, accountId: null, mailbox: null, locations: [],
  localFolder: false, localOnly: false, readOnly: false, serverBacked: false, serverActions: false,
  junkPath: null, snooze: false, unsubscribe: null, purge: null, sender: '', senderName: '',
  sent: false, singleRecipient: false, dark: false,
  explicit: { star: false, archive: false }, can: {}, busy: {},
};

/**
 * A list row's targets: one message, or every message of a thread row.
 * `backedUp` is whether any of them is on the backup drive, `canConfirm`
 * whether the row can ask before a delete, `saving` an archive in flight.
 */
export function rowFacts(emails, state, { backedUp = false, canConfirm = false, saving = false } = {}) {
  const locations = emails.map(email => resolveEmailLocation(email, state));
  const has = actionVisibility(emails);
  const resolved = locations.length > 0 && locations.every(Boolean);
  const oneAccount = resolved && new Set(locations.map(location => location.accountId)).size === 1;
  const oneMailbox = locations.length > 0 && locations.every(location => location?.mailbox === locations[0]?.mailbox);
  const primary = emails.length ? emails.reduce((a, b) => new Date(b.date) > new Date(a.date) ? b : a) : null;
  // Rows of a vault-only folder (an MBOX import kept on this computer): no
  // server holds them, so no server action is offered, and neither is a
  // purge or unarchive (each would drop the only copy with no bin copy kept)
  // nor an archive (it fetches from a server; the vault already has them).
  const localFolder = emails.some(email => inLocalFolder(email, state));
  const serverBacked = emails.some(email => email.source !== 'local-only');
  const accountIds = resolved ? [...new Set(locations.map(location => location.accountId))] : [];
  const junkPaths = accountIds.map(accountId => junkPathOf(state, accountId));
  // A thread row unsubscribes through its newest message that offers it.
  const listIndex = emails.reduce((best, email, index) => email.listUnsubscribe
    && (best < 0 || new Date(email.date) > new Date(emails[best].date)) ? index : best, -1);
  const confirm = !!canConfirm;
  return {
    ...BASE,
    count: emails.length, primary, has, resolved, locations,
    accountId: oneAccount ? locations[0].accountId : null,
    mailbox: oneMailbox ? locations[0]?.mailbox : null,
    localFolder,
    localOnly: emails.length > 0 && emails.every(isLocalOnly),
    readOnly: emails.some(insightsOnly),
    serverBacked,
    serverActions: !localFolder && resolved && emails.every(email => email.source !== 'local-only' && !insightsOnly(email)),
    junkPath: junkPaths.length && junkPaths.every(Boolean) && new Set(junkPaths).size === 1 ? junkPaths[0] : null,
    snooze: emails.every(email => canSnooze(email, state)),
    unsubscribe: listIndex < 0 ? null : { email: emails[listIndex], accountId: locations[listIndex]?.accountId },
    purge: !localFolder && describePurge({ server: serverBacked, vault: has.unarchive, backup: backedUp }, emails.length) || null,
    sender: primary?.from?.address || '',
    senderName: primary ? getSenderName(primary) : '',
    can: { unarchive: confirm, delete: confirm, deleteServer: confirm, deleteEverywhere: confirm },
    busy: { archive: !!saving },
  };
}

// A ticked message is archived when its row says the vault holds it, as the
// row menu reads it. The uids in `archivedIds` name only the open folder's
// messages, so they stand in only for a bare key no row resolves; reading a
// full key's uid there counted an archived message of another account or
// folder (every row of a spanning view, a search hit) as unarchived.
const isArchivedKey = (rowByKey, archivedIds) => key => {
  const row = rowByKey.get(key);
  return row ? !!row.isArchived : !String(key).includes(':') && archivedIds.has(key);
};

/**
 * The ticked `keys` whose message the vault holds, in selection order: `rows`
 * the loaded rows (those no key names are ignored), `archivedIds` the open
 * folder's archived uids. The bulk modal's counts and its Unarchive run read
 * this, so they agree with the selection bar.
 */
export function archivedSelectionKeys(keys, rows, archivedIds, state) {
  // The first row a key names, as the selection bar resolves it: a list's row
  // carries the derived state, a vault row it shadows may not.
  const rowByKey = new Map();
  for (const email of rows) {
    const key = selectionKey(email, state);
    if (!rowByKey.has(key)) rowByKey.set(key, email);
  }
  return [...keys].filter(isArchivedKey(rowByKey, archivedIds));
}

/** Every loaded row a selection key can name: the lists on screen and the search hits. */
export function loadedRows({ sortedEmails, emails, localEmails, sentEmails }, searchResults) {
  return [...(sortedEmails || []), ...(emails || []), ...(localEmails || []), ...(sentEmails || []), ...(searchResults || [])];
}

/**
 * The selection bar's targets: `keys` the ticked selection (a Set), `rows` its
 * messages the loaded lists resolve, `pool` every loaded row and
 * `archivedIds` the open folder's archived uids. `backedUp` is whether any
 * of the rows is on the backup drive. Adds `archivedCount`/`totalCount`,
 * which the delete confirmation states and which must agree with the
 * Archive/Unarchive gates.
 */
export function selectionFacts(keys, rows, pool, archivedIds, state, { backedUp = false } = {}) {
  const rowByKey = new Map(rows.map(email => [selectionKey(email, state), email]));
  const archived = [...keys].filter(isArchivedKey(rowByKey, archivedIds)).length;
  const unarchived = keys.size - archived;
  const target = resolveQuickActionSelectionTarget([...keys], pool, state);
  const fullyResolved = rowByKey.size === keys.size && [...keys].every(key => rowByKey.has(key));
  const locations = rows.map(email => resolveEmailLocation(email, state));
  // A selection in a vault-only folder: nothing that needs a server is
  // offered (archive among them), and neither is a purge or unarchive.
  // Delete stays, as the delete workflow's local path into the bin.
  const localFolder = rows.some(email => inLocalFolder(email, state));
  const junkPaths = [...new Set(locations.map(location => location ? junkPathOf(state, location.accountId) : null))];
  const { markRead, markUnread, star, unstar } = actionVisibility(rows);
  const serverBacked = rows.some(email => email.source !== 'local-only');
  return {
    ...BASE,
    count: keys.size,
    has: { markRead, markUnread, star, unstar, archive: unarchived > 0, unarchive: archived > 0 },
    resolved: fullyResolved && locations.length > 0 && locations.every(Boolean),
    fullyResolved,
    accountId: target?.accountId || null,
    mailbox: target?.mailbox || null,
    locations,
    localFolder,
    localOnly: rows.length > 0 && rows.every(isLocalOnly),
    readOnly: rows.some(insightsOnly),
    serverBacked,
    serverActions: !localFolder && fullyResolved && rows.length > 0
      && rows.every(email => email.source !== 'local-only' && !insightsOnly(email)),
    junkPath: target && junkPaths.length === 1 ? junkPaths[0] : null,
    snooze: fullyResolved && rows.length > 0 && rows.every(email => canSnooze(email, state)),
    // The row's purge: the places past the server it reaches, none while the
    // server holds the only copy (Delete from server is that action).
    purge: !localFolder && describePurge({ server: serverBacked, vault: archived > 0, backup: backedUp }, keys.size) || null,
    archivedCount: archived,
    totalCount: archived + unarchived,
  };
}

// Which host handler each reader action runs through.
export const READER_HANDLERS = {
  reply: 'onReply', replyAll: 'onReplyAll', forward: 'onForward',
  archive: 'onArchive', unarchive: 'onArchive',
  delete: 'onDelete', deleteServer: 'onDelete', deleteEverywhere: 'onDeleteEverywhere',
  move: 'onMove', toggleRead: 'onToggleRead', markRead: 'onToggleRead', markUnread: 'onToggleRead',
  star: 'onToggleFlag', unstar: 'onToggleFlag', spam: 'onSpam', tag: 'onApplyLocalLabel',
  export: 'onExport', open: 'onOpenInWindow', source: 'onViewSource', theme: 'onToggleEmailTheme',
};

/**
 * The reader's one open message. `host` is what its host passes: the
 * handlers (a missing one hides its action), `isRead`/`isArchived`/
 * `isLocalOnly`/`isSentEmail`/`singleRecipient`, `emailThemeDark` and
 * `disabled` (actions busy right now). `entries` is the configured list: with
 * both Star and Unstar (or Archive and Unarchive) each shows only where it
 * applies; alone, it toggles. `canTag` is whether a tag can be applied
 * without a host handler.
 */
export function readerFacts(email, state, host, entries = [], { canTag = false } = {}) {
  const location = resolveEmailLocation(email, state);
  const read = host.isRead ?? !!email?.flags?.includes('\\Seen');
  const flagged = !!email?.flags?.includes('\\Flagged');
  // One message, so the shared rule (a side applies iff some target needs
  // it) collapses to its own read/flagged/archived state.
  const has = actionVisibility([{ flags: [...(read ? ['\\Seen'] : []), ...(flagged ? ['\\Flagged'] : [])], isArchived: host.isArchived }]);
  const accountId = location?.accountId;
  const can = Object.fromEntries(Object.entries(READER_HANDLERS).map(([action, prop]) => [action, !!host[prop]]));
  can.tag = can.tag || canTag;
  const configured = action => entries.some(item => item.action === action);
  const localFolder = inLocalFolder(email, state);
  return {
    ...BASE,
    present: !!email,
    count: email ? 1 : 0,
    primary: email || null,
    has,
    resolved: !!location,
    accountId: accountId || null,
    mailbox: location?.mailbox || null,
    locations: [location],
    // A message in a vault-only folder: no server holds it. Star, read state,
    // delete (into the deleted bin) and export are local and stay; what needs
    // a server goes, and so does unarchive, which would drop the only copy.
    localFolder,
    localOnly: !!host.isLocalOnly,
    readOnly: insightsOnly(email),
    serverBacked: !host.isLocalOnly,
    serverActions: !!location && !insightsOnly(email) && !host.isLocalOnly && !localFolder,
    junkPath: accountId ? junkPathOf(state, accountId) : null,
    snooze: !!email && canSnooze(email, state),
    unsubscribe: email?.listUnsubscribe ? { email, accountId } : null,
    sender: email?.from?.address || '',
    senderName: email ? getSenderName(email) : '',
    sent: !!host.isSentEmail,
    singleRecipient: !!host.singleRecipient,
    dark: !!host.emailThemeDark,
    explicit: {
      star: configured('star') && configured('unstar'),
      archive: configured('archive') && configured('unarchive'),
    },
    can,
    busy: host.disabled || {},
  };
}
