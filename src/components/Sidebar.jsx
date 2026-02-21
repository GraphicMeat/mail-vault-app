import React, { useState, useMemo } from 'react';
import { version } from '../../package.json';
import { useMailStore } from '../stores/mailStore';
import { useThemeStore } from '../stores/themeStore';
import { useSettingsStore, getAccountInitial, getAccountColor } from '../stores/settingsStore';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Inbox,
  Send,
  File,
  Trash2,
  Star,
  Archive,
  AlertCircle,
  Plus,
  ChevronDown,
  ChevronRight,
  Settings,
  HardDrive,
  Cloud,
  Layers,
  PenSquare,
  Sun,
  Moon,
  WifiOff,
  Key,
  ServerOff,
  RefreshCw,
  Info,
  X,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react';

const MAILBOX_ICONS = {
  INBOX: Inbox,
  '\\Sent': Send,
  '\\Drafts': File,
  '\\Trash': Trash2,
  '\\Junk': Trash2,
  '\\Starred': Star,
  '\\Important': AlertCircle,
  '\\Archive': Archive,
  '\\All': Archive
};

function getMailboxIcon(mailbox) {
  const Icon = MAILBOX_ICONS[mailbox.specialUse] || MAILBOX_ICONS[mailbox.path] || Inbox;
  return Icon;
}

