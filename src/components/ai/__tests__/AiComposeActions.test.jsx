// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useMailStore } from '../../../stores/mailStore';
import { AiComposeActions } from '../AiComposeActions';

vi.mock('../../../services/daemonClient', () => ({ daemonCall: vi.fn() }));
import { daemonCall } from '../../../services/daemonClient';

afterEach(cleanup);

describe('AiComposeActions', () => {
  beforeEach(() => {
    daemonCall.mockReset();
    useMailStore.setState({ accounts: [
      { id: 'plain', email: 'd@fastmail.com', authType: 'password', imapHost: 'imap.fastmail.com' },
      { id: 'gmail', email: 'a@gmail.com', authType: 'oauth2', oauth2Provider: 'google', imapHost: 'imap.gmail.com' },
    ], activeAccountId: 'plain' });
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

  it('runs straight away with the preview turned off, on-device', async () => {
    useSettingsStore.setState({ aiSettings: { enabled: true, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false, skipPreview: true } });
    daemonCall.mockImplementation((method) => {
      if (method === 'ai.providers') return Promise.resolve([{ provider: 'localGguf', available: true, reason: '' }]);
      return Promise.resolve({ text: 'Shortened.' });
    });
    const onResult = vi.fn();
    render(<AiComposeActions actions={['shorten']} getDraftText={() => 'a long draft'} onResult={onResult} />);

    await waitFor(() => expect(screen.getByText('Shorten').disabled).toBe(false));
    fireEvent.click(screen.getByText('Shorten'));
    expect(screen.queryByTestId('ai-preview-text')).toBeNull();
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('shorten', 'Shortened.'));
  });

  it('still previews once for an endpoint never consented to, even with the preview off', async () => {
    useSettingsStore.setState({ aiSettings: { enabled: true, provider: 'endpoint', endpointUrl: 'http://h/v1', endpointModel: 'm', endpointConsented: false, skipPreview: true } });
    daemonCall.mockImplementation((method) => {
      if (method === 'ai.providers') return Promise.resolve([{ provider: 'endpoint', available: true, reason: '' }]);
      return Promise.resolve({ text: 'Shortened.' });
    });
    render(<AiComposeActions actions={['shorten']} accountIds={['plain']} getDraftText={() => 'a long draft'} onResult={() => {}} />);

    await waitFor(() => expect(screen.getByText('Shorten').disabled).toBe(false));
    fireEvent.click(screen.getByText('Shorten'));
    expect(screen.getByTestId('ai-preview-text')).toBeTruthy();
    expect(daemonCall).not.toHaveBeenCalledWith('ai.generate', expect.anything());
  });

  it('tells the daemon whose mail it is sending', async () => {
    useSettingsStore.setState({ aiSettings: { enabled: true, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false, skipPreview: true } });
    daemonCall.mockImplementation((method) => {
      if (method === 'ai.providers') return Promise.resolve([{ provider: 'localGguf', available: true, reason: '' }]);
      return Promise.resolve({ text: 'Shortened.' });
    });
    render(<AiComposeActions actions={['shorten']} accountIds={['plain', 'gmail']} getDraftText={() => 'a long draft'} onResult={() => {}} />);

    await waitFor(() => expect(screen.getByText('Shorten').disabled).toBe(false));
    fireEvent.click(screen.getByText('Shorten'));
    await waitFor(() => expect(daemonCall).toHaveBeenCalledWith('ai.generate', expect.objectContaining({ accountIds: ['plain', 'gmail'] })));
  });

  describe('Gmail mail only goes to on-device AI', () => {
    const CLOUD = { enabled: true, provider: 'endpoint', endpointUrl: 'https://api.openai.com/v1', endpointModel: 'gpt', endpointConsented: true, skipPreview: true };
    const providers = (...available) => (method) => {
      if (method === 'ai.providers') {
        return Promise.resolve(['appleFm', 'localGguf', 'endpoint'].map(provider => ({ provider, available: available.includes(provider), reason: '' })));
      }
      return Promise.resolve({ text: 'Shortened.' });
    };

    it('uses Apple Intelligence instead of the chosen cloud endpoint for a Gmail account', async () => {
      useSettingsStore.setState({ aiSettings: CLOUD });
      daemonCall.mockImplementation(providers('appleFm', 'endpoint'));
      const onResult = vi.fn();
      render(<AiComposeActions actions={['shorten']} accountIds={['gmail']} getDraftText={() => 'a long draft'} onResult={onResult} />);

      await waitFor(() => expect(screen.getByText('Shorten').disabled).toBe(false));
      fireEvent.click(screen.getByText('Shorten'));
      await waitFor(() => expect(onResult).toHaveBeenCalledWith('shorten', 'Shortened.'));
      const [, params] = daemonCall.mock.calls.find(([method]) => method === 'ai.generate');
      expect(params.provider).toEqual({ type: 'appleFm' });
      expect(params.accountIds).toEqual(['gmail']);
    });

    it('falls back to the downloaded model when Apple Intelligence is not available', async () => {
      useSettingsStore.setState({ aiSettings: CLOUD });
      daemonCall.mockImplementation(providers('localGguf', 'endpoint'));
      render(<AiComposeActions actions={['shorten']} accountIds={['plain', 'gmail']} getDraftText={() => 'a long draft'} onResult={() => {}} />);

      await waitFor(() => expect(screen.getByText('Shorten').disabled).toBe(false));
      fireEvent.click(screen.getByText('Shorten'));
      await waitFor(() => expect(daemonCall).toHaveBeenCalledWith('ai.generate', expect.objectContaining({ provider: { type: 'localGguf' } })));
    });

    it('names where the text goes in the preview: this device, not the cloud endpoint', async () => {
      useSettingsStore.setState({ aiSettings: { ...CLOUD, skipPreview: false } });
      daemonCall.mockImplementation(providers('appleFm', 'endpoint'));
      render(<AiComposeActions actions={['shorten']} accountIds={['gmail']} getDraftText={() => 'a long draft'} onResult={() => {}} />);

      await waitFor(() => expect(screen.getByText('Shorten').disabled).toBe(false));
      fireEvent.click(screen.getByText('Shorten'));
      expect(screen.getByText('Sent to: This device')).toBeTruthy();
      expect(screen.queryByText(/api\.openai\.com/)).toBeNull();
    });

    it('shows the refusal, offers nothing and sends nothing when no on-device provider is available', async () => {
      useSettingsStore.setState({ aiSettings: CLOUD });
      daemonCall.mockImplementation(providers('endpoint'));
      render(<AiComposeActions actions={['shorten']} accountIds={['gmail']} getDraftText={() => 'a long draft'} onResult={() => {}} />);

      expect((await screen.findByTestId('ai-google-refusal')).textContent).toMatch(/only processed by on-device AI/);
      expect(screen.getByText('Shorten').disabled).toBe(true);
      expect(daemonCall).not.toHaveBeenCalledWith('ai.generate', expect.anything());
    });

    it('keeps the cloud endpoint for a non-Google account', async () => {
      useSettingsStore.setState({ aiSettings: CLOUD });
      daemonCall.mockImplementation(providers('appleFm', 'endpoint'));
      render(<AiComposeActions actions={['shorten']} accountIds={['plain']} getDraftText={() => 'a long draft'} onResult={() => {}} />);

      await waitFor(() => expect(screen.getByText('Shorten').disabled).toBe(false));
      fireEvent.click(screen.getByText('Shorten'));
      await waitFor(() => expect(daemonCall).toHaveBeenCalledWith('ai.generate', expect.objectContaining({
        provider: expect.objectContaining({ type: 'endpoint', url: 'https://api.openai.com/v1' }),
        accountIds: ['plain'],
      })));
      expect(screen.queryByTestId('ai-google-refusal')).toBeNull();
    });
  });
});
