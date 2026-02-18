import React, { useState, useRef } from 'react';
import { version } from '../../package.json';
import { useMailStore } from '../stores/mailStore';
import { useThemeStore } from '../stores/themeStore';
import { useSettingsStore } from '../stores/settingsStore';
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
  User,
  Settings,
  HardDrive,
  Cloud,
  Layers,
  PenSquare,
  Sun,
  Moon,
  WifiOff,
  Wifi,
  Key,
  ServerOff,
  RefreshCw,
  Info,
  X
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
  const { getOrderedAccounts, setAccountOrder } = useSettingsStore();

  const [expandedFolders, setExpandedFolders] = useState(new Set(['INBOX']));
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [dragOverId, setDragOverId] = useState(null);
  const dragItemRef = useRef(null);

  const orderedAccounts = getOrderedAccounts(accounts);
  
  const activeAccount = accounts.find(a => a.id === activeAccountId);
  
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
  
  return (
    <div className="w-64 h-full bg-mail-surface border-r border-mail-border flex flex-col relative">
      {/* Logo */}
      <div data-tauri-drag-region className="px-4 py-3 border-b border-mail-border flex items-center justify-between flex-shrink-0">
        <h1 className="text-xl font-display font-bold">
          <span className="text-mail-accent">Mail</span>
          <span className="text-mail-text">Vault</span>
        </h1>
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
          {orderedAccounts.map(account => (
            <div
              key={account.id}
              draggable
              onDragStart={(e) => {
                dragItemRef.current = account.id;
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (account.id !== dragItemRef.current) {
                  setDragOverId(account.id);
                }
              }}
              onDragLeave={() => setDragOverId(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverId(null);
                const fromId = dragItemRef.current;
                if (!fromId || fromId === account.id) return;
                const ids = orderedAccounts.map(a => a.id);
                const fromIdx = ids.indexOf(fromId);
                const toIdx = ids.indexOf(account.id);
                ids.splice(fromIdx, 1);
                ids.splice(toIdx, 0, fromId);
                setAccountOrder(ids);
              }}
              onDragEnd={() => {
                dragItemRef.current = null;
                setDragOverId(null);
              }}
              className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all
                         ${account.id === activeAccountId
                           ? 'bg-mail-accent/10 text-mail-accent'
                           : 'hover:bg-mail-surface-hover text-mail-text'}
                         ${dragOverId === account.id ? 'border-t-2 border-mail-accent' : 'border-t-2 border-transparent'}`}
              onClick={() => setActiveAccount(account.id)}
            >
              <div className="relative">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center
                               ${account.id === activeAccountId ? 'bg-mail-accent' : 'bg-mail-border'}`}>
                  <User size={14} className="text-white" />
                </div>
                {/* Connection status dot */}
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
                <div className="text-sm font-medium truncate">
                  {account.name || account.email}
                </div>
                <div className="text-xs text-mail-text-muted truncate">
                  {account.email}
                </div>
              </div>
            </div>
          ))}
          
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
          
          <button
            onClick={onAddAccount}
            className="w-full mt-2 flex items-center gap-2 p-2 text-sm text-mail-text-muted 
                      hover:text-mail-text hover:bg-mail-surface-hover rounded-lg transition-all"
          >
            <Plus size={16} />
            Add Account
          </button>
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
        
        {mailboxes.map(mailbox => {
          const Icon = getMailboxIcon(mailbox);
          const hasChildren = mailbox.children?.length > 0;
          const isExpanded = expandedFolders.has(mailbox.path);
          const isActive = activeMailbox === mailbox.path;
          
          return (
            <div key={mailbox.path}>
              <div
                className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer
                           transition-all ${isActive 
                             ? 'bg-mail-accent/10 text-mail-accent' 
                             : 'text-mail-text hover:bg-mail-surface-hover'}`}
                onClick={() => setActiveMailbox(mailbox.path)}
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

      {/* Error Details Modal */}
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
    </div>
  );
}
