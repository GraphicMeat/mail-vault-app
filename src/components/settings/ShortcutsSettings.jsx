import React, { useState, useEffect } from 'react';
import { useSettingsStore, DEFAULT_SHORTCUTS } from '../../stores/settingsStore';
import { ToggleSwitch } from './ToggleSwitch';
import { Keyboard, ChevronUp, ChevronDown, RotateCcw } from 'lucide-react';

export function ShortcutsSettings() {
  const {
    keyboardShortcuts,
    keyboardShortcutsEnabled,
    setKeyboardShortcut,
    setKeyboardShortcutsEnabled,
    resetKeyboardShortcuts,
  } = useSettingsStore();

  const [rebindingAction, setRebindingAction] = useState(null);
  const [rebindFirstKey, setRebindFirstKey] = useState(null);
  const [rebindTimer, setRebindTimer] = useState(null);

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
    <>
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
                            idx > 0 ? 'border-t border-mail-border' : ''
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
    </>
  );
}
