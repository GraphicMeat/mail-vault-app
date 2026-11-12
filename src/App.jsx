import React, { useEffect, useState, useRef, useCallback, lazy, Suspense } from 'react';
import { bootstrapTags } from './services/tagMigration';
import { initTagEvents } from './stores/tagStore';
import { initScheduledSend } from './stores/scheduledStore';
import { initSnooze } from './stores/snoozeStore';
import { initFollowUp } from './stores/followUpStore';
import { initAutoTags } from './stores/autoTagStore';
import { useMailStore } from './stores/mailStore';
import { useNetActivityStore } from './stores/netActivityStore';
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
import { LifecycleMessageView } from './components/LifecycleMessageView';
import { Toast } from './components/Toast';
import { BulkSaveProgress } from './components/BulkSaveProgress';
import { AbdProgressPanel } from './components/abd/AbdProgressPanel';
import { AbdPill } from './components/abd/AbdPill';
import { SelectionActionBar } from './components/SelectionActionBar';
import { Onboarding } from './components/Onboarding';
import { MailArrivalCelebration } from './components/MailArrivalCelebration';
import { OnboardingRefreshPrompt } from './components/onboarding/OnboardingRefreshPrompt';
import { OnboardingResumePrompt } from './components/onboarding/OnboardingResumePrompt';
import { ChatViewWrapper } from './components/ChatViewWrapper';
import { UndoSendToast } from './components/UndoSendToast';
import { UndoToast } from './components/UndoToast';
import { ToastDockHost } from './components/ui/ToastDock';
import { UnsubscribeHost } from './components/UnsubscribeHost';
import { OutboxTray } from './components/OutboxTray';
import { RestoreTray } from './components/RestoreTray';
import { SettingsBubble } from './components/settings/SettingsBubble';
import { CodeBubbles } from './components/CodeBubble';
import { useCodeBubbleStore } from './stores/codeBubbleStore';
import { useUnsavedStore } from './stores/unsavedStore';
import { MoveToFolderDropdown } from './components/MoveToFolderDropdown';
import { SnoozePicker } from './components/SnoozePicker';
import { MigrationToast } from './components/MigrationToast';
import { SearchIndexReindexPrompt } from './components/SearchIndexReindexPrompt';
import { UpdateInstallFailedPrompt } from './components/UpdateInstallFailedPrompt';
import { KeychainToast } from './components/KeychainToast';
import { KeychainUnlockCard } from './components/KeychainUnlockCard';
import { PortableUnlockCard } from './components/PortableUnlockCard';
import { VaultAlertBanner } from './components/VaultAlertBanner';
import { PortableDriveBanner } from './components/PortableIndicators';
import { SearchIndexProgress } from './components/SearchIndexProgress';
import { ViewsReindexNotice } from './components/ViewsReindexNotice';
import { MboxUploadProgress } from './components/MboxUploadProgress';
import { FolderMoveProgress } from './components/FolderMoveProgress';
import { FormatMigrationProgress } from './components/FormatMigrationProgress';
import { OfflineBanner } from './components/OfflineBanner';
import { GraphImapBanner } from './components/GraphImapBanner';
import { BugReportDialog } from './components/BugReportDialog';
import { FocusLock } from './components/FocusLock';
import { PrivacyDictionaryHost } from './components/privacy/PrivacyDictionaryHost';
import { usePrivacyStore, isPrivacyMasking } from './stores/privacyStore';
import { usePrivacyPeekListeners } from './hooks/usePrivacy';
import ShareUnlockModal from './components/ShareUnlockModal';
import { PendingActionsReminder } from './components/PendingActionsReminder';
import BackupUpsellModal from './components/BackupUpsellModal.jsx';
import { ExportDialog } from './components/export/ExportDialog.jsx';
import { ExportUpsellModal } from './components/export/ExportUpsellModal.jsx';
import { useExportStore } from './stores/exportStore.js';
import RestoreModal from './components/RestoreModal.jsx';
import ChangeServerModal from './components/ChangeServerModal.jsx';
// BackupToast removed — backup progress now shows in sidebar via BackupIndicator
import { useEmailScheduler } from './hooks/useEmailScheduler';
import { useLifecycleMail } from './hooks/useLifecycleMail';
import { useLifecycleStore } from './stores/lifecycleStore';
import { useUpdateAvailable } from './hooks/useUpdateAvailable';
import { usePipelineCoordinator } from './hooks/usePipelineCoordinator';
import { useAfterSettingsClose, useSettingsWindow } from './hooks/useSettingsWindow';
import { useExportWindow } from './hooks/useExportWindow';
import { currentQuickActionScopeSnapshot, watchQuickActionScope } from './hooks/useQuickActionConfiguration';
import { useSearchIndexConfig } from './hooks/useSearchIndexConfig';
import { useOverlayPages } from './hooks/app/useOverlayPages';
import { useWindowSize } from './hooks/app/useWindowSize';
import { useAutoCollapseSidebar } from './hooks/app/useAutoCollapseSidebar';
import { useComposeWindows } from './hooks/app/useComposeWindows';
import { useAppShortcuts } from './hooks/app/useAppShortcuts';
import { useNativeBridges } from './hooks/app/useNativeBridges';
import { useStartupLoad } from './hooks/app/useStartupLoad';
import { useComposePrefills } from './hooks/app/useComposePrefills';
import { useDmgWarning } from './hooks/app/useDmgWarning';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw, X } from 'lucide-react';
import { BulkPendingOperationBanner } from './components/BulkPendingOperationBanner';
import { resolveErrorToastProps } from './utils/errorToast';
import { shouldStartFullInit } from './utils/shouldStartFullInit';
import { migrationManager } from './services/migrationManager.js';
import { initAbd } from './services/abd.js';
import { initOAuthCredentialProjection } from './services/oauthCredentialProjection.js';
import { useAbdStore } from './stores/abdStore';
import { restoreManager } from './services/restoreManager.js';
import { retryMailtoCompose } from './utils/mailto';
import { openNotificationTarget } from './utils/notificationOpen';
import { isTerminalCompose, composeSessionData } from './services/composeSession';
import { openInBrowser } from './services/billingApi';
import { faqUrl } from './services/faqUrl';
import { tErr, t as tr, useT, setLocale } from './i18n/index.js';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getAccountCacheMailboxes } from './services/cacheManager';

