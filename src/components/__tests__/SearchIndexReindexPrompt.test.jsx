// @vitest-environment jsdom
//
// After an update, mail indexed or listed by the older build lacks the header
// fields the new one stores (sender verification, list headers), so its search
// results and archived list rows cannot show the shield, the sender logo or
// Unsubscribe. The app asks once whether to rebuild the index; yes rebuilds
// (the daemon parses the list rows again with it), no leaves everything as it is.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../../services/searchIndex', () => ({ rebuild: vi.fn().mockResolvedValue(null) }));
vi.mock('../../services/daemonClient', () => ({ daemonCall: vi.fn().mockResolvedValue(null) }));
const { rebuild } = await import('../../services/searchIndex');
const { daemonCall } = await import('../../services/daemonClient');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { SearchIndexReindexPrompt } = await import('../SearchIndexReindexPrompt');

const offer = (extra = {}) => useSettingsStore.setState({
  searchIndexReindexOffer: true, searchIndexEnabled: true, onboardingComplete: true, ...extra,
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); useSettingsStore.setState({ searchIndexReindexOffer: false }); });

describe('SearchIndexReindexPrompt', () => {
  it('explains the rebuild and runs it on yes, then never asks again', async () => {
    offer();
    render(<SearchIndexReindexPrompt />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toMatch(/search index/i);
    expect(dialog.textContent).toMatch(/SPF, DKIM and DMARC/);
    expect(dialog.textContent).toMatch(/message list/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /rebuild now/i })); });
    expect(rebuild).toHaveBeenCalledTimes(1);
    // The rebuild itself parses the list rows again; no second call.
    expect(daemonCall).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().searchIndexReindexOffer).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('does nothing on no, and never asks again', () => {
    offer();
    render(<SearchIndexReindexPrompt />);
    // The footer button; the corner X carries the same label and does the same.
    fireEvent.click(screen.getByText(/not now/i, { selector: 'button' }));
    expect(rebuild).not.toHaveBeenCalled();
    expect(daemonCall).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().searchIndexReindexOffer).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks nothing on a new install', () => {
    useSettingsStore.setState({ searchIndexReindexOffer: false, searchIndexEnabled: true, onboardingComplete: true });
    render(<SearchIndexReindexPrompt />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('waits until onboarding is done', () => {
    offer({ onboardingComplete: false });
    render(<SearchIndexReindexPrompt />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useSettingsStore.getState().searchIndexReindexOffer).toBe(true);
  });

  it('drops the offer without asking when the index is off, and has the list rows parsed again', () => {
    offer({ searchIndexEnabled: false });
    render(<SearchIndexReindexPrompt />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // Turning the index on builds it fresh; only the list rows are stale.
    expect(rebuild).not.toHaveBeenCalled();
    expect(daemonCall).toHaveBeenCalledTimes(1);
    expect(daemonCall).toHaveBeenCalledWith('vault_reparse_rows', {});
    expect(useSettingsStore.getState().searchIndexReindexOffer).toBe(false);
  });
});
