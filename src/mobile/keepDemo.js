// `?ui=keep` (perf-gate builds only): stages the phone's kept-email dock for the store screenshot.
// Keeps the first three messages of the first sender with two or more on the page, plus one other
// message (kept first, so the group is the newest stack), then opens the viewer on the first kept
// message and reports how far the group's count sits from the bubble's centre.
import { useKeepStore } from './keep.js';
import { keepId } from '../shared/keep';

const senderOf = (row) => (row.fromAddress || row.fromName || '').toLowerCase();

/** `{ group, other }` from the list's rows: the sender's first three rows, one row of someone else. */
export function pickKeepDemo(rows) {
  const bySender = new Map();
  for (const row of rows) {
    const key = senderOf(row);
    if (key) bySender.set(key, [...(bySender.get(key) || []), row]);
  }
  const group = [...bySender.values()].find((list) => list.length >= 2)?.slice(0, 3);
  const other = group && rows.find((row) => senderOf(row) && senderOf(row) !== senderOf(group[0]));
  return group && other ? { group, other } : null;
}

function centreOffset() {
  const bubble = document.querySelector('.keep-bubble[data-group]');
  const count = bubble?.querySelector('.keep-count');
  if (!bubble || !count) return null;
  const a = bubble.getBoundingClientRect();
  const b = count.getBoundingClientRect();
  return { dx: b.left + b.width / 2 - (a.left + a.width / 2), dy: b.top + b.height / 2 - (a.top + a.height / 2) };
}

export function stageKeepDemo({ list, placeOf, openRow, log }) {
  const rows = Array.from({ length: Math.min(list.total, 50) }, (_, i) => list.rowAt(i)).filter(Boolean);
  const picked = pickKeepDemo(rows);
  if (!picked) {
    log({ demo: 'keep', error: 'no sender with two messages on the first page' });
    return;
  }
  const entryOf = (row) => {
    const { accountId, folder } = placeOf(row);
    return {
      accountId, mailbox: folder, uid: row.uid, subject: row.subject || '',
      sender: { name: row.fromName || '', address: row.fromAddress || '' },
    };
  };
  const { toggle, items } = useKeepStore.getState();
  const isKept = (entry) => items.some((item) => keepId(item) === keepId(entry));
  for (const row of [picked.other, ...[...picked.group].reverse()]) {
    const entry = entryOf(row);
    if (!isKept(entry)) toggle(entry);
  }
  openRow(picked.group[0]);
  setTimeout(() => log({ demo: 'keep', ...centreOffset() }), 1500);
}
