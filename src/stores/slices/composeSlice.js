// ── composeSlice — undo-send queue ──

import { useSettingsStore } from '../settingsStore';

export const createComposeSlice = (set, get) => ({
  // Undo send
  pendingSend: null,  // { composeState, timeoutId, timestamp, delay }

  // Queue a send with a delay (undo window), or send immediately if delay is 0.
  // overrideDelay: per-compose override in seconds (from compose UI), null = use global setting.
  queueSend: (composeState, sendFn, overrideDelay = null) => {
    const { sendDelay, undoSendEnabled, undoSendDelay } = useSettingsStore.getState();
    // Use override > new sendDelay > legacy undoSendDelay
    const delay = overrideDelay ?? sendDelay ?? (undoSendEnabled ? undoSendDelay : 0);
    if (delay === 0) {
      sendFn();
      return;
    }
    const timeoutId = setTimeout(() => {
      sendFn();
      set({ pendingSend: null });
    }, delay * 1000);
    set({ pendingSend: { composeState, timeoutId, timestamp: Date.now(), delay } });
  },

  cancelPendingSend: () => {
    const { pendingSend } = get();
    if (pendingSend) {
      clearTimeout(pendingSend.timeoutId);
      const saved = pendingSend.composeState;
      set({ pendingSend: null });
      return saved;
    }
    return null;
  },
});
