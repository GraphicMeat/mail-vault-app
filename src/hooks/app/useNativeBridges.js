import { useEffect, useRef } from 'react';
import { startMailtoBridge } from '../../utils/mailto';
import { announceActivation, startActivationBridge } from '../../services/billingActivation';
import { startPrivacySync } from '../../utils/privacy/privacySync';
import { useMailStore } from '../../stores/mailStore';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

export function useNativeBridges({ setMailtoError, openSettings, setShowShortcutsModal, setComposeState, showSettings, settingsMinimized, minimizeSettings, openMailFromSidebar, handleReportBug }) {
  // `mailto:` handed over by the OS — a link clicked in a browser, a PDF, a chat
  // app. The bridge drains a queue in Rust rather than reading an event payload:
  // when the click *launches* MailVault the URL is queued before this webview
  // exists, so a listener alone would drop the first mailto of every cold start.
  useEffect(() => {
    let stop = null;
    let active = true;
    Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ]).then(([{ invoke }, { listen }]) => {
      const bridge = startMailtoBridge({ invoke, listen, onError: () => { if (active) setMailtoError(true); } });
      void bridge.ready.catch(() => { if (active) setMailtoError(true); });
      // Unmounted while the imports were in flight — same guard the listeners
      // below use, or the bridge outlives the component that owns it.
      if (!active) bridge.stop();
      else stop = bridge.stop;
    }).catch(() => {}); // not in Tauri
    return () => { active = false; if (stop) stop(); };
  }, []);

  // mailvault://activate links from the website's web checkout: spend the token, sign in.
  useEffect(() => {
    let stop = null;
    let active = true;
    Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ]).then(([{ invoke }, { listen }]) => {
      const bridge = startActivationBridge({ invoke, listen, onResult: announceActivation });
      if (!active) bridge.stop();
      else stop = bridge.stop;
    }).catch(() => {}); // not in Tauri
    return () => { active = false; if (stop) stop(); };
  }, []);

  // Broadcast privacy-mode changes to the detached windows.
  useEffect(() => startPrivacySync(), []);

  // Listen for server crash events from the Rust backend
  useEffect(() => {
    let unlisten;
    let active = true;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('server-crashed', (event) => {
        console.error('[App] Server crashed:', event.payload);
        useMailStore.setState({
          connectionStatus: 'error',
          connectionError: event.payload,
          connectionErrorType: 'serverError',
          connectionErrorCode: null,
        });
      }).then(fn => {
        if (!active) fn(); // unmounted before listener ready — detach immediately
        else unlisten = fn;
      });
    }).catch(() => {}); // not in Tauri environment
    return () => { active = false; if (unlisten) unlisten(); };
  }, []);

  // Listen for open-settings event from native menu, or from a compose window
  // of its own asking for a tab (its Upgrade). That one comes forward first:
  // Settings opened behind the compose window reads as a dead button.
  useEffect(() => {
    let unlisten;
    let active = true;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('open-settings', ({ payload }) => {
        if (typeof payload?.tab !== 'string') { openSettings(); return; }
        void WebviewWindow.getByLabel('main').then(window => window?.setFocus()).catch(() => {});
        // A compose window's "Add address..." names the account and its Aliases section.
        const accountId = typeof payload.accountId === 'string' ? payload.accountId : undefined;
        const section = typeof payload.section === 'string' ? payload.section : undefined;
        openSettings({ tab: payload.tab, accountId, section });
      }).then(fn => {
        if (!active) fn();
        else unlisten = fn;
      });
    }).catch(() => {});
    return () => { active = false; if (unlisten) unlisten(); };
  }, [openSettings]);

  // Listen for open-shortcuts event from native menu
  useEffect(() => {
    let unlisten;
    let active = true;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('open-shortcuts', () => {
        setShowShortcutsModal(prev => !prev);
      }).then(fn => {
        if (!active) fn();
        else unlisten = fn;
      });
    }).catch(() => {});
    return () => { active = false; if (unlisten) unlisten(); };
  }, []);

  // The tray menu's Compose and account rows. Rust has already brought the
  // window forward; these do what the sidebar's Compose button and account
  // row do. Settings open over the mail goes to its minimized chip, unsaved
  // edits and all, rather than hiding the inbox the click asked for.
  const trayActions = useRef(null);
  trayActions.current = {
    compose: () => setComposeState({}),
    showMail: () => {
      if (showSettings && !settingsMinimized) minimizeSettings();
      openMailFromSidebar();
    },
  };
  useEffect(() => {
    let unlisteners = [];
    let active = true;
    import('@tauri-apps/api/event').then(({ listen }) => Promise.all([
      listen('tray-compose', () => trayActions.current.compose()),
      listen('tray-open-account', ({ payload: accountId }) => {
        if (typeof accountId !== 'string') return;
        trayActions.current.showMail();
        void import('../../stores/viewStore').then(({ useViewStore }) => {
          if (useViewStore.getState().activeViewId) useViewStore.getState().closeView();
          return useMailStore.getState().activateAccount(accountId, 'INBOX');
        }).catch(e => console.warn('[tray] could not open the account inbox:', e));
      }),
    ])).then(fns => {
      if (!active) fns.forEach(fn => fn());
      else unlisteners = fns;
    }).catch(() => {}); // not in Tauri
    return () => { active = false; unlisteners.forEach(fn => fn()); };
  }, []);

  // Listen for report-bug event from native menu
  useEffect(() => {
    let unlisten;
    let active = true;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('report-bug', () => {
        handleReportBug();
      }).then(fn => {
        if (!active) fn();
        else unlisten = fn;
      });
    }).catch(() => {});
    return () => { active = false; if (unlisten) unlisten(); };
  }, [handleReportBug]);
}
