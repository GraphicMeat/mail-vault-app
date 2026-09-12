// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let originalFetch;
let originalOpen;

beforeEach(() => {
  vi.resetModules();
  originalFetch = window.fetch;
  originalOpen = window.open;
  delete window.__MAILVAULT_DEMO_GUARDS__;
});

afterEach(() => {
  window.fetch = originalFetch;
  window.open = originalOpen;
  delete window.__MAILVAULT_DEMO_GUARDS__;
  delete window.__MAILVAULT_DEMO__;
  delete window.__TAURI__;
  delete document.body.dataset.mailvaultDemo;
});

describe('browser demo isolation', () => {
  it('loads same-origin assets while rejecting live APIs and daemon addresses in every fetch input form', async () => {
    const nativeFetch = vi.fn().mockResolvedValue({ ok: true });
    window.fetch = nativeFetch;
    const { installDemoGlobals, demoBackend } = await import('../runtime.js');
    const notices = [];
    demoBackend.on('demo:state', ({ payload }) => notices.push(payload));
    installDemoGlobals();

    await expect(window.fetch('/demo/assets/app.js')).resolves.toMatchObject({ ok: true });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    const blocked = [
      'http://127.0.0.1:19840/health',
      'http://localhost:19840/rpc',
      '//api.mailvault.app/checkout',
      '/api/checkout',
      new URL('/api/billing', window.location.href),
      new Request('https://api.mailvault.app/account'),
    ];
    for (const url of blocked) {
      await expect(window.fetch(url)).rejects.toMatchObject({ code: 'DEMO_UNSUPPORTED' });
    }
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(blocked.length);
    expect(notices.every(notice => notice.type === 'unsupported-network')).toBe(true);
  });

  it('blocks external window openings while keeping site navigation available', async () => {
    const nativeOpen = vi.fn().mockReturnValue({});
    window.open = nativeOpen;
    const { installDemoGlobals } = await import('../runtime.js');
    installDemoGlobals();

    expect(window.open('https://accounts.google.com/oauth')).toBeNull();
    expect(window.open('//api.mailvault.app/checkout')).toBeNull();
    window.open('/get-started.html?plan=free', '_blank');
    expect(nativeOpen).toHaveBeenCalledExactlyOnceWith('/get-started.html?plan=free', '_blank');
  });
});
