// App-owned asynchronous producer for resolved reply bodies. This is the
// existing per-window fill queue; it does not own drafts or another URL queue.
import { prepareMessage, preparationIdentity } from './composePrep';
import { resolveInitialComposeIdentity } from '../utils/sendAsSuggestions';
import { sameReply, applyReplyFill } from '../utils/sameReply';
import { isTerminalCompose, composeSessionData } from './composeSession';

export function createReplyFillController({ getWindows, setWindows, getContext, onError }) {
  const slots = new Map();
  return { fill(state) {
      const target = getWindows().find(w => !w.detached && !isTerminalCompose(composeSessionData(w))
        && sameReply(w, { mode: state.mode, replyTo: state._fillFrom }));
      if (!target) return;
      const identityFor = window => {
        const prefs = getContext().settings;
        const mail = getContext().mail;
        const accounts = prefs.getOrderedAccounts(mail.accounts);
        const data = window.snapshot || window.initialData;
        const initial = resolveInitialComposeIdentity({ replyTo: window.replyTo, initialData: data,
          accounts, activeAccountId: mail.activeAccountId, selectedAccountId: mail.lastSelectedAccountId });
        const accountId = data?._accountId || initial.accountId;
        const fromAddress = data?._fromAddress || initial.address || prefs.sendAsAddresses?.[accountId] || accounts.find(a => a.id === accountId)?.email || '';
        return { accountId, fromAddress, generation: preparationIdentity({ accountId, fromAddress, accounts,
          aliases: prefs.aliases || {}, sendAsAddresses: prefs.sendAsAddresses }) };
      };
      const identity = identityFor(target);
      const slot = slots.get(target.id) || { running: false, desired: null, generation: 0 };
      slots.set(target.id, slot);
      const generation = ++slot.generation;
      const current = windows => {
        const window = windows.find(w => w.id === target.id && !w.detached && !isTerminalCompose(composeSessionData(w))
          && sameReply(w, { mode: state.mode, replyTo: state._fillFrom }));
        return Boolean(window && slot.generation === generation && identityFor(window).generation === identity.generation);
      };
      slot.desired = async () => {
        try {
          const result = await prepareMessage({ replyTo: state.replyTo, mode: state.mode, accountId: identity.accountId,
            pickedFrom: identity.fromAddress }, { isCurrent: () => current(getWindows()) });
          if (!current(getWindows())) return;
          const prepared = { source: state.replyTo, identityGeneration: identity.generation, result };
          setWindows(prev => current(prev) ? applyReplyFill(prev, { ...state, _fillWindowId: target.id }, prepared) : prev);
        } catch {
          if (current(getWindows())) onError?.();
        }
      };
      if (!slot.running) {
        slot.running = true;
        slot.completion = (async () => {
          try { while (slot.desired) { const next = slot.desired; slot.desired = null; await next(); } }
          finally { slot.running = false; if (slots.get(target.id) === slot) slots.delete(target.id); }
        })();
      }
      return slot.completion;
  } };
}
