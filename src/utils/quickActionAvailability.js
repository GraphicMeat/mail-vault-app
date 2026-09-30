// Whether a quick action is on offer, for every surface in one place. Each
// action names, per surface, the gates that HIDE it and the gates that
// DISABLE it; every gate is one predicate over the shared facts shape
// (quickActionFacts.js). A surface differs from another only in this table
// and in QUICK_ACTION_SURFACE_POLICY, never in a rule of its own.

/** A saved folder's path, as moves and the Junk lookup name it. */
export const folderPath = folder => folder?.path || folder?.name || null;

// Which host "busy" flag (the reader's `disabled` prop, a row's archive in
// flight) holds each action back.
const BUSY_GROUP = {
  archive: 'archive', unarchive: 'archive',
  delete: 'delete', deleteServer: 'delete', deleteEverywhere: 'delete',
  move: 'move', toggleRead: 'toggleRead', markRead: 'toggleRead', markUnread: 'toggleRead',
  star: 'toggleFlag', unstar: 'toggleFlag', reply: 'compose', replyAll: 'compose', forward: 'compose',
};
const PAIR = { star: 'star', unstar: 'star', archive: 'archive', unarchive: 'archive' };

// Each gate passes (true) when the action may go ahead on its account.
// `ctx`: `tags`, `templates` and `folders(accountId)`.
const deletable = f => f.serverActions || f.localFolder && f.fullyResolved;
const GATES = {
  never: () => false,
  present: f => f.present,
  // Not an Insights copy that may only be read.
  writable: f => !f.readOnly,
  handler: (f, entry) => !!f.can[entry.action],
  idle: (f, entry) => !f.busy[BUSY_GROUP[entry.action]],
  placed: f => f.resolved,
  fullyResolved: f => f.fullyResolved,
  oneAccount: f => !!f.accountId,
  notLocalFolder: f => !f.localFolder,
  notLocalOnly: f => !f.localOnly,
  // A local-only copy is always an archived one; it can only be unarchived.
  localOnlyArchived: f => !f.localOnly || f.has.unarchive,
  // The side of the pair applies to some target. A thread row's split
  // toggle offers both sides whatever they apply to.
  has: (f, entry) => f.has[entry.action] || !!entry.thread,
  hasEither: f => f.has.markRead || f.has.markUnread,
  // With both sides configured each shows only where it applies; alone it toggles.
  pairShown: (f, entry) => !f.explicit[PAIR[entry.action]] || f.has[entry.action],
  serverBacked: f => f.serverBacked,
  serverActions: f => f.serverActions,
  deletable,
  // Nothing on a server to delete: the delete unarchives the vault copy.
  vaultOnlyOrDeletable: f => !f.serverBacked || deletable(f),
  purge: f => !!f.purge,
  junk: f => !!f.junkPath,
  spamRoute: f => !!f.can.spam || !!f.junkPath,
  // A saved move needs the targets' one account, and a folder of it that
  // can hold messages (a \Noselect folder is only a parent in the tree).
  moveTarget: (f, entry, ctx) => {
    const { mailbox, accountId } = entry.params || {};
    if (!mailbox) return !!f.accountId;
    return !!f.accountId && (!accountId || accountId === f.accountId) && ctx.folders(f.accountId)
      .some(folder => folderPath(folder) === mailbox && !folder.noselect);
  },
  tag: (f, entry, ctx) => ctx.tags.some(tag => tag.id === entry.params?.tagId),
  template: (f, entry, ctx) => ctx.templates.some(template => template.id === entry.params?.templateId),
  sender: f => !!f.sender,
  snooze: f => f.snooze,
  unsubscribe: f => !!f.unsubscribe,
  notSent: f => !f.sent,
  multiRecipient: f => !f.singleRecipient,
};

// How a surface shows an action it cannot run. The selection bar never hides
// one (its layout stays put as the selection changes); the reader hides every
// action while it has no message.
export const QUICK_ACTION_SURFACE_POLICY = {
  row: { hides: true },
  selection: { hides: false },
  reader: { hides: true, requires: ['present'] },
};

