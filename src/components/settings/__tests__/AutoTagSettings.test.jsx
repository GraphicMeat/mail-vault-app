// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  motion: { div: React.forwardRef((props, ref) => React.createElement('div', { ...props, ref })) },
  AnimatePresence: ({ children }) => children,
}));

vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : (props) => React.createElement('span', { 'data-icon': String(name), ...props })),
  has: () => true,
}));

const mockDaemonCall = vi.fn();
vi.mock('../../../services/daemonClient', () => ({
  daemonCall: (...args) => mockDaemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));

const { AutoTagSettings } = await import('../AutoTagSettings');
const { useAutoTagStore } = await import('../../../stores/autoTagStore');
const { useTagStore } = await import('../../../stores/tagStore');
const { useMailStore } = await import('../../../stores/mailStore');

const RECEIPTS_TAG = { id: 't1', name: 'Receipts', color: '', position: 0, count: 0 };

beforeEach(() => {
  mockDaemonCall.mockReset();
  useAutoTagStore.setState({ rules: [], backfills: {} });
  useTagStore.setState({ tags: [RECEIPTS_TAG], byRow: {} });
  useMailStore.setState({ accounts: [{ id: 'a1', email: 'me@example.test' }], activeAccountId: 'a1' });
});

afterEach(cleanup);

describe('AutoTagSettings', () => {
  it('starts a new rule with allowRemote off, and shows no remote-destination copy', () => {
    render(<AutoTagSettings />);
    fireEvent.click(screen.getByText('New rule'));

    const toggle = screen.getByTestId('auto-tag-allow-remote');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // The privacy surface: the destination is only ever named once the
    // toggle is actually on, never as ambient copy beside an off switch.
    expect(screen.queryByTestId('ai-preview-text')).toBeNull();
    expect(screen.queryByText(/This device/i)).toBeNull();
  });

  it('names the destination before allowRemote can be turned on, and only then', () => {
    render(<AutoTagSettings />);
    fireEvent.click(screen.getByText('New rule'));

    fireEvent.click(screen.getByTestId('auto-tag-allow-remote'));
    // Turning it on is not immediate — a confirmation names the destination first.
    expect(screen.getByTestId('ai-preview-text')).toBeTruthy();
    expect(screen.getByText(/This device/i)).toBeTruthy();
    expect(screen.getByTestId('auto-tag-allow-remote').getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByTestId('ai-preview-confirm'));
    expect(screen.getByTestId('auto-tag-allow-remote').getAttribute('aria-checked')).toBe('true');
  });

  it('turning allowRemote back off clears the provider without any confirmation', () => {
    render(<AutoTagSettings />);
    fireEvent.click(screen.getByText('New rule'));
    fireEvent.click(screen.getByTestId('auto-tag-allow-remote'));
    fireEvent.click(screen.getByTestId('ai-preview-confirm'));
    expect(screen.getByTestId('auto-tag-allow-remote').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByTestId('auto-tag-allow-remote'));
    expect(screen.getByTestId('auto-tag-allow-remote').getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByTestId('ai-preview-text')).toBeNull();
  });

  it('previews without ever calling a write RPC, and renders confidence', async () => {
    mockDaemonCall.mockResolvedValueOnce({
      candidates: [
        { accountId: 'a1', mailbox: 'INBOX', uid: 1, subject: 'Your receipt', matched: true, confidence: 0.92, refused: null },
        { accountId: 'a1', mailbox: 'INBOX', uid: 2, subject: 'Newsletter', matched: false, confidence: null, refused: null },
      ],
    });

    render(<AutoTagSettings />);
    fireEvent.click(screen.getByText('New rule'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Receipts' } });
    fireEvent.change(screen.getByLabelText('Rule, in plain English'), { target: { value: 'receipts and invoices' } });

    await fireEvent.click(screen.getByText('Preview'));

    expect(mockDaemonCall).toHaveBeenCalledWith('auto_tags.preview', expect.objectContaining({ accountId: 'a1' }));
    // The only daemon call the whole preview flow makes is auto_tags.preview
    // — nothing that could assign a tag or create/update a rule.
    const calledMethods = mockDaemonCall.mock.calls.map(call => call[0]);
    expect(calledMethods).toEqual(['auto_tags.preview']);

    const results = await screen.findByTestId('auto-tag-preview-results');
    expect(within(results).getByText(/Your receipt/)).toBeTruthy();
    expect(within(results).getByText(/92%/)).toBeTruthy();
    expect(within(results).getByText(/Newsletter/)).toBeTruthy();
  });

  it('clears a preview when the instruction is removed', async () => {
    mockDaemonCall.mockResolvedValueOnce({ candidates: [
      { accountId: 'a1', mailbox: 'INBOX', uid: 1, subject: 'Old match', matched: true, confidence: 0.9 },
    ] });
    render(<AutoTagSettings />);
    fireEvent.click(screen.getByText('New rule'));
    const instruction = screen.getByLabelText('Rule, in plain English');
    fireEvent.change(instruction, { target: { value: 'receipts' } });
    fireEvent.click(screen.getByText('Preview'));
    expect(await screen.findByText('Old match')).toBeTruthy();
    fireEvent.change(instruction, { target: { value: '' } });
    await act(async () => {});
    expect(screen.queryByTestId('auto-tag-preview-results')).toBeNull();
    expect(screen.getByText('Preview').closest('button').disabled).toBe(true);
  });

  it('offers loaded senders in Tom Select for From filters', () => {
    useMailStore.setState({ emails: [{ from: { address: 'sender@example.test' } }] });
    render(<AutoTagSettings />);
    fireEvent.click(screen.getByText('New rule'));
    fireEvent.click(screen.getByText('Narrow it down (optional)'));
    const address = document.querySelector('select[aria-label="From address"]');
    const domain = document.querySelector('select[aria-label="From domain"]');
    expect(address.tomselect).toBeTruthy();
    expect(domain.tomselect).toBeTruthy();
    expect(address.tomselect.options['sender@example.test']).toBeTruthy();
    expect(domain.tomselect.options['example.test']).toBeTruthy();
  });

  it('uses Tom Select to choose the preview account', () => {
    useMailStore.setState({ accounts: [
      { id: 'a1', email: 'me@example.test' }, { id: 'a2', email: 'team@example.test' },
    ] });
    render(<AutoTagSettings />);
    fireEvent.click(screen.getByText('New rule'));
    const from = document.querySelector('select[aria-label="From"]');
    expect(from.tomselect.options.a2.text).toBe('team@example.test');
  });
});
