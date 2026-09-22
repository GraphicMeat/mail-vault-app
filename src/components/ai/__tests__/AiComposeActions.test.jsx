// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { AiComposeActions } from '../AiComposeActions';

vi.mock('../../../services/daemonClient', () => ({ daemonCall: vi.fn() }));
import { daemonCall } from '../../../services/daemonClient';

afterEach(cleanup);

describe('AiComposeActions', () => {
  beforeEach(() => {
    daemonCall.mockReset();
    useSettingsStore.setState({
      aiSettings: { enabled: false, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false },
    });
  });

  it('disables every action, with a reason, when AI features are off', () => {
    render(<AiComposeActions actions={['shorten']} getDraftText={() => 'draft'} onResult={() => {}} />);
    const button = screen.getByText('Shorten');
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/turn on ai features/i);
    expect(daemonCall).not.toHaveBeenCalled();
  });

  it('never calls generate before the preview is confirmed', async () => {
    useSettingsStore.setState({ aiSettings: { enabled: true, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false } });
    daemonCall.mockImplementation((method) => {
      if (method === 'ai.providers') return Promise.resolve([{ provider: 'localGguf', available: true, reason: '' }]);
      return Promise.resolve({ text: 'Shortened.' });
    });
    const onResult = vi.fn();
    render(<AiComposeActions actions={['shorten']} getDraftText={() => 'a long draft'} onResult={onResult} />);

    await waitFor(() => expect(screen.getByText('Shorten').disabled).toBe(false));
    fireEvent.click(screen.getByText('Shorten'));

    // The preview is open; generate must not have run yet.
    expect(screen.getByTestId('ai-preview-text').textContent).toContain('a long draft');
    expect(daemonCall).not.toHaveBeenCalledWith('ai.generate', expect.anything());

    fireEvent.click(screen.getByTestId('ai-preview-confirm'));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('shorten', 'Shortened.'));
  });

  it('treats an empty generation as a failure — never wipes the draft', async () => {
    useSettingsStore.setState({ aiSettings: { enabled: true, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false } });
    daemonCall.mockImplementation((method) => {
      if (method === 'ai.providers') return Promise.resolve([{ provider: 'localGguf', available: true, reason: '' }]);
      return Promise.resolve({ text: '   ' });
    });
    const onResult = vi.fn();
    render(<AiComposeActions actions={['shorten']} getDraftText={() => 'a long draft'} onResult={onResult} />);

    await waitFor(() => expect(screen.getByText('Shorten').disabled).toBe(false));
    fireEvent.click(screen.getByText('Shorten'));
    fireEvent.click(screen.getByTestId('ai-preview-confirm'));

    await waitFor(() => expect(screen.getByText("Couldn't generate a suggestion")).toBeTruthy());
    expect(onResult).not.toHaveBeenCalled();
    // The preview stays open so the user can retry or cancel, same as a real failure.
    expect(screen.getByTestId('ai-preview-text')).toBeTruthy();
  });

  it('disables an action when the provider reports unavailable', async () => {
    useSettingsStore.setState({ aiSettings: { enabled: true, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false } });
    daemonCall.mockResolvedValue([{ provider: 'localGguf', available: false, reason: 'no model downloaded' }]);
    render(<AiComposeActions actions={['shorten']} getDraftText={() => 'draft'} onResult={() => {}} />);
    await waitFor(() => expect(screen.getByText('Shorten').disabled).toBe(true));
  });
});