// Surfaces that only exist once the user asks for them. Keeping them in the
// startup chunk cost ~1.1 MB of JavaScript that has to parse before the first
// message list can paint — ComposeModal alone drags in TipTap and ProseMirror.
// Each one is warmed at idle below, so the first click still opens instantly.
const InsightsPage = lazy(() => import('./components/insights/InsightsPage'));
const NotesBoard = lazy(() => import('./components/notes/NotesBoard'));
const ContactsView = lazy(() => import('./components/contacts/ContactsView').then(m => ({ default: m.ContactsView })));

const AccountModal = lazy(() => import('./components/AccountModal').then(m => ({ default: m.AccountModal })));
const ExportModal = lazy(() => import('./components/transfer/ExportModal').then(m => ({ default: m.ExportModal })));
const ImportModal = lazy(() => import('./components/transfer/ImportModal').then(m => ({ default: m.ImportModal })));
const PhoneQrModal = lazy(() => import('./components/transfer/PhoneQrModal').then(m => ({ default: m.PhoneQrModal })));
const ComposeModal = lazy(() => import('./components/ComposeModal').then(m => ({ default: m.ComposeModal })));
const SettingsPage = lazy(() => import('./components/SettingsPage').then(m => ({ default: m.SettingsPage })));
const UpdateModal = lazy(() => import('./components/UpdateModal').then(m => ({ default: m.UpdateModal })));
const ShortcutsModal = lazy(() => import('./components/ShortcutsModal').then(m => ({ default: m.ShortcutsModal })));

// Resizable divider component
function ResizeDivider({ orientation, onResize, onResizeEnd }) {
  const t = useT();
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
      role="separator" tabIndex={0} aria-orientation={orientation}
      aria-label={t('workspace.resizePanes')}
      onKeyDown={e => {
        const keys = orientation === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
        if (!keys.includes(e.key)) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onResize((orientation === 'vertical' ? rect.left : rect.top) + (e.key === keys[0] ? -20 : 20));
        onResizeEnd?.();
      }}
      onMouseDown={handleMouseDown}
      className={`
        ${orientation === 'vertical' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}
        mail-pane-divider hover:bg-mail-accent transition-colors flex-shrink-0
        ${isDragging ? 'bg-mail-accent' : ''}
      `}
      style={{ touchAction: 'none' }}
    />
  );
}

