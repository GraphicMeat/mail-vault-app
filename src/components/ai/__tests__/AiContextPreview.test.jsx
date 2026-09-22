// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { AiContextPreview, destinationLabel } from '../AiContextPreview';

afterEach(cleanup);

describe('destinationLabel', () => {
  it('names the endpoint URL for a non-local provider', () => {
    expect(destinationLabel({ type: 'endpoint', url: 'http://localhost:11434/v1' })).toBe('http://localhost:11434/v1');
  });

  it('names "this device" for an on-device provider', () => {
    expect(destinationLabel({ type: 'localGguf' })).toBe('This device');
    expect(destinationLabel({ type: 'appleFm' })).toBe('This device');
  });
});

describe('AiContextPreview', () => {
  it('shows the exact text that will be sent', () => {
    render(
      <AiContextPreview open text="Subject: Hi\n\nExact prompt text" provider={{ type: 'localGguf' }}
        onConfirm={() => {}} onCancel={() => {}} />
    );
    expect(screen.getByTestId('ai-preview-text').textContent).toContain('Exact prompt text');
  });

  it('does not call onConfirm until the user clicks confirm', () => {
    const onConfirm = vi.fn();
    render(
      <AiContextPreview open text="hello" provider={{ type: 'endpoint', url: 'http://x.test' }}
        onConfirm={onConfirm} onCancel={() => {}} />
    );
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('ai-preview-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('warns that the text leaves the device only for a non-local provider', () => {
    const { rerender } = render(
      <AiContextPreview open text="hello" provider={{ type: 'localGguf' }} onConfirm={() => {}} onCancel={() => {}} />
    );
    expect(screen.queryByText(/leave your device/i)).toBeNull();

    rerender(
      <AiContextPreview open text="hello" provider={{ type: 'endpoint', url: 'http://x.test' }} onConfirm={() => {}} onCancel={() => {}} />
    );
    expect(screen.getByText(/leave your device/i)).toBeTruthy();
  });

  it('renders nothing when closed', () => {
    render(<AiContextPreview open={false} text="hello" provider={{ type: 'localGguf' }} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByTestId('ai-preview-text')).toBeNull();
  });
});
