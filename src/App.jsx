import React, { useEffect, useState, useRef, useCallback, lazy, Suspense } from 'react';
import { useMailStore } from './stores/mailStore';
import { useAccountStore } from './stores/accountStore';
import { useSyncStore } from './stores/syncStore';
import { useUiStore } from './stores/uiStore';
import { useThemeStore } from './stores/themeStore';
import { useSettingsStore } from './stores/settingsStore';
import {
  clampListPaneWidth, maxListPaneWidth, MIN_LIST_WIDTH,
  clampListPaneHeight, MIN_LIST_HEIGHT, MIN_VIEWER_HEIGHT,
} from './utils/paneLayout';
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary';
import { Sidebar } from './components/Sidebar';
import { EmailList } from './components/EmailList';
import { EmailViewer } from './components/EmailViewer';
import { discardDraftFor } from './services/localDrafts';
import { Toast } from './components/Toast';
import { BulkSaveProgress } from './components/BulkSaveProgress';
import { SelectionActionBar } from './components/SelectionActionBar';
import { Onboarding } from './components/Onboarding';
import { ChatViewWrapper } from './components/ChatViewWrapper';
import { UndoSendToast } from './components/UndoSendToast';
import { OutboxTray } from './components/OutboxTray';
import { RestoreTray } from './components/RestoreTray';
import { MoveToFolderDropdown } from './components/MoveToFolderDropdown';
import { MigrationToast } from './components/MigrationToast';
import { KeychainToast } from './components/KeychainToast';
import { VaultAlertBanner } from './components/VaultAlertBanner';
import ShareUnlockModal from './components/ShareUnlockModal';
import BackupUpsellModal from './components/BackupUpsellModal.jsx';
import RestoreModal from './components/RestoreModal.jsx';
import ChangeServerModal from './components/ChangeServerModal.jsx';
// BackupToast removed — backup progress now shows in sidebar via BackupIndicator
import { useEmailScheduler } from './hooks/useEmailScheduler';
import { usePipelineCoordinator } from './hooks/usePipelineCoordinator';
import { useBackupScheduler } from './hooks/useBackupScheduler';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw, X } from 'lucide-react';
import * as bulkApi from './services/api';
import { bulkOperationManager } from './services/BulkOperationManager';
import { resolveErrorToastProps } from './utils/errorToast';
import { resolveEscapeAction } from './utils/escapeAction';
import { filterUnread } from './utils/emailParser';
import { migrationManager } from './services/migrationManager.js';
import { restoreManager } from './services/restoreManager.js';
import { setComposeOpener } from './services/localDrafts';
import { setMailtoComposeOpener } from './utils/mailto';
import { version } from '../package.json';
import { decodeImapUtf7 } from './utils/imapUtf7';

