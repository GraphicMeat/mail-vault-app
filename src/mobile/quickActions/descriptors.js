// The descriptors the wheel and the bulk bar draw (QuickActionsWheel.jsx reads `label`, `Icon`,
// `hidden`, `disabled`, `isDestructive`, `onActivate`): desktop's availability rules (the shared
// quickActionAvailability.js) over facts about the phone's rows, desktop's glyphs, the same
// catalog keys through the phone's translator, and a handler per action the phone runs
// (actionTable.js decides which). Desktop's own catalog (quickActionCatalog.js) says the same
// things through the desktop translator, which the phone cannot import.
//
// `rows` are list rows as the list shows them (a conversation's `seen` and `flagged` already
// folded, MessageRow.jsx `shown`). `handlers`: `setRead(read)`, `setFlagged(flagged)`, `delete()`,
// `pickFolder()`, `moveTo(path)`, `spam()`, `tag(tagId)`, `compose(mode)`, `select()`.
import { CheckSquare } from 'lucide-react';
import { quickActionIcon } from '../../utils/quickActionIcons.jsx';
import { quickActionAvailability, folderPath } from '../../utils/quickActionAvailability.js';
import { t } from '../i18n.js';
import { decisionOf } from './actionTable.js';

// Desktop's DESTRUCTIVE_QUICK_ACTIONS (quickActionCatalog.js, which reaches desktop's translator).
const DESTRUCTIVE = ['delete', 'deleteServer', 'deleteEverywhere'];
const senderName = (row) => row?.fromName || row?.fromAddress || '';

/** The facts desktop's availability rules read (quickActionFacts.js), for these list rows. */
export function phoneFacts(rows, { accountId = null, mailbox = null, junkPath = null } = {}) {
  const primary = rows[0] || null;
  return {
    present: true,
    count: rows.length,
    primary,
    has: {
      markRead: rows.some((r) => !r.seen),
      markUnread: rows.some((r) => r.seen),
      star: rows.some((r) => !r.flagged),
      unstar: rows.some((r) => r.flagged),
      archive: false,
      unarchive: false,
    },
    resolved: true,
    fullyResolved: true,
    accountId,
    mailbox,
    locations: [],
    localFolder: false,
    localOnly: false,
    readOnly: false,
    serverBacked: true,
    serverActions: true,
    junkPath,
    snooze: false,
    unsubscribe: null,
    goTo: null,
    purge: null,
    sender: primary?.fromAddress || '',
    senderName: senderName(primary),
    sent: false,
    singleRecipient: false,
    dark: false,
    explicit: { star: false, archive: false },
    // A row's delete asks nothing of the host the way desktop's does: the app's own delete flow.
    can: { delete: true, deleteServer: true, unarchive: false, deleteEverywhere: false },
    busy: {},
  };
}

// Desktop's label keys (quickActionCatalog.js QUICK_ACTION_LABELS), with the phone's Delete: both
// deletes are Delete, since nothing here is "from the server" as against a vault.
const tagLabel = (facts, entry, ctx) => ctx.tags.find((tag) => tag.id === entry.params?.tagId)?.name || t('quickActions.action.tag');
const moveLabel = (savedKey, pickerKey) => (facts, entry) => (entry.params?.mailbox ? `${t(savedKey)}: ${entry.params.mailbox}` : t(pickerKey));
const LABELS = {
  row: {
    archive: 'common.archive', unarchive: 'rowMenu.unarchive', delete: 'common.delete', deleteServer: 'common.delete',
    deleteEverywhere: 'rowMenu.deleteEverywhere', markRead: 'rowMenu.markRead', markUnread: 'rowMenu.markUnread',
    star: 'rowMenu.star', unstar: 'rowMenu.unstar', tag: tagLabel, move: moveLabel('quickActions.action.move', 'rowMenu.moveFolder'),
    spam: 'quickActions.action.spam', reply: 'emailActionBar.reply', replyAll: 'emailActionBar.replyAll',
    forward: 'emailActionBar.forward', replyTemplate: 'quickActions.action.replyTemplate', export: 'common.export',
    newMessage: 'quickActions.action.newMessage', snooze: 'snooze.action', unsubscribe: 'unsubscribe.action',
    goToMailbox: 'rowMenu.goToMailbox', open: 'chat.bubble.openNewWindow',
  },
  selection: {
    archive: 'common.archive', unarchive: 'selection.unarchive', delete: 'common.delete', deleteServer: 'common.delete',
    deleteEverywhere: 'selection.deleteEverywhere', markRead: 'selection.markRead', markUnread: 'selection.markUnread',
    star: 'rowMenu.star', unstar: 'rowMenu.unstar', tag: tagLabel, move: moveLabel('selection.move', 'selection.moveFolder'),
    spam: 'quickActions.action.spam', export: 'selection.exportSelected', snooze: 'snooze.action',
  },
};

