// ── composeSlice — undo-send queue ──

import { useSettingsStore } from '../settingsStore';

export const createComposeSlice = (set, get) => ({
  // Undo send
  pendingSend: null,  // { composeState, timeoutId, timestamp, delay }

  // Undo send — queue a send with a delay, or send immediately if disabled
  queueSend: (composeState, sendFn) => {
    const { undoSendEnabled, undoSendDelay } = useSettingsStore.getState();
    if (!undoSendEnabled || undoSendDelay === 0) {
      sendFn();
      return;
    }
    const timeoutId = setTimeout(() => {
      sendFn();
      set({ pendingSend: null });
    }, undoSendDelay * 1000);
    set({ pendingSend: { composeState, timeoutId, timestamp: Date.now(), delay: undoSendDelay } });
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
