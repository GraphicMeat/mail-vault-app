import React, { useMemo, useState } from 'react';
import { useKeepStore } from '../stores/keepStore';
import { useMailStore } from '../stores/mailStore';
import { keptStacks } from '../shared/keep';
import { KeepDockView } from './keep/KeepDockView';
import { SettingsViewProvider } from './settings/views/viewContext';
import { Private } from './privacy/Private';
import { useT } from '../i18n/index.js';

/// Desktop wiring of the kept-email dock: the keep store and the account list
/// in, the shared view (keep/KeepDockView.jsx) out. `onOpen({ accountId,
/// mailbox, uid })` shows one message; opening never removes it from the dock.
export function KeepDock({ onOpen }) {
  const t = useT();
  const items = useKeepStore(s => s.items);
  const dock = useKeepStore(s => s.dock);
  const accounts = useMailStore(s => s.accounts);
  const [expandedKey, setExpandedKey] = useState(null);
  // Kept emails of an account that is gone (removed, restored, imported) stay out of the dock and its counts.
  const stacks = useMemo(() => keptStacks(items, accounts.map(a => a.id)), [items, accounts]);
  const { remove, removeSender, moveDock } = useKeepStore.getState();
  return (
    <SettingsViewProvider t={t} Private={Private}>
      <KeepDockView
        stacks={stacks}
        dock={dock}
        expandedKey={expandedKey}
        onExpand={setExpandedKey}
        onOpen={({ accountId, mailbox, uid }) => onOpen({ accountId, mailbox, uid })}
        onRemove={remove}
        onCloseStack={removeSender}
        onMove={moveDock}
      />
    </SettingsViewProvider>
  );
}
