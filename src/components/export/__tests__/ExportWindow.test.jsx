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

// The window reads the token from its own URL, once, when the module loads.
window.history.replaceState({}, '', '/app.html?export=tok-1');
const { ExportWindow } = await import('../ExportWindow');

const ok = { ok: true, files: [{ name: 'a.png', base64: 'AAAA' }], failures: [] };
const sent = (name) => emit.mock.calls.filter(c => c[0] === name).map(c => c[1]);
const boot = (token = 'tok-1', over = {}) => act(() => handlers.get('export-window-payload')({
  payload: { token, initial: { format: 'html', mirror: false }, messages: [{ uid: 1 }, { uid: 2 }], theme: { theme: 'dark', palette: 'default' }, ...over },
}));

beforeEach(() => { handlers.clear(); emit.mockClear(); destroy.mockClear(); });
afterEach(cleanup);

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

  it('hands the choices back to the app, format included', async () => {
    render(<ExportWindow />);
    await waitFor(() => expect(handlers.size).toBe(2));
    await boot();
    fireEvent.click(await screen.findByRole('button', { name: /back to app/i }));
    expect(sent('export-window-dock')).toEqual([{
      token: 'tok-1',
      initial: { format: 'html', layout: 'single', mirror: false, attachments: true, redact: false, redactStyle: 'blur', width: 820 },
    }]);
  });
});
