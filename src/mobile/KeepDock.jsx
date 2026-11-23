// The phone's dock of kept emails: this device's keep store and account list in, the shared view
// (components/keep/KeepDockView.jsx) out. `onOpen({ accountId, folder, uid })` goes through the
// notification-tap path (App.jsx), so a kept message opens in its own account and folder.
import React, { useCallback, useEffect, useMemo } from 'react';
import { useKeepStore } from './keep.js';
import { useMobileStore } from './store.js';
import { visibleAccounts } from './prefs.js';
import { useBackLayer } from './backStack.js';
import { useT } from './i18n.js';
import { keptStacks } from '../shared/keep';
import { KeepDockView } from '../components/keep/KeepDockView';
import { useExpandedStack } from '../components/keep/useExpandedStack';
import { SettingsViewProvider } from '../components/settings/views/viewContext';

export default function KeepDock({ onOpen, autoExpand = false }) {
  const t = useT();
  const items = useKeepStore((s) => s.items);
  const dock = useKeepStore((s) => s.dock);
  const accounts = useMobileStore((s) => s.accounts);
  // Kept emails of an account that is gone or hidden stay out of the dock and its counts.
  const stacks = useMemo(() => keptStacks(items, visibleAccounts(accounts).map((a) => a.id)), [items, accounts]);
  const [expandedKey, setExpandedKey] = useExpandedStack(stacks);
  const collapse = useCallback(() => setExpandedKey(null), []);
  useBackLayer(Boolean(expandedKey), collapse);
  // Screenshot hook (?ui=keep): the first group opens by itself.
  useEffect(() => {
    if (autoExpand && stacks[0]) setExpandedKey((key) => key ?? stacks[0].key);
  }, [autoExpand, stacks, setExpandedKey]);
  const { remove, removeSender, moveDock } = useKeepStore.getState();
  return (
    <SettingsViewProvider t={t}>
      <KeepDockView
        stacks={stacks}
        dock={dock}
        expandedKey={expandedKey}
        onExpand={setExpandedKey}
        onOpen={({ accountId, mailbox, uid }) => onOpen({ accountId, folder: mailbox, uid })}
        onRemove={remove}
        onCloseStack={removeSender}
        onMove={moveDock}
      />
    </SettingsViewProvider>
  );
}
