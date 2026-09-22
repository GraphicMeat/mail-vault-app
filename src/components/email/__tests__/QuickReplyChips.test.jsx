// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { QuickReplyChips } from '../QuickReplyChips';

vi.mock('../../../utils/composeOpener', () => ({ openCompose: vi.fn() }));
import { openCompose } from '../../../utils/composeOpener';

afterEach(cleanup);

const question = {
  uid: 1, messageId: '<q1@x>',
  from: { address: 'ann@example.test' }, to: [{ address: 'me@example.test' }],
  subject: 'Quick one', text: 'Did you send the invoice?',
};

describe('QuickReplyChips', () => {
  beforeEach(() => {
    openCompose.mockClear();
    // AI OFF by default — Tier 1 only, no daemon involved.
    useSettingsStore.setState({
      aiSettings: { enabled: false, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false },
      dismissedQuickReplyThreads: {},
    });
  });

  it('renders Tier 1 chips for a person-to-person question', () => {
    render(<QuickReplyChips email={question} />);
    expect(screen.getByText('Yes')).toBeTruthy();
    expect(screen.getByText('No')).toBeTruthy();
  });

  it('opens Compose prefilled with the clicked chip text, and never sends', () => {
    render(<QuickReplyChips email={question} />);
    fireEvent.click(screen.getByText('Yes'));
    expect(openCompose).toHaveBeenCalledTimes(1);
    const [arg] = openCompose.mock.calls[0];
    expect(arg.mode).toBe('reply');
    expect(arg.templateBody).toBe('Yes');
    expect(arg.replyTo.uid).toBe(1);
  });

  it('renders nothing for an automated (newsletter) thread', () => {
    const { container } = render(<QuickReplyChips email={{ ...question, listUnsubscribe: '<mailto:off@list.test>' }} />);
    expect(container.querySelector('[data-testid="quick-reply-chips"]')).toBeNull();
  });

  it('stays hidden once its thread has been dismissed', () => {
    const { rerender, container } = render(<QuickReplyChips email={question} />);
    fireEvent.click(screen.getByLabelText('Dismiss quick replies'));
    // The dismiss action writes to the real store; a re-render must respect it.
    rerender(<QuickReplyChips email={question} />);
    expect(container.querySelector('[data-testid="quick-reply-chips"]')).toBeNull();
    expect(useSettingsStore.getState().dismissedQuickReplyThreads['<q1@x>']).toBe(true);
  });

  it('is suppressed when the caller marks it (e.g. your own sent mail)', () => {
    const { container } = render(<QuickReplyChips email={question} suppressed />);
    expect(container.querySelector('[data-testid="quick-reply-chips"]')).toBeNull();
  });
});
