// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

let statusReply;
let progress = null;
const rebuild = vi.fn();
vi.mock('../../../services/searchIndex', () => ({
  status: () => Promise.resolve(statusReply),
  rebuild: (...args) => rebuild(...args),
  onProgress: async (cb) => { progress = cb; return () => { progress = null; }; },
}));

import { SearchIndexSettings } from '../SearchIndexSettings';
import { useSettingsStore } from '../../../stores/settingsStore';
import { formatBytes } from '../../../utils/formatBytes';

const statusText = () => screen.getByTestId('search-index-status').textContent;

beforeEach(() => {
  statusReply = { available: true, state: 'indexing', indexed: 12, total: 40, sizeBytes: 2048, complete: false };
  progress = null;
  rebuild.mockReset().mockResolvedValue(undefined);
  useSettingsStore.setState({ searchIndexBodies: true });
});
afterEach(cleanup);

describe('Search index settings', () => {
  it('shows how much is indexed, its size, and a progress bar while indexing', async () => {
    render(<SearchIndexSettings />);
    await waitFor(() => expect(statusText()).toBe(`12 / 40 indexed · ${formatBytes(2048)}`));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30');
  });

  it('turns message bodies off and on', async () => {
    render(<SearchIndexSettings />);
    const toggle = screen.getByTestId('search-index-bodies');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().searchIndexBodies).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().searchIndexBodies).toBe(true);
    await waitFor(() => screen.getByTestId('search-index-status'));
  });

  it('rebuilds the index on request', async () => {
    render(<SearchIndexSettings />);
    await waitFor(() => screen.getByTestId('search-index-status'));
    fireEvent.click(screen.getByTestId('search-index-rebuild'));
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('says so when the index is unavailable', async () => {
    statusReply = { available: false };
    render(<SearchIndexSettings />);
    expect(await screen.findByText(/The index is not available right now/)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByTestId('search-index-status')).toBeNull();
  });

  it('follows progress events', async () => {
    render(<SearchIndexSettings />);
    await waitFor(() => expect(statusText()).toContain('12 / 40'));
    act(() => progress({ available: true, state: 'idle', indexed: 40, total: 40, sizeBytes: 4096, complete: true }));
    expect(statusText()).toBe(`40 / 40 indexed · ${formatBytes(4096)}`);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
