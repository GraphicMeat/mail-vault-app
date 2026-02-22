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
import { usePipelineCoordinator } from './hooks/usePipelineCoordinator';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw } from 'lucide-react';

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

// Debug: log to Rust side via invoke
const debugLog = (...args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  console.log(msg);
  window.__TAURI__?.core?.invoke?.('log_from_frontend', { message: msg }).catch(() => {});
};

function App() {
  const { init, accounts, error, clearError, connectionErrorType, emails, loading } = useMailStore();
  const { initTheme } = useThemeStore();
  const {
    layoutMode,
    viewStyle,
    listPaneSize,
    setListPaneSize,
    sidebarCollapsed,
    onboardingComplete
  } = useSettingsStore();
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const mainContainerRef = useRef(null);

  // Initialize email scheduler
  useEmailScheduler();

  // Pipeline coordinator — manages background caching for all accounts
  usePipelineCoordinator();

  // Handle resize for email list pane
  const handleListResize = useCallback((position) => {
    if (!mainContainerRef.current) return;
    const containerRect = mainContainerRef.current.getBoundingClientRect();

    if (layoutMode === 'three-column') {
      // In 3-column mode, position is X coordinate
      const sidebarWidth = sidebarCollapsed ? 56 : 256;
      const newSize = Math.max(300, Math.min(600, position - sidebarWidth));
      setListPaneSize(newSize);
    } else {
      // In 2-column mode, position is Y coordinate
      // Minimum 100px for both top and bottom sections
      const newSize = Math.max(100, Math.min(containerRect.height - 100, position - containerRect.top));
      setListPaneSize(newSize);
    }
  }, [layoutMode, setListPaneSize, sidebarCollapsed]);

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
    const invoke = window.__TAURI__?.core?.invoke;
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

  // Listen for server crash events from the Rust backend
  useEffect(() => {
    let unlisten;
    let active = true;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('server-crashed', (event) => {
        console.error('[App] Server crashed:', event.payload);
        useMailStore.setState({
          connectionStatus: 'error',
          connectionError: event.payload,
          connectionErrorType: 'serverError'
        });
      }).then(fn => {
        if (!active) fn(); // unmounted before listener ready — detach immediately
        else unlisten = fn;
      });
    }).catch(() => {}); // not in Tauri environment
    return () => { active = false; if (unlisten) unlisten(); };
  }, []);

  // Listen for open-settings event from native menu
  useEffect(() => {
    let unlisten;
    let active = true;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('open-settings', () => {
        setShowSettings(true);
      }).then(fn => {
        if (!active) fn();
        else unlisten = fn;
      });
    }).catch(() => {});
    return () => { active = false; if (unlisten) unlisten(); };
  }, []);

  // Track if quick load is done
  const [quickLoadDone, setQuickLoadDone] = useState(false);

  // Quick load: get accounts from disk ASAP so the main UI renders immediately.
  // Email headers/local data are loaded in a second phase to avoid blocking.
  useEffect(() => {
    const quickLoadAccounts = async () => {
      try {
        const db = await import('./services/db');
        await db.initBasic();
        const accounts = await db.getAccountsWithoutPasswords();
        if (accounts.length > 0) {
          const { hiddenAccounts } = useSettingsStore.getState();
          const firstVisible = accounts.find(a => !hiddenAccounts[a.id]) || accounts[0];
          debugLog('[QuickLoad] Phase 1: setting', accounts.length, 'accounts, firstVisible:', firstVisible.email);

          // Set accounts FIRST so the main UI renders immediately
          useMailStore.setState({
            accounts,
            activeAccountId: firstVisible.id,
            activeMailbox: 'INBOX',
            mailboxes: [
              { name: 'INBOX', path: 'INBOX', specialUse: null, children: [] },
              { name: 'Sent', path: 'Sent', specialUse: '\\Sent', children: [] },
              { name: 'Drafts', path: 'Drafts', specialUse: '\\Drafts', children: [] },
              { name: 'Trash', path: 'Trash', specialUse: '\\Trash', children: [] }
            ],
            loading: true,
          });

          // Phase 2: Load partial cached headers (fast) — only first 200 to avoid blocking
          // on large mailboxes (17k+ emails = 15-20MB JSON). Full cache loads during init.
          try {
            const cachedHeaders = await db.getEmailHeadersPartial(firstVisible.id, 'INBOX', 200);

            debugLog('[QuickLoad] Phase 2: cachedHeaders=' +
              (cachedHeaders ? cachedHeaders.emails.length + ' of ' + cachedHeaders.totalCached + ' emails' : 'null'));

            if (cachedHeaders && cachedHeaders.emails.length > 0) {
              const emailsByIndex = new Map();
              cachedHeaders.emails.forEach((email, idx) => {
                const index = email.displayIndex !== undefined ? email.displayIndex : idx;
                emailsByIndex.set(index, {
                  ...email,
                  source: email.source || 'server'
                });
              });

              useMailStore.setState({
                emails: cachedHeaders.emails,
                emailsByIndex,
                loadedRanges: [{ start: 0, end: cachedHeaders.emails.length }],
                totalEmails: cachedHeaders.totalEmails,
                loading: false,
                loadingMore: true, // Full cache + server sync will follow
                hasMoreEmails: cachedHeaders.emails.length < cachedHeaders.totalEmails,
                currentPage: Math.ceil(cachedHeaders.emails.length / 50) || 1
              });
              useMailStore.getState().updateSortedEmails();
              const { sortedEmails } = useMailStore.getState();
              debugLog('[QuickLoad] Phase 2 done: emails=' + cachedHeaders.emails.length +
                ', sortedEmails=' + sortedEmails.length + ', totalEmails=' + cachedHeaders.totalEmails);
            }
          } catch (e) {
            console.warn('[App] Quick load headers failed (non-fatal):', e);
          }
        }
      } catch (e) {
        console.error('[App] Quick load failed:', e);
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
      // Short delay to ensure UI has rendered before potential keychain prompt
      const timer = setTimeout(() => {
        console.log('[App] Full initialization starting (after 500ms delay)...');

        // Failsafe: if init hangs (e.g. keychain dialog behind window), unblock after 5s
        const failsafe = setTimeout(() => {
          console.warn('[App] Init failsafe triggered — unblocking UI after 5s');
          setInitialized(true);
        }, 5000);

        init().then(() => {
          console.log('[App] Full init completed');
          clearTimeout(failsafe);
          setInitialized(true);
        }).catch((err) => {
          console.error('[App] Full init failed:', err);
          clearTimeout(failsafe);
          setInitialized(true);
        });
      }, 500); // 500ms delay - enough for UI to render

      return () => clearTimeout(timer);
    }
  }, [initialized, quickLoadDone, onboardingComplete]);

  // Show onboarding if user hasn't dismissed it
  if (!onboardingComplete) {
    return <Onboarding />;
  }

  // Show welcome screen only after full init confirms there are truly no accounts.
  // Before full init, accounts.json may be empty (older installs store accounts only in keychain).
  if (accounts.length === 0) {
    if (!initialized) {
      // Still loading — show branded loading screen while keychain prompt may be active
      return (
        <div className="h-screen bg-mail-bg flex items-center justify-center pt-8">
          <div className="text-center">
            <h1 className="text-4xl font-display font-bold text-mail-text mb-4">
              <span className="text-mail-accent">Mail</span>Vault
            </h1>
            <p className="text-mail-text-muted mb-4">Loading your accounts...</p>
            <RefreshCw size={24} className="animate-spin text-mail-accent mx-auto" />
          </div>
        </div>
      );
    }
    return (
      <div className="h-screen bg-mail-bg flex items-center justify-center pt-8">
        <motion.div
          initial={{ opacity: 1, y: 0 }}
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
          <SettingsPage onClose={() => setShowSettings(false)} onAddAccount={() => { setShowSettings(false); setShowAccountModal(true); }} />
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
