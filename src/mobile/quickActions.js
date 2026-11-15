// The viewer's quick actions (Settings > Appearance > Quick actions): the phone's share of the
// desktop's reader surface. `quickActionsReader` (settings.rs PREFS) lists the actions on the
// viewer's bar, in order, at most BAR_LIMIT; every other action the phone can do on an open
// message is under the bar's More, so nothing is ever out of reach. The desktop's presets map onto
// the phone's actions the way a desktop import does (transfer.rs `phone_reader_actions`).
import { QUICK_ACTION_PRESETS } from '../utils/quickActionPresets.js';

/** What the phone can do on an open message, in the order More lists them. */
export const READER_ACTIONS = Object.freeze(['toggleRead', 'flag', 'move', 'delete', 'spam', 'reply', 'replyAll', 'forward']);
/** The bar's buttons besides More: five 68pt buttons fit a 375pt screen. */
export const BAR_LIMIT = 4;
/** The bar as it was before the setting (prefs.js and settings.rs default). */
export const DEFAULT_READER_BAR = Object.freeze(['toggleRead', 'flag', 'move', 'delete']);

const DESKTOP_TO_PHONE = {
  toggleRead: 'toggleRead', markRead: 'toggleRead', markUnread: 'toggleRead',
  star: 'flag', unstar: 'flag',
  move: 'move',
  delete: 'delete', deleteServer: 'delete', deleteEverywhere: 'delete',
  spam: 'spam',
  reply: 'reply', replyAll: 'replyAll', forward: 'forward',
};

/** A list as the bar shows it: the phone's actions only, each once, at most BAR_LIMIT. */
export function readerBar(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (READER_ACTIONS.includes(a) && !out.includes(a)) out.push(a);
  }
  return out.slice(0, BAR_LIMIT);
}

/** A desktop reader action list in the phone's actions (as transfer.rs maps an import). */
export function fromDesktop(actions) {
  return readerBar((actions || []).map((a) => DESKTOP_TO_PHONE[a]).filter(Boolean));
}

/**
 * The desktop's action sets on the phone: MailVault is the phone's own default bar, the others
 * the desktop preset's reader set mapped.
 */
export const READER_PRESETS = Object.freeze(QUICK_ACTION_PRESETS.map((p) => Object.freeze({
  id: p.id,
  labelKey: p.labelKey,
  bar: p.id === 'mailvault' ? DEFAULT_READER_BAR : fromDesktop(p.surfaces.reader.entries.map((e) => e.action)),
})));

/** The preset whose bar `list` is exactly, or null (custom). */
export function activeReaderPreset(list) {
  const bar = readerBar(list);
  const hit = READER_PRESETS.find((p) => p.bar.length === bar.length && p.bar.every((a, i) => a === bar[i]));
  return hit ? hit.id : null;
}

/**
 * The bar and More for one message: `can(action)` is false for an action this message cannot take
 * (spam with no Junk folder, or already in it).
 */
export function splitReader(list, can = () => true) {
  const bar = readerBar(list).filter(can);
  const more = READER_ACTIONS.filter((a) => !bar.includes(a) && can(a));
  return { bar, more };
}

/** The account's Junk folder (special-use `\Junk`), if it has one. */
export function junkFolder(folders) {
  return (folders || []).find((f) => !f.noselect && String(f.specialUse || '').toLowerCase() === '\\junk') || null;
}
