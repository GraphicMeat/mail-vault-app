import { useCallback, useEffect, useRef } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { useThemeStore } from '../stores/themeStore';
import { usePrivacyStore } from '../stores/privacyStore';
import { buildLocal } from '../services/export/exportSource';

/**
 * The main window's half of the detached Image and HTML export (ExportWindow),
 * the twin of useSocialExportWindow.
 *
 * The window is only the panel: every build happens here, where the messages,
 * the mirrored remote content and the privacy dictionary live, and the window
 * previews and saves from the files it gets back. It is handed a bare list of
 * the messages (ids, to key its preview), and when it docks back the dialog
 * reopens on the messages held here, never on anything the window sends.
 *
 * Privacy mode is enforced here too: while it is on, a build is redacted
 * whatever the window asked.
 *
 * One window at a time. `onDock` receives `{ messages, account, mailbox, initial }`
 * when the window hands itself back to the dialog.
 */
export function useExportWindow({ onDock }) {
  const current = useRef(null); // { token, label, messages, account, mailbox, initial }
  const dockRef = useRef(onDock);
  dockRef.current = onDock;

  useEffect(() => {
    let disposed = false;
    let stops = [];
    const mine = payload => payload?.token && payload.token === current.current?.token;
    Promise.all([
      listen('export-window-ready', async ({ payload }) => {
        if (!mine(payload)) return;
        const record = current.current;
        record.label = payload.label;
        const theme = useThemeStore.getState();
        await emitTo(payload.label, 'export-window-payload', {
          token: record.token, initial: record.initial,
          messages: record.messages.map(({ uid, messageId, _accountId, _mailbox }) => (
            Object.fromEntries(Object.entries({ uid, messageId, _accountId, _mailbox }).filter(([, v]) => v !== undefined))
          )),
          theme: { theme: theme.theme, palette: theme.palette },
        }).catch(() => {});
      }),
      listen('export-window-request', async ({ payload }) => {
        if (!mine(payload)) return;
        const { token, label, messages, account, mailbox } = current.current;
        const reply = body => emitTo(label, 'export-window-reply', { token, requestId: payload.requestId, ...body }).catch(() => {});
        try {
          // In the shape of a failed build: the panel words it as the premium notice.
          if (!hasPremiumAccess(useSettingsStore.getState().billingProfile)) {
            await reply({ ok: true, result: { ok: false, reason: 'premium' } });
            return;
          }
          const options = payload.options || {};
          const redact = options.redact || (usePrivacyStore.getState().enabled
            ? { style: options.format === 'html' ? 'bar' : 'blur' }
            : null);
          const result = await buildLocal({ ...options, redact, messages, account, mailbox });
          await reply({ ok: true, result });
        } catch (err) {
          await reply({ ok: false, error: String(err?.message || err) });
        }
      }),
      listen('export-window-dock', ({ payload }) => {
        if (!mine(payload)) return;
        const { label, messages, account, mailbox } = current.current;
        current.current = null;
        void WebviewWindow.getByLabel(label).then(window => window?.destroy()).catch(() => {});
        // A minimized main would take the dialog out of sight.
        void WebviewWindow.getByLabel('main')
          .then(async window => { await window?.unminimize(); await window?.setFocus(); })
          .catch(() => {});
        dockRef.current?.({ messages, account, mailbox, initial: payload.initial });
      }),
    ]).then(results => { if (disposed) results.forEach(stop => stop()); else stops = results; });
    return () => { disposed = true; stops.forEach(stop => stop()); };
  }, []);

  const popOut = useCallback(async ({ messages, account, mailbox, initial }) => {
    const previous = current.current;
    if (previous?.label) void WebviewWindow.getByLabel(previous.label).then(window => window?.destroy()).catch(() => {});
    const token = crypto.randomUUID();
    current.current = { token, label: null, messages, account, mailbox, initial };
    try {
      const label = await invoke('open_auxiliary_window', { kind: 'export', token });
      if (current.current?.token === token) current.current.label = label;
      const native = await WebviewWindow.getByLabel(label);
      await native?.once('tauri://destroyed', () => {
        if (current.current?.token === token) current.current = null;
      });
      return true;
    } catch (cause) {
      if (current.current?.token === token) current.current = null;
      console.warn('[export] could not open the window:', cause);
      return false;
    }
  }, []);

  return { popOut };
}
