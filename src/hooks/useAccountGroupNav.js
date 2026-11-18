import { useEffect } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useViewStore } from '../stores/viewStore';
import { groupUnread } from '../services/accountGroups';

export function useAccountGroupNav(sections, accounts, mailHidden, onOpenMail) {
  const collapsed = useSettingsStore(state => state.collapsedAccountGroups);
  const toggleGroup = useSettingsStore(state => state.toggleAccountGroupCollapsed);
  const unreadPerAccount = useSettingsStore(state => state.unreadPerAccount);
  const hiddenAccounts = useSettingsStore(state => state.hiddenAccounts);
  const accountGroups = useSettingsStore(state => state.accountGroups);
  const unifiedInbox = useAccountStore(state => state.unifiedInbox);
  const unifiedGroup = useAccountStore(state => state.unifiedGroup);
  const setUnifiedInbox = useAccountStore(state => state.setUnifiedInbox);
  const activeViewId = useViewStore(state => state.activeViewId);

  useEffect(() => {
    if (unifiedInbox && unifiedGroup && !sections.some(section => section.name === unifiedGroup)) {
      setUnifiedInbox(true);
    }
  }, [sections, unifiedInbox, unifiedGroup, setUnifiedInbox]);

  return {
    collapsed,
    selectedGroup: unifiedInbox && !mailHidden && !activeViewId ? unifiedGroup : null,
    unreadOf: name => groupUnread(accounts, name, { hiddenAccounts, accountGroups, unreadPerAccount }),
    openGroup: name => {
      if (useViewStore.getState().activeViewId) useViewStore.getState().closeView();
      onOpenMail?.();
      setUnifiedInbox(true, name);
    },
    toggleGroup,
  };
}
