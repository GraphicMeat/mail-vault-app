// @vitest-environment jsdom
//
// The update dialog lists what changed since the installed version, read from
// the GitHub releases by the daemon. Sparkle's appcast carries no notes, so on
// macOS the feed's own `notes` is usually empty: the releases are the content.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { version as currentVersion } from '../../../package.json';

vi.mock('../../services/daemonClient', () => ({
  daemonCall: vi.fn(),
  DaemonError: class DaemonError extends Error {},
}));

const { daemonCall } = await import('../../services/daemonClient');
const { UpdateModal } = await import('../UpdateModal');
const { useSettingsStore } = await import('../../stores/settingsStore');

// Real release bodies come from GitHub with CRLF line ends.
const RELEASES = [
  { version: '2.16.0', name: 'MailVault v2.16.0', publishedAt: '2026-09-25T13:45:06Z',
    body: '### Added\r\n- **Windows.** MailVault runs on Windows.\r\n### Fixed\r\n- **Search.** Finds mail again.' },
  { version: '2.15.0', name: 'MailVault v2.15.0', publishedAt: '2026-09-20T19:34:56Z',
    body: '### Fixed\r\n- **Backup.** Resumes after sleep.' },
];

const openModal = (updateInfo = { version: '2.16.0', notes: '' }) =>
  render(<UpdateModal updateInfo={updateInfo} onClose={() => {}} />);

let settingsSnapshot;
beforeEach(() => {
  daemonCall.mockReset();
  settingsSnapshot = useSettingsStore.getState();
  useSettingsStore.setState({ updateTrack: 'stable' });
});
afterEach(() => {
  cleanup();
  useSettingsStore.setState(settingsSnapshot, true);
});

describe('UpdateModal release notes', () => {
  it('asks the daemon for the releases between the installed and the offered version', async () => {
    daemonCall.mockResolvedValue([]);
    openModal();
    await waitFor(() => expect(daemonCall).toHaveBeenCalledWith('app.release_notes',
      { from: currentVersion, to: '2.16.0', includePrereleases: false }));
  });

  it('includes prereleases for someone on the nightly track', async () => {
    useSettingsStore.setState({ updateTrack: 'nightly' });
    daemonCall.mockResolvedValue([]);
    openModal();
    await waitFor(() => expect(daemonCall).toHaveBeenCalledWith('app.release_notes',
      expect.objectContaining({ includePrereleases: true })));
  });

  it('shows every release, one heading per version, inside the scrolling box', async () => {
    daemonCall.mockResolvedValue(RELEASES);
    openModal();
    const box = await screen.findByTestId('update-release-notes');
    await waitFor(() => expect(within(box).getByRole('heading', { name: 'v2.15.0' })).toBeTruthy());
    expect(within(box).getByRole('heading', { name: 'v2.16.0' })).toBeTruthy();
    // CRLF bodies still render their sections as clean headings.
    expect(within(box).getAllByRole('heading').filter(h => h.textContent === 'Fixed')).toHaveLength(2);
    expect(box.textContent).toContain('Resumes after sleep.');
    expect(box.textContent).toContain('Finds mail again.');
    expect(box.className).toContain('overflow-y-auto');
  });

  it('shows a single release without a version heading', async () => {
    daemonCall.mockResolvedValue([RELEASES[0]]);
    openModal();
    await waitFor(() => expect(screen.getByTestId('update-release-notes').textContent).toContain('Finds mail again.'));
    expect(within(screen.getByTestId('update-release-notes')).queryByRole('heading', { name: 'v2.16.0' })).toBeNull();
  });

  it('keeps the feed notes on screen while the releases load', () => {
    daemonCall.mockReturnValue(new Promise(() => {}));
    openModal({ version: '2.16.0', notes: '### Fixed\n- Feed note.' });
    expect(screen.getByTestId('update-release-notes').textContent).toContain('Feed note.');
  });

  it('falls back to the feed notes when the releases cannot be read', async () => {
    daemonCall.mockRejectedValue(new Error('offline'));
    openModal({ version: '2.16.0', notes: '### Fixed\n- Feed note.' });
    await waitFor(() => expect(daemonCall).toHaveBeenCalled());
    expect(screen.getByTestId('update-release-notes').textContent).toContain('Feed note.');
    expect(screen.getByRole('button', { name: 'Update Now' })).toBeTruthy();
  });

  it('shows no notes box when neither the releases nor the feed have any', async () => {
    daemonCall.mockResolvedValue([]);
    openModal();
    await waitFor(() => expect(daemonCall).toHaveBeenCalled());
    expect(screen.queryByTestId('update-release-notes')).toBeNull();
  });
});