/** The phone's own wedge: Select (the multi-select, src/mobile/selection/). Never saved in a configuration. */
export const SELECT_ENTRY = Object.freeze({ id: 'select', action: 'select' });

function directionOf(entry, facts) {
  return entry.action === 'toggleRead' ? (facts.has.markRead ? 'markRead' : 'markUnread') : entry.action;
}

/**
 * The descriptor for `entry` on `surface` ('row' or 'selection') over `facts`, without
 * `onActivate`. `ctx`: `tags` and `folders(accountId)`.
 */
export function describeAction({ surface, entry, facts, ctx }) {
  if (entry.action === 'select') {
    return { id: entry.id, action: 'select', label: t('mobile.quickActions.select'), Icon: CheckSquare, hidden: false, disabled: false, restoreFocus: false };
  }
  const direction = directionOf(entry, facts);
  const key = LABELS[surface][direction] ?? 'quickActions.title';
  const name = typeof key === 'function' ? key(facts, entry, ctx) : t(key);
  const onDesktop = decisionOf(entry.action) === 'desktop';
  // A saved move names the desktop's account id: here it is the account the rows are in.
  const own = entry.action === 'move' && entry.params ? { ...entry, params: { ...entry.params, accountId: undefined } } : entry;
  // The phone's templates carry no desktop ids: a reply template is desktop's (actionTable.js).
  const rules = quickActionAvailability(surface, own, facts, { templates: [], ...ctx });
  const hidden = decisionOf(entry.action) === 'hidden' ? true : rules.hidden === undefined ? undefined : (onDesktop ? false : rules.hidden);
  return {
    id: entry.id,
    action: entry.action,
    label: onDesktop ? t('mobile.quickActions.onDesktop', { name }) : name,
    Icon: quickActionIcon(direction, { dark: false }),
    hidden,
    disabled: onDesktop || rules.disabled,
    isDestructive: DESTRUCTIVE.includes(direction),
    restoreFocus: false,
  };
}

/** What activating `entry` does, over `handlers`; nothing for an action the phone does not run. */
function runner(entry, facts, handlers) {
  const h = handlers || {};
  switch (entry.action) {
    case 'toggleRead': return () => h.setRead?.(facts.has.markRead);
    case 'markRead': return () => h.setRead?.(true);
    case 'markUnread': return () => h.setRead?.(false);
    case 'star': return () => h.setFlagged?.(true);
    case 'unstar': return () => h.setFlagged?.(false);
    case 'delete':
    case 'deleteServer': return () => h.delete?.();
    case 'move': return () => (entry.params?.mailbox ? h.moveTo?.(entry.params.mailbox) : h.pickFolder?.());
    case 'spam': return () => h.spam?.();
    case 'tag': return () => h.tag?.(entry.params?.tagId);
    case 'reply':
    case 'replyAll':
    case 'forward': return () => h.compose?.(entry.action);
    case 'select': return () => h.select?.();
    default: return undefined;
  }
}

/** One descriptor per entry of `entries`, each with its `onActivate`. */
export function buildDescriptors({ surface, entries, facts, ctx, handlers }) {
  return entries.map((entry) => {
    const descriptor = describeAction({ surface, entry, facts, ctx });
    const onActivate = decisionOf(entry.action) === 'run' || entry.action === 'select' ? runner(entry, facts, handlers) : undefined;
    return { ...descriptor, onActivate };
  });
}

export { folderPath };
