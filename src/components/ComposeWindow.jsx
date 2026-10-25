import React, { useCallback, useEffect, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ComposeModal } from './ComposeModal';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useThemeStore } from '../stores/themeStore';
import { isComposeMessage } from '../services/composeWindow';
import { setLocale, tErr } from '../i18n/index.js';
import { startPrivacySync } from '../utils/privacy/privacySync';
import { PrivacyDictionaryHost } from './privacy/PrivacyDictionaryHost';

const composeId = new URLSearchParams(window.location.search).get('compose');
const token = new URLSearchParams(window.location.search).get('token');
const requestTimeoutMs = 10_000;
export const sendCheckTimeoutMs = 70_000;
const waitForHydration = (store) => {
  const persist = store.persist;
  if (!persist?.hasHydrated || !persist.onFinishHydration || persist.hasHydrated()) return Promise.resolve();
  return new Promise(resolve => {
    const stop = persist.onFinishHydration?.(() => {
      stop?.();
      resolve();
    });
  });
};

// This intentionally mounts no App shell. App owns schedulers, session disk
// state, and settings persistence; this window receives one initialized draft.
export function ComposeWindow() {
  const [initialization, setInitialization] = useState(null);
  const [activated, setActivated] = useState(false);
  const [bootError, setBootError] = useState(null);
  const [bridgeError, setBridgeError] = useState(null);
  const latest = useRef(null);
  const snapshotRef = useRef(null);
  const sendInvalidationRef = useRef(null);
  const closing = useRef(false);
  const pending = useRef(new Map());
  const operationPending = useRef(false);
  const initializedMessage = useRef(false);
  const originalSettingsActions = useRef(null);

  const rejectPending = useCallback((error) => {
    pending.current.forEach(({ reject }) => reject(error));
    pending.current.clear();
  }, []);

  const invalidateSendCheck = useCallback(editorGeneration => {
    void requestRef.current?.('prepare-settings', { purpose: 'invalidate-send-check', editorGeneration }).catch(() => {});
  }, []);
  const requestRef = useRef(null);
  const request = useCallback((type, payload, { timeoutMs = requestTimeoutMs } = {}) => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const isOperation = type === 'send' || type === 'schedule' || type === 'discard';
    if (isOperation) operationPending.current = true;
    const settle = (method, value) => {
      const item = pending.current.get(requestId);
      if (!item) return;
      pending.current.delete(requestId);
      if (item.timeout) clearTimeout(item.timeout);
      if (item.isOperation) operationPending.current = false;
      method(value);
    };
    const timeout = timeoutMs == null ? null : setTimeout(() => settle(reject, new Error('Compose window request timed out')), timeoutMs);
    pending.current.set(requestId, {
      timeout, isOperation,
      resolve: value => settle(resolve, value),
      reject: error => settle(reject, error),
    });
    emit('compose-window-request', { composeId, token, requestId, type, payload })
      .catch(error => settle(reject, error));
  }), []);

  requestRef.current = request;

  const applySettings = useCallback((patch) => {
    if (patch && typeof patch === 'object') useSettingsStore.setState(patch);
  }, []);

  const relaySetting = useCallback(async (key, value) => {
    try {
      const patch = await request('settings', { key, value });
      applySettings(patch);
      return patch;
    } catch (error) {
      setBridgeError(tErr(error));
      throw error;
    }
  }, [applySettings, request]);

  const installSettingRelays = useCallback(() => {
    const current = useSettingsStore.getState();
    if (!originalSettingsActions.current) {
      originalSettingsActions.current = {
        setComposeContextVisible: current.setComposeContextVisible,
        setComposeContextSplit: current.setComposeContextSplit,
        setComposeSize: current.setComposeSize,
        addEmailTemplate: current.addEmailTemplate,
        setSpellcheckEnabled: current.setSpellcheckEnabled,
        setAiSettings: current.setAiSettings,
      };
    }
    useSettingsStore.setState({
      setComposeContextVisible: value => relaySetting('composeContextVisible', value),
      setComposeContextSplit: value => relaySetting('composeContextSplit', value),
      setComposeSize: value => relaySetting('composeSize', value),
      addEmailTemplate: (name, body) => relaySetting('addEmailTemplate', { name, body }),
      setSpellcheckEnabled: value => relaySetting('spellcheckEnabled', value),
      setAiSettings: value => relaySetting('aiSettings', value),
    });
  }, [relaySetting]);

  // Mask changes made in the main window reach this webview.
  useEffect(() => startPrivacySync(), []);

  useEffect(() => {
    let unlisten;
    let unclose;
    let disposed = false;
    const currentWindow = getCurrentWebviewWindow();
    const boot = async () => {
      const messageUnlisten = await listen('compose-window-message', async ({ payload }) => {
        try {
          if (!isComposeMessage(payload, composeId, token)) return;
        const pendingRequest = pending.current.get(payload.requestId);
        if (payload.type === 'error' && pendingRequest) {
          pendingRequest.reject(new Error(payload.payload));
          return;
        }
        if (payload.type === 'initialize' && pendingRequest) pendingRequest.resolve();
        if (['ack', 'accepted', 'scheduled', 'activate'].includes(payload.type) && pendingRequest) {
          pendingRequest.resolve(payload.payload);
        }
        if (payload.type === 'accepted' || payload.type === 'scheduled') {
          closing.current = true;
          void currentWindow.destroy();
          return;
        }
        // A settings change made in main since detach (composeWindow.js pushSettings).
        if (payload.type === 'accounts-changed') {
          useMailStore.setState(payload.payload);
          return;
        }
        if (payload.type === 'settings-changed') {
          applySettings(payload.payload);
          return;
        }
        if (payload.type !== 'initialize' || disposed || initializedMessage.current) return;
        initializedMessage.current = true;

        const context = payload.payload || {};
        if (context.accounts) useMailStore.setState({ accounts: context.accounts, activeAccountId: context.activeAccountId });
        await Promise.all([waitForHydration(useSettingsStore), waitForHydration(useThemeStore)]);
        if (disposed) return;
        if (context.settings) useSettingsStore.setState(context.settings);
        if (context.theme) useThemeStore.setState(context.theme);
        const theme = useThemeStore.getState();
        theme.setTheme(context.theme?.theme || theme.theme);
        theme.setPalette(context.theme?.palette || theme.palette);
        theme.initTheme();
        await setLocale(context.settings?.language || 'en');
        if (disposed) return;
        installSettingRelays();
        latest.current = context.snapshot;
        setInitialization(context);
        try {
          await request('initialized');
          if (!disposed) setActivated(true);
        } catch (error) {
          if (!disposed) setBootError(error?.message || String(error));
        }
        } catch (error) {
          if (!disposed) setBootError(error?.message || String(error));
        }
      });
      if (disposed) {
        messageUnlisten();
        return;
      }
      unlisten = messageUnlisten;

      const closeUnlisten = await currentWindow.onCloseRequested(async event => {
        event.preventDefault();
        if (closing.current || operationPending.current) return;
        closing.current = true;
        sendInvalidationRef.current?.();
        try {
          const snapshot = await snapshotRef.current?.() || latest.current;
          latest.current = snapshot;
          await request('closed', snapshot);
          await currentWindow.destroy();
        } catch (error) {
          closing.current = false;
          setBridgeError(tErr(error));
        }
      });
      if (disposed) {
        closeUnlisten();
        return;
      }
      unclose = closeUnlisten;
      await request('ready');
    };
    void boot().catch(error => {
      if (!disposed) setBootError(error?.message || String(error));
    });
    return () => {
      disposed = true;
      unlisten?.();
      unclose?.();
      rejectPending(new Error('Compose window closed'));
      if (originalSettingsActions.current) useSettingsStore.setState(originalSettingsActions.current);
    };
  }, [applySettings, installSettingRelays, rejectPending, request]);

  const close = useCallback(async (type, explicitSnapshot) => {
    closing.current = true;
    sendInvalidationRef.current?.();
    try {
      const snapshot = explicitSnapshot || await snapshotRef.current?.() || latest.current;
      latest.current = snapshot;
      const result = await request(type, snapshot, type === 'discard' ? { timeoutMs: null } : {});
      await getCurrentWebviewWindow().destroy();
      return result;
    } catch (error) {
      closing.current = false;
      setBridgeError(tErr(error));
      throw error;
    }
  }, [request]);

  if (bootError) return <div className="h-screen bg-mail-bg text-mail-danger p-4" role="alert">{bootError}</div>;
  if (!initialization || !activated) return <div className="h-screen bg-mail-bg" aria-busy="true" />;
  return <>
    {/* The quoted original and the thread are masked here too: this window builds its own dictionary. */}
    <PrivacyDictionaryHost />
    {bridgeError && <div className="fixed top-2 left-2 right-2 z-[100] rounded bg-mail-danger px-3 py-2 text-sm text-white" role="alert">{bridgeError}</div>}
    <ComposeModal
      detached
      mode={initialization.mode || 'new'}
      initialData={initialization.snapshot}
      onSaveState={snapshot => {
        latest.current = snapshot;
        void request('snapshot', snapshot).catch(error => setBridgeError(tErr(error)));
      }}
      snapshotRef={snapshotRef}
      sendInvalidationRef={sendInvalidationRef}
      onMinimize={snapshot => { latest.current = snapshot; void close('minimize', snapshot).catch(() => {}); }}
      // Back into the main window, open there rather than as a bubble. The
      // promise is handed back so a refused handoff unfreezes this editor.
      onAttach={snapshot => { latest.current = snapshot; return close('attach', snapshot); }}
      onClose={() => { void close('return').catch(() => {}); }}
      onDiscard={snapshot => close('discard', snapshot)}
      onContextVisibleChange={visible => relaySetting('composeContextVisible', visible)}
      onAddTemplate={value => relaySetting('addEmailTemplate', value)}
      acknowledgePreparation={() => request('prepare-settings')}
      invalidateSendCheck={invalidateSendCheck}
      prepareSendCheck={async payload => {
        try {
          const result = await request('prepare-settings', { purpose: 'send-check', ...payload }, { timeoutMs: sendCheckTimeoutMs });
          if (result?.attempt !== payload.attempt || result?.editorGeneration !== payload.editorGeneration || !result.outcome) throw new Error('compose.preparationUnavailable');
          return result.outcome;
        } catch (error) {
          // A timeout retires authority; a late native result remains inert.
          invalidateSendCheck(payload.editorGeneration + 1);
          throw error;
        }
      }}
      finalizeSendCheck={async (payload, scheduled) => {
        const result = await request(scheduled ? 'schedule' : 'send', payload, { timeoutMs: null });
        if (result == null) return;
        if (result.attempt !== payload.attempt || result.editorGeneration !== payload.editorGeneration || !result.outcome) throw new Error('compose.preparationUnavailable');
        return result.outcome;
      }}
      // Settings lives in the main window, which also answers the native menu's Settings item.
      onUpgrade={() => { void emit('open-settings', { tab: 'billing' }).catch(() => {}); }}
      onOpenAliases={accountId => { void emit('open-settings', { tab: 'accounts', accountId, section: 'aliases' }).catch(() => {}); }}
    />
  </>;
}
