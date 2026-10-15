// @vitest-environment jsdom
// The perf gate's probe is an e2e hook: installed only in an e2e build (VITE_E2E === '1'), and lazily, so a
// production entry chunk never holds it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../components/email/bodyRendererRegistry', () => ({ registerBodyRenderer: vi.fn() }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ label: 'main', onCloseRequested: vi.fn(async () => () => {}) }) }));
vi.mock('../service', async (orig) => ({
  ...(await orig()),
  openRender: vi.fn(async () => ({ docId: 1, rev: 1, meta: { cssHeight: 10 } })),
  closeRender: vi.fn(async () => {}),
  onRenderUpdated: vi.fn(() => Promise.resolve(() => {})),
}));

beforeEach(() => { vi.stubEnv('VITE_MV_APPSTORE', ''); delete window.__MV_BLITZ_PERF__; });
afterEach(() => { vi.unstubAllEnvs(); delete window.__MV_BLITZ_PERF__; });

describe('installPerfProbe', () => {
  it('installs window.__MV_BLITZ_PERF__.run in an e2e build', async () => {
    vi.stubEnv('VITE_E2E', '1');
    const { installPerfProbe } = await import('../surfaces/perfProbe');
    const win = {};
    installPerfProbe(win);
    expect(typeof win.__MV_BLITZ_PERF__.run).toBe('function');
  });

  it('installs nothing in any other build', async () => {
    vi.stubEnv('VITE_E2E', '');
    const { installPerfProbe } = await import('../surfaces/perfProbe');
    const win = {};
    installPerfProbe(win);
    expect(win.__MV_BLITZ_PERF__).toBeUndefined();
  });
});

describe('the module entry', () => {
  const load = async () => { vi.resetModules(); await import('../index.js'); await new Promise((r) => setTimeout(r, 50)); };

  it('loads and installs the probe in an e2e build', async () => {
    vi.stubEnv('VITE_E2E', '1');
    await load();
    expect(typeof window.__MV_BLITZ_PERF__?.run).toBe('function');
  });

  it('does not load the probe in a production build', async () => {
    vi.stubEnv('VITE_E2E', '');
    await load();
    expect(window.__MV_BLITZ_PERF__).toBeUndefined();
  });
});

describe('the probe scenarios', () => {
  it('an iframe is not painted on its initial blank document, whatever its height', async () => {
    const { painted } = await import('../surfaces/perfProbe');
    const f = document.createElement('iframe');
    f.style.height = '120px';
    document.body.appendChild(f);
    expect(painted(f)).toBe(false);
    f.dataset.perfLoaded = '1'; // the flag alone (no srcdoc document behind it) is not enough either
    expect(painted(f)).toBe(false);
    f.remove();
  });

  it('feeds each surface its real document, unique per run and body', async () => {
    const { buildBodies, blitzProps } = await import('../surfaces/perfProbe');
    const html = '<html><body><p>Hi</p></body></html>';
    const [thread] = buildBodies([html], 'thread');
    expect(thread.iframeDoc).toContain('Hi');
    const tp = blitzProps('thread', thread, 3, 7);
    expect(tp).toMatchObject({ surface: 'thread', foldQuotes: true, signatureDisplay: 'smart', sizing: 'content' });
    expect(tp.bodyHtml).toContain('<!--perf run 3 body 7-->');
    expect(tp.documentHtml).toBeUndefined();

    const [bubble] = buildBodies([html], 'bubble');
    const bp = blitzProps('bubble', bubble, 3, 7);
    expect(bp).toMatchObject({ surface: 'bubble', foldQuotes: true, signatureDisplay: 'smart', sizing: { collapsedMax: 400 } });
    expect(bp.bodyHtml).toBeUndefined();
    expect(bp.documentHtml.indexOf('<!--perf run 3 body 7-->')).toBeLessThan(bp.documentHtml.lastIndexOf('</body>'));
    expect(blitzProps('bubble', bubble, 3, 8).documentHtml).not.toBe(bp.documentHtml);
  });
});
