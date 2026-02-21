import React, { useState, useMemo } from 'react';
import { useMailStore } from '../stores/mailStore';
import { groupByCorrespondent, buildThreads } from '../utils/emailParser';
import { motion, AnimatePresence } from 'framer-motion';
import { ChatSenderList } from './ChatSenderList';
import { ChatTopicsList } from './ChatTopicsList';
import { ChatBubbleView } from './ChatBubbleView';
import { ComposeModal } from './ComposeModal';

export function ChatViewWrapper({ layoutMode }) {
  const { accounts, activeAccountId, getChatEmails, emails, localEmails, sentEmails, viewMode } = useMailStore();

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
    <div className="flex-1 flex flex-col h-full min-h-0 overflow-hidden bg-mail-bg">
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
