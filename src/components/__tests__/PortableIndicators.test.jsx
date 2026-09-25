// @vitest-environment jsdom
//
// A copy running from a drive says so in the sidebar, and says so loudly when
// the drive goes away under it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';

vi.mock('../../services/daemonClient', () => ({
  daemonCall: vi.fn(() => new Promise(() => {})),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('../../services/workflows/retryKeychainAccess', () => ({ retryKeychainAccess: vi.fn(() => Promise.resolve(true)) }));

const { PortableBadge, PortableDriveBanner } = await import('../PortableIndicators');
const { usePortableStore, __resetPortableForTests } = await import('../../stores/portableStore');

beforeEach(() => __resetPortableForTests());
afterEach(cleanup);

describe('Portable indicators', () => {
  it('shows nothing in an installed copy', () => {
    render(<><PortableBadge /><PortableDriveBanner /></>);
    expect(screen.queryByTestId('portable-badge')).toBeNull();
    expect(screen.queryByTestId('portable-disconnected')).toBeNull();
  });

  it('badges a copy running from a drive, naming the drive', () => {
    render(<PortableBadge />);
    act(() => usePortableStore.getState().apply({ portable: true, locked: false, drive: '/Volumes/USB' }));
    expect(screen.getByTestId('portable-badge').getAttribute('title')).toContain('/Volumes/USB');
  });

  it('raises a banner when the drive is disconnected', () => {
    render(<PortableDriveBanner />);
    act(() => usePortableStore.getState().apply({ portable: true, locked: false, drive: '/Volumes/USB', disconnected: false }));
    expect(screen.queryByTestId('portable-disconnected')).toBeNull();
    act(() => usePortableStore.getState().apply({ portable: true, locked: false, drive: '/Volumes/USB', disconnected: true }));
    expect(screen.getByTestId('portable-disconnected').getAttribute('role')).toBe('alert');
  });
});
