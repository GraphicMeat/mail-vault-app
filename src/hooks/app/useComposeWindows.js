import { useCallback, useEffect, useRef, useState } from 'react';
import { useReplyFillController } from '../useReplyFillController';
import { useMailStore } from '../../stores/mailStore';
import { hasPremiumAccess, useSettingsStore } from '../../stores/settingsStore';
import { t as tr } from '../../i18n/index.js';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { composeSessionData, isTerminalCompose, mergeComposeSnapshot, useComposeSessionHydration } from '../../services/composeSession';
import { sameReply } from '../../utils/sameReply';
import { createComposeWindowOwner } from '../../services/composeWindow';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { createComposeSend, scheduleCompose } from '../../services/composeSend';
import { flushSafeStorage } from '../../stores/safeStorage';
import { checkCompose, composeCheckInput } from '../../services/composePrep';
import { composeSenderName } from '../../utils/sendAsSuggestions';
import { isGraphAccount } from '../../services/graphConfig';
import { setComposeOpener } from '../../services/localDrafts';
import { setMailtoComposeOpener } from '../../utils/mailto';
import { openComposeResolved } from '../../utils/replyTarget';
import { registerComposeOpener } from '../../utils/composeOpener';

export function useComposeWindows() {
  const [composeWindows, setComposeWindows] = useState([]);
  const replyFillController = useReplyFillController({
    windows: composeWindows, setWindows: setComposeWindows,
    getContext: () => ({ mail: useMailStore.getState(), settings: useSettingsStore.getState() }),
    onError: () => useMailStore.setState({ error: tr('compose.preparationUnavailable') }),
  });
  const [mailtoError, setMailtoError] = useState(false);
  const composeIdRef = useRef(0);
  const composeWindowOwnerRef = useRef(null);
  const focusNativeCompose = useCallback(async (label) => {
    const native = await WebviewWindow.getByLabel(label);
    if (!native) return;
    await native.unminimize();
    await native.setFocus();
  }, []);

  const { openDraft: openDraftCompose, saveState: saveComposeState, canMount: canMountCompose, terminalCleanup: cleanupComposeDraft, retryCleanup: retryComposeCleanup, removeSource: removeComposeSource, restoreCompose: restoreOwnedCompose } = useComposeSessionHydration({
    windows: composeWindows, setWindows: setComposeWindows, idRef: composeIdRef, focus: focusNativeCompose,
  });

  // A reply already open on this message comes forward instead of stacking —
  // see utils/sameReply.js for why the header made that necessary.
  const openCompose = useCallback((state = {}) => {
    // Fill-only: a radial reply/replyAll opens on the header right away
    // (RowQuickActions.jsx) and calls back in here once resolveMessageBody
    // lands, carrying the ORIGINAL header as `_fillFrom` instead of the
    // resolved copy — matched with `sameReply` below, so a messageId that
    // only shows up once the fetch lands can never change the match key and
    // stack a duplicate. This path never opens, un-minimizes or focuses a
    // window: the fetch finishing late must not reopen a reply the user
    // already sent, discarded or closed, or pull one they minimized back out.
    if (state._fillFrom) {
      void replyFillController.fill(state);
      return;
    }
    const restoredData = state.snapshot || state.initialData;
    if (restoredData?._draftId || restoredData?._draftUid) {
      restoreOwnedCompose(state);
      return;
    }
    setComposeWindows(prev => {
      const already = prev.find(w => !isTerminalCompose(composeSessionData(w)) && sameReply(w, state));
      if (already) {
        if (already.detached && already.nativeLabel) void focusNativeCompose(already.nativeLabel).catch(() => {});
        return prev.map(w => w.id === already.id ? { ...w, minimized: false } : w);
      }
      composeIdRef.current += 1;
      return [...prev, { id: composeIdRef.current, minimized: false, ...state }];
    });
  }, [focusNativeCompose, restoreOwnedCompose]);

  const closeCompose = removeComposeSource;

  const minimizeCompose = useCallback((id) => {
    setComposeWindows(prev => prev.map(w => w.id === id
      ? { ...w, initialData: w.snapshot || w.initialData, minimized: true }
      : w));
  }, []);

  const patchComposeWindow = useCallback((id, patch) => {
    setComposeWindows(prev => prev.map(window => window.id === id ? {
      ...window, ...patch,
      ...(patch.snapshot ? { snapshot: mergeComposeSnapshot(composeSessionData(window), patch.snapshot) } : {}),
      ...(isTerminalCompose(composeSessionData(window)) ? { minimized: true, detached: false, nativeLabel: null } : {}),
    } : window));
  }, []);

  if (!composeWindowOwnerRef.current) {
    composeWindowOwnerRef.current = createComposeWindowOwner({
      open: async ({ composeId, token }) => {
        // The size the user last resized a detached compose window to
        // (setComposeSize, relayed from any window through installSettingRelays
        // below). Rust clamps it to its own floor and the primary monitor.
        const size = useSettingsStore.getState().composeSize;
        const label = await invoke('open_compose_window', { composeId, token, width: size?.width, height: size?.height });
        const native = await WebviewWindow.getByLabel(label);
        if (!native) throw new Error(tr('errors.composeWindowClosed'));
        await native.once('tauri://destroyed', () => composeWindowOwnerRef.current?.recoverLabel(label, token));
        return label;
      },
      emitTo,
      update: (id, patch) => patchComposeWindow(id, patch),
      remove: id => removeComposeSource(id),
      discard: (snapshot, id) => cleanupComposeDraft(snapshot, 'discard', id),
      // A compose moved back from its own window. Popping out is remembered
      // (ComposeModal popOut), so popping back in is too: left on 'window',
      // the compose about to open here would hand itself straight back.
      attached: () => {
        useSettingsStore.getState().setComposeOpenMode('app');
        // A minimized main would take the draft out of sight: it comes forward
        // the way a focused native compose does (focusNativeCompose).
        void WebviewWindow.getByLabel('main')
          .then(async window => { await window?.unminimize(); await window?.setFocus(); })
          .catch(() => {});
      },
      close: label => WebviewWindow.getByLabel(label).then(window => window?.destroy()).catch(() => {}),
      queueSend: async (snapshot, delay, session, scheduled, context) => {
        const account = context.account;
        if (!account) throw new Error(tr('compose.noAccountSelected'));
        const replyTo = snapshot._replyTo || null;
        const settings = context.settings;
        if (scheduled) {
          await scheduleCompose({ snapshot, account, settings, cleanupDraft: (data, kind) => cleanupComposeDraft(data, kind, session.id) });
          return;
        }
        const composeState = { mode: session.mode, replyTo, initialData: snapshot };
        useMailStore.getState().queueSend(
          composeState,
          createComposeSend({ snapshot, mode: session.mode, replyTo, account, settings, cleanupDraft: (data, kind) => cleanupComposeDraft(data, kind, session.id) }),
          snapshot._composeDelay ?? delay,
        );
      },
      acknowledgePreparation: options => flushSafeStorage({ acknowledge: true, ...options }),
      checkPreparation: ({ settingsVersion, isCurrent, ...input }) => checkCompose(composeCheckInput(input), { settingsVersion, isCurrent }),
      sendContext: snapshot => {
        const account = useMailStore.getState().accounts?.find(item => item.id === snapshot?._accountId);
        const prefs = useSettingsStore.getState();
        return { account, senderSettings: { displayName: composeSenderName({ account, fromAddress: snapshot._fromAddress,
          displayName: prefs.getDisplayName(account?.id), aliases: prefs.aliases?.[account?.id], sendAsAddress: prefs.sendAsAddresses?.[account?.id] }) },
          remindAllowed: !!account && !isGraphAccount(account) && hasPremiumAccess(prefs.billingProfile) };
      },
      settings: {
        composeContextVisible: value => {
          const store = useSettingsStore.getState();
          store.setComposeContextVisible(value);
          return { composeContextVisible: useSettingsStore.getState().composeContextVisible };
        },
        composeContextSplit: value => {
          useSettingsStore.getState().setComposeContextSplit(value);
          return { composeContextSplit: useSettingsStore.getState().composeContextSplit };
        },
        composeSize: value => {
          useSettingsStore.getState().setComposeSize(value);
          return { composeSize: useSettingsStore.getState().composeSize };
        },
        addEmailTemplate: value => {
          const store = useSettingsStore.getState();
          store.addEmailTemplate(value.name, value.body);
          return { emailTemplates: useSettingsStore.getState().emailTemplates };
        },
        spellcheckEnabled: value => {
          const store = useSettingsStore.getState();
          store.setSpellcheckEnabled(value);
          return { spellcheckEnabled: useSettingsStore.getState().spellcheckEnabled };
        },
        aiSettings: value => {
          const store = useSettingsStore.getState();
          store.setAiSettings(value);
          return { aiSettings: useSettingsStore.getState().aiSettings };
        },
      },
    });
  }
  useEffect(() => {
    let unlisten;
    let disposed = false;
    listen('compose-window-request', ({ payload }) => composeWindowOwnerRef.current?.receive(payload)).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  // A compose window of its own was handed the billing profile, font and text
  // size at detach; a change made here afterwards has to reach it too.
  useEffect(() => useSettingsStore.subscribe((state, prev) => {
    // Aliases too: a compose window's "Add address..." sends the user to
    // Settings here, and the address they add belongs in that window's From row.
    const relevant = ['aliases', 'sendAsAddresses', 'displayNames', 'attachmentReminder', 'billingProfile', 'shareGrant', 'sendDelay', 'undoSendEnabled', 'undoSendDelay'];
    if (relevant.some(key => state[key] !== prev[key])) composeWindowOwnerRef.current?.invalidateSendPreparation();
    const keys = [...relevant, 'appFont', 'textScale', 'showMenuBar'];
    if (keys.some(key => state[key] !== prev[key])) composeWindowOwnerRef.current?.pushSettings(Object.fromEntries(keys.map(key => [key, state[key]])));
  }), []);

  useEffect(() => useMailStore.subscribe((state, previous) => {
    if (state.accounts !== previous.accounts) composeWindowOwnerRef.current?.invalidateSendPreparation();
    if (state.accounts !== previous.accounts || state.activeAccountId !== previous.activeAccountId)
      composeWindowOwnerRef.current?.pushAccounts(state.accounts, state.activeAccountId);
  }), []);

  const restoreCompose = useCallback((id) => {
    setComposeWindows(prev => prev.map(w => {
      if (w.id !== id || isTerminalCompose(composeSessionData(w))) return w;
      if (w.detached && w.nativeLabel) void focusNativeCompose(w.nativeLabel).catch(() => {});
      return { ...w, initialData: w.snapshot || w.initialData, minimized: false };
    }));
  }, [focusNativeCompose]);

  // Clicking a draft row in the Drafts folder reopens it here rather than in
  // the viewer (services/localDrafts.js does the reading; a service cannot
  // reach this state, so it is handed the opener).
  //
  // A draft already open comes forward instead of opening a second window on
  // it: two windows autosaving one vault uid interleave their writes, and the
  // loser's text is gone.
  useEffect(() => {
    setComposeOpener(openDraftCompose);
    return () => setComposeOpener(null);
  }, [openDraftCompose]);

  // A mailto: link in a message body opens compose here rather than handing
  // the address to the OS mail client (see utils/mailto.js).
  useEffect(() => {
    setMailtoComposeOpener(initialData => openCompose({ initialData }), { onError: () => setMailtoError(true) });
    return () => setMailtoComposeOpener(null);
  }, [openCompose]);

  // Backwards-compatible helpers
  const composeState = composeWindows.find(w => !w.minimized && !w.detached) || null;
  const setComposeState = useCallback((val) => {
    if (val === null) {
      // Close the active (non-minimized) window
      setComposeWindows(prev => prev.filter(w => w.minimized || w.detached));
    } else {
      // A reader's snippet stand-in is not the message: every entry point
      // (shortcuts, other views, the row seam) gets the real body first.
      void openComposeResolved(val, openCompose, useMailStore.getState());
    }
  }, [openCompose]);

  // The list's row menus reach compose through the same kind of seam.
  useEffect(() => {
    registerComposeOpener(setComposeState);
    return () => registerComposeOpener(null);
  }, [setComposeState]);

  return { composeWindows, mailtoError, setMailtoError, composeState, setComposeState, openCompose, closeCompose, minimizeCompose, restoreCompose, canMountCompose, saveComposeState, cleanupComposeDraft, retryComposeCleanup, composeWindowOwnerRef };
}