// Surfaces that only exist once the user asks for them. Keeping them in the
// startup chunk cost ~1.1 MB of JavaScript that has to parse before the first
// message list can paint — ComposeModal alone drags in TipTap and ProseMirror.
// Each one is warmed at idle below, so the first click still opens instantly.
const AccountModal = lazy(() => import('./components/AccountModal').then(m => ({ default: m.AccountModal })));
const ComposeModal = lazy(() => import('./components/ComposeModal').then(m => ({ default: m.ComposeModal })));
const SettingsPage = lazy(() => import('./components/SettingsPage').then(m => ({ default: m.SettingsPage })));
const UpdateModal = lazy(() => import('./components/UpdateModal').then(m => ({ default: m.UpdateModal })));
const ShortcutsModal = lazy(() => import('./components/ShortcutsModal').then(m => ({ default: m.ShortcutsModal })));

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
  const init = useAccountStore(s => s.init);
  const accounts = useAccountStore(s => s.accounts);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const error = useUiStore(s => s.error);
  const errorType = useUiStore(s => s.errorType);
  const errorTypeFor = useUiStore(s => s.errorTypeFor);
  const clearError = useUiStore(s => s.clearError);
  const errorToast = resolveErrorToastProps({ error, errorType, errorTypeFor });
  const loading = useSyncStore(s => s.loading);
  const initTheme = useThemeStore(s => s.initTheme);
  const userLayoutMode = useSettingsStore(s => s.layoutMode);
  const setLayoutMode = useSettingsStore(s => s.setLayoutMode);
  const viewStyle = useSettingsStore(s => s.viewStyle);
  const listPaneSize = useSettingsStore(s => s.listPaneSize);
  const setListPaneSize = useSettingsStore(s => s.setListPaneSize);
  const listPaneHeight = useSettingsStore(s => s.listPaneHeight);
  const setListPaneHeight = useSettingsStore(s => s.setListPaneHeight);
  const sidebarCollapsed = useSettingsStore(s => s.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore(s => s.setSidebarCollapsed);
  const onboardingComplete = useSettingsStore(s => s.onboardingComplete);
  const [showAccountModal, setShowAccountModal] = useState(false);

  // ── Responsive layout adaptation ─────────────────────────────────────────
  const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200);
  const [windowHeight, setWindowHeight] = useState(typeof window !== 'undefined' ? window.innerHeight : 800);
  const autoCollapsedRef = useRef(false); // true = sidebar was collapsed by responsive, not by user

  useEffect(() => {
    const onResize = () => { setWindowWidth(window.innerWidth); setWindowHeight(window.innerHeight); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Warm the deferred overlay chunks once the window is idle. They are off the
  // startup path but a person clicking Compose should never wait on a fetch.
  useEffect(() => {
    const warm = () => {
      import('./components/ComposeModal');
      import('./components/SettingsPage');
      import('./components/AccountModal');
    };
    const idle = window.requestIdleCallback;
    if (idle) {
      const handle = idle(warm, { timeout: 3000 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const t = setTimeout(warm, 1500);
    return () => clearTimeout(t);
  }, []);

  // If user manually expands sidebar while auto-collapsed, clear the flag
  // (so window resize won't re-expand what user explicitly collapsed later)
  const prevCollapsedRef = useRef(sidebarCollapsed);
  useEffect(() => {
    const prev = prevCollapsedRef.current;
    prevCollapsedRef.current = sidebarCollapsed;
    // User manually expanded while we auto-collapsed → clear flag
    if (prev && !sidebarCollapsed && autoCollapsedRef.current) {
      autoCollapsedRef.current = false;
    }
    // User manually collapsed while window is wide → ensure we don't auto-expand
    if (!prev && sidebarCollapsed && windowWidth >= 900) {
      autoCollapsedRef.current = false;
    }
  }, [sidebarCollapsed]);

  // Auto-collapse sidebar on narrow windows
  useEffect(() => {
    if (windowWidth < 900 && !sidebarCollapsed) {
      autoCollapsedRef.current = true;
      setSidebarCollapsed(true);
    } else if (windowWidth >= 900 && sidebarCollapsed && autoCollapsedRef.current) {
      autoCollapsedRef.current = false;
      setSidebarCollapsed(false);
    }
  }, [windowWidth]);

  // Auto-switch to two-column on very narrow windows
  const layoutMode = windowWidth < 768 ? 'two-column' : userLayoutMode;
  const [composeWindows, setComposeWindows] = useState([]);
  const composeIdRef = useRef(0);

  const openCompose = useCallback((state = {}) => {
    composeIdRef.current += 1;
    setComposeWindows(prev => [...prev, { id: composeIdRef.current, minimized: false, ...state }]);
  }, []);

  const closeCompose = useCallback((id) => {
    setComposeWindows(prev => prev.filter(w => w.id !== id));
  }, []);

  const minimizeCompose = useCallback((id) => {
    setComposeWindows(prev => prev.map(w => w.id === id ? { ...w, minimized: true } : w));
  }, []);

  const saveComposeState = useCallback((id, savedData) => {
    setComposeWindows(prev => prev.map(w => w.id === id ? { ...w, initialData: savedData } : w));
  }, []);

  const restoreCompose = useCallback((id) => {
    setComposeWindows(prev => prev.map(w => w.id === id ? { ...w, minimized: false } : w));
  }, []);

  // Clicking a draft row in the Drafts folder reopens it here rather than in
  // the viewer (services/localDrafts.js does the reading; a service cannot
  // reach this state, so it is handed the opener).
  //
  // A draft already open comes forward instead of opening a second window on
  // it: two windows autosaving one vault uid interleave their writes, and the
  // loser's text is gone.
  const openDraftCompose = useCallback((initialData) => {
    const already = composeWindows.find(w =>
      w.initialData?._draftUid === initialData._draftUid &&
      w.initialData?._draftMailbox === initialData._draftMailbox);
    if (already) {
      restoreCompose(already.id);
      return;
    }
    openCompose({ initialData });
  }, [composeWindows, openCompose, restoreCompose]);

  useEffect(() => {
    setComposeOpener(openDraftCompose);
    return () => setComposeOpener(null);
  }, [openDraftCompose]);

  // A mailto: link in a message body opens compose here rather than handing
  // the address to the OS mail client (see utils/mailto.js).
  useEffect(() => {
    setMailtoComposeOpener(initialData => openCompose({ initialData }));
    return () => setMailtoComposeOpener(null);
  }, [openCompose]);

  // Backwards-compatible helpers
  const composeState = composeWindows.find(w => !w.minimized) || null;
  const setComposeState = useCallback((val) => {
    if (val === null) {
      // Close the active (non-minimized) window
      setComposeWindows(prev => prev.filter(w => w.minimized));
    } else {
      openCompose(val);
    }
  }, [openCompose]);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState(null);
  const [settingsInitialAccountId, setSettingsInitialAccountId] = useState(null);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [pendingOperation, setPendingOperation] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showMoveDropdown, setShowMoveDropdown] = useState(false);
  const mainContainerRef = useRef(null);
  // Clamp list pane width so the viewer always has at least MIN_VIEWER_WIDTH.
  const sidebarWidth = sidebarCollapsed ? 56 : 256;
  const availableWidth = windowWidth - sidebarWidth;
  const maxListWidth = maxListPaneWidth(availableWidth);
  const clampedListWidth = clampListPaneWidth(listPaneSize, availableWidth);

  // Stacked layout: the window is too narrow to hold a list and a reader side
  // by side, so the two take turns instead of splitting a window neither fits
  // in. With nothing selected the list IS the screen — a placeholder telling
  // someone to pick a message, in a pane below the list they are looking at,
  // is 450px of a 900px window spent saying nothing. Once a message is open
  // the reader takes the larger share and the list keeps a scannable strip, so
  // moving to the next message never costs a trip back.
  const hasOpenMessage = useMailStore(s => !!s.selectedEmail || !!s.selectedThread);
  const stackedSolo = layoutMode === 'two-column' && !hasOpenMessage;
  const clampedListHeight = clampListPaneHeight(listPaneHeight, windowHeight);

  const listPaneStyle = layoutMode === 'three-column'
    ? { width: clampedListWidth, minWidth: MIN_LIST_WIDTH, maxWidth: maxListWidth }
    : stackedSolo
      ? { flex: '1 1 auto', minHeight: 0 }
      : { height: clampedListHeight, minHeight: MIN_LIST_HEIGHT };

  // Initialize email scheduler
  useEmailScheduler();

  // Pipeline coordinator — manages background caching for all accounts
  usePipelineCoordinator();

  // Backup scheduler — bridges backup singleton to React lifecycle
  useBackupScheduler();

  // Migration manager — listens for migration progress events and checks for incomplete migrations
  useEffect(() => {
    migrationManager.init();
    restoreManager.init();
    return () => {
      migrationManager.destroy();
      restoreManager.destroy();
    };
  }, []);

  // Keyboard shortcuts — wire all shortcut actions to app state/store methods
  useKeyboardShortcuts({
    compose: () => setComposeState({}),
    reply: () => {
      const email = useMailStore.getState().selectedEmail;
      if (email) setComposeState({ mode: 'reply', replyTo: email });
    },
    replyAll: () => {
      const email = useMailStore.getState().selectedEmail;
      if (email) setComposeState({ mode: 'replyAll', replyTo: email });
    },
    forward: () => {
      const email = useMailStore.getState().selectedEmail;
      if (email) setComposeState({ mode: 'forward', replyTo: email });
    },
    archive: () => {
      const uid = useMailStore.getState().selectedEmailId;
      if (uid) useMailStore.getState().saveEmailsLocally([uid]);
    },
    delete: () => {
      const uid = useMailStore.getState().selectedEmailId;
      if (uid) useMailStore.getState().deleteEmailFromServer(uid);
    },
    // j/k walk the list the user can actually see: with the unread filter on,
    // the store still holds every loaded message, so navigating the raw
    // sortedEmails would select rows that aren't on screen.
    nextEmail: () => {
      const { sortedEmails, selectedEmailId, selectEmail, unreadOnly } = useMailStore.getState();
      const visible = filterUnread(sortedEmails, unreadOnly, selectedEmailId);
      if (!visible.length) return;
      const idx = visible.findIndex(e => e.uid === selectedEmailId);
      const next = idx < visible.length - 1 ? idx + 1 : idx;
      if (visible[next]) selectEmail(visible[next].uid);
    },
    prevEmail: () => {
      const { sortedEmails, selectedEmailId, selectEmail, unreadOnly } = useMailStore.getState();
      const visible = filterUnread(sortedEmails, unreadOnly, selectedEmailId);
      if (!visible.length) return;
      const idx = visible.findIndex(e => e.uid === selectedEmailId);
      const prev = idx > 0 ? idx - 1 : 0;
      if (visible[prev]) selectEmail(visible[prev].uid);
    },
    goToInbox: () => { const s = useMailStore.getState(); s.activateAccount(s.activeAccountId, 'INBOX'); },
    goToSent: () => { const s = useMailStore.getState(); s.activateAccount(s.activeAccountId, 'Sent'); },
    goToDrafts: () => { const s = useMailStore.getState(); s.activateAccount(s.activeAccountId, 'Drafts'); },
    toggleSelect: () => {
      const uid = useMailStore.getState().selectedEmailId;
      if (uid) useMailStore.getState().toggleEmailSelection(uid);
    },
    escape: () => {
      const {
        selectedEmailIds, clearSelection, bulkModalOpen, bulkSession, endBulkSession,
      } = useMailStore.getState();
      const action = resolveEscapeAction({
        bulkModalOpen,
        bulkSessionActive: !!bulkSession?.active,
        selectedCount: selectedEmailIds.size,
        composeOpen: !!composeState,
        settingsOpen: showSettings,
        shortcutsOpen: showShortcutsModal,
      });
      if (action === 'end-bulk-session') endBulkSession();
      else if (action === 'clear-selection') clearSelection();
      else if (action === 'close-compose') setComposeState(null);
      else if (action === 'close-settings') setShowSettings(false);
      else if (action === 'close-shortcuts') setShowShortcutsModal(false);
    },
    focusSearch: () => {
      const input = document.querySelector('input[placeholder*="Search"]');
      if (input) input.focus();
    },
    showShortcuts: () => setShowShortcutsModal(prev => !prev),
    openSettings: () => setShowSettings(true),
    moveToFolder: () => {
      const { selectedEmailIds, selectedEmailId } = useMailStore.getState();
      // Only open if there's something to move
      if (selectedEmailIds.size > 0 || selectedEmailId) {
        setShowMoveDropdown(true);
      }
    },
  });

  // Handle resize for email list pane
  const handleListResize = useCallback((position) => {
    if (!mainContainerRef.current) return;
    const containerRect = mainContainerRef.current.getBoundingClientRect();

    if (layoutMode === 'three-column') {
      // In 3-column mode, position is X coordinate — clamp to keep viewer usable
      const sw = sidebarCollapsed ? 56 : 256;
      setListPaneSize(clampListPaneWidth(position - sw, containerRect.width));
    } else {
      // In 2-column mode, position is a Y coordinate — clamped on its own axis
      // and stored in its own setting, so a drag here never becomes a width.
      setListPaneHeight(clampListPaneHeight(position - containerRect.top, containerRect.height));
    }
  }, [layoutMode, setListPaneSize, setListPaneHeight, sidebarCollapsed]);

  const handleReportBug = useCallback(() => {
    const os = navigator.platform || navigator.userAgent || 'Unknown';
    const accountCount = accounts.length;
    const activeAccount = accounts.find(a => a.id === activeAccountId);
    const activeProvider = activeAccount?.oauth2Provider || 'password';

    // The compose editor renders this as HTML, so the template has to be HTML —
    // a \n-separated string collapses into one unreadable line.
    const esc = (v) => String(v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const section = (title, ...lines) =>
      `<p><strong>${title}</strong></p><p>${lines.join('<br>')}</p>`;

    setComposeState({
      initialData: {
        to: 'hello@mailvaultapp.com',
        subject: `[Bug Report] MailVault v${version}`,
        body: [
          section('System info (auto-collected)',
            `App version: ${esc(version)}`,
            `Platform: ${esc(os)}`,
            `Accounts: ${accountCount}`,
            `Active provider: ${esc(activeProvider)}`),
          section('What happened?', '&nbsp;'),
          section('Steps to reproduce', '1.', '2.', '3.'),
          section('What you expected instead', '&nbsp;'),
        ].join('')
      }
    });
  }, [accounts, activeAccountId]);

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

  // Listen for open-shortcuts event from native menu
  useEffect(() => {
    let unlisten;
    let active = true;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('open-shortcuts', () => {
        setShowShortcutsModal(prev => !prev);
      }).then(fn => {
        if (!active) fn();
        else unlisten = fn;
      });
    }).catch(() => {});
    return () => { active = false; if (unlisten) unlisten(); };
  }, []);

  // Listen for report-bug event from native menu
  useEffect(() => {
    let unlisten;
    let active = true;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('report-bug', () => {
        handleReportBug();
      }).then(fn => {
        if (!active) fn();
        else unlisten = fn;
      });
    }).catch(() => {});
    return () => { active = false; if (unlisten) unlisten(); };
  }, [handleReportBug]);

  // Listen for update-available event from Rust updater.
  // MAS builds rely on the App Store for updates — the event is never emitted there,
  // but we also skip the listener to avoid pulling in the Sparkle plugin module.
  useEffect(() => {
    if (import.meta.env.VITE_MV_APPSTORE === '1') return;
    let unlisten;
    let active = true;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('update-available', (event) => {
        const { version: newVersion, isManualCheck } = event.payload;
        const { updateSnoozeUntil, updateSkippedVersion } = useSettingsStore.getState();

        // For auto-checks: respect snooze and skip-version
        if (!isManualCheck) {
          if (updateSnoozeUntil && Date.now() < updateSnoozeUntil) {
            console.log('[App] Update snoozed until', new Date(updateSnoozeUntil).toISOString());
            return;
          }
          if (updateSkippedVersion === newVersion) {
            console.log('[App] Version', newVersion, 'skipped by user');
            return;
          }
        }

        // Manual check: clear stale snooze/skip so modal always shows
        if (isManualCheck) {
          useSettingsStore.getState().clearUpdateSnooze();
          if (updateSkippedVersion === newVersion) {
            useSettingsStore.getState().clearSkippedVersion();
          }
        }

        // Deduplicate: ignore if modal is already showing for the same version
        setUpdateInfo(prev => {
          if (prev && prev.version === newVersion) return prev;
          return event.payload;
        });
      }).then(fn => {
        if (!active) fn();
        else unlisten = fn;
      });
    }).catch(() => {});
    return () => { active = false; if (unlisten) unlisten(); };
  }, []);

  // Track if quick load is done
  const [quickLoadDone, setQuickLoadDone] = useState(false);
  const quickLoadHadAccountsRef = useRef(false);

  // Quick load: get accounts from disk ASAP, then activateAccount handles all email loading.
  useEffect(() => {
    const quickLoadAccounts = async () => {
      try {
        const db = await import('./services/db');
        await db.initBasic();

        // Start keychain loading in background immediately — the macOS prompt
        // appears sooner, and getAccounts() in init() won't block as long.
        db.startKeychainLoad();

        const accounts = await db.getAccountsWithoutPasswords();
        // One-time migration: move .eml files from email-address dirs to UUID dirs
        db.migrateMaildirEmailDirs(accounts).catch(() => {});
        quickLoadHadAccountsRef.current = accounts.length > 0;
        if (accounts.length > 0) {
          const { hiddenAccounts } = useSettingsStore.getState();
          const firstVisible = accounts.find(a => !hiddenAccounts[a.id]) || accounts[0];
          debugLog('[QuickLoad] Setting', accounts.length, 'accounts, firstVisible:', firstVisible.email);

          // Set accounts FIRST so the main UI renders immediately
          useMailStore.setState({
            accounts,
            activeAccountId: firstVisible.id,
            activeMailbox: 'INBOX',
            loading: true,
          });

          // activateAccount handles all local cache + server loading in parallel
          useMailStore.getState().activateAccount(firstVisible.id, 'INBOX')
            .catch(e => console.warn('[QuickLoad] activateAccount failed (non-fatal):', e));

          // Check for pending bulk operations
          try {
            const pending = await bulkApi.readPendingOperation();
            if (pending && pending.status !== 'complete') {
              const remainingCount = (pending.totalUids || []).length - (pending.completedUids || []).length;
              if (remainingCount > 0) {
                setPendingOperation(pending);
              }
            }
          } catch (e) {
            console.warn('[QuickLoad] Failed to check pending operations:', e);
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
      // If quick-load found accounts, wait 500ms so the cached UI renders first.
      // If no accounts were found (keychain-only install), skip the delay — the user
      // is staring at a "Loading..." splash and needs the keychain prompt ASAP.
      const delay = quickLoadHadAccountsRef.current ? 500 : 0;
      const timer = setTimeout(() => {
        console.log(`[App] Full initialization starting (after ${delay}ms delay)...`);

        // Failsafe: if init hangs (e.g. keychain dialog behind window), unblock after 5s
        const failsafe = setTimeout(() => {
          console.warn('[App] Init failsafe triggered — unblocking UI after 5s');
          setInitialized(true);
        }, 5000);

        init().then(() => {
          const state = useMailStore.getState();
          console.log('[App] Full init completed — emails=%d, sortedEmails=%d, loading=%s, mailboxes=%d',
            state.emails.length, state.sortedEmails.length, state.loading, state.mailboxes.length);
          clearTimeout(failsafe);
          setInitialized(true);
        }).catch((err) => {
          console.error('[App] Full init failed:', err);
          clearTimeout(failsafe);
          setInitialized(true);
        });
      }, delay);

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
              <span className="text-mail-accent-text">Mail</span>Vault
            </h1>
            <p className="text-mail-text-muted mb-4">Loading your accounts...</p>
            <RefreshCw size={24} className="animate-spin text-mail-accent-text mx-auto" />
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
              <span className="text-mail-accent-text">Mail</span>Vault
            </h1>
            <p className="text-mail-text-muted">
              A reactive email client with local storage
            </p>
          </div>

          <button
            onClick={() => setShowAccountModal(true)}
            className="px-6 py-3 bg-mail-accent-fill hover:bg-mail-accent-hover text-white
                       font-medium rounded-lg transition-colors duration-200"
          >
            Add Your First Account
          </button>

          <ChunkErrorBoundary name="Add account">
          <Suspense fallback={null}>
            <AnimatePresence>
              {showAccountModal && (
                <AccountModal onClose={() => setShowAccountModal(false)} />
              )}
            </AnimatePresence>
          </Suspense>
          </ChunkErrorBoundary>
        </motion.div>
      </div>
    );
  }
  
  return (
    <div className="h-screen bg-mail-bg flex flex-col overflow-clip">
      {/* Storage folder unreachable — blocks sync, so it sits above everything */}
      <VaultAlertBanner />
      {/* overflow-CLIP, not hidden: an overflow-hidden box is still a scroll
          container, and WebKit scrolls one sideways to reveal a text selection.
          With no scrollbar the offset sticks and the sidebar and list end up
          off-screen for good. `clip` cannot scroll at all. */}
      <div className="flex-1 flex min-w-0 min-h-0 overflow-clip">
      <div data-testid="sidebar">
        <Sidebar
          onAddAccount={() => setShowAccountModal(true)}
          onCompose={() => setComposeState({})}
          onOpenSettings={(tab) => { if (typeof tab === 'string') setSettingsInitialTab(tab); setShowSettings(true); }}
          onOpenBackup={(accountId) => { setSettingsInitialTab('backup'); setSettingsInitialAccountId(accountId || null); setShowSettings(true); }}
          onOpenAccounts={(accountId) => { setSettingsInitialTab('accounts'); setSettingsInitialAccountId(accountId || null); setShowSettings(true); }}
          onOpenDataUsage={(accountId) => { setSettingsInitialTab('data-usage'); setSettingsInitialAccountId(accountId || null); setShowSettings(true); }}
          onReportBug={handleReportBug}
        />
      </div>

      {/* Main content area with layout support.

          min-w-0 is load-bearing: without it this flex item keeps
          `min-width: auto` and refuses to shrink below its min-content width.
          A thread header subject is `truncate` (white-space: nowrap), so its
          min-content is the WHOLE subject line — a DMARC report subject blew
          this row out to ~1670px inside a 900px window and pushed the list and
          sidebar off-screen. */}
      <div
        ref={mainContainerRef}
        className={`flex-1 flex min-w-0 min-h-0 ${layoutMode === 'two-column' ? 'flex-col' : 'flex-row'}`}
      >
        {viewStyle === 'chat' ? (
          /* Chat View */
          <ChatViewWrapper onComposeReply={(mode, email) => setComposeState({ mode, replyTo: email })} />
        ) : (
          /* Traditional List View */
          <>
            {/* Email List */}
            <div
              style={listPaneStyle}
              className={`flex-shrink-0 min-h-0 flex flex-col ${layoutMode === 'three-column' ? 'border-r border-mail-border' : 'border-b border-mail-border'}`}
            >
              <EmailList />
            </div>

            {/* Divider and reader. Both stand down in the stacked layout while
                nothing is open — see `stackedSolo`. */}
            {!stackedSolo && (
              <>
                <ResizeDivider
                  orientation={layoutMode === 'three-column' ? 'vertical' : 'horizontal'}
                  onResize={handleListResize}
                />

                <div
                  className="flex-1 min-h-0 min-w-0 flex flex-col"
                  style={layoutMode === 'three-column' ? { minWidth: 300 } : { minHeight: MIN_VIEWER_HEIGHT }}
                >
                  <EmailViewer onComposeReply={(mode, email) => setComposeState({ mode, replyTo: email })} />
                </div>
              </>
            )}
          </>
        )}
      </div>

      <ChunkErrorBoundary name="Add account">
      <Suspense fallback={null}>
        <AnimatePresence>
          {showAccountModal && (
            <AccountModal onClose={() => setShowAccountModal(false)} />
          )}
        </AnimatePresence>
      </Suspense>
      </ChunkErrorBoundary>

      {/* Active (non-minimized) compose windows */}
      <ChunkErrorBoundary name="Compose">
      <Suspense fallback={null}>
      <AnimatePresence>
        {composeWindows.filter(w => !w.minimized).map(w => (
          <ComposeModal
            key={w.id}
            mode={w.initialData ? 'new' : (w.mode || 'new')}
            replyTo={w.initialData ? null : (w.replyTo || null)}
            initialData={w.initialData}
            onClose={() => closeCompose(w.id)}
            onMinimize={() => minimizeCompose(w.id)}
            onSaveState={(data) => saveComposeState(w.id, data)}
          />
        ))}
      </AnimatePresence>
      </Suspense>
      </ChunkErrorBoundary>

      {/* Minimized compose bubbles — stacked top-right */}
      {composeWindows.filter(w => w.minimized).length > 0 && (
        <div className="fixed top-16 right-4 z-40 flex flex-col gap-2">
          {composeWindows.filter(w => w.minimized).map(w => {
            const subject = w.initialData?.subject || w.replyTo?.subject || '';
            const displaySubject = w.mode === 'reply' || w.mode === 'replyAll'
              ? (subject.startsWith('Re:') ? subject : `Re: ${subject}`)
              : w.mode === 'forward'
              ? (subject.startsWith('Fwd:') ? subject : `Fwd: ${subject}`)
              : subject || 'New Message';
            const recipient = w.initialData?.to || w.replyTo?.from?.address || '';
            return (
              <motion.div
                key={w.id}
                data-testid="compose-bubble"
                initial={{ x: 100, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 100, opacity: 0 }}
                className="flex items-center gap-2 bg-mail-surface border border-mail-strong
                           rounded-lg px-3 py-2 cursor-pointer hover:bg-mail-surface-hover
                           transition-colors max-w-[280px] group"
                onClick={() => restoreCompose(w.id)}
              >
                <div className="w-7 h-7 rounded-full bg-mail-accent/20 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-semibold text-mail-accent-text">
                    {(recipient || 'N')[0].toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-mail-text truncate">{displaySubject}</p>
                  {recipient && <p className="text-[10px] text-mail-text-muted truncate">{recipient}</p>}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    // The bubble's X is a discard, so the vault draft goes too.
                    discardDraftFor(w.initialData);
                    closeCompose(w.id);
                  }}
                  className="p-0.5 hover:bg-mail-border rounded opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={12} className="text-mail-text-muted" />
                </button>
              </motion.div>
            );
          })}
        </div>
      )}

      <ChunkErrorBoundary name="Settings">
      <Suspense fallback={null}>
        <AnimatePresence>
          {showSettings && (
            <SettingsPage onClose={() => { setShowSettings(false); setSettingsInitialTab(null); setSettingsInitialAccountId(null); }} onAddAccount={() => { setShowSettings(false); setShowAccountModal(true); }} onReportBug={handleReportBug} initialTab={settingsInitialTab} initialAccountId={settingsInitialAccountId} />
          )}
        </AnimatePresence>
      </Suspense>
      </ChunkErrorBoundary>

      <AnimatePresence>
        {error && (
          <Toast message={error} onClose={clearError} type={errorToast.type} duration={errorToast.duration} />
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

      <SelectionActionBar />
      <BulkSaveProgress />
      <MigrationToast showSettings={showSettings} onOpenSettings={() => { setSettingsInitialTab('migration'); setShowSettings(true); }} />
      <KeychainToast
        onRetry={() => useMailStore.getState().retryKeychainAccess()}
        onOpenAccounts={() => { setSettingsInitialTab('accounts'); setShowSettings(true); }}
      />
      <UndoSendToast onUndo={(cs) => openCompose(cs)} />
      <OutboxTray onRestoreDraft={(cs) => openCompose(cs)} />
      <RestoreTray />
      <ShareUnlockModal onSubscribe={() => { setSettingsInitialTab('billing'); setShowSettings(true); }} />
      <BackupUpsellModal onUpgrade={() => { setSettingsInitialTab('billing'); setShowSettings(true); }} />
      <RestoreModal />
      <ChangeServerModal />

      {/* Move to Folder dropdown (triggered by keyboard shortcut M) */}
      {showMoveDropdown && (() => {
        const { selectedEmailIds, selectedEmailId } = useMailStore.getState();
        const uids = selectedEmailIds.size > 0 ? [...selectedEmailIds] : selectedEmailId ? [selectedEmailId] : [];
        if (uids.length === 0) return null;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <MoveToFolderDropdown
              uids={uids}
              onClose={() => setShowMoveDropdown(false)}
            />
          </div>
        );
      })()}

      <ChunkErrorBoundary name="Update">
      <Suspense fallback={null}>
        <AnimatePresence>
          {updateInfo && (
            <UpdateModal
              updateInfo={updateInfo}
              onClose={() => setUpdateInfo(null)}
            />
          )}
        </AnimatePresence>
      </Suspense>
      </ChunkErrorBoundary>

      <ChunkErrorBoundary name="Keyboard shortcuts">
      <Suspense fallback={null}>
        <AnimatePresence>
          {showShortcutsModal && (
            <ShortcutsModal onClose={() => setShowShortcutsModal(false)} />
          )}
        </AnimatePresence>
      </Suspense>
      </ChunkErrorBoundary>

      {/* Pending bulk operation resume banner */}
      {pendingOperation && (
        <div className="fixed top-4 right-4 z-50 bg-mail-surface border border-mail-strong rounded-xl p-4 max-w-sm">
          <p className="text-sm text-mail-text mb-3">
            You have an unfinished operation: {pendingOperation.type.replace(/_/g, ' ')} {
              ((pendingOperation.totalUids || []).length - (pendingOperation.completedUids || []).length).toLocaleString()
            } remaining emails in {decodeImapUtf7(pendingOperation.mailbox)}.
          </p>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                setPendingOperation(null);
                const accounts = useMailStore.getState().accounts;
                const account = accounts.find(a => a.id === pendingOperation.accountId);
                if (!account) return;
                await bulkOperationManager.resume(pendingOperation, account, () => {});
              }}
              className="px-3 py-1.5 text-sm font-medium bg-mail-accent-fill text-white rounded-lg
                        hover:bg-mail-accent/90 transition-colors"
            >
              Resume
            </button>
            <button
              onClick={async () => {
                setPendingOperation(null);
                await bulkApi.clearPendingOperation();
              }}
              className="px-3 py-1.5 text-sm text-mail-text-muted hover:bg-mail-border rounded-lg transition-colors"
            >
              Discard
            </button>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

export default App;
