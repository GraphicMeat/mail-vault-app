// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';

const handlers = vi.hoisted(() => new Map());
const emitTo = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); },
  emitTo: (...a) => emitTo(...a),
}));
const invoke = vi.hoisted(() => vi.fn(async () => 'export-1'));
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
const mail = vi.hoisted(() => ({ selectedEmail: null }));
vi.mock('../../stores/mailStore', () => ({ useMailStore: { getState: () => mail } }));
const spam = vi.hoisted(() => ({ value: false }));
vi.mock('../../utils/spamFolder', () => ({ isSpamMessage: () => spam.value }));
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
vi.mock('../../stores/themeStore', () => ({ useThemeStore: { getState: () => ({ theme: 'dark', palette: 'default' }) } }));
const privacy = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../stores/privacyStore', () => ({ usePrivacyStore: { getState: () => privacy } }));
const buildLocal = vi.hoisted(() => vi.fn(async () => ({ ok: true, files: [{ name: 'a.png', base64: 'PNG' }], failures: [] })));
vi.mock('../../services/export/exportSource', () => ({ buildLocal: (...a) => buildLocal(...a) }));

import { useExportWindow } from '../useExportWindow';

const messages = [{ uid: 7, subject: 'Hi', html: '<p>x</p>', messageId: 'm7', _accountId: 'acct' }, { uid: 8, subject: 'Re: Hi' }];

async function opened(onDock = vi.fn()) {
  const hook = renderHook(() => useExportWindow({ onDock }));
  await waitFor(() => expect(handlers.size).toBe(4));
  await act(() => hook.result.current.popOut({ messages, account: 'a@x.test', mailbox: 'INBOX', initial: { format: 'image', mirror: false } }));
  const token = invoke.mock.calls.at(-1)[1].token;
  return { hook, token, onDock };
}
const lastReply = () => emitTo.mock.calls.filter(c => c[1] === 'export-window-reply').at(-1)?.[2];
const request = (token, requestId, options) => act(() => handlers.get('export-window-request')({ payload: { token, requestId, options } }));

beforeEach(() => {
  handlers.clear();
  [emitTo, invoke, destroy, buildLocal, setSocialExport, buildSocialContent].forEach(m => m.mockClear());
  premium.value = true;
  privacy.enabled = false;
  spam.value = false;
  mail.selectedEmail = null;
});
afterEach(cleanup);

