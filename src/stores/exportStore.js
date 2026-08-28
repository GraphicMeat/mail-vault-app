import { create } from 'zustand';
import { useMailStore } from './mailStore';
import { useSettingsStore, hasPremiumAccess } from './settingsStore';

// One dialog, four entry points. Each surface hands over the messages it means
// and nothing else; the dialog and the upsell mount once in App.
//
// Provenance is resolved HERE rather than at each call site, because a unified
// row belongs to the account it came from, not to whichever account is active.
// Four surfaces each deriving that themselves is four chances to stamp the
// wrong address into an exported file's footer.
function describeTarget({ messages, account, mailbox }) {
  const { accounts = [], activeAccountId, activeMailbox } = useMailStore.getState();
  const first = messages?.[0] || {};
  const accountId = first._accountId || activeAccountId;
  const found = accounts.find(a => a.id === accountId);
  return {
    messages,
    account: account || found?.email || accountId || 'Unknown account',
    mailbox: mailbox || first._mailbox || activeMailbox || 'INBOX',
  };
}

export const useExportStore = create((set) => ({
  target: null,
  showSamples: false,
  // Without a subscription there is nothing to configure — the format and
  // mirror choices are all premium — so the gate dialog was one dead click in
  // front of the samples. Free users go straight to the samples, which carry
  // the Upgrade button themselves. Routed here rather than at the four entry
  // points so no surface can forget it.
  openExport: (target) => set(hasPremiumAccess(useSettingsStore.getState().billingProfile)
    ? { target: describeTarget(target) }
    : { showSamples: true }),
  closeExport: () => set({ target: null }),
  openSamples: () => set({ showSamples: true }),
  closeSamples: () => set({ showSamples: false }),
}));
