import { useMemo } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSearchStore } from '../stores/searchStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useViewStore, effectiveViewConfig } from '../stores/viewStore';
import { currentQuickActionScope, quickActionScopeKey, resolveQuickActions } from '../utils/quickActions';

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
  const scope = scopeOverride === undefined ? currentQuickActionScope(context, { emailListView }) : scopeOverride;
  const key = quickActionScopeKey(scope);
  const resolved = useMemo(() => resolveQuickActions(quickActions, surface, scope), [quickActions, surface, key]);
  return { ...resolved, scope };
}
