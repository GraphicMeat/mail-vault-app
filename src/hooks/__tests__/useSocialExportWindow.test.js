// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';

const handlers = vi.hoisted(() => new Map());
const emitTo = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); },
  emitTo: (...a) => emitTo(...a),
}));
const invoke = vi.hoisted(() => vi.fn(async () => 'social-1'));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
const destroy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: { getByLabel: async () => ({ destroy, once: async () => {}, unminimize: async () => {}, setFocus: async () => {} }) },
}));
const premium = vi.hoisted(() => ({ value: true }));
const setSocialExport = vi.hoisted(() => vi.fn());
vi.mock('../../stores/settingsStore', () => ({
  hasPremiumAccess: () => premium.value,
  useSettingsStore: { getState: () => ({ billingProfile: {}, socialExport: { size: 'auto' }, setSocialExport }) },
}));
vi.mock('../../stores/themeStore', () => ({ useThemeStore: { getState: () => ({ theme: 'dark', palette: 'default' }) } }));
const mail = vi.hoisted(() => ({ selectedEmail: null }));
vi.mock('../../stores/mailStore', () => ({ useMailStore: { getState: () => mail } }));
vi.mock('../../utils/captureTarget', () => ({
  captureTargetOf: (email) => ({ uid: email.uid }),
  isCaptureTarget: (email, target) => !!email && email.uid === target.uid,
}));
const buildSocialContent = vi.hoisted(() => vi.fn(async () => ({ width: 10, height: 10 })));
vi.mock('../../services/export/social/buildSocialExport', () => ({
  buildSocialContent: (...a) => buildSocialContent(...a),
  socialFileName: async () => 'x - social.png',
}));
vi.mock('../../services/export/social/encodePng', () => ({ canvasToPngBase64: async () => 'PNG' }));

import { useSocialExportWindow } from '../useSocialExportWindow';

const message = { uid: 7, subject: 'Hi' };

async function opened(onDock = vi.fn()) {
  const hook = renderHook(() => useSocialExportWindow({ onDock }));
  await waitFor(() => expect(handlers.size).toBe(4));
  await act(() => hook.result.current.popOut({ message, account: 'a@x.test', mailbox: 'INBOX', initial: { redact: true } }));
  const token = invoke.mock.calls.at(-1)[1].token;
  return { hook, token, onDock };
}
const lastReply = () => emitTo.mock.calls.filter(c => c[1] === 'social-window-reply').at(-1)?.[2];

beforeEach(() => {
  handlers.clear();
  [emitTo, invoke, destroy, setSocialExport, buildSocialContent].forEach(m => m.mockClear());
  premium.value = true;
  mail.selectedEmail = null;
});
afterEach(cleanup);

describe('useSocialExportWindow', () => {
  it('opens a social window and hands it the choices and the style', async () => {
    const { token } = await opened();
    expect(invoke).toHaveBeenCalledWith('open_auxiliary_window', { kind: 'social', token });
    await act(() => handlers.get('social-window-ready')({ payload: { token, label: 'social-1' } }));
    expect(emitTo).toHaveBeenCalledWith('social-1', 'social-window-payload', expect.objectContaining({
      token, initial: { redact: true }, settings: { socialExport: { size: 'auto' } },
    }));
  });

  it('renders the popped-out message with the window options, and ignores a foreign token', async () => {
    const { token } = await opened();
    await act(() => handlers.get('social-window-request')({ payload: { token: 'other', requestId: 'r0', options: {} } }));
    expect(buildSocialContent).not.toHaveBeenCalled();
    await act(() => handlers.get('social-window-request')({ payload: { token, requestId: 'r1', options: { content: 'card', redact: true } } }));
    expect(buildSocialContent).toHaveBeenCalledWith(message, { content: 'card', redact: true });
    expect(lastReply()).toEqual({ token, requestId: 'r1', ok: true, base64: 'PNG', name: 'x - social.png' });
  });

  it('refuses without premium, and an app shot once another message is open', async () => {
    const { token } = await opened();
    premium.value = false;
    await act(() => handlers.get('social-window-request')({ payload: { token, requestId: 'r1', options: { content: 'card' } } }));
    expect(lastReply()).toMatchObject({ ok: false, error: 'premium' });
    premium.value = true;
    mail.selectedEmail = { uid: 99 };
    await act(() => handlers.get('social-window-request')({ payload: { token, requestId: 'r2', options: { content: 'app' } } }));
    expect(lastReply()).toMatchObject({ ok: false, error: 'not-open' });
    expect(buildSocialContent).not.toHaveBeenCalled();
    mail.selectedEmail = { uid: 7 };
    await act(() => handlers.get('social-window-request')({ payload: { token, requestId: 'r3', options: { content: 'app' } } }));
    expect(lastReply()).toMatchObject({ ok: true });
  });

  it('remembers the style in the main window, and docks back into the dialog', async () => {
    const { token, onDock } = await opened();
    handlers.get('social-window-prefs')({ payload: { token, patch: { size: 'story' } } });
    expect(setSocialExport).toHaveBeenCalledWith({ size: 'story' });
    handlers.get('social-window-dock')({ payload: { token, initial: { redact: false } } });
    expect(onDock).toHaveBeenCalledWith({ message, account: 'a@x.test', mailbox: 'INBOX', initial: { redact: false } });
    await waitFor(() => expect(destroy).toHaveBeenCalled());
    // The record is gone: a late request from the closed window is ignored.
    await act(() => handlers.get('social-window-request')({ payload: { token, requestId: 'r9', options: {} } }));
    expect(buildSocialContent).not.toHaveBeenCalled();
  });
});
