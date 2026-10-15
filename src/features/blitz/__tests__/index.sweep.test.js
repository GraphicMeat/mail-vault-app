// @vitest-environment jsdom
// Leaving Blitz closes the docs nobody holds so the worker can idle out. The
// settings subscriber fires before React unmounts the bodies, and a body that
// unmounts after the sweep defers its close (thread, bubble): the sweep runs a
// tick later, after them (plan D F19).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../components/email/bodyRendererRegistry', () => ({ registerBodyRenderer: vi.fn() }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ label: 'main', onCloseRequested: vi.fn(async () => () => {}) }) }));
vi.mock('../service', async (orig) => ({
  ...(await orig()),
  closeRender: vi.fn(async () => {}),
  onRenderUpdated: vi.fn(() => Promise.resolve(() => {})),
}));

async function load() {
  vi.resetModules();
  await import('../index.js');
  const { useSettingsStore } = await import('../../../stores/settingsStore');
  const { getDocRegistry } = await import('../surfaces/docRegistry');
  const sweep = vi.spyOn(getDocRegistry(), 'closeDeferred');
  return { useSettingsStore, sweep };
}

beforeEach(() => { vi.stubEnv('VITE_MV_APPSTORE', ''); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('leaving Blitz sweeps the deferred docs a tick later', () => {
  it('not in the setter, but once the timers run', async () => {
    const { useSettingsStore, sweep } = await load();
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    expect(sweep).not.toHaveBeenCalled();
    useSettingsStore.setState({ emailRenderer: 'web' });
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('entering Blitz, or a change that stays in it, sweeps nothing', async () => {
    const { useSettingsStore, sweep } = await load();
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    useSettingsStore.setState({ viewStyle: 'chat' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sweep).not.toHaveBeenCalled();
  });
});
