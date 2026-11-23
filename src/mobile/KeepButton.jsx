// The viewer's "Keep in bubble" toggle: keeps the open message in the floating dock (KeepDock.jsx),
// or takes it out again.
import React from 'react';
import { useKeepStore } from './keep.js';
import { useT } from './i18n.js';
import { BookmarkIcon } from './icons.jsx';
import { keepId } from '../shared/keep';

export default function KeepButton({ accountId, folder, row }) {
  const t = useT();
  const identity = { accountId, mailbox: folder, uid: row.uid };
  const kept = useKeepStore((s) => s.items.some((item) => keepId(item) === keepId(identity)));
  const label = t(kept ? 'keep.remove' : 'keep.add');
  return (
    <button
      type="button"
      className="mv-iconbtn"
      data-mv-keep
      aria-pressed={kept}
      aria-label={label}
      title={label}
      onClick={() => useKeepStore.getState().toggle({
        ...identity,
        subject: row.subject || '',
        sender: { name: row.fromName || '', address: row.fromAddress || '' },
      })}
    >
      <BookmarkIcon filled={kept} />
    </button>
  );
}
