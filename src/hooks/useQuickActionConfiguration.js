import { useMemo, useSyncExternalStore } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSearchStore } from '../stores/searchStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useViewStore, effectiveViewConfig, currentListView } from '../stores/viewStore';
import { currentQuickActionScope, quickActionScopeKey, resolveQuickActions } from '../utils/quickActions';

// The detached Settings window has none of the main window's mail, search or
// view state, so on its own it resolved every surface for INBOX. It is handed
// the main window's scope at open and again whenever that changes (App.jsx,
// watchQuickActionScope), and pins it here. Components re-render on a new pin:
// Current-view edits must land on the view the main window shows now.
let pinnedScope;
const pinListeners = new Set();
export function pinQuickActionScope(scope) {
  if (scope !== undefined && pinnedScope !== undefined && quickActionScopeKey(scope) === quickActionScopeKey(pinnedScope)) return;
  pinnedScope = scope;
  pinListeners.forEach(listener => listener());
}
const subscribePin = listener => {
  pinListeners.add(listener);
  return () => pinListeners.delete(listener);
};
const readPin = () => pinnedScope;

/// The scope the main window's surfaces resolve right now, read outside React.
export function currentQuickActionScopeSnapshot() {
  const { activeMailbox, activeAccountId, viewMode, unifiedInbox, unifiedFolder, mailboxScope } = useMailStore.getState();
  return currentQuickActionScope({
    activeMailbox, activeAccountId, viewMode, unifiedInbox, unifiedFolder, mailboxScope,
    isSearchResults: useSearchStore.getState().searchActive,
  }, { emailListView: currentListView() });
}

/// Calls `onChange(scope)` whenever the main window's scope changes: a move to
/// another folder, account, search or list mode. It listens to every store the
/// snapshot reads and compares scope keys, which is cheap next to what a mail
/// store update costs anyway.
export function watchQuickActionScope(onChange) {
  let key = quickActionScopeKey(currentQuickActionScopeSnapshot());
  const check = () => {
    const scope = currentQuickActionScopeSnapshot();
    const next = quickActionScopeKey(scope);
    if (next === key) return;
    key = next;
    onChange(scope);
  };
  const stops = [useMailStore, useSearchStore, useViewStore, useSettingsStore].map(store => store.subscribe(check));
  return () => stops.forEach(stop => stop());
}

export function useQuickActionConfiguration(surface, scopeOverride = undefined) {
  const quickActions = useSettingsStore(state => state.quickActions);
  const globalListView = useSettingsStore(state => state.emailListView);
  const viewOverrides = useSettingsStore(state => state.viewOverrides);
  const activeView = useViewStore(state => state.views.find(view => view.id === state.activeViewId) || null);
  // Inside a saved view the list mode is that view's own, not the global one.
  const emailListView = activeView ? effectiveViewConfig(activeView, { emailListView: globalListView, viewOverrides }).listView : globalListView;
  const activeMailbox = useMailStore(state => state.activeMailbox);
  const activeAccountId = useMailStore(state => state.activeAccountId);
  const viewMode = useMailStore(state => state.viewMode);
  const unifiedInbox = useMailStore(state => state.unifiedInbox);
  const unifiedFolder = useMailStore(state => state.unifiedFolder);
  const mailboxScope = useMailStore(state => state.mailboxScope);
  const searchActive = useSearchStore(state => state.searchActive);
  const pinned = useSyncExternalStore(subscribePin, readPin);
  const context = { activeMailbox, activeAccountId, viewMode, unifiedInbox, unifiedFolder, mailboxScope, isSearchResults: searchActive };
  const scope = scopeOverride !== undefined ? scopeOverride
    : pinned !== undefined ? pinned
      : currentQuickActionScope(context, { emailListView });
  const key = quickActionScopeKey(scope);
  const resolved = useMemo(() => resolveQuickActions(quickActions, surface, scope), [quickActions, surface, key]);
  return { ...resolved, scope };
}
