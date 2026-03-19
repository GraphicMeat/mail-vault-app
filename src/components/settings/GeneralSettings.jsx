import React, { useState, useEffect } from 'react';
import { useThemeStore } from '../../stores/themeStore';
import { useSettingsStore, AVATAR_COLORS, getAccountInitial, getAccountColor, DEFAULT_SHORTCUTS } from '../../stores/settingsStore';
import { formatEmailDate } from '../../utils/dateFormat';
import { ToggleSwitch } from './ToggleSwitch';
import {
  Sun,
  Moon,
  Palette,
  ChevronUp,
  ChevronDown,
  RefreshCw,
  Bell,
  Key,
  LayoutGrid,
  Columns,
  Rows,
  RotateCcw,
  Search,
  Clock,
  Filter,
  MessageSquare,
  List,
  Eye,
  EyeOff,
  PenTool,
  Keyboard,
  SendHorizontal,
  Mail,
} from 'lucide-react';

export function GeneralSettings({ accounts }) {
  const { theme, toggleTheme } = useThemeStore();
  const {
    refreshInterval,
    setRefreshInterval,
    refreshOnLaunch,
    setRefreshOnLaunch,
    lastRefreshTime,
    notificationSettings,
    setNotificationEnabled,
    setNotificationShowPreview,
    setAccountNotificationEnabled,
    setAccountNotificationFolders,
    badgeEnabled,
    setBadgeEnabled,
    badgeMode,
    setBadgeMode,
    markAsReadMode,
    setMarkAsReadMode,
    markAsReadDelay,
    setMarkAsReadDelay,
    layoutMode,
    setLayoutMode,
    viewStyle,
    setViewStyle,
    emailListStyle,
    setEmailListStyle,
    threadSortOrder,
    setThreadSortOrder,
    searchHistoryLimit,
    setSearchHistoryLimit,
    searchHistory,
    clearSearchHistory,
    filterHistoryPeriodDays,
    setFilterHistoryPeriodDays,
    topFiltersLimit,
    setTopFiltersLimit,
    filterUsageHistory,
    clearFilterHistory,
    accountColors,
    hiddenAccounts,
    isAccountHidden,
    dateFormat,
    customDateFormat,
    setDateFormat,
    setCustomDateFormat,
    signatureDisplay,
    setSignatureDisplay,
    actionButtonDisplay,
    setActionButtonDisplay,
    keyboardShortcuts,
    keyboardShortcutsEnabled,
    setKeyboardShortcut,
    setKeyboardShortcutsEnabled,
    resetKeyboardShortcuts,
    undoSendEnabled,
    setUndoSendEnabled,
    undoSendDelay,
    setUndoSendDelay,
    getDisplayName,
    getOrderedAccounts,
  } = useSettingsStore();

  const [generalSubTab, setGeneralSubTab] = useState('appearance');
  const generalSubTabs = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'behavior', label: 'Behavior' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'shortcuts', label: 'Keyboard Shortcuts' },
  ];

  const [rebindingAction, setRebindingAction] = useState(null);
  const [rebindFirstKey, setRebindFirstKey] = useState(null);
  const [rebindTimer, setRebindTimer] = useState(null);
  const [expandedNotifAccounts, setExpandedNotifAccounts] = useState({});

  const orderedAccounts = getOrderedAccounts(accounts);

  // Keyboard shortcut rebind listener
  useEffect(() => {
    if (!rebindingAction) return;

    const handleRebindKey = (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Ignore bare modifier keys
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;

      // Build key string with modifiers
      let key = '';
      if (e.metaKey) key += 'Meta+';
      if (e.ctrlKey) key += 'Ctrl+';
      if (e.altKey) key += 'Alt+';
      if (e.shiftKey && e.key.length > 1) key += 'Shift+';
      key += e.key.length === 1 ? e.key : e.key;

      // Cancel rebind on Escape (without modifiers)
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !rebindFirstKey) {
        setRebindingAction(null);
        setRebindFirstKey(null);
        if (rebindTimer) { clearTimeout(rebindTimer); setRebindTimer(null); }
        return;
      }

      if (rebindFirstKey) {
        // Second key of multi-key sequence
        if (rebindTimer) clearTimeout(rebindTimer);
        const binding = rebindFirstKey + ' ' + (e.key.length === 1 ? e.key : e.key);
        setKeyboardShortcut(rebindingAction, binding);
        setRebindingAction(null);
        setRebindFirstKey(null);
        setRebindTimer(null);
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
        // Single printable key — could be start of multi-key sequence
        const firstKey = e.key;
        setRebindFirstKey(firstKey);
        const timer = setTimeout(() => {
          // No second key within 500ms — save as single key
          setKeyboardShortcut(rebindingAction, firstKey);
          setRebindingAction(null);
          setRebindFirstKey(null);
          setRebindTimer(null);
        }, 500);
        setRebindTimer(timer);
      } else {
        // Modifier combo or special key — save immediately
        setKeyboardShortcut(rebindingAction, key);
        setRebindingAction(null);
        setRebindFirstKey(null);
      }
    };

    window.addEventListener('keydown', handleRebindKey, true);
    return () => {
      window.removeEventListener('keydown', handleRebindKey, true);
      if (rebindTimer) clearTimeout(rebindTimer);
    };
  }, [rebindingAction, rebindFirstKey, rebindTimer, setKeyboardShortcut]);

  // Helper: find duplicate bindings
  const findDuplicateBinding = (action, binding) => {
    if (!binding) return null;
    for (const [otherAction, otherBinding] of Object.entries(keyboardShortcuts)) {
      if (otherAction !== action && otherBinding === binding) return otherAction;
    }
    return null;
  };

  // Shortcut action labels (same as ShortcutsModal)
  const SHORTCUT_ACTION_LABELS = {
    nextEmail: 'Next email',
    prevEmail: 'Previous email',
    goToInbox: 'Go to Inbox',
    goToSent: 'Go to Sent',
    goToDrafts: 'Go to Drafts',
    reply: 'Reply',
    replyAll: 'Reply all',
    forward: 'Forward',
    archive: 'Archive',
    delete: 'Delete',
    moveToFolder: 'Move to folder',
    compose: 'Compose',
    toggleSelect: 'Select / deselect',
    escape: 'Clear selection / close',
    focusSearch: 'Search',
    showShortcuts: 'Show shortcuts',
    openSettings: 'Open settings',
  };

  const SHORTCUT_CATEGORIES = [
    { title: 'Navigation', actions: ['nextEmail', 'prevEmail', 'goToInbox', 'goToSent', 'goToDrafts'] },
    { title: 'Actions', actions: ['reply', 'replyAll', 'forward', 'archive', 'delete', 'moveToFolder', 'compose'] },
    { title: 'Selection', actions: ['toggleSelect', 'escape'] },
    { title: 'UI', actions: ['focusSearch', 'showShortcuts', 'openSettings'] },
  ];

  // Format keybinding for display
  const formatKeybindingDisplay = (keybinding) => {
    if (!keybinding) return '\u2014';
    const modMap = { Meta: '\u2318', Ctrl: '\u2303', Alt: '\u2325', Shift: '\u21E7' };
    if (keybinding.includes('+')) {
      return keybinding.split('+').map(p => modMap[p] || p).join('');
    }
    if (keybinding.includes(' ')) {
      return keybinding.split(' ').join(' then ');
    }
    if (keybinding === 'Escape') return 'Esc';
    return keybinding;
  };

  return (
    <div>
      {/* Sub-tab navigation */}
      <div className="flex border-b border-mail-border px-6 pt-2">
        {generalSubTabs.map(sub => (
          <button
            key={sub.id}
            onClick={() => setGeneralSubTab(sub.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px
                       ${generalSubTab === sub.id
                         ? 'border-mail-accent text-mail-accent'
                         : 'border-transparent text-mail-text-muted hover:text-mail-text hover:border-mail-border'}`}
          >
            {sub.label}
          </button>
        ))}
      </div>

      <div className="p-6 space-y-6">
        {/* === Appearance sub-tab === */}
        {generalSubTab === 'appearance' && <>
        {/* Appearance */}
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <Palette size={18} className="text-mail-accent" />
            Appearance
          </h4>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-2">
              <div>
                <div className="font-medium text-mail-text">Theme</div>
                <div className="text-sm text-mail-text-muted">
                  Choose between light and dark mode
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Sun size={18} className={theme === 'light' ? 'text-mail-accent' : 'text-mail-text-muted'} />
                <ToggleSwitch
                  active={theme === 'dark'}
                  onClick={toggleTheme}
                />
                <Moon size={18} className={theme === 'dark' ? 'text-mail-accent' : 'text-mail-text-muted'} />
              </div>
            </div>

            {/* Date Format */}
            <div className="pt-4 border-t border-mail-border">
              <div className="font-medium text-mail-text mb-1">Date Format</div>
              <div className="text-sm text-mail-text-muted mb-3">
                Controls how dates appear in the email list
              </div>
              <select
                value={dateFormat}
                onChange={(e) => setDateFormat(e.target.value)}
                className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:border-mail-accent transition-all cursor-pointer"
              >
                <option value="auto">System Default ({navigator.language})</option>
                <option value="MM/dd/yyyy">MM/DD/YYYY (US)</option>
                <option value="dd/MM/yyyy">DD/MM/YYYY (Europe)</option>
                <option value="yyyy-MM-dd">YYYY-MM-DD (ISO)</option>
                <option value="dd MMM yyyy">DD MMM YYYY (e.g., 25 Feb 2024)</option>
                <option value="custom">Custom...</option>
              </select>
              {dateFormat === 'custom' && (
                <div className="mt-3">
                  <input
                    type="text"
                    value={customDateFormat}
                    onChange={(e) => setCustomDateFormat(e.target.value)}
                    placeholder="e.g., dd.MM.yyyy"
                    className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:border-mail-accent transition-all"
                  />
                  <p className="text-xs text-mail-text-muted mt-1">
                    Uses date-fns tokens: yyyy=year, MM=month, dd=day, HH=hour, mm=minute
                  </p>
                </div>
              )}
              <div className="mt-2 flex items-center gap-4 text-xs text-mail-text-muted">
                <span>Today: <span className="text-mail-text">{formatEmailDate(new Date().toISOString())}</span></span>
                <span>Older: <span className="text-mail-text">{formatEmailDate('2023-06-15T10:00:00Z')}</span></span>
              </div>
            </div>

            {/* Action Button Style */}
            <div className="pt-4 border-t border-mail-border">
              <div className="font-medium text-mail-text mb-1">Action button style</div>
              <div className="text-sm text-mail-text-muted mb-3">
                Choose how email action buttons are displayed
              </div>
              <select
                value={actionButtonDisplay}
                onChange={(e) => setActionButtonDisplay(e.target.value)}
                className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:border-mail-accent transition-all cursor-pointer"
              >
                <option value="icon-only">Icons only</option>
                <option value="icon-label">Icons and labels</option>
                <option value="text-only">Labels only</option>
              </select>
            </div>
          </div>
        </div>

        {/* Layout */}
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <LayoutGrid size={18} className="text-mail-accent" />
            Layout
          </h4>

          <p className="text-sm text-mail-text-muted mb-4">
            Choose how emails are displayed. Drag the divider between panes to resize.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setLayoutMode('three-column')}
              className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                        ${layoutMode === 'three-column'
                          ? 'border-mail-accent bg-mail-accent/10'
                          : 'border-mail-border hover:border-mail-accent/50'}`}
            >
              <div className="flex gap-1 w-full h-12">
                <div className="w-1/4 bg-mail-border rounded" />
                <div className="w-1/3 bg-mail-border rounded" />
                <div className="flex-1 bg-mail-border rounded" />
              </div>
              <div className="flex items-center gap-2 text-sm font-medium text-mail-text">
                <Columns size={16} />
                Three Columns
              </div>
              <span className="text-xs text-mail-text-muted">
                Sidebar | List | Content
              </span>
            </button>

            <button
              onClick={() => setLayoutMode('two-column')}
              className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                        ${layoutMode === 'two-column'
                          ? 'border-mail-accent bg-mail-accent/10'
                          : 'border-mail-border hover:border-mail-accent/50'}`}
            >
              <div className="flex gap-1 w-full h-12">
                <div className="w-1/4 bg-mail-border rounded" />
                <div className="flex-1 flex flex-col gap-1">
                  <div className="h-1/2 bg-mail-border rounded" />
                  <div className="h-1/2 bg-mail-border rounded" />
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm font-medium text-mail-text">
                <Rows size={16} />
                Two Columns
              </div>
              <span className="text-xs text-mail-text-muted">
                List above Content
              </span>
            </button>
          </div>
        </div>

        {/* View Style */}
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <MessageSquare size={18} className="text-mail-accent" />
            View Style
          </h4>

          <p className="text-sm text-mail-text-muted mb-4">
            Choose how to display your emails. Traditional list view or chat-style conversation view.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setViewStyle('list')}
              className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                        ${viewStyle === 'list'
                          ? 'border-mail-accent bg-mail-accent/10'
                          : 'border-mail-border hover:border-mail-accent/50'}`}
            >
              <div className="w-full h-12 flex flex-col gap-1">
                <div className="h-3 bg-mail-border rounded w-full" />
                <div className="h-3 bg-mail-border rounded w-full" />
                <div className="h-3 bg-mail-border rounded w-3/4" />
              </div>
              <div className="flex items-center gap-2 text-sm font-medium text-mail-text">
                <List size={16} />
                List View
              </div>
              <span className="text-xs text-mail-text-muted">
                Traditional email list
              </span>
            </button>

            <button
              onClick={() => setViewStyle('chat')}
              className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                        ${viewStyle === 'chat'
                          ? 'border-mail-accent bg-mail-accent/10'
                          : 'border-mail-border hover:border-mail-accent/50'}`}
            >
              <div className="w-full h-12 flex flex-col justify-end gap-1">
                <div className="h-2.5 bg-mail-border rounded-full w-2/3 self-start" />
                <div className="h-2.5 bg-mail-accent/30 rounded-full w-1/2 self-end" />
                <div className="h-2.5 bg-mail-border rounded-full w-3/5 self-start" />
              </div>
              <div className="flex items-center gap-2 text-sm font-medium text-mail-text">
                <MessageSquare size={16} />
                Chat View
              </div>
              <span className="text-xs text-mail-text-muted">
                Conversation style
              </span>
            </button>
          </div>
        </div>

        {/* Email List Style */}
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <List size={18} className="text-mail-accent" />
            Email List Style
          </h4>

          <p className="text-sm text-mail-text-muted mb-4">
            Choose how emails appear in the list.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setEmailListStyle('default')}
              className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                        ${emailListStyle === 'default'
                          ? 'border-mail-accent bg-mail-accent/10'
                          : 'border-mail-border hover:border-mail-accent/50'}`}
            >
              <div className="w-full h-12 flex flex-col gap-1.5 justify-center">
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 bg-mail-border rounded-sm flex-shrink-0" />
                  <div className="h-2 bg-mail-border rounded flex-1" />
                  <div className="h-2 bg-mail-border rounded w-8" />
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 bg-mail-border rounded-sm flex-shrink-0" />
                  <div className="h-2 bg-mail-border rounded flex-1" />
                  <div className="h-2 bg-mail-border rounded w-8" />
                </div>
              </div>
              <span className="text-sm font-medium text-mail-text">Default</span>
              <span className="text-xs text-mail-text-muted">Single line per email</span>
            </button>

            <button
              onClick={() => setEmailListStyle('compact')}
              className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                        ${emailListStyle === 'compact'
                          ? 'border-mail-accent bg-mail-accent/10'
                          : 'border-mail-border hover:border-mail-accent/50'}`}
            >
              <div className="w-full h-12 flex flex-col gap-0.5 justify-center">
                <div className="flex items-center gap-1">
                  <div className="h-1.5 bg-mail-text-muted/30 rounded w-16" />
                  <div className="h-1.5 bg-mail-border rounded w-6 ml-auto" />
                </div>
                <div className="h-2 bg-mail-border rounded w-full" />
                <div className="h-px bg-mail-border/50 w-full mt-0.5" />
                <div className="flex items-center gap-1">
                  <div className="h-1.5 bg-mail-text-muted/30 rounded w-12" />
                  <div className="h-1.5 bg-mail-border rounded w-6 ml-auto" />
                </div>
                <div className="h-2 bg-mail-border rounded w-3/4" />
              </div>
              <span className="text-sm font-medium text-mail-text">Compact</span>
              <span className="text-xs text-mail-text-muted">Sender + subject on two lines</span>
            </button>
          </div>
        </div>

        {/* Thread Sort Order */}
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <List size={18} className="text-mail-accent" />
            Thread Sort Order
          </h4>
          <p className="text-sm text-mail-text-muted mb-4">
            Choose how emails are ordered within a thread conversation.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setThreadSortOrder('oldest-first')}
              className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                        ${threadSortOrder === 'oldest-first'
                          ? 'border-mail-accent bg-mail-accent/10'
                          : 'border-mail-border hover:border-mail-accent/50'}`}
            >
              <ChevronDown size={24} className="text-mail-text-muted" />
              <span className="text-sm font-medium text-mail-text">Oldest First</span>
              <span className="text-xs text-mail-text-muted">Conversation flows top to bottom</span>
            </button>
            <button
              onClick={() => setThreadSortOrder('newest-first')}
              className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                        ${threadSortOrder === 'newest-first'
                          ? 'border-mail-accent bg-mail-accent/10'
                          : 'border-mail-border hover:border-mail-accent/50'}`}
            >
              <ChevronUp size={24} className="text-mail-text-muted" />
              <span className="text-sm font-medium text-mail-text">Newest First</span>
              <span className="text-xs text-mail-text-muted">Latest reply at the top</span>
            </button>
          </div>
        </div>

        {/* Signature Display */}
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <PenTool size={18} className="text-mail-accent" />
            Signature Display
          </h4>
          <p className="text-sm text-mail-text-muted mb-4">
            Control how email signatures appear in threads and conversations.
          </p>
          <div className="grid grid-cols-2 gap-3">
            {[
              { value: 'smart', label: 'Smart', desc: 'Show once per sender, collapse duplicates' },
              { value: 'always-show', label: 'Always Show', desc: 'Never collapse signatures' },
              { value: 'always-hide', label: 'Always Hide', desc: 'Collapse all signatures' },
              { value: 'collapsed', label: 'Collapsed', desc: 'Collapsed with toggle to expand' },
            ].map(opt => (
              <button
                key={opt.value}
                onClick={() => setSignatureDisplay(opt.value)}
                className={`p-3 rounded-lg border-2 transition-all text-left
                  ${signatureDisplay === opt.value
                    ? 'border-mail-accent bg-mail-accent/10'
                    : 'border-mail-border hover:border-mail-accent/50'}`}
              >
                <span className="text-sm font-medium text-mail-text block">{opt.label}</span>
                <span className="text-xs text-mail-text-muted">{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>
        </>}

        {/* === Behavior sub-tab === */}
        {generalSubTab === 'behavior' && <>
        {/* Email Sync (Behavior) */}
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <RefreshCw size={18} className="text-mail-accent" />
            Email Sync
          </h4>

          <p className="text-sm text-mail-text-muted mb-4">
            Automatically check for new emails at regular intervals.
          </p>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-2">
              <div>
                <div className="font-medium text-mail-text">Refresh on app launch</div>
                <div className="text-sm text-mail-text-muted">
                  Check for new emails when the app starts
                </div>
              </div>
              <ToggleSwitch
                active={refreshOnLaunch}
                onClick={() => setRefreshOnLaunch(!refreshOnLaunch)}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-mail-text mb-2">
                Auto-refresh interval
              </label>
              <select
                value={refreshInterval}
                onChange={(e) => setRefreshInterval(parseInt(e.target.value))}
                className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                          text-mail-text focus:border-mail-accent transition-all
                          cursor-pointer"
              >
                <option value={0}>Never</option>
                <option value={1}>Every minute</option>
                <option value={5}>Every 5 minutes</option>
                <option value={15}>Every 15 minutes</option>
                <option value={30}>Every 30 minutes</option>
                <option value={60}>Every hour</option>
                <option value={120}>Every 2 hours</option>
                <option value={360}>Every 6 hours</option>
                <option value={720}>Every 12 hours</option>
                <option value={1440}>Every 24 hours</option>
              </select>
            </div>

            {lastRefreshTime && (
              <div className="flex items-center gap-2 p-3 bg-mail-bg rounded-lg text-sm text-mail-text-muted">
                <RefreshCw size={14} />
                <span>
                  Last refreshed: {(() => {
                    const diff = Date.now() - lastRefreshTime;
                    const minutes = Math.floor(diff / 60000);
                    if (minutes < 1) return 'Just now';
                    if (minutes === 1) return '1 minute ago';
                    if (minutes < 60) return `${minutes} minutes ago`;
                    const hours = Math.floor(minutes / 60);
                    if (hours === 1) return '1 hour ago';
                    if (hours < 24) return `${hours} hours ago`;
                    const days = Math.floor(hours / 24);
                    if (days === 1) return '1 day ago';
                    return `${days} days ago`;
                  })()}
                </span>
              </div>
            )}
          </div>
        </div>
        </>}

        {/* === Notifications sub-tab === */}
        {generalSubTab === 'notifications' && <>
        {/* Notifications */}
        <div data-testid="settings-notifications" className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <Bell size={18} className="text-mail-accent" />
            Notifications
          </h4>

          <p className="text-sm text-mail-text-muted mb-4">
            Get notified when new emails arrive.
          </p>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-2">
              <div>
                <div className="font-medium text-mail-text">Enable desktop notifications</div>
                <div className="text-sm text-mail-text-muted">
                  Show desktop notifications for new emails
                </div>
              </div>
              <ToggleSwitch
                active={notificationSettings.enabled}
                onClick={() => setNotificationEnabled(!notificationSettings.enabled)}
              />
            </div>

            {notificationSettings.enabled && (
              <>
                <div className="flex items-center justify-between py-2">
                  <div>
                    <div className="font-medium text-mail-text">Show email preview</div>
                    <div className="text-sm text-mail-text-muted">
                      Show sender and subject in notifications
                    </div>
                  </div>
                  <ToggleSwitch
                    active={notificationSettings.showPreview}
                    onClick={() => setNotificationShowPreview(!notificationSettings.showPreview)}
                  />
                </div>

                {/* Per-account notification settings */}
                <div className="border-t border-mail-border pt-3">
                  <div className="text-sm font-medium text-mail-text mb-3">Per-account settings</div>
                  <div className="space-y-1">
                    {orderedAccounts.filter(a => !isAccountHidden(a.id)).map(account => {
                      const acctConfig = notificationSettings.accounts[account.id] || { enabled: true, folders: ['INBOX'] };
                      const isExpanded = expandedNotifAccounts[account.id];
                      const commonFolders = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive'];
                      const displayName = getDisplayName(account.id) || account.email;

                      return (
                        <div key={account.id} className="rounded-lg border border-mail-border overflow-hidden">
                          <div className="flex items-center gap-3 px-3 py-2.5">
                            {/* Account avatar */}
                            <div
                              className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold flex-shrink-0"
                              style={{ backgroundColor: getAccountColor(accountColors, account) }}
                            >
                              {getAccountInitial(account, displayName)}
                            </div>

                            {/* Account name + expand toggle */}
                            <button
                              className="flex-1 text-left min-w-0"
                              onClick={() => setExpandedNotifAccounts(prev => ({
                                ...prev,
                                [account.id]: !prev[account.id]
                              }))}
                            >
                              <div className="text-sm font-medium text-mail-text truncate">{displayName}</div>
                            </button>

                            {/* Expand chevron */}
                            {acctConfig.enabled && (
                              <button
                                className="p-1 text-mail-text-muted hover:text-mail-text transition-colors"
                                onClick={() => setExpandedNotifAccounts(prev => ({
                                  ...prev,
                                  [account.id]: !prev[account.id]
                                }))}
                                title="Configure folders"
                              >
                                {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                              </button>
                            )}

                            {/* Account toggle */}
                            <ToggleSwitch
                              active={acctConfig.enabled}
                              onClick={() => setAccountNotificationEnabled(account.id, !acctConfig.enabled)}
                            />
                          </div>

                          {/* Expanded folder list */}
                          {acctConfig.enabled && isExpanded && (
                            <div className="px-3 pb-3 pt-1 border-t border-mail-border bg-mail-bg/50">
                              <div className="text-xs text-mail-text-muted mb-2">Notify for these folders:</div>
                              <div className="space-y-1.5">
                                {commonFolders.map(folder => {
                                  const isChecked = acctConfig.folders.includes(folder);
                                  return (
                                    <label key={folder} className="flex items-center gap-2 cursor-pointer group">
                                      <input
                                        type="checkbox"
                                        checked={isChecked}
                                        onChange={() => {
                                          const newFolders = isChecked
                                            ? acctConfig.folders.filter(f => f !== folder)
                                            : [...acctConfig.folders, folder];
                                          setAccountNotificationFolders(account.id, newFolders);
                                        }}
                                        className="rounded border-mail-border text-mail-accent focus:ring-mail-accent"
                                      />
                                      <span className="text-sm text-mail-text group-hover:text-mail-accent transition-colors">
                                        {folder}
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

          </div>
        </div>

        {/* Badge */}
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <Mail size={18} className="text-mail-accent" />
            Badge
          </h4>

          <p className="text-sm text-mail-text-muted mb-4">
            Configure the dock icon badge counter.
          </p>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-2">
              <div>
                <div className="font-medium text-mail-text">Show badge count</div>
                <div className="text-sm text-mail-text-muted">
                  Display email count on dock icon
                </div>
              </div>
              <ToggleSwitch
                active={badgeEnabled}
                onClick={() => setBadgeEnabled(!badgeEnabled)}
              />
            </div>

            {badgeEnabled && (
              <div>
                <label className="block text-sm font-medium text-mail-text mb-2">
                  Badge shows
                </label>
                <select
                  value={badgeMode}
                  onChange={(e) => setBadgeMode(e.target.value)}
                  className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                            text-mail-text focus:border-mail-accent transition-all
                            cursor-pointer"
                >
                  <option value="unread">Unread messages</option>
                  <option value="total">Total messages</option>
                </select>
              </div>
            )}
          </div>
        </div>
        </>}

        {/* === Behavior sub-tab (continued) === */}
        {generalSubTab === 'behavior' && <>
        {/* Sending */}
        <div data-testid="settings-undo-send" className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <SendHorizontal size={18} className="text-mail-accent" />
            Sending
          </h4>

          <p className="text-sm text-mail-text-muted mb-4">
            Configure send behavior and undo options.
          </p>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-2">
              <div>
                <div className="font-medium text-mail-text">Enable Undo Send</div>
                <div className="text-sm text-mail-text-muted">
                  Briefly delay sending so you can undo
                </div>
              </div>
              <ToggleSwitch
                active={undoSendEnabled}
                onClick={() => setUndoSendEnabled(!undoSendEnabled)}
              />
            </div>

            {undoSendEnabled && (
              <div>
                <label className="block text-sm font-medium text-mail-text mb-2">
                  Undo send delay
                </label>
                <select
                  value={undoSendDelay}
                  onChange={(e) => setUndoSendDelay(Number(e.target.value))}
                  className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                            text-mail-text focus:border-mail-accent transition-all
                            cursor-pointer"
                >
                  <option value={5}>5 seconds</option>
                  <option value={10}>10 seconds</option>
                  <option value={15}>15 seconds</option>
                  <option value={30}>30 seconds</option>
                </select>
              </div>
            )}
          </div>
        </div>

        {/* Mark as Read */}
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <Eye size={18} className="text-mail-accent" />
            Mark as Read
          </h4>

          <p className="text-sm text-mail-text-muted mb-4">
            Choose when opened emails are marked as read.
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-mail-text mb-2">
                Mark emails as read
              </label>
              <select
                value={markAsReadMode}
                onChange={(e) => setMarkAsReadMode(e.target.value)}
                className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                          text-mail-text focus:border-mail-accent transition-all
                          cursor-pointer"
              >
                <option value="delay">After a short delay</option>
                <option value="auto">Immediately when opened</option>
                <option value="manual">Manually only</option>
              </select>
              <p className="text-xs text-mail-text-muted mt-1">
                {markAsReadMode === 'delay'
                  ? `Emails are marked as read after ${markAsReadDelay} seconds of viewing`
                  : markAsReadMode === 'auto'
                  ? 'Emails are marked as read instantly when you open them'
                  : 'Use the Mark as Read button to mark emails as read'}
              </p>
            </div>

            {markAsReadMode === 'delay' && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-mail-text">
                    Delay before marking as read
                  </label>
                  <span className="text-sm font-medium text-mail-accent">
                    {markAsReadDelay} {markAsReadDelay === 1 ? 'second' : 'seconds'}
                  </span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="10"
                  step="1"
                  value={markAsReadDelay}
                  onChange={(e) => setMarkAsReadDelay(parseInt(e.target.value))}
                  className="w-full"
                />
                <div className="flex justify-between mt-1 px-1">
                  <span className="text-[10px] text-mail-text-muted">1s</span>
                  <span className="text-[10px] text-mail-text-muted">5s</span>
                  <span className="text-[10px] text-mail-text-muted">10s</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Search Settings */}
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <Search size={18} className="text-mail-accent" />
            Search
          </h4>

          <p className="text-sm text-mail-text-muted mb-4">
            Configure search behavior and history settings.
          </p>

          <div className="space-y-4">
            {/* Search history limit */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-mail-text">
                  Search history limit
                </label>
                <span className="text-sm font-medium text-mail-accent">
                  {searchHistoryLimit} searches
                </span>
              </div>
              <input
                type="range"
                min="20"
                max="500"
                step="10"
                value={searchHistoryLimit}
                onChange={(e) => setSearchHistoryLimit(parseInt(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between mt-1 px-1">
                <span className="text-[10px] text-mail-text-muted">20</span>
                <span className="text-[10px] text-mail-text-muted">250</span>
                <span className="text-[10px] text-mail-text-muted">500</span>
              </div>
            </div>

            {/* Popular filters period */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-mail-text">
                  Popular filters period
                </label>
                <span className="text-sm font-medium text-mail-accent">
                  {filterHistoryPeriodDays >= 30 && filterHistoryPeriodDays < 60
                    ? '1 month'
                    : filterHistoryPeriodDays >= 60 && filterHistoryPeriodDays < 90
                    ? '2 months'
                    : filterHistoryPeriodDays >= 90 && filterHistoryPeriodDays < 180
                    ? '3 months'
                    : filterHistoryPeriodDays >= 180 && filterHistoryPeriodDays < 365
                    ? '6 months'
                    : '1 year'}
                </span>
              </div>
              <input
                type="range"
                min="30"
                max="365"
                step="30"
                value={filterHistoryPeriodDays}
                onChange={(e) => setFilterHistoryPeriodDays(parseInt(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between mt-1 px-1">
                <span className="text-[10px] text-mail-text-muted">1 month</span>
                <span className="text-[10px] text-mail-text-muted">6 months</span>
                <span className="text-[10px] text-mail-text-muted">1 year</span>
              </div>
            </div>

            {/* Top filters limit */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-mail-text">
                  Number of popular filters to show
                </label>
                <span className="text-sm font-medium text-mail-accent">
                  {topFiltersLimit} filters
                </span>
              </div>
              <input
                type="range"
                min="5"
                max="50"
                step="5"
                value={topFiltersLimit}
                onChange={(e) => setTopFiltersLimit(parseInt(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between mt-1 px-1">
                <span className="text-[10px] text-mail-text-muted">5</span>
                <span className="text-[10px] text-mail-text-muted">25</span>
                <span className="text-[10px] text-mail-text-muted">50</span>
              </div>
            </div>

            {/* Search history */}
            <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
              <div className="flex items-center gap-2">
                <Clock size={14} className="text-mail-text-muted" />
                <div>
                  <div className="text-sm text-mail-text">Search history</div>
                  <div className="text-xs text-mail-text-muted">
                    {searchHistory.length} saved searches
                  </div>
                </div>
              </div>
              <button
                onClick={clearSearchHistory}
                disabled={searchHistory.length === 0}
                className="px-3 py-1.5 text-sm text-mail-text-muted hover:text-mail-text
                          hover:bg-mail-border rounded-lg transition-colors disabled:opacity-50"
              >
                Clear
              </button>
            </div>

            {/* Filter usage history */}
            <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
              <div className="flex items-center gap-2">
                <Filter size={14} className="text-mail-text-muted" />
                <div>
                  <div className="text-sm text-mail-text">Filter history</div>
                  <div className="text-xs text-mail-text-muted">
                    {filterUsageHistory.length} filter uses tracked
                  </div>
                </div>
              </div>
              <button
                onClick={clearFilterHistory}
                disabled={filterUsageHistory.length === 0}
                className="px-3 py-1.5 text-sm text-mail-text-muted hover:text-mail-text
                          hover:bg-mail-border rounded-lg transition-colors disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
        </>}

        {/* === Keyboard Shortcuts sub-tab === */}
        {generalSubTab === 'shortcuts' && <>
        {/* Keyboard Shortcuts */}
        <div data-testid="settings-shortcuts" className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <Keyboard size={18} className="text-mail-accent" />
            Keyboard Shortcuts
          </h4>

          <p className="text-sm text-mail-text-muted mb-4">
            Customize keyboard shortcuts. Click a binding to change it.
          </p>

          <div className="space-y-4">
            {/* Master toggle */}
            <div className="flex items-center justify-between py-2">
              <div>
                <div className="font-medium text-mail-text">Enable keyboard shortcuts</div>
                <div className="text-sm text-mail-text-muted">
                  Use keyboard shortcuts to navigate and perform actions
                </div>
              </div>
              <ToggleSwitch
                active={keyboardShortcutsEnabled}
                onClick={() => setKeyboardShortcutsEnabled(!keyboardShortcutsEnabled)}
              />
            </div>

            {keyboardShortcutsEnabled && (
              <div className="pt-2 space-y-5">
                {SHORTCUT_CATEGORIES.map(category => (
                  <div key={category.title}>
                    <h5 className="text-xs font-semibold text-mail-text uppercase tracking-wider mb-2">
                      {category.title}
                    </h5>
                    <div className="bg-mail-bg rounded-lg overflow-hidden border border-mail-border">
                      {category.actions.map((action, idx) => {
                        const binding = keyboardShortcuts[action];
                        const defaultBinding = DEFAULT_SHORTCUTS[action];
                        const isModified = binding !== defaultBinding;
                        const isRebinding = rebindingAction === action;
                        const duplicate = isModified ? findDuplicateBinding(action, binding) : null;

                        return (
                          <div
                            key={action}
                            className={`flex items-center justify-between px-3 py-2 ${
                              idx > 0 ? 'border-t border-mail-border/50' : ''
                            }`}
                          >
                            <span className="text-sm text-mail-text">
                              {SHORTCUT_ACTION_LABELS[action] || action}
                            </span>
                            <div className="flex items-center gap-2">
                              {duplicate && (
                                <span className="text-xs text-amber-500" title={`Also bound to "${SHORTCUT_ACTION_LABELS[duplicate]}"`}>
                                  Duplicate
                                </span>
                              )}
                              <button
                                onClick={() => {
                                  if (isRebinding) {
                                    setRebindingAction(null);
                                    setRebindFirstKey(null);
                                    if (rebindTimer) { clearTimeout(rebindTimer); setRebindTimer(null); }
                                  } else {
                                    setRebindingAction(action);
                                    setRebindFirstKey(null);
                                  }
                                }}
                                className={`inline-flex items-center justify-center min-w-[72px] h-7 px-2
                                           text-xs font-mono rounded-md border transition-all ${
                                  isRebinding
                                    ? 'border-mail-accent bg-mail-accent/10 text-mail-accent animate-pulse'
                                    : isModified
                                      ? 'border-mail-accent/50 bg-mail-accent/5 text-mail-text hover:border-mail-accent'
                                      : 'border-mail-border bg-mail-border/30 text-mail-text-muted hover:border-mail-accent/50'
                                }`}
                              >
                                {isRebinding
                                  ? rebindFirstKey
                                    ? `${rebindFirstKey} + \u2026`
                                    : 'Press key\u2026'
                                  : formatKeybindingDisplay(binding)
                                }
                              </button>
                              {isModified && !isRebinding && (
                                <button
                                  onClick={() => setKeyboardShortcut(action, defaultBinding)}
                                  className="p-1 text-mail-text-muted hover:text-mail-text rounded transition-colors"
                                  title="Reset to default"
                                >
                                  <RotateCcw size={13} />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {/* Reset All */}
                <div className="pt-2 border-t border-mail-border">
                  <button
                    onClick={resetKeyboardShortcuts}
                    className="px-4 py-2 text-sm text-mail-text-muted hover:text-mail-text
                              hover:bg-mail-border rounded-lg transition-colors flex items-center gap-2"
                  >
                    <RotateCcw size={14} />
                    Reset All to Defaults
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        </>}

      </div>
    </div>
  );
}
