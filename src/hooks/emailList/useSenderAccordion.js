import { useEffect, useRef, useState } from 'react';
import { rowKey, spansMailboxes } from '../../stores/slices/unifiedHelpers';
import { useMailStore } from '../../stores/mailStore';

export function useSenderAccordion({ senderGroups, isExplorer, emailListGrouping, selectEmailRow }) {
  const [expandedSender, setExpandedSender] = useState(null);
  const [expandedTopics, setExpandedTopics] = useState(new Set());
  const [expandedEmail, setExpandedEmail] = useState(null);
  const [focusedRow, setFocusedRow] = useState(null);

  const expandedSenderRef = useRef(expandedSender);
  const expandedTopicsRef = useRef(expandedTopics);
  const expandedEmailRef = useRef(expandedEmail);
  const focusedRowRef = useRef(focusedRow);
  const senderGroupsRef = useRef(senderGroups);

  useEffect(() => { expandedSenderRef.current = expandedSender; }, [expandedSender]);
  useEffect(() => { expandedTopicsRef.current = expandedTopics; }, [expandedTopics]);
  useEffect(() => { expandedEmailRef.current = expandedEmail; }, [expandedEmail]);
  useEffect(() => { focusedRowRef.current = focusedRow; }, [focusedRow]);
  useEffect(() => { senderGroupsRef.current = senderGroups; }, [senderGroups]);

  useEffect(() => {
    if (isExplorer || emailListGrouping !== 'sender') return;

    const handleKeyDown = (e) => {
      if (e.defaultPrevented || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      const groups = senderGroupsRef.current;
      if (!groups?.length) return;

      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const items = [];
        for (const sender of groups) {
          items.push({ type: 'sender', senderEmail: sender.senderEmail });
          if (expandedSenderRef.current === sender.senderEmail) {
            sender.topics.forEach((topic) => {
              const topicKey = `${sender.senderEmail}-${topic.topicId}`;
              items.push({ type: 'topic', senderEmail: sender.senderEmail, topicKey });
              if (expandedTopicsRef.current.has(topicKey)) {
                topic.emails.forEach(email => {
                  items.push({ type: 'email', senderEmail: sender.senderEmail, topicKey, emailUid: email.uid });
                });
              }
            });
          }
        }

        const current = focusedRowRef.current;
        const currentIdx = current ? items.findIndex(item =>
          item.type === current.type &&
          item.senderEmail === current.senderEmail &&
          item.topicKey === current.topicKey &&
          item.emailUid === current.emailUid
        ) : -1;

        const nextIdx = e.key === 'j'
          ? Math.min(currentIdx + 1, items.length - 1)
          : Math.max(currentIdx - 1, 0);

        setFocusedRow(items[nextIdx] || null);
      }

      if (e.key === 'Enter' && focusedRowRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const fr = focusedRowRef.current;
        if (fr.type === 'sender') {
          setExpandedSender(expandedSenderRef.current === fr.senderEmail ? null : fr.senderEmail);
          setExpandedTopics(new Set());
          setExpandedEmail(null);
        } else if (fr.type === 'topic') {
          setExpandedTopics(prev => {
            const next = new Set(prev);
            if (next.has(fr.topicKey)) next.delete(fr.topicKey);
            else next.add(fr.topicKey);
            return next;
          });
          setExpandedEmail(null);
        } else if (fr.type === 'email') {
          if (expandedEmailRef.current === fr.emailUid) {
            setExpandedEmail(null);
          } else {
            setExpandedEmail(fr.emailUid);
            const groups = senderGroupsRef.current;
            const sender = groups.find(s => s.senderEmail === fr.senderEmail);
            const topic = sender?.topics.find(t => `${fr.senderEmail}-${t.topicId}` === fr.topicKey);
            const email = topic?.emails.find(e => e.uid === fr.emailUid);
            if (email) selectEmailRow(rowKey(email, spansMailboxes(useMailStore.getState())), email);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isExplorer, emailListGrouping, selectEmailRow]);

  return { expandedSender, setExpandedSender, expandedTopics, setExpandedTopics, expandedEmail, setExpandedEmail, focusedRow, setFocusedRow };
}
