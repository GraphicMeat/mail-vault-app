// How each quick action presents itself on each surface: label, glyph, tone
// and whether activating it hands focus on to follow-up UI. Where surfaces
// word an action differently the table holds each surface's own catalog key.
// `describeQuickAction` joins this with quickActionAvailability.js into the
// descriptor QuickActions renders; the component adds `onActivate`.
import { quickActionIcon } from './quickActionIcons';
import { quickActionAvailability } from './quickActionAvailability';
import { t } from '../i18n/index.js';

export const DESTRUCTIVE_QUICK_ACTIONS = ['delete', 'deleteServer', 'deleteEverywhere'];

export function quickActionTone(action) {
  if (DESTRUCTIVE_QUICK_ACTIONS.includes(action)) return 'danger';
  return action === 'archive' || action === 'unarchive' ? 'positive' : undefined;
}

// Actions that open a picker, a confirmation or compose: focus goes there,
// not back to the trigger.
export const QUICK_ACTION_FOLLOW_UP = {
  row: ['move', 'snooze', 'unsubscribe', 'delete', 'deleteServer', 'deleteEverywhere', 'unarchive', 'reply', 'replyAll', 'forward', 'replyTemplate', 'newMessage'],
  selection: ['move', 'snooze', 'delete', 'deleteServer', 'deleteEverywhere', 'unarchive'],
  reader: ['move', 'snooze', 'unsubscribe', 'delete', 'deleteServer', 'deleteEverywhere', 'unarchive', 'reply', 'replyAll', 'forward', 'replyTemplate', 'open', 'source'],
};

// A toggle presents itself as the direction it will take: its label, glyph
// and focus are those of that side. Rows and the selection bar offer Star /
// Unstar and Archive / Unarchive as separate entries; the reader's lone Star
// and Archive toggle (with both sides configured, the side that does not
// apply is hidden, so the toggle only ever shows its applicable side).
const DIRECTION = {
  toggleRead: facts => (facts.has.markRead ? 'markRead' : 'markUnread'),
  star: facts => (facts.has.unstar ? 'unstar' : 'star'),
  archive: facts => (facts.has.unarchive ? 'unarchive' : 'archive'),
};
export const QUICK_ACTION_TOGGLES = {
  row: ['toggleRead'],
  selection: ['toggleRead'],
  reader: ['toggleRead', 'star', 'archive'],
};

// A label is a catalog key, or `(facts, entry, ctx)` returning the text.
// An action a surface has no label for reads as the generic "Quick actions".
const tagLabel = (facts, entry, ctx) => ctx.tags.find(tag => tag.id === entry.params?.tagId)?.name || t('quickActions.action.tag');
const templateLabel = (facts, entry, ctx) => ctx.templates.find(template => template.id === entry.params?.templateId)?.name
  || t('quickActions.action.replyTemplate');
const moveLabel = (savedKey, pickerKey) => (facts, entry) => (entry.params?.mailbox ? `${t(savedKey)}: ${entry.params.mailbox}` : t(pickerKey));
// A vault-only folder has no server: its delete is the plain one.
const deleteServerLabel = facts => t(facts.localFolder ? 'common.delete' : 'rowMenu.deleteServer');

export const QUICK_ACTION_LABELS = {
  row: {
    archive: 'common.archive', unarchive: 'rowMenu.unarchive', delete: 'common.delete', deleteServer: deleteServerLabel,
    // The purge names the places it reaches.
    deleteEverywhere: facts => facts.purge?.label || t('rowMenu.deleteEverywhere'),
    markRead: 'rowMenu.markRead', markUnread: 'rowMenu.markUnread', star: 'rowMenu.star', unstar: 'rowMenu.unstar',
    tag: tagLabel, move: moveLabel('quickActions.action.move', 'rowMenu.moveFolder'), spam: 'quickActions.action.spam',
    reply: 'emailActionBar.reply', replyAll: 'emailActionBar.replyAll', forward: 'emailActionBar.forward',
    replyTemplate: templateLabel, export: 'common.export',
    newMessage: facts => t('rowMenu.newMessageTo', { name: facts.senderName }),
    snooze: 'snooze.action', unsubscribe: 'unsubscribe.action',
  },
  selection: {
    archive: 'common.archive', unarchive: 'selection.unarchive', delete: 'common.delete', deleteServer: deleteServerLabel,
    deleteEverywhere: 'selection.deleteEverywhere',
    markRead: 'selection.markRead', markUnread: 'selection.markUnread', star: 'rowMenu.star', unstar: 'rowMenu.unstar',
    tag: tagLabel, move: moveLabel('selection.move', 'selection.moveFolder'), spam: 'quickActions.action.spam',
    export: 'selection.exportSelected', snooze: 'snooze.action',
  },
  reader: {
    archive: 'common.archive', unarchive: 'rowMenu.unarchive',
    // A local-only message's delete removes the vault copy: an unarchive.
    delete: facts => t(facts.localOnly ? 'rowMenu.unarchive' : 'common.delete'),
    deleteServer: facts => t(facts.localOnly ? 'rowMenu.unarchive' : 'common.delete'),
    deleteEverywhere: 'rowMenu.deleteEverywhere',
    markRead: 'emailActionBar.markRead', markUnread: 'emailActionBar.markUnread', star: 'emailActionBar.star', unstar: 'emailActionBar.unstar',
    tag: tagLabel, move: moveLabel('emailActionBar.move', 'emailActionBar.move'), spam: 'quickActions.action.spam',
    reply: 'emailActionBar.reply', replyAll: 'emailActionBar.replyAll', forward: 'emailActionBar.forward',
    replyTemplate: templateLabel, export: 'common.export', newMessage: 'quickActions.action.newMessage',
    snooze: 'snooze.action', unsubscribe: 'unsubscribe.action',
    theme: facts => t(facts.dark ? 'emailActionBar.light' : 'emailActionBar.dark'),
    open: 'common.open', source: 'emailActionBar.source',
  },
};
// A tooltip that says more than the button: the bar acts on every ticked message.
const TITLE_LABELS = {
  selection: { archive: 'selection.archiveSelected', unarchive: 'selection.unarchiveSelected' },
};

/**
 * The descriptor for `entry` on `surface` over `facts` (quickActionFacts.js),
 * without `onActivate`. `ctx`: `tags`, `templates` and `folders(accountId)`.
 */
export function describeQuickAction(surface, entry, facts, ctx) {
  const direction = QUICK_ACTION_TOGGLES[surface].includes(entry.action) ? DIRECTION[entry.action](facts) : entry.action;
  const label = QUICK_ACTION_LABELS[surface][direction] ?? 'quickActions.title';
  const titleKey = TITLE_LABELS[surface]?.[direction];
  return {
    id: entry.id,
    action: entry.action,
    label: typeof label === 'function' ? label(facts, entry, ctx) : t(label),
    titleLabel: titleKey && t(titleKey),
    Icon: quickActionIcon(direction, { dark: facts.dark }),
    ...quickActionAvailability(surface, entry, facts, ctx),
    tone: quickActionTone(direction),
    isDestructive: DESTRUCTIVE_QUICK_ACTIONS.includes(direction),
    restoreFocus: !QUICK_ACTION_FOLLOW_UP[surface].includes(direction),
  };
}
