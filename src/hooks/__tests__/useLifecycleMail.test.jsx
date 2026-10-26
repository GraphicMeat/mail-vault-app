// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  lifecycleSync: vi.fn().mockResolvedValue({ rows: [] }),
  lifecycleMarkSeen: vi.fn().mockResolvedValue({ rows: [] }),
  lifecycleDismiss: vi.fn().mockResolvedValue({ rows: [] }),
}));

const api = await import('../../services/api');
const { useMailStore } = await import('../../stores/mailStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { useLifecycleStore } = await import('../../stores/lifecycleStore');
const { useLifecycleMail, FOCUS_GAP_MS } = await import('../useLifecycleMail');

function Probe() { useLifecycleMail(); return null; }
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
  await useSettingsStore.persist.rehydrate();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useMailStore.setState({ selectedEmailId: null });
  useLifecycleStore.setState({ rows: [], openId: null, lastSyncAt: 0 });
  api.lifecycleSync.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('useLifecycleMail', () => {
  it('asks the daemon once when the app starts', async () => {
    render(<Probe />);
    await flush();
    expect(api.lifecycleSync).toHaveBeenCalledTimes(1);
  });

  it('asks again when billing changes, since that is what decides most messages', async () => {
    render(<Probe />);
    await flush();
    act(() => { useSettingsStore.setState({ billingProfile: { premiumAccess: true, hasSubscription: true, status: 'trialing' } }); });
    await flush();
    expect(api.lifecycleSync).toHaveBeenCalledTimes(2);
  });

  it('asks again when the messages are switched on or off, and when onboarding ends', async () => {
    render(<Probe />);
    await flush();
    act(() => { useSettingsStore.setState({ lifecycleMessages: false }); });
    await flush();
    act(() => { useSettingsStore.setState({ lifecycleMessages: true, onboardingComplete: true }); });
    await flush();
    // Off answers locally without asking, so only the start and the switch back on ask.
    expect(api.lifecycleSync.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('on a window focus leaves a fresh answer alone and refreshes a stale one', async () => {
    render(<Probe />);
    await flush();
    api.lifecycleSync.mockClear();

    act(() => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(api.lifecycleSync).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + FOCUS_GAP_MS + 1000);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(api.lifecycleSync).toHaveBeenCalledTimes(1);
  });

  it('closes an open message when the user opens a real email', async () => {
    useLifecycleStore.setState({ rows: [{ id: 'free-nudge', kind: 'free-nudge', atMs: 1, seen: true, dismissed: false }], openId: 'free-nudge' });
    api.lifecycleSync.mockResolvedValue({ rows: [{ id: 'free-nudge', kind: 'free-nudge', atMs: 1, seen: true, dismissed: false }] });
    render(<Probe />);
    await flush();
    expect(useLifecycleStore.getState().openId).toBe('free-nudge');
    act(() => { useMailStore.setState({ selectedEmailId: 'a1:INBOX:5' }); });
    expect(useLifecycleStore.getState().openId).toBeNull();
  });

  it('stops listening when it unmounts', async () => {
    const { unmount } = render(<Probe />);
    await flush();
    unmount();
    api.lifecycleSync.mockClear();
    vi.setSystemTime(Date.now() + FOCUS_GAP_MS + 1000);
    window.dispatchEvent(new Event('focus'));
    useSettingsStore.setState({ billingProfile: { premiumAccess: false } });
    await flush();
    expect(api.lifecycleSync).not.toHaveBeenCalled();
  });
});
