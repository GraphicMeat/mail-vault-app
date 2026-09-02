// @vitest-environment jsdom
//
// The banner is the only surface that says "no internet" for the whole app.
// It has to appear on the verdict, say the mail is still readable, and — the
// part a modal would get wrong — leave on its own when the network returns.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

const mockDaemonCall = vi.fn();
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...args) => mockDaemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));

const { OfflineBanner } = await import('../OfflineBanner');
const { useConnectivityStore, __resetConnectivityForTests } = await import('../../stores/connectivityStore');

const BANNER = 'offline-banner';

beforeEach(() => {
  __resetConnectivityForTests();
  mockDaemonCall.mockReset();
});
afterEach(cleanup);

describe('OfflineBanner', () => {
  it('stays out of the way while online', () => {
    render(<OfflineBanner />);
    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it('appears when the verdict goes offline', () => {
    render(<OfflineBanner />);
    act(() => useConnectivityStore.getState().setOnline(false));
    expect(screen.getByTestId(BANNER)).toBeTruthy();
  });

  // The whole argument for a banner over a modal: the archive is on disk, so
  // losing the network must never read as losing the mail.
  it('says the saved mail is still readable', () => {
    render(<OfflineBanner />);
    act(() => useConnectivityStore.getState().setOnline(false));
    expect(screen.getByTestId(BANNER).textContent).toMatch(/still here/i);
  });

  it('disappears on its own when connectivity comes back', async () => {
    render(<OfflineBanner />);
    act(() => useConnectivityStore.getState().setOnline(false));
    expect(screen.getByTestId(BANNER)).toBeTruthy();

    // No click: this is what the daemon's heartbeat does 30s later.
    act(() => useConnectivityStore.getState().setOnline(true));
    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it('re-probes when asked, and clears itself if the probe succeeds', async () => {
    mockDaemonCall.mockResolvedValue({ online: true });
    render(<OfflineBanner />);
    act(() => useConnectivityStore.getState().setOnline(false));

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(mockDaemonCall).toHaveBeenCalledWith('net.probe');
    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it('keeps the banner up when the re-probe still finds nothing', async () => {
    mockDaemonCall.mockResolvedValue({ online: false });
    render(<OfflineBanner />);
    act(() => useConnectivityStore.getState().setOnline(false));

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(screen.getByTestId(BANNER)).toBeTruthy();
  });
});
