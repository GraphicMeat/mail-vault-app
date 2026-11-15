// The chat view (Settings > Appearance > Mail view: `viewStyle` chat, desktop's ChatViewWrapper):
// in place of the message list, the open folder's mail by person (`mobile.chat.people`), then one
// person's conversations (`mobile.chat.topics`, engine `chat.rs`). A topic is a list row like the
// threaded list's: a tap opens the conversation screen (ThreadView) or the message, a swipe acts on
// it. Both read again whenever the folder's list reloads (`list.version` moves: new mail, a delete,
// a move), and a row waiting out its undo toast is left out, as in the list.
import React, { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { displayText } from '../utils/bidiText.js';
import MessageRow from './MessageRow.jsx';
import { rowHeight } from './prefs.js';
import { daemonCall } from './transport.js';
import { formatEmailDate } from './format.js';
import { useT } from './i18n.js';
import { useMobileStore } from './store.js';
import { useBackLayer } from './backStack.js';

/** The list's `version`, as state: it moves whenever the folder's rows change. */
function useListVersion(list) {
  const [, bump] = useReducer((n) => n + 1, 0);
  useEffect(() => (list ? list.subscribe(bump) : undefined), [list]);
  return list ? list.version : 0;
}

/**
 * The people, virtualized like the message list: one row height from the preferences (text size,
 * density, preview lines; MessageList.jsx), nothing measured. A person row always has its address
 * line, so it is never shorter than one preview line.
 */
function People({ people, onPick }) {
  const t = useT();
  const dates = useMobileStore((s) => s.prefs);
  const height = useMobileStore((s) => rowHeight({ ...s.prefs, listPreviewLines: Math.max(1, s.prefs.listPreviewLines ?? 1) }));
  const scrollRef = useRef(null);
  const virtualizer = useVirtualizer({
    count: people.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => height,
    overscan: 8,
  });
  // A preference changed the height: every position is recomputed from the new estimate.
  const measured = useRef(height);
  useLayoutEffect(() => {
    if (measured.current === height) return;
    measured.current = height;
    virtualizer.measure();
  }, [height, virtualizer]);
  if (!people.length) return <div className="mv-list"><p className="mv-list__empty">{t('mobile.list.empty')}</p></div>;
  return (
    <div ref={scrollRef} className="mv-list">
      <div className="mv-list__inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map(({ index, start }) => {
          const p = people[index];
          return (
            <div
              key={p.email}
              className="mv-row-slot"
              data-mv-chat-person={p.email}
              style={{ height: `${height}px`, transform: `translateY(${start}px)` }}
            >
              <button type="button" className={p.unread > 0 ? 'mv-row mv-row--unread' : 'mv-row'} onClick={() => onPick(p)}>
                <span className="mv-row__top">
                  <span className="mv-row__sender" dir="auto">{displayText(p.name, p.email)}</span>
                  {p.count > 1 && (
                    <span className="mv-row__count" role="img" aria-label={t('email.thread.messagesInThread', { count: p.count })}>
                      {p.count}
                    </span>
                  )}
                  <span className="mv-row__date">{formatEmailDate(p.lastDateMs, undefined, dates)}</span>
                </span>
                <span className="mv-row__subject" dir="auto">{displayText(p.lastSubject, t('common.noSubject'))}</span>
                <span className="mv-row__snippet" dir="auto">{p.email}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ChatView({ accountId, folder, list, onOpen, onSwipe }) {
  const t = useT();
  const version = useListVersion(list);
  const [people, setPeople] = useState(null);
  const [person, setPerson] = useState(null);
  const [topics, setTopics] = useState(null);
  const height = useMobileStore((s) => rowHeight(s.prefs));

  useEffect(() => {
    let live = true;
    daemonCall('mobile.chat.people', { accountId, folder }).then(
      (reply) => { if (live) setPeople(Array.isArray(reply?.people) ? reply.people : []); },
      () => { if (live) setPeople((old) => old ?? []); },
    );
    return () => { live = false; };
  }, [accountId, folder, version]);

  useEffect(() => {
    if (!person) {
      setTopics(null);
      return undefined;
    }
    let live = true;
    daemonCall('mobile.chat.topics', { accountId, folder, email: person.email }).then(
      (reply) => { if (live) setTopics(Array.isArray(reply?.rows) ? reply.rows : []); },
      () => { if (live) setTopics((old) => old ?? []); },
    );
    return () => { live = false; };
  }, [accountId, folder, person, version]);

  const back = () => setPerson(null);
  useBackLayer(Boolean(person), back);

  // Nothing of theirs is left: back to the people.
  useEffect(() => {
    if (person && topics && topics.length === 0) setPerson(null);
  }, [person, topics]);

  const shown = topics && list?.isHidden ? topics.filter((r) => !list.isHidden(list.keyFor(accountId, r.uid))) : topics;

  if (person) {
    return (
      <div className="mv-list-wrap" data-mv-chat="topics">
        <header className="mv-compose__bar">
          <button type="button" className="mv-compose__back" data-mv-chat-back style={{ minHeight: '44px' }} onClick={back}>
            {t('common.back')}
          </button>
          <h1 className="mv-compose__title" dir="auto">{displayText(person.name, person.email)}</h1>
        </header>
        <div className="mv-list">
          {shown && (
            <div className="mv-list__inner" style={{ height: `${shown.length * height}px` }}>
              {shown.map((r, i) => (
                <MessageRow key={r.uid} index={i} start={i * height} row={r} onOpen={onOpen} onSwipe={onSwipe} />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="mv-list-wrap" data-mv-chat="people">
      {people && <People people={people} onPick={setPerson} />}
    </div>
  );
}
