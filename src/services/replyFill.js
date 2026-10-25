// App's per-window producer for resolved reply bodies. Draft ownership stays
// with the existing compose session; only the latest fill intent is retained.
import { messagePreparation, prepareCompose, preparationIdentity } from './composePrep';
import { resolveInitialComposeIdentity } from '../utils/sendAsSuggestions';
import { sameReply, applyReplyFill } from '../utils/sameReply';
import { isTerminalCompose, composeSessionData } from './composeSession';

export function createReplyFillController({ getWindows, setWindows, getContext, onError }) {
  const slots = new Map();
  const identityFor = window => {
    const { settings, mail } = getContext();
    const accounts = settings.getOrderedAccounts(mail.accounts);
    const data = composeSessionData(window);
    const initial = resolveInitialComposeIdentity({ replyTo: window.replyTo, initialData: data, accounts,
      activeAccountId: mail.activeAccountId, selectedAccountId: mail.lastSelectedAccountId });
    const accountId = accounts.find(account => account.id === initial.accountId)?.id || accounts[0]?.id || null;
    const fromAddress = (data?._accountId === accountId ? data._fromAddress : '') || initial.address
      || settings.sendAsAddresses?.[accountId] || accounts.find(account => account.id === accountId)?.email || '';
    return { accountId, fromAddress, generation: preparationIdentity({ accountId, fromAddress, accounts,
      aliases: settings.aliases || {}, sendAsAddresses: settings.sendAsAddresses }) };
  };
  const targetFor = (windows, slot, intent) => windows.find(window => window.id === slot.id && !window.detached
    && !isTerminalCompose(composeSessionData(window)) && sameReply(window, { mode: intent.state.mode, replyTo: intent.state._fillFrom }));

  const commit = (slot, intent, identity, result) => new Promise(resolve => {
    setWindows(windows => {
      if (slot.intent !== intent) { resolve('superseded'); return windows; }
      const target = targetFor(windows, slot, intent);
      if (!target) { resolve('gone'); return windows; }
      if (identityFor(target).generation !== identity.generation) { resolve('identity'); return windows; }
      const prepared = { source: intent.state.replyTo, identityGeneration: identity.generation, result };
      const next = applyReplyFill(windows, { ...intent.state, _fillWindowId: slot.id }, prepared);
      resolve('applied');
      return next;
    });
  });

  const run = async slot => {
    try {
      while (slot.intent) {
        const intent = slot.intent;
        const target = targetFor(getWindows(), slot, intent);
        if (!target) { slot.intent = null; continue; }
        const identity = identityFor(target);
        const current = () => {
          const window = targetFor(getWindows(), slot, intent);
          return Boolean(slot.intent === intent && window && identityFor(window).generation === identity.generation);
        };
        let result;
        try {
          result = await prepareCompose({ ...intent.request,
            ...(identity.accountId && { accountId: identity.accountId }),
            ...(identity.fromAddress && { pickedFrom: identity.fromAddress }),
          }, { isCurrent: current });
        } catch (error) {
          if (slot.intent !== intent) continue;
          const window = targetFor(getWindows(), slot, intent);
          if (!window) { slot.intent = null; continue; }
          // Retain complete bytes only for an observed identity invalidation.
          // An ordinary timeout/error is reported once, never retried here.
          if (identityFor(window).generation !== identity.generation) continue;
          slot.intent = null;
          onError?.(error);
          continue;
        }
        const outcome = await commit(slot, intent, identity, result);
        if (outcome === 'identity' || outcome === 'superseded') continue;
        if (slot.intent === intent) slot.intent = null;
      }
    } catch (error) {
      slot.intent = null;
      onError?.(error);
    } finally {
      slot.running = null;
      if (slots.get(slot.id) === slot) slots.delete(slot.id);
    }
  };

  return { fill(state) {
    const target = getWindows().find(window => !window.detached && !isTerminalCompose(composeSessionData(window))
      && sameReply(window, { mode: state.mode, replyTo: state._fillFrom }));
    if (!target) return Promise.resolve();
    let request;
    try { request = messagePreparation({ replyTo: state.replyTo, mode: state.mode }); }
    catch (error) { onError?.(error); return Promise.resolve(); }
    const slot = slots.get(target.id) || { id: target.id, running: null, intent: null };
    slots.set(target.id, slot);
    slot.intent = { state, request };
    if (!slot.running) slot.running = run(slot);
    return slot.running;
  } };
}
