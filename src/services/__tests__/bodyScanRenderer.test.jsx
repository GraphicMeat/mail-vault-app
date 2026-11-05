// @vitest-environment jsdom
// The renderers' side of the body scan client (`useBodyScan`): a mounted
// frame keeps its answer however many other bodies are scanned meanwhile,
// and what it frames is what Network Activity counts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

// vitest.setup.js answers every scan at once for the renderers' tests; this is the client itself.
vi.unmock('../bodyScan');

const harness = vi.hoisted(() => ({ daemonCall: vi.fn() }));
vi.mock('../daemonClient', () => ({
  daemonCall: (...args) => harness.daemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));

const { useBodyScan, scanBody, allowExternalContent, SETTINGS_WAIT_MS, _resetBodyScans } = await import('../bodyScan');
const { useNetActivityStore } = await import('../../stores/netActivityStore');
const { useSettingsStore } = await import('../../stores/settingsStore');

const BEACON = '<p>hi</p><img src="https://u1.ct.sendgrid.net/wf/open?upn=abc" width="1" height="1">';

beforeEach(() => {
  _resetBodyScans();
  harness.daemonCall.mockReset();
  harness.daemonCall.mockImplementation(async (_method, p) => {
    const found = p.html.includes('sendgrid');
    return { trackers: found ? [{ vendor: 'SendGrid', url: 'https://u1.ct.sendgrid.net/wf/open?upn=abc' }] : [], count: found ? 1 : 0, https: found ? 1 : 0, summary: null, html: null, alerts: null, maxAlertLevel: null };
  });
  useNetActivityStore.setState({ remoteImages: { blocked: 0, loaded: 0 } });
});

describe('useBodyScan', () => {
  it('keeps framing its answer after 500 other bodies push it out of the cache', async () => {
    const { result, rerender } = renderHook(() => useBodyScan(BEACON, { key: 'a-INBOX-1' }));
    await waitFor(() => expect(result.current?.scanned).toBe(true));
    const first = result.current;
    await act(async () => {
      for (let i = 0; i < 520; i++) await scanBody(`<p>${i}</p>`, { key: `b-INBOX-${i}` });
    });
    rerender();
    expect(result.current).toBe(first);
  });

  it('counts the frame it draws once for Network Activity', async () => {
    const { result, rerender } = renderHook(() => useBodyScan(BEACON, { key: 'a-INBOX-2' }));
    await waitFor(() => expect(result.current?.scanned).toBe(true));
    rerender();
    await act(async () => { await Promise.resolve(); });
    expect(useNetActivityStore.getState().remoteImages).toEqual({ blocked: 0, loaded: 1 });
  });
});

describe('useBodyScan with external content held back', () => {
  const settle = () => act(async () => { await Promise.resolve(); });
  beforeEach(() => useSettingsStore.setState({ holdExternalContent: true }));
  afterEach(() => useSettingsStore.setState({ holdExternalContent: false }));

  it('Network Activity counts nothing as loaded until the user takes the load', async () => {
    const { result } = renderHook(() => useBodyScan(BEACON, { key: 'a-INBOX-3' }));
    await waitFor(() => expect(result.current?.holding).toBe(true));
    await settle();
    expect(useNetActivityStore.getState().remoteImages).toEqual({ blocked: 0, loaded: 0 });

    act(() => allowExternalContent(result.current.holdKey));
    await waitFor(() => expect(result.current.holding).toBe(false));
    await settle();
    expect(useNetActivityStore.getState().remoteImages).toEqual({ blocked: 0, loaded: 1 });
  });

  it('a re-render keeps the object: a frame memoizes on it and a new one reloads', async () => {
    const { result, rerender } = renderHook(() => useBodyScan(BEACON, { key: 'a-INBOX-4' }));
    await waitFor(() => expect(result.current?.holding).toBe(true));
    const held = result.current;
    rerender();
    expect(result.current).toBe(held);
  });

  it('the setting off hands back the scan itself', async () => {
    useSettingsStore.setState({ holdExternalContent: false });
    const { result } = renderHook(() => useBodyScan(BEACON, { key: 'a-INBOX-5' }));
    await waitFor(() => expect(result.current?.scanned).toBe(true));
    expect(result.current.holding).toBeFalsy();
    expect(result.current).toBe(await scanBody(BEACON, { key: 'a-INBOX-5' }));
  });

  // A detached window (the pop-out, a quoted original) gets its body by event
  // and reads the settings over an async RPC: framed before they arrive, a body
  // loads under the default, and the images have fired by the time "on" lands.
  describe('in a window whose settings are not read yet', () => {
    let finishHydration;
    beforeEach(() => {
      useSettingsStore.setState({ holdExternalContent: false });
      vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(false);
      vi.spyOn(useSettingsStore.persist, 'onFinishHydration').mockImplementation((cb) => {
        finishHydration = cb;
        return () => { finishHydration = null; };
      });
    });
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

    it('frames nothing until they are, then holds if they say so', async () => {
      const { result } = renderHook(() => useBodyScan(BEACON, { key: 'a-INBOX-6' }));
      await act(async () => { await scanBody(BEACON, { key: 'a-INBOX-6' }); });
      expect(result.current).toBeUndefined();

      act(() => {
        useSettingsStore.setState({ holdExternalContent: true });
        finishHydration();
      });

      expect(result.current.holding).toBe(true);
    });

    it('a read that never finishes does not leave the frame blank for ever', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useBodyScan(BEACON, { key: 'a-INBOX-7' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(SETTINGS_WAIT_MS - 1000); });
      expect(result.current).toBeUndefined();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(result.current?.scanned).toBe(true);
    });

    it('a window already past it frames at once', async () => {
      useSettingsStore.persist.hasHydrated.mockReturnValue(true);
      const { result } = renderHook(() => useBodyScan(BEACON, { key: 'a-INBOX-8' }));
      await waitFor(() => expect(result.current?.scanned).toBe(true));
      expect(useSettingsStore.persist.onFinishHydration).not.toHaveBeenCalled();
    });
  });
});
