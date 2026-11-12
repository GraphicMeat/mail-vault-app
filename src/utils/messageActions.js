// What a quick action does, for every surface that offers one: the row menu
// and swipe (RowQuickActions), the selection bar (SelectionActionBar) and a
// reader's bar (EmailActionBar). Which actions a surface shows is
// quickActionCatalog's; this is what pressing one runs.
//
// Each action names one operation of the surface's context (`ctx`) and the
// arguments it takes. A surface builds `ctx` for what it acts on: a row's
// messages (made the selection for the call), the live selection, or the one
// message a reader shows. The differences between surfaces live there, not in
// a second copy of this table.
//
// - `closesFirst`: a row closes its menu before the action runs (the action
//   opens something of its own: a confirm, compose, another folder); every
//   other action closes it once done, except one that opens a picker.
// - `confirms`: the action asks first (a delete or an unarchive).
// - `picker(entry)`: the action opens a picker and leaves the menu to it.
const flagFor = (ctx, action) => (ctx.starToggles
  ? action === 'star' && !ctx.flagged
  : action === 'star');

export const MESSAGE_ACTIONS = Object.freeze({
  reply: { op: 'compose', args: () => ['reply'], closesFirst: true },
  replyAll: { op: 'compose', args: () => ['replyAll'], closesFirst: true },
  forward: { op: 'compose', args: () => ['forward'], closesFirst: true },
  replyTemplate: { op: 'replyTemplate', args: (_ctx, entry) => [entry.params?.templateId], closesFirst: true },
  newMessage: { op: 'newMessage', closesFirst: true },
  archive: { op: 'archive' },
  unarchive: { op: 'unarchive', closesFirst: true, confirms: true },
  delete: { op: 'delete', closesFirst: true, confirms: true },
  deleteServer: { op: 'deleteServer', closesFirst: true, confirms: true },
  deleteEverywhere: { op: 'deleteEverywhere', closesFirst: true, confirms: true },
  // The direction the button shows: read when anything is unread.
  toggleRead: { op: 'setRead', args: ctx => [ctx.hasUnread] },
  markRead: { op: 'setRead', args: () => [true] },
  markUnread: { op: 'setRead', args: () => [false] },
  star: { op: 'setFlagged', args: ctx => [flagFor(ctx, 'star')] },
  unstar: { op: 'setFlagged', args: ctx => [flagFor(ctx, 'unstar')] },
  // A configured folder moves at once; plain Move opens the folder picker.
  move: {
    op: (_ctx, entry) => (entry.params?.mailbox ? 'moveTo' : 'pickFolder'),
    args: (_ctx, entry) => (entry.params?.mailbox ? [entry.params.mailbox] : []),
    picker: entry => !entry.params?.mailbox,
  },
  spam: { op: 'spam' },
  snooze: { op: 'pickSnooze', picker: () => true },
  tag: { op: 'tag', args: (_ctx, entry) => [entry.params.tagId] },
  export: { op: 'export' },
  unsubscribe: { op: 'unsubscribe', closesFirst: true },
  goToMailbox: { op: 'goToMailbox', closesFirst: true },
  open: { op: 'openInWindow' },
  source: { op: 'viewSource' },
  theme: { op: 'toggleTheme' },
});

/**
 * Run `entry` (a quick-action entry: `{ action, params }`) on a surface's
 * `ctx`. Every operation is called with its arguments and then the `event`
 * that pressed the button. An action whose operation the surface does not
 * offer does nothing, and closes nothing.
 */
export async function runMessageAction(entry, ctx, event) {
  const spec = MESSAGE_ACTIONS[entry?.action];
  if (!spec) return;
  const name = typeof spec.op === 'function' ? spec.op(ctx, entry) : spec.op;
  const op = ctx[name];
  if (typeof op !== 'function') return;
  if (spec.closesFirst) ctx.close?.();
  await op(...(spec.args ? spec.args(ctx, entry) : []), event);
  if (!spec.closesFirst && !spec.picker?.(entry)) ctx.close?.();
}
