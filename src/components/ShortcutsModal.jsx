import React, { useId } from 'react';
import { X, Keyboard } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';

const ACTION_LABELS = {
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

const CATEGORIES = [
  {
    title: 'Navigation',
    actions: ['nextEmail', 'prevEmail', 'goToInbox', 'goToSent', 'goToDrafts'],
  },
  {
    title: 'Actions',
    actions: ['reply', 'replyAll', 'forward', 'archive', 'delete', 'moveToFolder', 'compose'],
  },
  {
    title: 'Selection',
    actions: ['toggleSelect', 'escape'],
  },
  {
    title: 'UI',
    actions: ['focusSearch', 'showShortcuts', 'openSettings'],
  },
];

/** Map modifier names to display symbols */
function formatModifier(mod) {
  const map = { Meta: '\u2318', Ctrl: '\u2303', Alt: '\u2325', Shift: '\u21E7' };
  return map[mod] || mod;
}

/** Parse a keybinding string into displayable key badges */
function parseKeybinding(keybinding) {
  if (!keybinding) return [];

  // Modifier combo like "Meta+,"
  if (keybinding.includes('+')) {
    const parts = keybinding.split('+');
    return parts.map(p => formatModifier(p));
  }

  // Multi-key sequence like "g i"
  if (keybinding.includes(' ')) {
    return keybinding.split(' ');
  }

  // Special key names
  if (keybinding === 'Escape') return ['Esc'];

  // Single key
  return [keybinding];
}

function KeyBadge({ children }) {
  return (
    <span className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5
                     text-xs font-mono font-medium text-mail-text
                     bg-mail-border/50 border border-mail-border rounded-md shadow-sm">
      {children}
    </span>
  );
}

function ShortcutRow({ action, keybinding }) {
  const label = ACTION_LABELS[action] || action;
  const keys = parseKeybinding(keybinding);

  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-mail-text-muted">{label}</span>
      <div className="flex items-center gap-1">
        {keys.map((key, i) => (
          <KeyBadge key={i}>{key}</KeyBadge>
        ))}
      </div>
    </div>
  );
}

export function ShortcutsModal({ onClose }) {
  const keyboardShortcuts = useSettingsStore(s => s.keyboardShortcuts);

  const titleId = useId();

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      padded={false}
      data-testid="shortcuts-modal"
      aria-labelledby={titleId}
      panelClassName="overflow-hidden"
    >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-mail-border">
          <h2 id={titleId} className="text-lg font-semibold text-mail-text flex items-center gap-2">
            <Keyboard size={20} className="text-mail-accent-text" />
            Keyboard Shortcuts
          </h2>
          <Button variant="ghost" icon size="xs" onClick={onClose} aria-label="Close">
            <X size={18} />
          </Button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
            {CATEGORIES.map((category) => (
              <div key={category.title}>
                <h3 className="text-xs font-semibold text-mail-text uppercase tracking-wider mb-2">
                  {category.title}
                </h3>
                <div className="space-y-0">
                  {category.actions.map((action) => (
                    <ShortcutRow
                      key={action}
                      action={action}
                      keybinding={keyboardShortcuts[action]}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer hint */}
        <div className="px-5 py-3 border-t border-mail-border">
          <p className="text-xs text-mail-text-muted text-center">
            Press <KeyBadge>?</KeyBadge> to toggle this panel
          </p>
        </div>
    </Dialog>
  );
}
