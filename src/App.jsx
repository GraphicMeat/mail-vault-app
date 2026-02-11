import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useMailStore } from './stores/mailStore';
import { useThemeStore } from './stores/themeStore';
import { useSettingsStore } from './stores/settingsStore';
import { Sidebar } from './components/Sidebar';
import { EmailList } from './components/EmailList';
import { EmailViewer } from './components/EmailViewer';
import { AccountModal } from './components/AccountModal';
import { ComposeModal } from './components/ComposeModal';
import { SettingsPage } from './components/SettingsPage';
import { Toast } from './components/Toast';
import { BulkSaveProgress } from './components/BulkSaveProgress';
import { Onboarding } from './components/Onboarding';
import { ChatViewWrapper } from './components/ChatViewWrapper';
import { useEmailScheduler } from './hooks/useEmailScheduler';
import { useBackgroundCaching } from './hooks/useBackgroundCaching';
import { motion, AnimatePresence } from 'framer-motion';

// Resizable divider component
function ResizeDivider({ orientation, onResize, onResizeEnd }) {
  const [isDragging, setIsDragging] = useState(false);
  const dividerRef = useRef(null);

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e) => {
      onResize(orientation === 'vertical' ? e.clientX : e.clientY);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      onResizeEnd?.();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, onResize, onResizeEnd, orientation]);

  return (
    <div
      ref={dividerRef}
      onMouseDown={handleMouseDown}
      className={`
        ${orientation === 'vertical' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}
        bg-mail-border hover:bg-mail-accent transition-colors flex-shrink-0
        ${isDragging ? 'bg-mail-accent' : ''}
      `}
      style={{ touchAction: 'none' }}
    />
  );
}