function App() {
  const t = useT();
  const { insightsOpen, notesOpen, contactsOpen, overlayOpen, openInsights, closeInsights, openNotes, closeNotes, openContacts, closeContacts, openMailFromSidebar } = useOverlayPages();
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
  const language = useSettingsStore(s => s.language);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [mailArrivalKind, setMailArrivalKind] = useState(null);
  const mailArrival = mailArrivalKind && (
    <MailArrivalCelebration kind={mailArrivalKind} onClose={() => setMailArrivalKind(null)} />
  );
  const accountAdded = () => {
    setShowAccountModal(false);
    setMailArrivalKind('account');
  };
  // Account transfer: main window only, even when asked from the detached Settings window.
  const [showExportModal, setShowExportModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showPhoneQrModal, setShowPhoneQrModal] = useState(false);

  // ── Responsive layout adaptation ─────────────────────────────────────────
  const { windowWidth, windowHeight } = useWindowSize();

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

  useAutoCollapseSidebar({ windowWidth, sidebarCollapsed, setSidebarCollapsed });

  // Auto-switch to two-column on very narrow windows
  const layoutMode = windowWidth < 768 ? 'two-column' : userLayoutMode;
  const { composeWindows, mailtoError, setMailtoError, composeState, setComposeState, openCompose, closeCompose, minimizeCompose, restoreCompose, canMountCompose, saveComposeState, cleanupComposeDraft, retryComposeCleanup, composeWindowOwnerRef } = useComposeWindows();

  // A minimized Archive & delete job shares the corner stack below.
  const abdMinimized = useAbdStore(s => !!s.panel?.minimized && !!s.jobs[s.panel.accountId]);
  // One-time codes that arrived by mail sit in the same stack.
  const codeBubblesShown = useCodeBubbleStore(s => s.bubbles.length > 0);
  const exportTarget = useExportStore(s => s.target);
  const showExportSamples = useExportStore(s => s.showSamples);
  const closeExport = useExportStore(s => s.closeExport);
  const openSamples = useExportStore(s => s.openSamples);
  const closeSamples = useExportStore(s => s.closeSamples);
  // The export in a window of its own, and back into the dialog.
  // Not window.__TAURI__: the website demo fakes that one, and has no windows.
  const isTauri = Boolean(window.__TAURI_INTERNALS__);
  // `initial` is the dialog's { format, files, social? } on the way out and the
  // window's on the way back, each panel's choices under its own name.
  const { popOut: popOutExport } = useExportWindow({
    onDock: ({ messages, account, mailbox, initial }) => useExportStore.getState()
      .openExport({ messages, account, mailbox, files: initial?.files, social: initial?.social }),
  });
  const handleExportPopOut = useCallback(async (initial) => {
    const target = useExportStore.getState().target;
    if (!target?.messages?.length) return;
    const { messages, account, mailbox } = target;
    if (await popOutExport({ messages, account, mailbox, initial })) closeExport();
  }, [popOutExport, closeExport]);

  const {
    isOpen: showSettings,
    isMounted: settingsMounted,
    isMinimized: settingsMinimized,
    request: settingsWindowRequest,
    openSettings,
    closeSettings,
    minimizeSettings,
  } = useSettingsWindow();
  const afterSettingsClose = useAfterSettingsClose(settingsMounted);
  const [settingsLocation, setSettingsLocation] = useState('');
  useEffect(() => {
    if (!settingsMounted) setSettingsLocation('');
  }, [settingsMounted]);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  // A leaf asked for a Settings tab (the tracker glyph's upsell, from a row or
  // the reading pane). Consume the request so the same tab can be asked for
  // again after the dialog closes.
  const settingsRequest = useMailStore(s => s.settingsRequest);
  useEffect(() => {
    if (!settingsRequest) return;
    const { tab, accountId, section } = settingsRequest;
    openSettings({ tab, accountId, section });
    useMailStore.getState().clearSettingsRequest();
  }, [settingsRequest, openSettings]);

  const [showBugModal, setShowBugModal] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [pendingOperation, setPendingOperation] = useState(null);
  const { updateInfo, setUpdateInfo } = useUpdateAvailable();
  const [showMoveDropdown, setShowMoveDropdown] = useState(false);
  const [snoozeKeys, setSnoozeKeys] = useState(null);
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
  // A lifecycle note open in the reader counts as an open message too.
  const lifecycleOpen = useLifecycleStore(s => !!s.openId);
  const hasOpenMessage = useMailStore(s => !!s.selectedEmail || !!s.selectedThread) || lifecycleOpen;
  const stackedSolo = layoutMode === 'two-column' && !hasOpenMessage;
  const clampedListHeight = clampListPaneHeight(listPaneHeight, windowHeight);

  const listPaneStyle = layoutMode === 'three-column'
    ? { width: clampedListWidth, minWidth: MIN_LIST_WIDTH, maxWidth: maxListWidth }
    : stackedSolo
      ? { flex: '1 1 auto', minHeight: 0 }
      : { height: clampedListHeight, minHeight: MIN_LIST_HEIGHT };

  // Initialize email scheduler
  useEmailScheduler();

  // MailVault's own notes about Premium (src-core/src/lifecycle_mail.rs)
  useLifecycleMail();

  // Pipeline coordinator — manages background caching for all accounts
  usePipelineCoordinator();

  // Offline search index: tell the app what to index as settings change
  useSearchIndexConfig();

  // Migration manager — listens for migration progress events and checks for incomplete migrations
  useEffect(() => {
    migrationManager.init();
    restoreManager.init();
    // Archive & delete jobs live in the daemon: pick up the ones already running.
    initAbd();
    // Refresh the visible account copy after native credential changes.
    initOAuthCredentialProjection();
    return () => {
      migrationManager.destroy();
      restoreManager.destroy();
    };
  }, []);


  const privacyOn = usePrivacyStore(isPrivacyMasking);
  useEffect(() => {
    document.documentElement.toggleAttribute('data-privacy', privacyOn);
  }, [privacyOn]);
  usePrivacyPeekListeners();

  useAppShortcuts({ setComposeState, composeState, insightsOpen, notesOpen, contactsOpen, overlayOpen, showSettings, showShortcutsModal, setShowShortcutsModal, closeInsights, closeNotes, closeContacts, closeSettings, openSettings, setShowMoveDropdown, setSnoozeKeys });

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

  const { composeBugEmail, handleReferFriend } = useComposePrefills({ setComposeState, setShowBugModal, accounts, activeAccountId });

  // The button opens the choice of channel; the email template above is only
  // one of them (GitHub Discussions is the one others can find later).
  const handleReportBug = useCallback(() => setShowBugModal(true), []);
  const settingsAuxRef = useRef(null);
  const settingsRelayMuted = useRef(false);
  const detachSettings = useCallback(async request => {
    if (settingsAuxRef.current?.label) {
      const existing = await WebviewWindow.getByLabel(settingsAuxRef.current.label);
      if (existing) { await existing.setFocus(); return; }
    }
    const token = crypto.randomUUID();
    let stopReady;
    try {
      stopReady = await listen('settings-window-ready', async event => {
        if (event.payload?.token !== token) return;
        const state = useMailStore.getState();
        await emitTo(event.payload.label, 'settings-window-payload', {
          token, request, accounts: state.accounts, activeAccountId: state.activeAccountId,
          mailboxes: state.mailboxes,
          accountMailboxes: Object.fromEntries((state.accounts || []).map(account => [account.id,
            getAccountCacheMailboxes(account.id) || (account.id === state.activeAccountId ? state.mailboxes : [])])),
          settings: Object.fromEntries(Object.entries(useSettingsStore.getState()).filter(([, value]) => typeof value !== 'function')),
          theme: { theme: useThemeStore.getState().theme, palette: useThemeStore.getState().palette },
          quickActionScope: currentQuickActionScopeSnapshot(),
          // Mail renders here: Network Activity's remote-images line reads this window's count.
          remoteImages: useNetActivityStore.getState().remoteImages,
        });
        stopReady?.();
      });
      const label = await invoke('open_auxiliary_window', { kind: 'settings', token });
      settingsAuxRef.current = { token, label };
      minimizeSettings();
    } catch (cause) {
      stopReady?.();
      console.warn('[settings] could not detach:', cause);
    }
  }, [minimizeSettings]);

  useEffect(() => {
    let disposed = false;
    let stops = [];
    Promise.all([
      listen('settings-window-change', event => {
        if (event.payload?.token !== settingsAuxRef.current?.token) return;
        settingsRelayMuted.current = true;
        try {
          if (event.payload.settings) {
            useSettingsStore.setState(event.payload.settings);
            if (event.payload.settings.language) void setLocale(event.payload.settings.language);
          }
          if (event.payload.accounts) useMailStore.setState({ accounts: event.payload.accounts });
          if (event.payload.theme) {
            const theme = useThemeStore.getState();
            if (event.payload.theme.theme !== theme.theme) theme.setTheme(event.payload.theme.theme);
            if (event.payload.theme.palette !== theme.palette) theme.setPalette(event.payload.theme.palette);
          }
        } finally {
          settingsRelayMuted.current = false;
        }
      }),
      listen('settings-window-closed', event => {
        if (event.payload?.token !== settingsAuxRef.current?.token) return;
        settingsAuxRef.current = null;
        closeSettings();
        void import('./stores/viewStore').then(({ useViewStore }) => useViewStore.getState().loadViews())
          .catch(error => console.warn('[views] could not load the views:', error?.message || error));
        void import('./stores/tagStore').then(({ useTagStore }) => useTagStore.getState().loadTags());
        void import('./stores/autoTagStore').then(({ useAutoTagStore }) => useAutoTagStore.getState().loadRules());
        void import('./stores/fieldStore').then(({ useFieldStore }) => Promise.allSettled(
          (useMailStore.getState().accounts || []).map(account => useFieldStore.getState().loadFields(account.id))));
      }),
      listen('settings-window-action', event => {
        if (event.payload?.token !== settingsAuxRef.current?.token) return;
        if (event.payload.action === 'add-account') setShowAccountModal(true);
        if (event.payload.action === 'setup-phone') setShowPhoneQrModal(true);
        if (event.payload.action === 'export-accounts') setShowExportModal(true);
        if (event.payload.action === 'import-accounts') setShowImportModal(true);
        if (event.payload.action === 'report-bug') handleReportBug();
        void WebviewWindow.getByLabel('main').then(window => window?.setFocus());
      }),
    ]).then(results => { if (disposed) results.forEach(stop => stop()); else stops = results; });
    const forward = change => {
      const current = settingsAuxRef.current;
      if (settingsRelayMuted.current || !current?.label) return;
      void emitTo(current.label, 'settings-window-owner-change', { token: current.token, ...change }).catch(() => {});
    };
    const stopSettings = useSettingsStore.subscribe((state, previous) => {
      const changed = Object.fromEntries(Object.entries(state).filter(([key, value]) =>
        key !== 'localeEpoch' && typeof value !== 'function' && value !== previous[key]));
      if (Object.keys(changed).length) forward({ settings: changed });
    });
    const stopTheme = useThemeStore.subscribe((state, previous) => {
      if (state.theme !== previous.theme || state.palette !== previous.palette) {
        forward({ theme: { theme: state.theme, palette: state.palette } });
      }
    });
    const stopMail = useMailStore.subscribe((state, previous) => {
      if (state.accounts !== previous.accounts || state.activeAccountId !== previous.activeAccountId) {
        forward({ accounts: state.accounts, activeAccountId: state.activeAccountId });
      }
    });
    const stopRemoteImages = useNetActivityStore.subscribe((state, previous) => {
      if (state.remoteImages !== previous.remoteImages) forward({ remoteImages: state.remoteImages });
    });
    // Quick actions' "Current view" there is the view shown here, so a move to
    // another folder follows. Not through forward(): its mute covers settings
    // relayed from that window, and a list mode chosen there changes the scope.
    const stopScope = watchQuickActionScope(quickActionScope => {
      const current = settingsAuxRef.current;
      if (!current?.label) return;
      void emitTo(current.label, 'settings-window-owner-change', { token: current.token, quickActionScope }).catch(() => {});
    });
    return () => {
      disposed = true; stops.forEach(stop => stop()); stopSettings(); stopTheme(); stopMail(); stopRemoteImages(); stopScope();
    };
  }, [closeSettings, handleReportBug]);


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

  const { dmgWarning, setDmgWarning } = useDmgWarning();

  useNativeBridges({ setMailtoError, openSettings, setShowShortcutsModal, setComposeState, showSettings, settingsMinimized, minimizeSettings, openMailFromSidebar, handleReportBug });

  const { quickLoadDone, quickLoadHadAccountsRef } = useStartupLoad({ setPendingOperation, openMailFromSidebar });

  // Full initialization with delay (includes keychain access)
  // Gated on shouldStartFullInit(): fires once quick load has run and either
  // an account is already known, or onboarding is complete — never on
  // accounts.length alone. Quick load only sees accounts.json, so a
  // keychain-only install reads 0 accounts here until init() itself runs
  // the keychain-inclusive lookup; requiring accounts.length > 0 would wait
  // forever on a count only init() can raise. See shouldStartFullInit.js.
  useEffect(() => {
    if (shouldStartFullInit({ initialized, quickLoadDone, accountCount: accounts.length, onboardingComplete })) {
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
          // Tags live in the daemon now. The legacy hand-over refuses while
          // the search index cannot place an assignment, and retries on the
          // next launch rather than clearing anything on a blind lookup.
          bootstrapTags();
          // Loads the queue, recomputes every queued row's fireAt against the
          // current tz rules, and subscribes to live status updates.
          initScheduledSend();
          // Snooze rows and their wake events (the worker lives in the daemon).
          initSnooze();
          // Follow-up reminders: rows, their events, and the one banner each.
          initFollowUp();
          // Loads Auto Tag rules and subscribes to backfill progress/completion.
          initAutoTags();
          // Tags the daemon assigns on its own reach the rows on screen.
          initTagEvents();
        }).catch((err) => {
          console.error('[App] Full init failed:', err);
          clearTimeout(failsafe);
          setInitialized(true);
        });
      }, delay);

      return () => clearTimeout(timer);
    }
  }, [initialized, quickLoadDone, accounts.length, onboardingComplete]);

  // Nothing else on screen that an onboarding invitation would sit on top of.
  const onboardingPromptReady = initialized && !settingsMounted && !showAccountModal && !showExportModal && !showImportModal && !showPhoneQrModal
    && composeWindows.length === 0 && !updateInfo && !showShortcutsModal && !showBugModal
    && !pendingOperation && !exportTarget && !showExportSamples;

  // Settings opens from the native menu on every screen, including onboarding
  // and the no-accounts welcome screen, so each of them renders it.
  const settingsLayer = (
    <ChunkErrorBoundary name="Settings">
    <Suspense fallback={null}>
      <AnimatePresence>
        {settingsMounted && (
          <SettingsPage key={settingsWindowRequest.id}
            minimized={settingsMinimized}
            onMinimize={minimizeSettings}
            onDetach={detachSettings}
            onClose={closeSettings}
            onAddAccount={() => { closeSettings(); setShowAccountModal(true); }}
            onSetupPhone={() => { closeSettings(); setShowPhoneQrModal(true); }}
            onExportAccounts={() => { closeSettings(); setShowExportModal(true); }}
            onImportAccounts={() => { closeSettings(); setShowImportModal(true); }}
            onReportBug={handleReportBug}
            onNavigationLabelChange={setSettingsLocation}
            initialTab={settingsWindowRequest.tab}
            initialAccountId={settingsWindowRequest.accountId}
            initialSection={settingsWindowRequest.section} />
        )}
      </AnimatePresence>
    </Suspense>
    </ChunkErrorBoundary>
  );

  // Show onboarding if user hasn't dismissed it
  if (!onboardingComplete) {
    return (
      <>
        <Onboarding
          onComplete={({ openBilling } = {}) => {
            if (!openBilling) { setMailArrivalKind('onboarding'); return; }
            // See Premium: Billing first, the arrival once Settings closes.
            afterSettingsClose(() => setMailArrivalKind('onboarding'));
            openSettings({ tab: 'billing' });
          }}
          onOpenFaq={() => { openInBrowser(faqUrl(language, 'onboarding')).catch(() => {}); }}
        />
        {settingsLayer}
        {mailArrival}
      </>
    );
  }

  // Show welcome screen only after full init confirms there are truly no accounts.
  // Before full init, accounts.json may be empty (older installs store accounts only in keychain).
  if (accounts.length === 0) {
    if (!initialized) {
      // Still loading — show branded loading screen while keychain prompt may be active
      return (
        <>
        <div className="h-screen bg-mail-bg flex items-center justify-center pt-8">
          <div className="text-center">
            <h1 className="text-4xl font-display font-bold text-mail-text mb-4">
              <span className="text-mail-accent-text">{t('app.mail')}</span>{t('app.vault')}
            </h1>
            <p className="text-mail-text-muted mb-4">{t('app.loadingAccounts')}</p>
            <RefreshCw size={24} className="animate-spin text-mail-accent-text mx-auto" />
          </div>
        </div>
        {mailArrival}
        </>
      );
    }
    return (
      <>
      <div className="h-screen bg-mail-bg flex items-center justify-center pt-8" data-testid="welcome-screen">
        <motion.div
          initial={{ opacity: 1, y: 0 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center"
        >
          <div className="mb-8">
            <h1 className="text-4xl font-display font-bold text-mail-text mb-2">
              <span className="text-mail-accent-text">{t('app.mail')}</span>{t('app.vault')}
            </h1>
            <p className="text-mail-text-muted">
              {t('app.reactiveEmailClientLocalStorage')}
            </p>
          </div>

          <button
            onClick={() => setShowAccountModal(true)}
            className="px-6 py-3 bg-mail-accent-fill hover:bg-mail-accent-hover text-white
                       font-medium rounded-lg transition-colors duration-200"
          >
            {t('app.addFirstAccount')}
          </button>
          <div className="mt-3">
            <button onClick={() => setShowImportModal(true)}
              className="text-sm text-mail-accent-text hover:underline">
              {t('app.importFromAnotherComputer')}
            </button>
          </div>

          <ChunkErrorBoundary name="Add account">
          <Suspense fallback={null}>
            <AnimatePresence>
              {showAccountModal && (
                <AccountModal onClose={() => setShowAccountModal(false)} onSuccess={accountAdded} />
              )}
            </AnimatePresence>
            {showImportModal && <ImportModal onClose={() => setShowImportModal(false)} />}
          </Suspense>
          </ChunkErrorBoundary>
        </motion.div>
      </div>
      {settingsLayer}
      {mailArrival}
      </>
    );
  }
  
  return (
    <>
    <div className="h-screen bg-mail-bg flex flex-col overflow-clip">
      {/* Storage folder unreachable — blocks sync, so it sits above everything */}
      <VaultAlertBanner />
      <PortableDriveBanner />
      {/* No internet. Below the vault banner: an unplugged drive is the worse
          problem, and only one of the two is the user's to fix right now. */}
      <OfflineBanner />
      {/* Outlook accounts still on Graph: IMAP works now and is the better way. */}
      <GraphImapBanner onSwitch={(accountId) => openSettings({ tab: 'accounts', accountId, section: 'connection' })} />
      {/* overflow-CLIP, not hidden: an overflow-hidden box is still a scroll
          container, and WebKit scrolls one sideways to reveal a text selection.
          With no scrollbar the offset sticks and the sidebar and list end up
          off-screen for good. `clip` cannot scroll at all. */}
      <div className="flex-1 flex min-w-0 min-h-0 overflow-clip">
      <div data-testid="sidebar" className="shrink-0 min-h-0">
        <Sidebar
          onAddAccount={() => setShowAccountModal(true)}
          onCompose={() => setComposeState({})}
          onOpenSettings={(tab) => openSettings(typeof tab === 'string' ? { tab } : undefined)}
          onOpenBackup={(accountId) => openSettings({ tab: 'backup', accountId })}
          onOpenAccounts={(accountId, section) => openSettings({ tab: 'accounts', accountId, section })}
          onOpenDataUsage={(accountId) => openSettings({ tab: 'data-usage', accountId })}
          onReportBug={handleReportBug}
          onReferFriend={handleReferFriend}
          onOpenInsights={openInsights}
          onOpenNotes={openNotes}
          onOpenContacts={openContacts}
          onOpenMail={openMailFromSidebar}
          insightsOpen={insightsOpen}
          notesOpen={notesOpen}
          contactsOpen={contactsOpen}
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
        hidden={overlayOpen}
        inert={overlayOpen ? '' : undefined}
        style={overlayOpen ? {display:'none'} : undefined}
        aria-hidden={overlayOpen || undefined}
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
              <EmailList stacked={layoutMode === 'two-column'} />
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
                  {!overlayOpen && (lifecycleOpen
                    ? <LifecycleMessageView onOpenBilling={() => openSettings({ tab: 'billing' })} />
                    : <EmailViewer onComposeReply={(mode, email) => setComposeState({ mode, replyTo: email })} />)}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {insightsOpen && <ChunkErrorBoundary name="Insights"><Suspense fallback={<div className="flex-1 bg-mail-bg" />}>
        <InsightsPage onClose={closeInsights} onComposeReply={(mode, email) => setComposeState({mode,replyTo:email})} />
      </Suspense></ChunkErrorBoundary>}
      {notesOpen && <ChunkErrorBoundary name="Notes to Self"><Suspense fallback={<div className="flex-1 bg-mail-bg" />}>
        <NotesBoard onClose={closeNotes} onComposeReply={(mode, email) => setComposeState({mode,replyTo:email})} />
      </Suspense></ChunkErrorBoundary>}
      {contactsOpen && <ChunkErrorBoundary name="Contacts"><Suspense fallback={<div className="flex-1 bg-mail-bg" />}>
        <ContactsView onClose={closeContacts} onOpenMail={openMailFromSidebar} />
      </Suspense></ChunkErrorBoundary>}

      <ChunkErrorBoundary name="Add account">
      <Suspense fallback={null}>
        <AnimatePresence>
          {showAccountModal && (
            <AccountModal onClose={() => setShowAccountModal(false)} onSuccess={accountAdded} />
          )}
        </AnimatePresence>
        {showExportModal && <ExportModal accounts={accounts} onClose={() => setShowExportModal(false)} />}
        {showPhoneQrModal && <PhoneQrModal onClose={() => setShowPhoneQrModal(false)} />}
        {showImportModal && <ImportModal onClose={() => setShowImportModal(false)} />}
      </Suspense>
      </ChunkErrorBoundary>

      {/* Active (non-minimized) compose windows */}
      <ChunkErrorBoundary name="Compose">
      <Suspense fallback={null}>
      <AnimatePresence>
        {composeWindows.filter(w => !w.minimized && !w.detached && canMountCompose(w)).map(w => (
          <ComposeModal
            key={w.id}
            mode={w.mode || 'new'}
            replyTo={w.initialData ? null : (w.replyTo || null)}
            initialData={w.initialData}
            templateBody={w.templateBody}
            preparedQuote={w.preparedQuote}
            onClose={() => closeCompose(w.id)}
            onMinimize={() => minimizeCompose(w.id)}
            onSaveState={(data) => saveComposeState(w.id, data)}
            onDiscard={data => cleanupComposeDraft(data, 'discard', w.id)}
            onDraftCleanup={(data, kind) => cleanupComposeDraft(data, kind, w.id)}
            onSend={w.bugReport ? () => useSettingsStore.getState().setLastBugReportAt(Date.now()) : undefined}
            onDetach={async data => composeWindowOwnerRef.current.detach({
              id: w.id,
              mode: w.mode || 'new',
              snapshot: { ...data, _composeWindowId: w.id },
              context: {
                accounts: useMailStore.getState().accounts,
                activeAccountId: useMailStore.getState().activeAccountId,
                // JSON cloning takes a read-only settings snapshot and omits
                // Zustand actions. The child can therefore render current
                // preferences without ever receiving main-window writers.
                theme: JSON.parse(JSON.stringify(useThemeStore.getState())),
                settings: JSON.parse(JSON.stringify(useSettingsStore.getState())),
              },
            })}
          />
        ))}
      </AnimatePresence>
      </Suspense>
      </ChunkErrorBoundary>

      {/* Minimized windows share one stack so their restore buttons never overlap. */}
      {(settingsMinimized || abdMinimized || codeBubblesShown || composeWindows.some(w => w.minimized)) && (
        <div className="fixed top-16 right-4 z-40 flex flex-col gap-2">
          <CodeBubbles
            onOpen={(target) => openNotificationTarget(target, useMailStore.getState)}
            onDelete={({ uid, accountId, mailbox }) => useMailStore.getState().deleteEmailFromServer(uid, { accountId, mailboxOverride: mailbox })}
          />
          <AbdPill />
          {settingsMinimized && <SettingsBubble location={settingsLocation} onRestore={openSettings}
            onClose={() => useUnsavedStore.getState().leave(closeSettings)} />}
          {composeWindows.filter(w => w.minimized).map(w => {
            const data = composeSessionData(w);
            const terminal = isTerminalCompose(data);
            const cleanupStateLabel = data?._draftTerminal === 'sent' ? tr('compose.sentCleanupPending')
              : data?._draftTerminal === 'scheduled' ? tr('compose.scheduledCleanupPending')
              : data?._draftCleanupState === 'pending' ? tr('compose.draftCleanupPending') : tr('compose.draftCleanupUnknown');
            const cleanupLabel = data?._draftCleanupPersistError ? `${cleanupStateLabel} ${tr('compose.draftCleanupStorageFailed')}` : cleanupStateLabel;
            const subject = data?.subject || w.replyTo?.subject || '';
            const displaySubject = w.mode === 'reply' || w.mode === 'replyAll'
              ? (subject.startsWith('Re:') ? subject : tr('app.re', { subject }))
              : w.mode === 'forward'
              ? (subject.startsWith('Fwd:') ? subject : tr('app.fwd', { subject }))
              : subject || 'New Message';
            const recipient = data?.to || w.replyTo?.from?.address || '';
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
                onClick={() => { if (terminal) void retryComposeCleanup(w.id); else restoreCompose(w.id); }}
              >
                <div className="w-7 h-7 rounded-full bg-mail-accent/20 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-semibold text-mail-accent-text">
                    {(recipient || 'N')[0].toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-mail-text truncate">{displaySubject}</p>
                  {terminal ? <p data-testid="compose-cleanup-status" className="text-[10px] text-mail-text-muted">{cleanupLabel}</p> : recipient && <p className="text-[10px] text-mail-text-muted truncate">{recipient}</p>}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (terminal) void retryComposeCleanup(w.id);
                    else void cleanupComposeDraft(w.snapshot || w.initialData, 'discard', w.id);
                  }}
                  className="p-0.5 hover:bg-mail-border rounded opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  {terminal ? <span className="text-xs">{tr('common.retry')}</span> : <X size={12} className="text-mail-text-muted" />}
                </button>
              </motion.div>
            );
          })}
        </div>
      )}

      {settingsLayer}

      <ToastDockHost />
      {mailtoError && <Toast duration={0} onClose={() => setMailtoError(false)} message={<>
        {tr('compose.preparationUnavailable')}
        <button type="button" className="ml-3 underline" onClick={() => {
          void retryMailtoCompose().then(() => setMailtoError(false)).catch(() => setMailtoError(true));
        }}>{tr('common.retry')}</button>
      </>} />}


      <AnimatePresence>
        {error && (
          <Toast message={tErr(error)} onClose={clearError} type={errorToast.type} duration={errorToast.duration} />
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

      {!overlayOpen && <SelectionActionBar />}
      <BulkSaveProgress />
      <AbdProgressPanel />
      <MigrationToast showSettings={showSettings} onOpenSettings={() => openSettings({ tab: 'migration' })} />
      <SearchIndexReindexPrompt />
      <UpdateInstallFailedPrompt />
      <KeychainToast
        onRetry={() => useMailStore.getState().retryKeychainAccess()}
        onOpenAccounts={() => openSettings({ tab: 'accounts' })}
      />
      <KeychainUnlockCard />
      <PortableUnlockCard />
      <OnboardingRefreshPrompt ready={onboardingPromptReady} />
      <OnboardingResumePrompt ready={onboardingPromptReady} />
      <UndoSendToast onUndo={(cs) => openCompose(cs)} />
      <UndoToast />
      <UnsubscribeHost />
      <OutboxTray onRestoreDraft={(cs) => openCompose(cs)} />
      <RestoreTray />
      <SearchIndexProgress />
      <ViewsReindexNotice />
      <MboxUploadProgress onOpenAccounts={(accountId) => openSettings({ tab: 'accounts', accountId })} />
      <FolderMoveProgress />
      <FormatMigrationProgress />
      <ShareUnlockModal onSubscribe={() => openSettings({ tab: 'billing' })} />
      <PendingActionsReminder />
      <BackupUpsellModal onUpgrade={() => openSettings({ tab: 'billing' })} />

      {/* Export — one dialog and one upsell for all four entry points */}
      <ExportDialog
        open={Boolean(exportTarget)}
        messages={exportTarget?.messages || []}
        account={exportTarget?.account}
        mailbox={exportTarget?.mailbox}
        social={exportTarget?.social}
        files={exportTarget?.files}
        onClose={closeExport}
        onPopOut={isTauri ? handleExportPopOut : undefined}
        onUpgrade={() => { closeExport(); openSettings({ tab: 'billing' }); }}
        onShowSamples={() => { closeExport(); openSamples(); }}
      />
      <ExportUpsellModal
        open={showExportSamples}
        onClose={closeSamples}
        onUpgrade={() => { closeSamples(); openSettings({ tab: 'billing' }); }}
      />
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

      {snoozeKeys && <SnoozePicker keys={snoozeKeys} onClose={() => setSnoozeKeys(null)} />}

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

      <BugReportDialog
        open={showBugModal}
        onClose={() => setShowBugModal(false)}
        onEmail={composeBugEmail}
      />

      <FocusLock />
      <PrivacyDictionaryHost />

      <BulkPendingOperationBanner pending={pendingOperation} onPendingChange={setPendingOperation} />
      </div>
    </div>
    {mailArrival}
    </>
  );
}

export default App;
