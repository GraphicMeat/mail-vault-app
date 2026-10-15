// @vitest-environment jsdom
// The Mac App Store shell is built without the render feature (no mvrender
// scheme), so a registered Blitz there would offer a setting whose every tile
// fails. The module registers nothing in that build.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const register = vi.hoisted(() => vi.fn());
vi.mock('../../../components/email/bodyRendererRegistry', () => ({ registerBodyRenderer: register }));

const win = vi.hoisted(() => ({ label: 'main', onCloseRequested: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => win }));
const svc = vi.hoisted(() => ({
  openRender: vi.fn(async () => ({ docId: 1, rev: 1, meta: { cssHeight: 10 } })),
  closeRender: vi.fn(async () => {}),
  onRenderUpdated: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock('../service', async (orig) => ({ ...(await orig()), ...svc }));

const load = async () => { vi.resetModules(); await import('../index.js'); };

beforeEach(() => { register.mockClear(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('blitz module registration', () => {
  it('registers the renderer, body and settings row, in an ordinary build', async () => {
    vi.stubEnv('VITE_MV_APPSTORE', '');
    await load();
    expect(register).toHaveBeenCalledTimes(1);
    const [name, impl] = register.mock.calls[0];
    expect(name).toBe('blitz');
    // A forwardRef component: the reply selection handle is read through its ref.
    expect(impl.Body.$$typeof).toBe(Symbol.for('react.forward_ref'));
    expect(typeof impl.SettingsRow).toBe('function');
  });

  it('registers nothing in a Mac App Store build: no body, no settings row', async () => {
    vi.stubEnv('VITE_MV_APPSTORE', '1');
    await load();
    expect(register).not.toHaveBeenCalled();
  });

  describe('the close handler of an original-* window (Review Focus 5)', () => {
    const P = { html: '<p>x', cssWidth: 600, scale: 2, allowRemote: true, theme: { mode: 'light' } };
    beforeEach(() => { vi.stubEnv('VITE_MV_APPSTORE', ''); win.onCloseRequested.mockClear(); });

    it('a web-mode original window gets no close-requested handler, and no registry', async () => {
      win.label = 'original-1';
      await load();
      await new Promise((r) => setTimeout(r, 0));
      expect(win.onCloseRequested).not.toHaveBeenCalled();
    });

    it('a window that draws a doc gets one, once', async () => {
      win.label = 'original-1';
      await load();
      const { getDocRegistry } = await import('../surfaces/docRegistry');
      const reg = getDocRegistry();
      await reg.acquire('k1', P);
      await reg.acquire('k2', { ...P, html: '<p>y' });
      expect(win.onCloseRequested).toHaveBeenCalledTimes(1);
    });

    it('the main window never gets one', async () => {
      win.label = 'main';
      await load();
      const { getDocRegistry } = await import('../surfaces/docRegistry');
      await getDocRegistry().acquire('k1', P);
      expect(win.onCloseRequested).not.toHaveBeenCalled();
    });
  });
});
