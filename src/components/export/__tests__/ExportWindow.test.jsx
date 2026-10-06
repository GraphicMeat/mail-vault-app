// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

const handlers = vi.hoisted(() => new Map());
const emit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); },
  emit: (...a) => emit(...a),
}));
const destroy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'export-3', destroy }),
}));
vi.mock('../../../utils/privacy/privacySync', () => ({ startPrivacySync: () => () => {} }));
vi.mock('../../../services/export/exportSaver', () => ({ saveOneFile: vi.fn(), saveFilesToDirectory: vi.fn() }));
vi.mock('../../../services/export/exportService', () => ({ buildExport: vi.fn() }));

// The Social tab: the panel and what it reads. Nothing here renders; the window asks main for the PNG.
vi.mock('../../../stores/mailStore', () => ({ useMailStore: { getState: () => ({}) } }));
vi.mock('../../../utils/spamFolder', () => ({ isSpamMessage: () => false }));
const composeSocialFile = vi.hoisted(() => vi.fn(async () => ({ ok: true, file: { name: 'x - social.png', base64: 'AAAA' } })));
vi.mock('../../../services/export/social/buildSocialExport', () => ({
  composeSocialFile: (...a) => composeSocialFile(...a),
  chromeTheme: (_content, appTheme) => (appTheme === 'dark' ? 'dark' : 'light'),
}));
vi.mock('../../../services/export/social/composeSocialImage', () => ({ composeSocialImage: () => ({ width: 10, height: 10 }) }));
vi.mock('../../../services/export/social/socialWatermark', () => ({ loadWatermark: async () => null }));
const settings = vi.hoisted(() => {
  const DEFAULT = {
    content: 'card', size: 'auto', background: { type: 'gradient', id: 'sunset' },
    padding: 64, radius: 16, shadow: true, chrome: true, senderDetails: false, links: false, appTheme: null, mailTheme: null,
  };
  const box = { state: null, DEFAULT };
  const store = (select) => select(box.state);
  store.getState = () => box.state;
  store.setState = (patch) => { box.state = { ...box.state, ...patch }; };
  box.store = store;
  return box;
});
vi.mock('../../../stores/settingsStore', () => ({
  hasPremiumAccess: () => true,
  DEFAULT_SOCIAL_EXPORT: settings.DEFAULT,
  useSettingsStore: settings.store,
}));

// The window reads the token from its own URL, once, when the module loads.
window.history.replaceState({}, '', '/app.html?export=tok-1');
const { ExportWindow } = await import('../ExportWindow');

const ok = { ok: true, files: [{ name: 'a.png', base64: 'AAAA' }], failures: [] };
const sent = (name) => emit.mock.calls.filter(c => c[0] === name).map(c => c[1]);
const requests = (format) => sent('export-window-request').filter(r => r.options.format === format);
const thread = [{ uid: 1 }, { uid: 2 }];
const single = [{ uid: 1 }];
const boot = (token = 'tok-1', over = {}) => act(() => handlers.get('export-window-payload')({
  payload: {
    token, initial: { format: 'html', files: { format: 'html', mirror: false } }, messages: thread,
    theme: { theme: 'dark', palette: 'default' }, settings: { socialExport: settings.DEFAULT }, ...over,
  },
}));
const open = async (over) => {
  render(<ExportWindow />);
  await waitFor(() => expect(handlers.size).toBe(2));
  await boot('tok-1', over);
};
const tab = (name) => screen.getByRole('radio', { name });

beforeEach(() => {
  handlers.clear(); emit.mockClear(); destroy.mockClear(); composeSocialFile.mockClear();
  settings.state = {
    socialExport: { ...settings.DEFAULT },
    setSocialExport: (patch) => { settings.state = { ...settings.state, socialExport: { ...settings.state.socialExport, ...patch } }; },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, drawImage() {} });
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 50, height: 50, close: vi.fn() })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('ExportWindow', () => {
  it('says it is ready with its token and label, and shows nothing until its payload arrives', async () => {
    render(<ExportWindow />);
    await waitFor(() => expect(emit).toHaveBeenCalledWith('export-window-ready', { token: 'tok-1', label: 'export-3' }));
    await boot('other');
    expect(screen.queryByRole('button', { name: /^export$/i })).toBeNull();
    await boot();
    expect(await screen.findByRole('button', { name: /^export$/i })).toBeTruthy();
    // The format and choices the main window handed over.
    expect(screen.getByRole('heading', { name: /export 2 messages/i })).toBeTruthy();
    expect(screen.queryByRole('slider', { name: 'Email width' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: /mirror remote content/i }).checked).toBe(false);
  });

  it('asks the main window to build, in plain options, and takes only its own reply', async () => {
    render(<ExportWindow />);
    await waitFor(() => expect(handlers.size).toBe(2));
    await boot();
    await waitFor(() => expect(sent('export-window-request')).toHaveLength(1), { timeout: 2000 });
    const request = sent('export-window-request')[0];
    expect(request).toMatchObject({ token: 'tok-1', options: { format: 'html', layout: 'single', mirror: false, attachments: false, redact: null } });
    expect(request.options).not.toHaveProperty('messages');
    expect(request.options).not.toHaveProperty('width');
    const reply = (over) => act(() => handlers.get('export-window-reply')({ payload: { requestId: request.requestId, ok: true, result: ok, ...over } }));
    await reply({ token: 'other' });
    await reply({ token: 'tok-1', requestId: 'unknown' });
    expect(screen.queryByTitle('Preview')).toBeNull();
    expect(screen.queryByText('Preview unavailable')).toBeNull();
    await reply({ token: 'tok-1' });
    expect((await screen.findByTitle('Preview')).tagName).toBe('IFRAME');
  });

  it('hands the choices back to the app, format included, under the Image and HTML name', async () => {
    await open();
    fireEvent.click(await screen.findByRole('button', { name: /back to app/i }));
    expect(sent('export-window-dock')).toEqual([{
      token: 'tok-1',
      initial: {
        format: 'html',
        files: { format: 'html', layout: 'single', mirror: false, attachments: true, redact: false, redactStyle: 'blur', width: 820 },
      },
    }]);
  });
});