describe('useExportWindow', () => {
  it('opens an export window and hands it the choices, the theme, the Social style and a bare list of the messages', async () => {
    const { token } = await opened();
    expect(invoke).toHaveBeenCalledWith('open_auxiliary_window', { kind: 'export', token });
    await act(() => handlers.get('export-window-ready')({ payload: { token, label: 'export-1' } }));
    expect(emitTo).toHaveBeenCalledWith('export-1', 'export-window-payload', {
      token, initial: { format: 'image', mirror: false }, theme: { theme: 'dark', palette: 'default' },
      settings: { socialExport: { size: 'auto' } }, socialDefaults: { revealSender: false },
      messages: [{ uid: 7, messageId: 'm7', _accountId: 'acct' }, { uid: 8 }],
    });
  });

  it('tells the window the first message is spam, so its Social tab starts with the sender shown', async () => {
    const { token } = await opened();
    spam.value = true;
    await act(() => handlers.get('export-window-ready')({ payload: { token, label: 'export-1' } }));
    expect(emitTo.mock.calls.at(-1)[2].socialDefaults).toEqual({ revealSender: true });
  });

  it('builds the popped-out messages for the window, and ignores a foreign token', async () => {
    const { token } = await opened();
    await request('other', 'r0', { format: 'image' });
    expect(buildLocal).not.toHaveBeenCalled();
    await request(token, 'r1', { format: 'image', layout: 'single', mirror: false, attachments: true, redact: null, width: 900 });
    expect(buildLocal).toHaveBeenCalledWith({
      messages, account: 'a@x.test', mailbox: 'INBOX',
      format: 'image', layout: 'single', mirror: false, attachments: true, redact: null, width: 900,
    });
    expect(lastReply()).toEqual({
      token, requestId: 'r1', ok: true, result: { ok: true, files: [{ name: 'a.png', base64: 'PNG' }], failures: [] },
    });
  });

  it('refuses without premium, in the shape the panel words as the premium notice', async () => {
    const { token } = await opened();
    premium.value = false;
    await request(token, 'r1', { format: 'image' });
    expect(lastReply()).toMatchObject({ ok: true, result: { ok: false, reason: 'premium' } });
    expect(buildLocal).not.toHaveBeenCalled();
  });

  it('redacts whatever the window asked while privacy mode is on: blur, bars for HTML', async () => {
    const { token } = await opened();
    privacy.enabled = true;
    await request(token, 'r1', { format: 'image', redact: null });
    expect(buildLocal.mock.calls.at(-1)[0].redact).toEqual({ style: 'blur' });
    await request(token, 'r2', { format: 'html', redact: null });
    expect(buildLocal.mock.calls.at(-1)[0].redact).toEqual({ style: 'bar' });
    await request(token, 'r3', { format: 'image', redact: { style: 'bar' } });
    expect(buildLocal.mock.calls.at(-1)[0].redact).toEqual({ style: 'bar' });
  });

  it('renders the first message for the Social tab with its options, minus the format key, and answers in the same reply shape', async () => {
    const { token } = await opened();
    await request(token, 'r1', { format: 'social', content: 'card', redact: true });
    expect(buildSocialContent).toHaveBeenCalledWith(messages[0], { content: 'card', redact: true });
    expect(buildLocal).not.toHaveBeenCalled();
    expect(lastReply()).toEqual({ token, requestId: 'r1', ok: true, result: { base64: 'PNG', name: 'x - social.png' } });
  });

  it('refuses a Social render without premium, and an app shot once another message is open', async () => {
    const { token } = await opened();
    premium.value = false;
    await request(token, 'r1', { format: 'social', content: 'card' });
    expect(lastReply()).toMatchObject({ ok: false, error: 'premium' });
    premium.value = true;
    mail.selectedEmail = { uid: 99 };
    await request(token, 'r2', { format: 'social', content: 'app' });
    expect(lastReply()).toMatchObject({ ok: false, error: 'not-open' });
    expect(buildSocialContent).not.toHaveBeenCalled();
    mail.selectedEmail = { uid: 7 };
    await request(token, 'r3', { format: 'social', content: 'app' });
    expect(lastReply()).toMatchObject({ ok: true });
  });

  it('remembers a Social style change from the window in the main window\'s settings', async () => {
    const { token } = await opened();
    handlers.get('export-window-prefs')({ payload: { token: 'other', patch: { size: 'square' } } });
    expect(setSocialExport).not.toHaveBeenCalled();
    handlers.get('export-window-prefs')({ payload: { token, patch: { size: 'story' } } });
    expect(setSocialExport).toHaveBeenCalledWith({ size: 'story' });
  });

  it('docks back into the dialog with the messages main holds, not what the window sent', async () => {
    const { token, onDock } = await opened();
    const initial = { format: 'social', files: { format: 'image' }, social: { redact: true } };
    handlers.get('export-window-dock')({ payload: { token, initial, messages: [{ uid: 666 }] } });
    expect(onDock).toHaveBeenCalledWith({ messages, account: 'a@x.test', mailbox: 'INBOX', initial });
    await waitFor(() => expect(destroy).toHaveBeenCalled());
    await request(token, 'r9', { format: 'image' });
    expect(buildLocal).not.toHaveBeenCalled();
  });

  it('says false when the window could not open', async () => {
    invoke.mockRejectedValueOnce(new Error('no'));
    const hook = renderHook(() => useExportWindow({ onDock: () => {} }));
    await waitFor(() => expect(handlers.size).toBe(4));
    let result;
    await act(async () => { result = await hook.result.current.popOut({ messages, account: 'a', mailbox: 'INBOX', initial: {} }); });
    expect(result).toBe(false);
  });
});
