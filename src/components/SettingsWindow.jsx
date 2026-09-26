import React, { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { SettingsPage } from './SettingsPage';
import { useUnsavedStore } from '../stores/unsavedStore';
import { UnsubscribeHost } from './UnsubscribeHost';
import { useSettingsStore } from '../stores/settingsStore';
import { useThemeStore } from '../stores/themeStore';
import { useMailStore } from '../stores/mailStore';
import { setLocale } from '../i18n/index.js';
import { saveRestoreDescriptor } from '../services/cacheManager';
import { useTagStore } from '../stores/tagStore';
import { useAutoTagStore } from '../stores/autoTagStore';
import { useFieldStore } from '../stores/fieldStore';
import { pinQuickActionScope } from '../hooks/useQuickActionConfiguration';

const token = new URLSearchParams(window.location.search).get('settings');

/// The window's own close button bypasses React: unsaved edits stop it here
/// and ask, and the answer closes it for real.
function holdUnsavedClose(event) {
  const unsaved = useUnsavedStore.getState();
  const closed = () => emit('settings-window-closed', { token });
  if (!unsaved.guard?.changes.length) { void closed(); return; }
  event.preventDefault();
  unsaved.leave(() => { void closed().finally(() => getCurrentWebviewWindow().destroy()); });
}
// Each window owns its own render epoch. Relaying it would bounce setLocale
// between windows after the asynchronous catalog import completes.
const plainState = state => Object.fromEntries(Object.entries(state).filter(([key, value]) => key !== 'localeEpoch' && typeof value !== 'function'));
const hydrated = store => store.persist?.hasHydrated?.() ? Promise.resolve() : new Promise(resolve => {
  const stop = store.persist?.onFinishHydration?.(() => { stop?.(); resolve(); });
  if (!stop) resolve();
});

export function SettingsWindow() {
  const [initial, setInitial] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    let unlisten;
    let unlistenOwner;
    let unclose;
    let unsubscribeSettings;
    let unsubscribeTheme;
    let unsubscribeMail;
    let suppressRelay = false;
    let ready = false;
    const boot = async () => {
      unlistenOwner = await listen('settings-window-owner-change', event => {
        if (disposed || !ready || event.payload?.token !== token) return;
        suppressRelay = true;
        try {
          if (event.payload.settings) {
            useSettingsStore.setState(event.payload.settings);
            if (event.payload.settings.language) void setLocale(event.payload.settings.language);
          }
          if (event.payload.theme) {
            useThemeStore.setState(event.payload.theme);
            useThemeStore.getState().initTheme();
          }
          if (event.payload.accounts) useMailStore.setState({ accounts: event.payload.accounts,
            activeAccountId: event.payload.activeAccountId });
        } finally { suppressRelay = false; }
      });
      unlisten = await listen('settings-window-payload', async event => {
        if (disposed || event.payload?.token !== token) return;
        const payload = event.payload;
        await Promise.all([hydrated(useSettingsStore), hydrated(useThemeStore)]);
        if (disposed) return;
        useMailStore.setState({ accounts: payload.accounts, activeAccountId: payload.activeAccountId, mailboxes: payload.mailboxes || [] });
        Object.entries(payload.accountMailboxes || {}).forEach(([accountId, mailboxes]) => {
          if (mailboxes?.length) saveRestoreDescriptor({ accountId, mailbox: 'INBOX', viewMode: 'live', mailboxes });
        });
        useSettingsStore.setState(payload.settings);
        // Quick actions edit the view the main window shows, not this window's INBOX.
        if (payload.quickActionScope) pinQuickActionScope(payload.quickActionScope);
        useThemeStore.setState(payload.theme);
        useThemeStore.getState().initTheme();
        await setLocale(payload.settings.language || 'en');
        await Promise.allSettled([
          useTagStore.getState().loadTags(),
          useAutoTagStore.getState().loadRules(),
          ...(payload.accounts || []).map(account => useFieldStore.getState().loadFields(account.id)),
        ]);
        if (disposed) return;
        setInitial(payload.request || {});
        ready = true;
        unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
          if (suppressRelay) return;
          const changed = Object.fromEntries(Object.entries(plainState(state)).filter(([key, value]) => value !== previous[key]));
          if (Object.keys(changed).length) void emit('settings-window-change', { token, settings: changed });
        });
        unsubscribeTheme = useThemeStore.subscribe((state, previous) => {
          if (suppressRelay) return;
          if (state.theme !== previous.theme || state.palette !== previous.palette) {
            void emit('settings-window-change', { token, theme: { theme: state.theme, palette: state.palette } });
          }
        });
        unsubscribeMail = useMailStore.subscribe((state, previous) => {
          if (suppressRelay) return;
          if (state.accounts !== previous.accounts) void emit('settings-window-change', { token, accounts: state.accounts });
        });
      });
      unclose = await getCurrentWebviewWindow().onCloseRequested(holdUnsavedClose);
      if (!disposed) await emit('settings-window-ready', { token, label: getCurrentWebviewWindow().label });
    };
    void boot().catch(cause => setError(cause?.message || String(cause)));
    return () => { disposed = true; unlisten?.(); unlistenOwner?.(); unclose?.(); unsubscribeSettings?.(); unsubscribeTheme?.(); unsubscribeMail?.(); };
  }, []);

  if (error) return <p role="alert" className="p-4 text-mail-danger">{error}</p>;
  if (!initial) return <div className="h-screen bg-mail-bg" aria-busy="true" />;
  const close = () => { void emit('settings-window-closed', { token }).finally(() => getCurrentWebviewWindow().destroy()); };
  const handoff = action => { void emit('settings-window-action', { token, action }).finally(close); };
  // Settings > Unsubscribe asks from this window too; App.jsx's host is not here.
  return <>
    <SettingsPage initialTab={initial.tab} initialAccountId={initial.accountId} initialSection={initial.section}
      onClose={close}
      onAddAccount={() => handoff('add-account')}
      /* Export and import run in the main window only (components/transfer/ explains why). */
      onExportAccounts={() => handoff('export-accounts')}
      onImportAccounts={() => handoff('import-accounts')}
      onReportBug={() => handoff('report-bug')} />
    <UnsubscribeHost />
  </>;
}