const READER_SERVER = ['writable', 'handler'];
const SELECTION_UNSUPPORTED = { selection: { disable: ['never'] } };
export const QUICK_ACTION_RULES = {
  archive: {
    row: { hide: ['has'], disable: ['idle'] },
    selection: { disable: ['has'] },
    reader: { hide: [...READER_SERVER, 'placed', 'notLocalFolder', 'pairShown', 'localOnlyArchived'], disable: ['idle'] },
  },
  unarchive: {
    row: { hide: ['notLocalFolder', 'has'], disable: ['placed', 'handler'] },
    selection: { disable: ['has', 'placed', 'notLocalFolder'] },
    reader: { hide: [...READER_SERVER, 'placed', 'notLocalFolder', 'pairShown', 'localOnlyArchived'], disable: ['idle'] },
  },
  delete: {
    row: { disable: ['handler', 'vaultOnlyOrDeletable'] },
    selection: { disable: ['deletable'] },
    reader: { hide: [...READER_SERVER, 'placed'], disable: ['idle'] },
  },
  deleteServer: {
    row: { hide: ['serverBacked'], disable: ['serverBacked', 'deletable', 'handler'] },
    selection: { disable: ['deletable'] },
    reader: { hide: [...READER_SERVER, 'notLocalOnly', 'placed'], disable: ['idle'] },
  },
  deleteEverywhere: {
    row: { hide: ['purge'], disable: ['purge', 'placed', 'handler'] },
    selection: { disable: ['placed', 'notLocalFolder'] },
    reader: { hide: [...READER_SERVER, 'placed', 'notLocalFolder'], disable: ['idle'] },
  },
  toggleRead: {
    row: { disable: ['placed'] },
    selection: { disable: ['fullyResolved', 'hasEither'] },
    reader: { hide: [...READER_SERVER, 'notLocalOnly'], disable: ['idle'] },
  },
  markRead: {
    row: { hide: ['has'] },
    selection: { disable: ['fullyResolved', 'has'] },
    reader: { hide: [...READER_SERVER, 'notLocalOnly', 'has'], disable: ['idle'] },
  },
  star: {
    row: { hide: ['has'] },
    selection: { disable: ['has'] },
    reader: { hide: [...READER_SERVER, 'notLocalOnly', 'pairShown'], disable: ['idle'] },
  },
  tag: {
    row: { disable: ['tag', 'placed'] },
    selection: { disable: ['tag', 'placed'] },
    reader: { hide: ['handler', 'placed'], disable: ['tag'] },
  },
  move: {
    row: { disable: ['serverActions', 'moveTarget'] },
    selection: { disable: ['serverActions', 'moveTarget'] },
    reader: { hide: [...READER_SERVER, 'notLocalOnly', 'placed', 'notLocalFolder'], disable: ['idle', 'moveTarget'] },
  },
  spam: {
    row: { disable: ['junk', 'oneAccount', 'serverActions'] },
    selection: { disable: ['serverActions', 'junk'] },
    reader: { hide: ['writable', 'spamRoute', 'notLocalOnly', 'notLocalFolder'] },
  },
  reply: { ...SELECTION_UNSUPPORTED, reader: { hide: ['notSent', 'handler'], disable: ['idle'] } },
  replyAll: { ...SELECTION_UNSUPPORTED, reader: { hide: ['notSent', 'handler', 'multiRecipient'], disable: ['idle'] } },
  forward: { ...SELECTION_UNSUPPORTED, reader: { hide: ['handler'], disable: ['idle'] } },
  replyTemplate: {
    row: { disable: ['template'] },
    ...SELECTION_UNSUPPORTED,
    reader: { disable: ['template', 'notSent'] },
  },
  export: { reader: { hide: ['handler'] } },
  newMessage: { row: { disable: ['sender'] }, ...SELECTION_UNSUPPORTED, reader: { hide: ['never'] } },
  open: { ...SELECTION_UNSUPPORTED, reader: { hide: ['handler'] } },
  source: { ...SELECTION_UNSUPPORTED, reader: { hide: ['handler'] } },
  theme: { ...SELECTION_UNSUPPORTED, reader: { hide: ['handler'] } },
  snooze: {
    row: { disable: ['snooze'] },
    selection: { disable: ['snooze'] },
    reader: { hide: ['notLocalOnly', 'snooze'] },
  },
  unsubscribe: { row: { hide: ['unsubscribe'] }, reader: { hide: ['unsubscribe'] } },
};
QUICK_ACTION_RULES.markUnread = QUICK_ACTION_RULES.markRead;
QUICK_ACTION_RULES.unstar = QUICK_ACTION_RULES.star;

/**
 * `{ hidden, disabled }` for `entry` on `surface` over `facts`. `ctx` holds
 * `tags`, `templates` and `folders(accountId)` (the saved folder list).
 * A surface that never hides leaves `hidden` undefined.
 */
export function quickActionAvailability(surface, entry, facts, ctx) {
  const policy = QUICK_ACTION_SURFACE_POLICY[surface];
  const rule = QUICK_ACTION_RULES[entry.action]?.[surface] || {};
  const fails = gates => (gates || []).some(gate => !GATES[gate](facts, entry, ctx));
  return {
    hidden: policy.hides ? fails(policy.requires) || fails(rule.hide) : undefined,
    disabled: fails(rule.disable),
  };
}