function App() {
  const { init, accounts, error, clearError, connectionErrorType, emails, loading } = useMailStore();
  const { initTheme } = useThemeStore();
  const {
    layoutMode,
    viewStyle,
    listPaneSize,
    setListPaneSize,
    onboardingComplete
  } = useSettingsStore();
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const mainContainerRef = useRef(null);

  // Initialize email scheduler
  useEmailScheduler();

  // Background caching hook
  const { startBackgroundCaching } = useBackgroundCaching();

  // Start background caching 5 seconds after emails load (allows UI to stabilize)
  useEffect(() => {
    if (initialized && emails.length > 0 && !loading) {
      const timer = setTimeout(() => {
        console.log('[App] Starting background caching...');
        startBackgroundCaching();
      }, 5000);

      return () => clearTimeout(timer);
    }
  }, [initialized, emails.length, loading, startBackgroundCaching]);

  // Handle resize for email list pane
  const handleListResize = useCallback((position) => {
    if (!mainContainerRef.current) return;
    const containerRect = mainContainerRef.current.getBoundingClientRect();

    if (layoutMode === 'three-column') {
      // In 3-column mode, position is X coordinate
      // Sidebar is 256px (w-64)
      const sidebarWidth = 256;
      const newSize = Math.max(300, Math.min(600, position - sidebarWidth));
      setListPaneSize(newSize);
    } else {
      // In 2-column mode, position is Y coordinate
      // Minimum 100px for both top and bottom sections
      const newSize = Math.max(100, Math.min(containerRect.height - 100, position - containerRect.top));
      setListPaneSize(newSize);
    }
  }, [layoutMode, setListPaneSize]);

  // Debug: log accounts changes
  useEffect(() => {
    console.log('[App] accounts changed:', accounts.length, 'accounts');
    console.log('[App] initialized:', initialized);
    console.log('[App] onboardingComplete:', onboardingComplete);
  }, [accounts, initialized, onboardingComplete]);

  // Initialize theme immediately
  useEffect(() => {
    initTheme();
  }, []);

  // Check if running from DMG and warn user
  const [dmgWarning, setDmgWarning] = useState(null);
  useEffect(() => {
    const invoke = window.__TAURI__?.tauri?.invoke || window.__TAURI__?.invoke;
    if (invoke) {
      invoke('check_running_from_dmg')
        .then(isFromDmg => {
          if (isFromDmg) {
            setDmgWarning('Running from disk image. For best experience, please move MailVault to your Applications folder.');
          }
        })
        .catch(e => console.warn('[App] Could not check DMG status:', e));
    }
  }, []);

  // Track if quick load is done
  const [quickLoadDone, setQuickLoadDone] = useState(false);

  // Quick load accounts and local emails from DB immediately (no keychain access)
  // This allows showing the home UI with local emails right away
  useEffect(() => {
    const quickLoadAccounts = async () => {
      try {
        const db = await import('./services/db');
        await db.initDB();
        // Use getAccountsWithoutPasswords to avoid triggering keychain prompt
        const accounts = await db.getAccountsWithoutPasswords();
        if (accounts.length > 0) {
          console.log('[App] Quick loaded', accounts.length, 'accounts from DB');
          const firstAccount = accounts[0];

          // Load local emails for the first account
          const localEmails = await db.getLocalEmails(firstAccount.id, 'INBOX');
          const savedEmailIds = await db.getSavedEmailIds(firstAccount.id, 'INBOX');

          // Load cached email headers for instant display
          const cachedHeaders = await db.getEmailHeaders(firstAccount.id, 'INBOX');

          // Default mailboxes for display before server fetch
          const defaultMailboxes = [
            { name: 'INBOX', path: 'INBOX', specialUse: null, children: [] },
            { name: 'Sent', path: 'Sent', specialUse: '\\Sent', children: [] },
            { name: 'Drafts', path: 'Drafts', specialUse: '\\Drafts', children: [] },
            { name: 'Trash', path: 'Trash', specialUse: '\\Trash', children: [] }
          ];

          console.log('[App] Quick loaded', localEmails.length, 'local emails');
          if (cachedHeaders) {
            console.log('[App] Quick loaded', cachedHeaders.emails.length, 'cached headers, total:', cachedHeaders.totalEmails);
          }

          // Build sparse index from cached headers
          const emailsByIndex = new Map();
          const loadedRanges = [];
          let emails = localEmails;
          let totalEmails = 0;

          if (cachedHeaders && cachedHeaders.emails.length > 0) {
            cachedHeaders.emails.forEach((email, idx) => {
              const index = email.displayIndex !== undefined ? email.displayIndex : idx;
              emailsByIndex.set(index, {
                ...email,
                isLocal: savedEmailIds.has(email.uid),
                source: email.source || 'server'
              });
            });
            loadedRanges.push({ start: 0, end: cachedHeaders.emails.length });
            emails = cachedHeaders.emails;
            totalEmails = cachedHeaders.totalEmails;
          }

          useMailStore.setState({
            accounts,
            activeAccountId: firstAccount.id,
            activeMailbox: 'INBOX',
            mailboxes: defaultMailboxes,
            localEmails,
            savedEmailIds,
            emails,
            emailsByIndex,
            loadedRanges,
            totalEmails,
            // Important: set loading to false so cached data shows immediately
            loading: cachedHeaders && cachedHeaders.emails.length > 0 ? false : true,
            // Calculate hasMore based on what's loaded
            hasMoreEmails: cachedHeaders ? cachedHeaders.emails.length < cachedHeaders.totalEmails : true,
            currentPage: cachedHeaders ? Math.ceil(cachedHeaders.emails.length / 50) || 1 : 1
          });

          // Update sorted emails
          useMailStore.getState().updateSortedEmails();
        }
      } catch (e) {
        console.error('[App] Quick load accounts failed:', e);
      } finally {
        setQuickLoadDone(true);
      }
    };
    quickLoadAccounts();
  }, []);

  // Full initialization with delay (includes keychain access)
  // Only start after onboarding is complete, quick load is done, and UI has had time to render
  useEffect(() => {
    if (!initialized && quickLoadDone && onboardingComplete) {
      // Long delay to ensure UI is fully rendered before keychain prompt
      const timer = setTimeout(() => {
        console.log('[App] Full initialization starting (after 2s delay)...');
        init().then(() => {
          console.log('[App] Full init completed');
          setInitialized(true);
        });
      }, 2000); // 2 second delay - gives UI plenty of time to render

      return () => clearTimeout(timer);
    }
  }, [initialized, quickLoadDone, onboardingComplete]);

  // Show onboarding if user hasn't dismissed it
  if (!onboardingComplete) {
    return <Onboarding />;
  }

  // Show welcome screen if no accounts
  if (accounts.length === 0) {
    return (
      <div className="h-screen bg-mail-bg flex items-center justify-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center"
        >
          <div className="mb-8">
            <h1 className="text-4xl font-display font-bold text-mail-text mb-2">
              <span className="text-mail-accent">Mail</span>Vault
            </h1>
            <p className="text-mail-text-muted">
              A reactive email client with local storage
            </p>
          </div>
          
          <button
            onClick={() => setShowAccountModal(true)}
            className="px-6 py-3 bg-mail-accent hover:bg-mail-accent-hover text-white 
                       font-medium rounded-lg transition-all duration-200 
                       shadow-glow hover:shadow-glow-lg"
          >
            Add Your First Account
          </button>
          
          <AnimatePresence>
            {showAccountModal && (
              <AccountModal onClose={() => setShowAccountModal(false)} />
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    );
  }
  
  return (
    <div className="h-screen bg-mail-bg flex overflow-hidden">
      <Sidebar
        onAddAccount={() => setShowAccountModal(true)}
        onCompose={() => setShowCompose(true)}
        onOpenSettings={() => setShowSettings(true)}
      />

      {/* Main content area with layout support */}
      <div
        ref={mainContainerRef}
        className={`flex-1 flex min-h-0 ${layoutMode === 'two-column' ? 'flex-col' : 'flex-row'}`}
      >
        {viewStyle === 'chat' ? (
          /* Chat View */
          <ChatViewWrapper layoutMode={layoutMode} />
        ) : (
          /* Traditional List View */
          <>
            {/* Email List */}
            <div
              style={layoutMode === 'three-column'
                ? { width: listPaneSize, minWidth: 300, maxWidth: 600 }
                : { height: listPaneSize, minHeight: 100 }
              }
              className="flex-shrink-0 min-h-0 flex flex-col"
            >
              <EmailList layoutMode={layoutMode} />
            </div>

            {/* Resizable divider */}
            <ResizeDivider
              orientation={layoutMode === 'three-column' ? 'vertical' : 'horizontal'}
              onResize={handleListResize}
            />

            {/* Email Viewer */}
            <div
              className="flex-1 min-h-0 flex flex-col"
              style={layoutMode === 'two-column' ? { minHeight: 100 } : undefined}
            >
              <EmailViewer />
            </div>
          </>
        )}
      </div>

      <AnimatePresence>
        {showAccountModal && (
          <AccountModal onClose={() => setShowAccountModal(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showCompose && (
          <ComposeModal
            mode="new"
            onClose={() => setShowCompose(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSettings && (
          <SettingsPage onClose={() => setShowSettings(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {error && (
          <Toast message={error} onClose={clearError} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {dmgWarning && (
          <Toast
            message={dmgWarning}
            onClose={() => setDmgWarning(null)}
            type="warning"
            duration={10000}
          />
        )}
      </AnimatePresence>

      <BulkSaveProgress />
    </div>
  );
}

export default App;
