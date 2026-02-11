import React, { useState, useMemo } from 'react';
import { useMailStore } from '../stores/mailStore';
import { motion, AnimatePresence } from 'framer-motion';
import { ChatSenderList } from './ChatSenderList';
import { ChatTopicsList } from './ChatTopicsList';
import { ChatBubbleView } from './ChatBubbleView';
import { ComposeModal } from './ComposeModal';

export function ChatViewWrapper({ layoutMode }) {
  const { accounts, activeAccountId } = useMailStore();

  // Per-account navigation state: { accountId: { correspondent, topic } }
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

  // Get current account's navigation state
  const currentNavState = accountNavState[activeAccountId] || {};
  const selectedCorrespondent = currentNavState.correspondent || null;
  const selectedTopic = currentNavState.topic || null;

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

  // Handlers
  const handleSelectSender = (correspondent) => {
    updateNavState({ correspondent, topic: null });
  };

  const handleSelectTopic = (topic) => {
    updateNavState({ topic });
  };

  const handleBackFromTopics = () => {
    updateNavState({ correspondent: null, topic: null });
  };

  const handleBackFromChat = () => {
    updateNavState({ topic: null });
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
  const currentView = selectedTopic ? 'chat' : selectedCorrespondent ? 'topics' : 'senders';

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

        {currentView === 'chat' && selectedCorrespondent && selectedTopic && (
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
              topic={selectedTopic}
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
