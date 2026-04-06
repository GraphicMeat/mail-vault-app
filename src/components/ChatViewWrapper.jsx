import React, { memo, useState, useMemo, useEffect, useRef } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useMessageListStore } from '../stores/messageListStore';
import { useUiStore } from '../stores/uiStore';
import { useShallow } from 'zustand/react/shallow';
import { groupByCorrespondent, buildThreads } from '../utils/emailParser';
import { motion, AnimatePresence } from 'framer-motion';
import { ChatSenderList } from './ChatSenderList';
import { ChatTopicsList } from './ChatTopicsList';
import { ChatBubbleView } from './ChatBubbleView';
import { ComposeModal } from './ComposeModal';

function ChatViewWrapperComponent() {
  const { accounts, activeAccountId, getChatEmails } = useAccountStore(
    useShallow(s => ({ accounts: s.accounts, activeAccountId: s.activeAccountId, getChatEmails: s.getChatEmails }))
  );
  const { emails, localEmails, sentEmails } = useMessageListStore(
    useShallow(s => ({ emails: s.emails, localEmails: s.localEmails, sentEmails: s.sentEmails }))
  );
  const viewMode = useUiStore(s => s.viewMode);

  // Per-account navigation state: only store identifiers, not full objects
  // { accountId: { correspondentEmail: string, threadId: string } }
  const [accountNavState, setAccountNavState] = useState({});

  // Compose modal state
  const [showCompose, setShowCompose] = useState(false);
  const [replyEmail, setReplyEmail] = useState(null);
  const [replyMode, setReplyMode] = useState('reply');

  // Get current user's email
  const userEmail = useMemo(() => {
    const activeAccount = accounts.find(a => a.id === activeAccountId);
    return activeAccount?.email || '';
  }, [accounts, activeAccountId]);

  // Get current account's navigation state (identifiers only)
  const currentNavState = accountNavState[activeAccountId] || {};
  const selectedCorrespondentEmail = currentNavState.correspondentEmail || null;
  const selectedThreadId = currentNavState.threadId || null;

  // Derive live correspondent and topic data from current store state
  const combinedEmails = getChatEmails();

  const correspondentMap = useMemo(() => {
    return groupByCorrespondent(combinedEmails, userEmail);
  }, [combinedEmails, userEmail]);

  // Re-derive the full correspondent object from live data
  const selectedCorrespondent = selectedCorrespondentEmail
    ? correspondentMap.get(selectedCorrespondentEmail) || null
    : null;

  // Compute threads ONCE per correspondent — shared by ChatTopicsList and ChatBubbleView
  const threadCache = useRef({ fingerprint: '', threads: null, sortedTopics: [] });

  const threadFingerprint = useMemo(() => {
    if (!selectedCorrespondent) return '';
    const emails = selectedCorrespondent.emails;
    return `${selectedCorrespondentEmail}-${emails.length}-${emails[0]?.uid || 0}-${emails[emails.length - 1]?.uid || 0}`;
  }, [selectedCorrespondent, selectedCorrespondentEmail]);

  const [threadsMap, setThreadsMap] = useState(null);
  const [sortedTopics, setSortedTopics] = useState([]);

  useEffect(() => {
    if (!selectedCorrespondent) {
      setThreadsMap(null);
      setSortedTopics([]);
      return;
    }

    // Use cached result if fingerprint matches
    if (threadCache.current.fingerprint === threadFingerprint) {
      setThreadsMap(threadCache.current.threads);
      setSortedTopics(threadCache.current.sortedTopics);
      return;
    }

    const timer = setTimeout(() => {
      const threads = buildThreads(selectedCorrespondent.emails);
      const sorted = Array.from(threads.values())
        .sort((a, b) => {
          const dateA = a.dateRange.end || new Date(0);
          const dateB = b.dateRange.end || new Date(0);
          return dateB - dateA;
        });
      threadCache.current = { fingerprint: threadFingerprint, threads, sortedTopics: sorted };
      setThreadsMap(threads);
      setSortedTopics(sorted);
    }, 0);

    return () => clearTimeout(timer);
  }, [selectedCorrespondent, threadFingerprint]);

  // Helper to update navigation state for current account
  const updateNavState = (updates) => {
    setAccountNavState(prev => ({
      ...prev,
      [activeAccountId]: {
        ...prev[activeAccountId],
        ...updates
      }
    }));
  };

  // Handlers — store only identifiers
  const handleSelectSender = (correspondent) => {
    updateNavState({ correspondentEmail: correspondent.email, threadId: null });
  };

  const handleSelectTopic = (topic) => {
    updateNavState({ threadId: topic.threadId });
  };

  const handleBackFromTopics = () => {
    updateNavState({ correspondentEmail: null, threadId: null });
  };

  const handleBackFromChat = () => {
    updateNavState({ threadId: null });
  };

  const handleReply = (email, mode = 'reply') => {
    setReplyEmail(email);
    setReplyMode(mode);
    setShowCompose(true);
  };

  const handleCloseCompose = () => {
    setShowCompose(false);
    setReplyEmail(null);
    setReplyMode('reply');
  };

  // Determine current view
  const currentView = selectedThreadId && selectedCorrespondent
    ? 'chat'
    : selectedCorrespondent
      ? 'topics'
      : 'senders';

  return (
    <div data-testid="chat-view" className="flex-1 flex flex-col h-full min-h-0 overflow-hidden bg-mail-bg">
      <AnimatePresence mode="wait">
        {currentView === 'senders' && (
          <motion.div
            key="senders"
            initial={{ x: -20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -20, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex-1 min-h-0 overflow-hidden"
          >
            <ChatSenderList onSelectSender={handleSelectSender} />
          </motion.div>
        )}

        {currentView === 'topics' && selectedCorrespondent && (
          <motion.div
            key="topics"
            initial={{ x: 20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 20, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex-1 min-h-0 overflow-hidden"
          >
            <ChatTopicsList
              correspondent={selectedCorrespondent}
              topics={sortedTopics}
              onBack={handleBackFromTopics}
              onSelectTopic={handleSelectTopic}
            />
          </motion.div>
        )}

        {currentView === 'chat' && selectedCorrespondent && selectedThreadId && (
          <motion.div
            key="chat"
            initial={{ x: 20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 20, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex-1 min-h-0 overflow-hidden"
          >
            <ChatBubbleView
              correspondent={selectedCorrespondent}
              threadId={selectedThreadId}
              threadsMap={threadsMap}
              userEmail={userEmail}
              onBack={handleBackFromChat}
              onReply={handleReply}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Compose Modal */}
      <AnimatePresence>
        {showCompose && (
          <ComposeModal
            mode={replyMode}
            replyTo={replyEmail}
            onClose={handleCloseCompose}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export const ChatViewWrapper = memo(ChatViewWrapperComponent);
