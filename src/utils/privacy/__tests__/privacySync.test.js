// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { emit, listen } = vi.hoisted(() => ({ emit: vi.fn(() => Promise.resolve()), listen: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit, listen }));
vi.mock('../../../stores/safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  flushSafeStorage: () => Promise.resolve(),
}));

import { usePrivacyStore } from '../../../stores/privacyStore';
import { startPrivacySync } from '../privacySync';

const tick = () => new Promise(r => setTimeout(r, 0));
const setUrl = (search) => window.history.replaceState({}, '', `/${search}`);

beforeEach(() => {
  usePrivacyStore.setState({ enabled: false, peek: false, captureMask: false });
  emit.mockClear();
  listen.mockReset();
});
afterEach(() => setUrl(''));

describe('startPrivacySync in the main window', () => {
  it('emits on every enabled change, nothing for peek or captureMask, nothing after cleanup', async () => {
    const stop = startPrivacySync();
    await tick();
    usePrivacyStore.setState({ enabled: true });
    expect(emit).toHaveBeenCalledWith('privacy-mode-changed', { enabled: true });
    emit.mockClear();
    usePrivacyStore.setState({ peek: true });
    usePrivacyStore.setState({ captureMask: true });
    expect(emit).not.toHaveBeenCalled();
    stop();
    usePrivacyStore.setState({ enabled: false });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('startPrivacySync in a detached window', () => {
  beforeEach(() => setUrl('?compose=1'));

  it('applies a received payload and drops peek', async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    usePrivacyStore.setState({ peek: true });
    const stop = startPrivacySync();
    await tick();
    expect(listen).toHaveBeenCalledWith('privacy-mode-changed', expect.any(Function));
    listen.mock.calls[0][1]({ payload: { enabled: true } });
    expect(usePrivacyStore.getState()).toMatchObject({ enabled: true, peek: false });
    stop();
    expect(unlisten).toHaveBeenCalled();
  });

  it('registers no listener when cleaned up before the event module loads', async () => {
    startPrivacySync()();
    await tick();
    expect(listen).not.toHaveBeenCalled();
  });

  it('detaches a listener that registers after cleanup (StrictMode double effect)', async () => {
    const unlisten = vi.fn();
    let resolve;
    listen.mockReturnValue(new Promise(r => { resolve = r; }));
    const stop = startPrivacySync();
    await tick();
    expect(listen).toHaveBeenCalledTimes(1);
    stop();
    resolve(unlisten);
    await tick();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
