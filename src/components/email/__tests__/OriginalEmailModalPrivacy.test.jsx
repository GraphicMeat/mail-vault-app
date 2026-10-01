// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { OriginalEmailModal } from '../OriginalEmailModal';
import { usePrivacyStore } from '../../../stores/privacyStore';

const email = { uid: 1, from: { name: 'Ada Lovelace', address: 'ada@example.com' }, to: [], subject: 'Secret plans', text: 'Body of the plans', attachments: [] };
afterEach(() => { cleanup(); usePrivacyStore.setState({ enabled: false }); });

describe('OriginalEmailModal under privacy mode', () => {
  it('shows a notice instead of the headers and text', () => {
    usePrivacyStore.setState({ enabled: true });
    render(<OriginalEmailModal email={email} onClose={() => {}} />);
    expect(screen.getByTestId('privacy-source-blocked')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Ada Lovelace|ada@example|Secret plans|Body of the plans/);
  });
  it('control: shows the message with privacy off', () => {
    render(<OriginalEmailModal email={email} onClose={() => {}} />);
    expect(document.body.textContent).toContain('Body of the plans');
  });
});
