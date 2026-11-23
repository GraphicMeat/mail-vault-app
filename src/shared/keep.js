// Kept emails ("Keep in bubble"): the rules both apps share. Pure: no store,
// no storage, no clock (callers pass `now`).

export const MAX_KEPT = 20;
export const DEFAULT_DOCK = Object.freeze({ side: 'right', top: 0.4 });

const MIN_TOP = 0.04;
const MAX_NUDGE_TOP = 0.85;
const NUDGE = 0.05;
// Clears the phone's bottom toolbar.
export const BOTTOM_CLEARANCE = 72;
const MAX_SUBJECT = 512;

const isText = value => typeof value === 'string' && value.length > 0;
const asText = value => (typeof value === 'string' ? value : '');
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/** One message's key. */
export function keepId({ accountId, mailbox, uid }) {
  return `${accountId}|${mailbox}|${uid}`;
}

/** The stack a kept email joins: its sender, address first. */
export function senderKey(item) {
  const sender = item.sender || {};
  return (sender.address || sender.name || keepId(item)).toLowerCase();
}

function restoreItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { accountId, mailbox, uid, keptAt } = raw;
  if (!isText(accountId) || !isText(mailbox) || !Number.isInteger(uid) || uid <= 0) return null;
  if (!Number.isFinite(keptAt)) return null;
  const sender = raw.sender && typeof raw.sender === 'object' ? raw.sender : {};
  return {
    accountId, mailbox, uid, keptAt,
    subject: asText(raw.subject).slice(0, MAX_SUBJECT),
    sender: { name: asText(sender.name), address: asText(sender.address) },
  };
}

function restoreDock(raw) {
  const valid = raw && typeof raw === 'object'
    && (raw.side === 'left' || raw.side === 'right')
    && Number.isFinite(raw.top) && raw.top >= 0 && raw.top <= 1;
  return valid ? { side: raw.side, top: raw.top } : DEFAULT_DOCK;
}

/** The well-formed part of an untrusted `{ items, dock }`: the validation line for persisted input. */
export function restoreKeep(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const items = [];
  for (const candidate of Array.isArray(source.items) ? source.items : []) {
    const item = restoreItem(candidate);
    if (!item || seen.has(keepId(item))) continue;
    seen.add(keepId(item));
    items.push(item);
    if (items.length === MAX_KEPT) break;
  }
  return { items, dock: restoreDock(source.dock) };
}

/** Items minus one message. */
export function withoutId(items, id) {
  return items.filter(item => keepId(item) !== id);
}

/** Items after the reader toggle: removed when kept, else added in front; oldest drops past the cap. */
export function withToggled(items, entry, now) {
  const id = keepId(entry);
  if (items.some(item => keepId(item) === id)) return withoutId(items, id);
  return [{ ...entry, keptAt: now }, ...items].slice(0, MAX_KEPT);
}

/** Items minus one sender's stack. */
export function withoutSender(items, key) {
  return items.filter(item => senderKey(item) !== key);
}

/**
 * The store actions both apps share, over their own `set` (zustand's) and clock, so a rule change
 * touches this file only.
 */
export function keepActions(set, now) {
  return {
    /** Keep the email, or un-keep it when already kept. */
    toggle: entry => set(s => ({ items: withToggled(s.items, entry, now()) })),
    remove: id => set(s => ({ items: withoutId(s.items, id) })),
    removeSender: key => set(s => ({ items: withoutSender(s.items, key) })),
    // An invalid dock falls back to the default through the same validation as stored input.
    moveDock: dock => set({ dock: restoreKeep({ dock }).dock }),
  };
}

/**
 * The live-entity filter and grouping: items of accounts that no longer exist
 * drop out, the rest group by sender (newest first), stacks ordered by their
 * newest kept email.
 */
export function keptStacks(items, liveAccountIds) {
  const live = new Set(liveAccountIds);
  const byKey = new Map();
  for (const item of [...items].sort((a, b) => b.keptAt - a.keptAt)) {
    if (!live.has(item.accountId)) continue;
    const key = senderKey(item);
    if (!byKey.has(key)) byKey.set(key, { key, sender: item.sender, items: [] });
    byKey.get(key).items.push(item);
  }
  return [...byKey.values()];
}

/** What a stack's bubble shows in its centre: the count for a group, the sender's initial for one email. */
export function bubbleLabel({ items, sender }) {
  if (items.length > 1) return String(items.length);
  const name = (sender && (sender.name || sender.address)) || '';
  return name ? name.trim().charAt(0).toUpperCase() || '?' : '?';
}

/** The lowest top (screen fraction) at which a dock of this height still clears the bottom bar. */
const lowestTop = (height, viewportHeight) =>
  Math.max(MIN_TOP, (viewportHeight - height - BOTTOM_CLEARANCE) / viewportHeight);

/** The dock after a drop: nearer side edge, dropped height kept on screen above the bottom bar. */
export function snapDock(rect, viewport) {
  const side = rect.left + rect.width / 2 < viewport.width / 2 ? 'left' : 'right';
  return { side, top: clamp(rect.top / viewport.height, MIN_TOP, lowestTop(rect.height, viewport.height)) };
}

/**
 * The dock after an arrow key on the grip; any other key leaves it unchanged. `fit` ({ height,
 * viewportHeight }, the dock as drawn) keeps Down from pushing the dock past the bottom bar.
 */
export function nudgeDock(dock, key, fit) {
  const limit = fit ? Math.min(MAX_NUDGE_TOP, lowestTop(fit.height, fit.viewportHeight)) : MAX_NUDGE_TOP;
  if (key === 'ArrowLeft') return { ...dock, side: 'left' };
  if (key === 'ArrowRight') return { ...dock, side: 'right' };
  if (key === 'ArrowUp') return { ...dock, top: clamp(dock.top - NUDGE, MIN_TOP, limit) };
  if (key === 'ArrowDown') return { ...dock, top: clamp(dock.top + NUDGE, MIN_TOP, limit) };
  return dock;
}