export function Sidebar({ onAddAccount, onCompose, onOpenSettings }) {
  const {
    accounts,
    activeAccountId,
    mailboxes,
    activeMailbox,
    viewMode,
    connectionStatus,
    connectionError,
    connectionErrorType,
    setActiveAccount,
    setActiveMailbox,
    setViewMode,
    loadEmails,
    retryKeychainAccess
  } = useMailStore();

  const { theme, toggleTheme } = useThemeStore();
  const { getOrderedAccounts, getDisplayName, accountColors, hiddenAccounts, sidebarCollapsed, toggleSidebarCollapsed } = useSettingsStore();

  const [expandedFolders, setExpandedFolders] = useState(new Set(['INBOX']));
  const [showErrorModal, setShowErrorModal] = useState(false);

  const orderedAccounts = getOrderedAccounts(accounts).filter(a => !hiddenAccounts[a.id]);
  const collapsed = sidebarCollapsed;

  // Sort mailboxes: INBOX first, then alphabetically; children sorted alphabetically too
  const sortedMailboxes = useMemo(() => {
    const sorted = [...mailboxes].sort((a, b) => {
      if (a.path === 'INBOX') return -1;
      if (b.path === 'INBOX') return 1;
      return a.name.localeCompare(b.name);
    });
    return sorted.map(m => m.children?.length > 0
      ? { ...m, children: [...m.children].sort((a, b) => a.name.localeCompare(b.name)) }
      : m
    );
  }, [mailboxes]);

  const toggleFolder = (path) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Shared error modal (rendered in both collapsed and expanded views)
  const errorModal = (
    <AnimatePresence>
      {showErrorModal && connectionError && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowErrorModal(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="bg-mail-bg border border-mail-border rounded-xl shadow-xl max-w-md w-full mx-4 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border">
              <h3 className="text-sm font-semibold text-mail-text">Error Details</h3>
              <button
                onClick={() => setShowErrorModal(false)}
                className="p-1 hover:bg-mail-surface-hover rounded transition-colors"
              >
                <X size={14} className="text-mail-text-muted" />
              </button>
            </div>
            <div className="p-4">
              <p className="text-sm text-mail-text-muted whitespace-pre-wrap break-words">
                {connectionError}
              </p>
              {connectionErrorType === 'outlookOAuth' && (
                <button
                  onClick={async () => {
                    const url = 'https://mailvaultapp.com/faq.html#microsoft-outlook-oauth2';
                    if (window.__TAURI__) {
                      const { open } = await import('@tauri-apps/plugin-shell');
                      await open(url);
                    } else {
                      window.open(url, '_blank');
                    }
                  }}
                  className="mt-3 text-sm text-mail-accent hover:text-mail-accent-hover transition-colors underline"
                >
                  Learn more in our FAQ
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  // --- COLLAPSED SIDEBAR ---
  if (collapsed) {
    return (
      <div className="w-14 h-full bg-mail-surface border-r border-mail-border flex flex-col items-center relative transition-all duration-200">
        {/* Expand button */}
        <div data-tauri-drag-region className="w-full py-3 flex justify-center border-b border-mail-border flex-shrink-0">
          <button
            onClick={toggleSidebarCollapsed}
            className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
            title="Expand sidebar"
          >
            <PanelLeftOpen size={18} className="text-mail-text-muted" />
          </button>
        </div>

        {/* Compose */}
        <div className="w-full py-2 flex justify-center border-b border-mail-border">
          <button
            onClick={onCompose}
            className="p-2.5 bg-mail-accent hover:bg-mail-accent-hover text-white rounded-lg transition-all shadow-glow hover:shadow-glow-lg"
            title="Compose"
          >
            <PenSquare size={16} />
          </button>
        </div>

        {/* Account icons */}
        <div className="w-full py-2 border-b border-mail-border flex flex-col items-center gap-1">
          {orderedAccounts.map(account => {
            const color = getAccountColor(accountColors, account);
            const initial = getAccountInitial(account, getDisplayName(account.id));
            return (
              <button
                key={account.id}
                className={`relative p-1.5 rounded-lg transition-all
                           ${account.id === activeAccountId
                             ? 'ring-2 ring-offset-1 ring-offset-mail-surface'
                             : 'hover:bg-mail-surface-hover'}`}
                style={account.id === activeAccountId ? { '--tw-ring-color': color } : undefined}
                onClick={() => setActiveAccount(account.id)}
                title={account.name || account.email}
              >
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold select-none"
                  style={{ backgroundColor: color }}
                >
                  {initial}
                </div>
                {account.id === activeAccountId && (
                  <div
                    className={`absolute bottom-1 right-1 w-2.5 h-2.5 rounded-full border-2 border-mail-surface
                               ${connectionStatus === 'connected' ? 'bg-mail-success' :
                                 connectionStatus === 'error' ? 'bg-mail-danger' : 'bg-mail-warning'}`}
                  />
                )}
              </button>
            );
          })}
          {orderedAccounts.length === 0 && (
            <button
              onClick={onAddAccount}
              className="p-1.5 hover:bg-mail-surface-hover rounded-lg transition-all"
              title="Add Account"
            >
              <Plus size={16} className="text-mail-text-muted" />
            </button>
          )}
        </div>

        {/* Folder icons with expandable children */}
        <div className="flex-1 overflow-y-auto w-full py-2 flex flex-col items-center gap-0.5">
          {sortedMailboxes.map(mailbox => {
            const Icon = getMailboxIcon(mailbox);
            const isActive = activeMailbox === mailbox.path;
            const hasChildren = mailbox.children?.length > 0;
            const isExpanded = expandedFolders.has(mailbox.path);
            return (
              <div key={mailbox.path} className="w-full flex flex-col items-center">
                <button
                  className={`p-2 rounded-lg transition-all
                             ${isActive && !mailbox.noselect
                               ? 'bg-mail-accent/10 text-mail-accent'
                               : 'text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover'}`}
                  onClick={() => {
                    if (mailbox.noselect && hasChildren) {
                      toggleFolder(mailbox.path);
                    } else if (!mailbox.noselect) {
                      setActiveMailbox(mailbox.path);
                      if (hasChildren) toggleFolder(mailbox.path);
                    }
                  }}
                  title={mailbox.name}
                >
                  <Icon size={16} />
                </button>
                {hasChildren && isExpanded && mailbox.children.map(child => {
                  const ChildIcon = getMailboxIcon(child);
                  const isChildActive = activeMailbox === child.path;
                  return (
                    <button
                      key={child.path}
                      className={`p-1.5 rounded-lg transition-all
                                 ${isChildActive
                                   ? 'bg-mail-accent/10 text-mail-accent'
                                   : 'text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover'}`}
                      onClick={() => setActiveMailbox(child.path)}
                      title={child.name}
                    >
                      <ChildIcon size={13} />
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer icons */}
        <div className="w-full py-2 border-t border-mail-border flex flex-col items-center gap-1">
          <button
            onClick={toggleTheme}
            className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? (
              <Sun size={16} className="text-mail-text-muted" />
            ) : (
              <Moon size={16} className="text-mail-text-muted" />
            )}
          </button>
          <button
            onClick={onOpenSettings}
            className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
            title="Settings"
          >
            <Settings size={16} className="text-mail-text-muted" />
          </button>
        </div>

        {errorModal}
      </div>
    );
  }

  // --- EXPANDED SIDEBAR ---
  return (
    <div className="w-64 h-full bg-mail-surface border-r border-mail-border flex flex-col relative transition-all duration-200">
      {/* Logo */}
      <div data-tauri-drag-region className="px-4 py-3 border-b border-mail-border flex items-center justify-between flex-shrink-0">
        <h1 className="text-xl font-display font-bold">
          <span className="text-mail-accent">Mail</span>
          <span className="text-mail-text">Vault</span>
        </h1>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleTheme}
            className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? (
              <Sun size={18} className="text-mail-text-muted" />
            ) : (
              <Moon size={18} className="text-mail-text-muted" />
            )}
          </button>
          <button
            onClick={toggleSidebarCollapsed}
            className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
            title="Collapse sidebar"
          >
            <PanelLeftClose size={18} className="text-mail-text-muted" />
          </button>
        </div>
      </div>

      {/* Compose Button */}
      <div className="p-3 border-b border-mail-border">
        <button
          onClick={onCompose}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                     bg-mail-accent hover:bg-mail-accent-hover text-white
                     font-medium rounded-lg transition-all shadow-glow hover:shadow-glow-lg"
        >
          <PenSquare size={18} />
          Compose
        </button>
      </div>

      {/* Account Selector */}
      <div className="p-3 border-b border-mail-border">
        <div className="relative">
          {orderedAccounts.map(account => {
            const color = getAccountColor(accountColors, account);
            const initial = getAccountInitial(account, getDisplayName(account.id));
            return (
              <div
                key={account.id}
                className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all
                           ${account.id === activeAccountId
                             ? 'bg-mail-accent/10 text-mail-accent'
                             : 'hover:bg-mail-surface-hover text-mail-text'}`}
                onClick={() => setActiveAccount(account.id)}
              >
                <div className="relative">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold select-none"
                    style={{ backgroundColor: color }}
                  >
                    {initial}
                  </div>
                  {account.id === activeAccountId && (
                    <div
                      className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-mail-surface
                                 ${connectionStatus === 'connected' ? 'bg-mail-success' :
                                   connectionStatus === 'error' ? 'bg-mail-danger' : 'bg-mail-warning'}`}
                      title={connectionStatus === 'connected' ? 'Connected' :
                             connectionStatus === 'error' ? `Offline: ${connectionError}` : 'Connecting...'}
                    />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  {account.name ? (
                    <>
                      <div className="text-sm font-medium truncate">
                        {account.name}
                      </div>
                      <div className="text-xs text-mail-text-muted truncate">
                        {account.email}
                      </div>
                    </>
                  ) : (
                    <div className="text-sm font-medium truncate">
                      {account.email}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Connection error banner */}
          {connectionStatus === 'error' && activeAccountId && (
            <div className={`mt-2 p-2 rounded-lg border ${
              connectionErrorType === 'passwordMissing'
                ? 'bg-mail-warning/10 border-mail-warning/20'
                : 'bg-mail-danger/10 border-mail-danger/20'
            }`}>
              <div className={`flex items-center justify-between text-xs ${
                connectionErrorType === 'passwordMissing' ? 'text-mail-warning' : 'text-mail-danger'
              }`}>
                <div className="flex items-center gap-2">
                  {connectionErrorType === 'passwordMissing' ? (
                    <>
                      <Key size={14} />
                      <span>Keychain access</span>
                    </>
                  ) : connectionErrorType === 'offline' ? (
                    <>
                      <WifiOff size={14} />
                      <span>No internet</span>
                    </>
                  ) : connectionErrorType === 'outlookOAuth' ? (
                    <>
                      <ServerOff size={14} />
                      <span>Microsoft issue</span>
                    </>
                  ) : (
                    <>
                      <ServerOff size={14} />
                      <span>Server error</span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setShowErrorModal(true)}
                    className={`p-1 rounded transition-colors ${
                      connectionErrorType === 'passwordMissing'
                        ? 'hover:bg-mail-warning/20'
                        : 'hover:bg-mail-danger/20'
                    }`}
                    title="View error details"
                  >
                    <Info size={12} />
                  </button>
                  {connectionErrorType === 'passwordMissing' ? (
                    <button
                      onClick={retryKeychainAccess}
                      className="p-1 hover:bg-mail-warning/20 rounded transition-colors"
                      title="Retry keychain access"
                    >
                      <RefreshCw size={12} />
                    </button>
                  ) : (
                    <button
                      onClick={() => loadEmails()}
                      className="p-1 hover:bg-mail-danger/20 rounded transition-colors"
                      title="Retry connection"
                    >
                      <RefreshCw size={12} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {orderedAccounts.length === 0 && (
            <button
              onClick={onAddAccount}
              className="w-full mt-2 flex items-center gap-2 p-2 text-sm text-mail-text-muted
                        hover:text-mail-text hover:bg-mail-surface-hover rounded-lg transition-all"
            >
              <Plus size={16} />
              Add Account
            </button>
          )}
        </div>
      </div>

      {/* View Mode Toggle */}
      <div className="p-3 border-b border-mail-border">
        <div className="text-xs text-mail-text-muted uppercase tracking-wide mb-2">
          View Mode
        </div>
        <div className="flex gap-1 bg-mail-bg rounded-lg p-1">
          {[
            { id: 'all', icon: Layers, label: 'All' },
            { id: 'server', icon: Cloud, label: 'Server' },
            { id: 'local', icon: HardDrive, label: 'Local' }
          ].map(mode => (
            <button
              key={mode.id}
              onClick={() => setViewMode(mode.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2
                         rounded-md text-xs font-medium transition-all
                         ${viewMode === mode.id
                           ? 'bg-mail-accent text-white'
                           : 'text-mail-text-muted hover:text-mail-text'}`}
            >
              <mode.icon size={12} />
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      {/* Mailboxes */}
      <div className="flex-1 overflow-y-auto p-3">
        <div className="text-xs text-mail-text-muted uppercase tracking-wide mb-2">
          Folders
        </div>

        {sortedMailboxes.map(mailbox => {
          const Icon = getMailboxIcon(mailbox);
          const hasChildren = mailbox.children?.length > 0;
          const isExpanded = expandedFolders.has(mailbox.path);
          const isActive = activeMailbox === mailbox.path;

          return (
            <div key={mailbox.path}>
              <div
                className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all
                           ${mailbox.noselect ? 'cursor-default' : 'cursor-pointer'}
                           ${isActive && !mailbox.noselect
                             ? 'bg-mail-accent/10 text-mail-accent'
                             : 'text-mail-text hover:bg-mail-surface-hover'}`}
                onClick={() => {
                  if (mailbox.noselect && hasChildren) {
                    toggleFolder(mailbox.path);
                  } else if (!mailbox.noselect) {
                    setActiveMailbox(mailbox.path);
                  }
                }}
              >
                {hasChildren && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFolder(mailbox.path);
                    }}
                    className="p-0.5"
                  >
                    {isExpanded ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </button>
                )}
                {!hasChildren && <div className="w-5" />}
                <Icon size={16} />
                <span className="text-sm flex-1 truncate">{mailbox.name}</span>
              </div>

              <AnimatePresence>
                {hasChildren && isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="ml-4 overflow-hidden"
                  >
                    {mailbox.children.map(child => {
                      const ChildIcon = getMailboxIcon(child);
                      const isChildActive = activeMailbox === child.path;

                      return (
                        <div
                          key={child.path}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded-lg
                                     cursor-pointer transition-all ${isChildActive
                                       ? 'bg-mail-accent/10 text-mail-accent'
                                       : 'text-mail-text hover:bg-mail-surface-hover'}`}
                          onClick={() => setActiveMailbox(child.path)}
                        >
                          <div className="w-5" />
                          <ChildIcon size={14} />
                          <span className="text-sm truncate">{child.name}</span>
                        </div>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-mail-border">
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2 p-2 text-sm text-mail-text-muted
                    hover:text-mail-text hover:bg-mail-surface-hover rounded-lg transition-all"
        >
          <Settings size={16} />
          Settings
        </button>
        <div className="text-xs text-mail-text-muted text-center mt-2">
          MailVault v{version}
        </div>
      </div>

      {errorModal}
    </div>
  );
}
