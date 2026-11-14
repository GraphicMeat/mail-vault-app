// One conversation (Settings > Appearance > Conversations, grouped or expandable): a full-screen
// layer over the list with the conversation's messages as list rows, in `threadSortOrder`
// (`mobile.messages.thread`, engine `threads.rs`). A tap opens a message in the viewer above it,
// a swipe acts on that message alone. The phone has no inline unfolding: expandable opens this
// screen too. It reads the conversation again whenever the list it came from reloads (the folder
// changed: a delete, a move, new mail), by any message it last held, and goes back to the list
// once none is left.
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { displayText } from '../utils/bidiText.js';
import MessageRow, { ROW_HEIGHT } from './MessageRow.jsx';
import { daemonCall } from './transport.js';
import { useT } from './i18n.js';
import { useMobileStore } from './store.js';

/** The conversation's messages, by the first of `uids` that is still listed. */
async function readThread(accountId, folder, uids, order) {
  for (const uid of uids) {
    const reply = await daemonCall('mobile.messages.thread', { accountId, folder, uid, order });
    if (Array.isArray(reply?.rows) && reply.rows.length) return reply.rows;
  }
  return [];
}

export default function ThreadView({ accountId, folder, row, list = null, accountOf = null, onOpen, onSwipe, onClose }) {
  const t = useT();
  const order = useMobileStore((s) => s.prefs.threadSortOrder);
  const [rows, setRows] = useState(null);
  const known = useRef([row.uid, ...(Array.isArray(row.threadUids) ? row.threadUids : [])]);
  // Bumped when the list drops its pages (its folder changed).
  const [version, bump] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    if (!list) return undefined;
    let seen = list.version;
    return list.subscribe(() => {
      if (list.version !== seen) {
        seen = list.version;
        bump();
      }
    });
  }, [list]);

  useEffect(() => {
    let live = true;
    readThread(accountId, folder, known.current, order).then(
      (got) => {
        if (!live) return;
        if (got.length) known.current = got.map((r) => r.uid);
        setRows(got);
      },
      () => { if (live) setRows((old) => old ?? []); },
    );
    return () => { live = false; };
  }, [accountId, folder, order, version]);

  // Nothing of it is left: back to the list.
  useEffect(() => {
    if (rows && rows.length === 0) onClose();
  }, [rows, onClose]);

  const subject = displayText(row.subject, t('common.noSubject'));
  return (
    <section className="mv-thread" role="dialog" aria-modal="true" aria-label={subject} data-mv-thread>
      <header className="mv-compose__bar">
        <button type="button" className="mv-compose__back" data-mv-thread-close style={{ minHeight: '44px' }} onClick={onClose}>
          {t('common.back')}
        </button>
        <h1 className="mv-compose__title" dir="auto">{subject}</h1>
      </header>
      <div className="mv-list mv-thread__list" data-mv-thread-list>
        {rows && (
          <div className="mv-list__inner" style={{ height: `${rows.length * ROW_HEIGHT}px` }}>
            {rows.map((r, i) => (
              <MessageRow
                key={r.uid}
                index={i}
                start={i * ROW_HEIGHT}
                row={r}
                account={accountOf ? accountOf(r) : undefined}
                onOpen={onOpen}
                onSwipe={onSwipe}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