describe('the format tabs of the window', () => {
  it('has Image, HTML and Social in one strip, on the format the window opened with', async () => {
    await open({ messages: single, initial: { format: 'html', files: { format: 'html' } } });
    expect(screen.getAllByRole('radio').filter(r => ['Image', 'HTML', 'Social'].includes(r.getAttribute('aria-label')))).toHaveLength(3);
    expect(tab('HTML').checked).toBe(true);
    expect(tab('Social').disabled).toBe(false);
  });

  it('keeps Social off for a thread, as the dialog does', async () => {
    await open();
    expect(tab('Social').disabled).toBe(true);
  });

  it('switches Image to HTML in place: the same window builds the other format, options kept', async () => {
    await open({ messages: single, initial: { format: 'image', files: { format: 'image', mirror: false } } });
    await waitFor(() => expect(requests('image')).toHaveLength(1), { timeout: 2000 });
    // The preview builds one at a time: the HTML build waits for this answer.
    await act(() => handlers.get('export-window-reply')({ payload: { token: 'tok-1', requestId: requests('image')[0].requestId, ok: true, result: ok } }));
    fireEvent.click(tab('HTML'));
    await waitFor(() => expect(requests('html')).toHaveLength(1), { timeout: 2000 });
    expect(requests('html')[0].options).toMatchObject({ format: 'html', mirror: false });
    expect(screen.queryByRole('slider', { name: 'Email width' })).toBeNull();
    expect(sent('export-window-dock')).toEqual([]);
  });

  it('switches to Social and asks main for the card, redacted, in the same window', async () => {
    await open({ messages: single, initial: { format: 'image', files: { format: 'image' } } });
    fireEvent.click(tab('Social'));
    await waitFor(() => expect(requests('social')).toHaveLength(1), { timeout: 2000 });
    expect(requests('social')[0]).toMatchObject({ token: 'tok-1', options: { format: 'social', content: 'card', redact: true } });
    expect(screen.getByRole('checkbox', { name: /redact sensitive info/i }).checked).toBe(true);
    expect(screen.getByRole('button', { name: /save png/i })).toBeTruthy();
    // Image and HTML's own options are gone with their panel.
    expect(screen.queryByRole('checkbox', { name: /mirror remote content/i })).toBeNull();
  });

  it('decodes the PNG main sent back and saves from it under the name main offered', async () => {
    await open({ messages: single, initial: { format: 'social' } });
    await waitFor(() => expect(requests('social')).toHaveLength(1), { timeout: 2000 });
    const { requestId } = sent('export-window-request').find(r => r.options.format === 'social');
    await act(() => handlers.get('export-window-reply')({
      payload: { token: 'tok-1', requestId, ok: true, result: { base64: 'AAAA', name: 'Hello - social.png' } },
    }));
    await waitFor(() => expect(screen.getByRole('button', { name: /save png/i }).disabled).toBe(false));
  });

  it('starts Social with the sender shown when main says it is a spam message, unless the choices say otherwise', async () => {
    await open({ messages: single, initial: { format: 'image', files: { format: 'image' } }, socialDefaults: { revealSender: true } });
    fireEvent.click(tab('Social'));
    await waitFor(() => expect(requests('social')).toHaveLength(1), { timeout: 2000 });
    expect(requests('social')[0].options.revealSender).toBe(true);
    cleanup(); handlers.clear(); emit.mockClear();
    await open({ messages: single, initial: { format: 'social', social: { redact: true, revealSender: false } }, socialDefaults: { revealSender: true } });
    await waitFor(() => expect(requests('social')).toHaveLength(1), { timeout: 2000 });
    expect(requests('social')[0].options).not.toHaveProperty('revealSender');
  });

  it('does not let Social\'s redact-on leak into Image: that export starts unredacted, attachments on', async () => {
    await open({ messages: single, initial: { format: 'social', social: { redact: true, revealSender: false } } });
    fireEvent.click(tab('Image'));
    expect(screen.getByRole('checkbox', { name: /redact sensitive info/i }).checked).toBe(false);
    expect(screen.getByRole('checkbox', { name: /include attachments/i }).checked).toBe(true);
  });

  it('tells main a Social style change, and shows it again after a trip through Image, not the style the window opened with', async () => {
    await open({ messages: single, initial: { format: 'social', social: { redact: true, revealSender: false, prefs: { size: 'story' } } } });
    expect(screen.getByRole('button', { name: '9:16' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '4:5' }));
    expect(sent('export-window-prefs')).toEqual([{ token: 'tok-1', patch: { size: 'portrait' } }]);
    fireEvent.click(tab('Image'));
    fireEvent.click(tab('Social'));
    expect(screen.getByRole('button', { name: '4:5' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('hands Social\'s choices back with the format, and the Image and HTML ones beside them', async () => {
    await open({ messages: single, initial: { format: 'social', social: { redact: true, revealSender: false }, files: { format: 'image', mirror: false } } });
    fireEvent.click(await screen.findByRole('button', { name: /back to app/i }));
    expect(sent('export-window-dock')).toEqual([{
      token: 'tok-1',
      initial: {
        format: 'social',
        files: { format: 'image', layout: 'single', mirror: false, attachments: true, redact: false, redactStyle: 'blur', width: 820 },
        social: { redact: true, revealSender: false, prefs: expect.objectContaining({ content: 'card' }) },
      },
    }]);
  });
});
