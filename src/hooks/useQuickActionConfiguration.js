import { useMemo } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSearchStore } from '../stores/searchStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useViewStore, effectiveViewConfig, currentListView } from '../stores/viewStore';
import { currentQuickActionScope, quickActionScopeKey, resolveQuickActions } from '../utils/quickActions';

// The detached Settings window has none of the main window's mail, search or
// view state, so on its own it resolved every surface for INBOX. It is handed
// the main window's scope instead and pins it here.
// ponytail: pinned once at open; forward scope changes from the main window if
// someone keeps a detached Settings open while moving between views.
let pinnedScope;
export function pinQuickActionScope(scope) { pinnedScope = scope; }

/// The scope the main window's surfaces resolve right now, read outside React.
export function currentQuickActionScopeSnapshot() {
  const { activeMailbox, activeAccountId, viewMode, unifiedInbox, unifiedFolder, mailboxScope } = useMailStore.getState();
  return currentQuickActionScope({
    activeMailbox, activeAccountId, viewMode, unifiedInbox, unifiedFolder, mailboxScope,
    isSearchResults: useSearchStore.getState().searchActive,
  }, { emailListView: currentListView() });
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
  const context = { activeMailbox, activeAccountId, viewMode, unifiedInbox, unifiedFolder, mailboxScope, isSearchResults: searchActive };
  const scope = scopeOverride !== undefined ? scopeOverride
    : pinnedScope !== undefined ? pinnedScope
      : currentQuickActionScope(context, { emailListView });
  const key = quickActionScopeKey(scope);
  const resolved = useMemo(() => resolveQuickActions(quickActions, surface, scope), [quickActions, surface, key]);
  return { ...resolved, scope };
}
