// @vitest-environment jsdom
// The renderers' side of the body scan client (`useBodyScan`): a mounted
// frame keeps its answer however many other bodies are scanned meanwhile,
// and what it frames is what Network Activity counts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

// vitest.setup.js answers every scan at once for the renderers' tests; this is the client itself.
vi.unmock('../bodyScan');

const harness = vi.hoisted(() => ({ daemonCall: vi.fn() }));
vi.mock('../daemonClient', () => ({
  daemonCall: (...args) => harness.daemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));

const { useBodyScan, scanBody, _resetBodyScans } = await import('../bodyScan');
const { useNetActivityStore } = await import('../../stores/netActivityStore');

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
