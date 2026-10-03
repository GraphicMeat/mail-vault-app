import { useCallback, useEffect, useRef } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { useThemeStore } from '../stores/themeStore';
import { useMailStore } from '../stores/mailStore';
import { captureTargetOf, isCaptureTarget } from '../utils/captureTarget';
import { buildSocialContent, socialFileName } from '../services/export/social/buildSocialExport';
import { canvasToPngBase64 } from '../services/export/social/encodePng';

/**
 * The main window's half of the detached Social export (SocialExportWindow).
 *
 * The window is only the panel: every content render happens here, where the
 * message, the privacy dictionary and (for an app shot) the window being shot
 * live, and buildSocialContent applies privacy mode whatever the window asked.
 * The window composes and saves from the PNG it gets back.
 *
 * An app shot shoots whatever main has open: once the user has opened another
 * message there, it answers `not-open` instead of shooting the wrong mail.
 *
 * One window at a time: popping out another message replaces it. `onDock`
 * receives `{ message, account, mailbox, initial }` when the window hands
 * itself back to the dialog.
 */
export function useSocialExportWindow({ onDock }) {
  const current = useRef(null); // { token, label, message, account, mailbox, initial }
  const dockRef = useRef(onDock);
  dockRef.current = onDock;

  useEffect(() => {
    let disposed = false;
    let stops = [];
    const mine = payload => payload?.token && payload.token === current.current?.token;
    Promise.all([
      listen('social-window-ready', async ({ payload }) => {
        if (!mine(payload)) return;
        const record = current.current;
        record.label = payload.label;
        const theme = useThemeStore.getState();
        await emitTo(payload.label, 'social-window-payload', {
          token: record.token, initial: record.initial,
          settings: { socialExport: useSettingsStore.getState().socialExport },
          theme: { theme: theme.theme, palette: theme.palette },
        }).catch(() => {});
      }),
      listen('social-window-request', async ({ payload }) => {
        if (!mine(payload)) return;
        const { token, label, message } = current.current;
        const reply = body => emitTo(label, 'social-window-reply', { token, requestId: payload.requestId, ...body }).catch(() => {});
        try {
          if (!hasPremiumAccess(useSettingsStore.getState().billingProfile)) throw new Error('premium');
          const options = payload.options || {};
          const state = useMailStore.getState();
          if (options.content === 'app' && !isCaptureTarget(state.selectedEmail, captureTargetOf(message, state), state)) {
            await reply({ ok: false, error: 'not-open' });
            return;
          }
          const [canvas, name] = await Promise.all([
            buildSocialContent(message, options),
            socialFileName(message, { redact: options.redact, revealSender: options.revealSender }),
          ]);
          await reply({ ok: true, base64: await canvasToPngBase64(canvas), name });
        } catch (err) {
          await reply({ ok: false, error: String(err?.message || err) });
        }
      }),
      // The style is remembered by the main window: a child's settings writes are off.
      listen('social-window-prefs', ({ payload }) => {
        if (mine(payload) && payload.patch) useSettingsStore.getState().setSocialExport(payload.patch);
      }),
      listen('social-window-dock', ({ payload }) => {
        if (!mine(payload)) return;
        const { label, message, account, mailbox } = current.current;
        current.current = null;
        void WebviewWindow.getByLabel(label).then(window => window?.destroy()).catch(() => {});
        // A minimized main would take the dialog out of sight.
        void WebviewWindow.getByLabel('main')
          .then(async window => { await window?.unminimize(); await window?.setFocus(); })
          .catch(() => {});
        dockRef.current?.({ message, account, mailbox, initial: payload.initial });
      }),
    ]).then(results => { if (disposed) results.forEach(stop => stop()); else stops = results; });
    return () => { disposed = true; stops.forEach(stop => stop()); };
  }, []);

  const popOut = useCallback(async ({ message, account, mailbox, initial }) => {
    const previous = current.current;
    if (previous?.label) void WebviewWindow.getByLabel(previous.label).then(window => window?.destroy()).catch(() => {});
    const token = crypto.randomUUID();
    current.current = { token, label: null, message, account, mailbox, initial };
    try {
      const label = await invoke('open_auxiliary_window', { kind: 'social', token });
      if (current.current?.token === token) current.current.label = label;
      const native = await WebviewWindow.getByLabel(label);
      await native?.once('tauri://destroyed', () => {
        if (current.current?.token === token) current.current = null;
      });
      return true;
    } catch (cause) {
      if (current.current?.token === token) current.current = null;
      console.warn('[social] could not open the window:', cause);
      return false;
    }
  }, []);

  return { popOut };
}
