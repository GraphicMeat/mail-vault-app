// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  motion: { div: React.forwardRef((props, ref) => React.createElement('div', { ...props, ref })) },
  AnimatePresence: ({ children }) => children,
}));
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : (props) => React.createElement('span', { 'data-icon': String(name), ...props })),
  has: () => true,
}));
vi.mock('../../../services/daemonClient', () => ({ daemonCall: vi.fn(), DaemonError: class DaemonError extends Error {} }));

const { daemonCall } = await import('../../../services/daemonClient');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { AiProvidersSettings } = await import('../AiProvidersSettings');

const SETTINGS = { enabled: true, provider: 'endpoint', endpointUrl: 'https://api.openai.com/v1', endpointModel: 'gpt', endpointConsented: true, skipPreview: true };

beforeEach(() => {
  daemonCall.mockReset();
  daemonCall.mockResolvedValue({ text: 'Got it.' });
  useSettingsStore.setState({ aiSettings: SETTINGS });
});
afterEach(cleanup);

describe('AiProvidersSettings', () => {
  it('says Gmail accounts always use on-device AI, next to the provider choice', () => {
    render(<AiProvidersSettings />);
    expect(screen.getByTestId('ai-settings-google-on-device').textContent).toBe('Gmail accounts always use on-device AI.');
  });

  it('sends the connection test to a cloud endpoint as a prompt that holds no mail', async () => {
    render(<AiProvidersSettings />);
    fireEvent.click(screen.getByText('Send test message'));
    await waitFor(() => expect(daemonCall).toHaveBeenCalledWith('ai.generate', expect.objectContaining({ noMailContent: true })));
    const [, params] = daemonCall.mock.calls.find(([method]) => method === 'ai.generate');
    expect(params.accountIds).toBeUndefined();
    expect(params.provider).toMatchObject({ type: 'endpoint', url: 'https://api.openai.com/v1' });
  });
});
