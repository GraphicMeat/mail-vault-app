// @vitest-environment jsdom
// The outbox bubble of a failed send. A send that may already have gone out
// (a Graph or JMAP submission that got no answer, the daemon's
// MAY_HAVE_GONE_OUT marker) offers "Check Sent", never Retry: a retry could
// send it twice. A JMAP refusal reads in the app's words.
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OutboxTray } from '../OutboxTray';
import { useMailStore } from '../../stores/mailStore';
import { t } from '../../i18n';

const activateAccount = vi.fn();
const item = (error) => ({
  id: 1, status: 'error', error, startedAt: Date.now(), sendFn: vi.fn(),
  composeState: { mode: 'new', initialData: { subject: 'Quarterly', to: 'them@example.test', _accountId: 'jm' } },
});

beforeEach(() => {
  activateAccount.mockReset().mockResolvedValue(undefined);
  useMailStore.setState({
    accounts: [{ id: 'jm', email: 'me@example.test', jmapSessionUrl: 'https://jmap.example.test/jmap/session' }],
    activeAccountId: 'jm',
    mailboxes: [{ path: 'INBOX', name: 'INBOX' }, { path: 'Sent Items', name: 'Sent Items', specialUse: '\\Sent' }],
    activateAccount,
  });
});
afterEach(() => { cleanup(); useMailStore.setState({ outboxItems: [] }); });

it('offers Check Sent instead of Retry when the message may have gone out', async () => {
  useMailStore.setState({ outboxItems: [item('The mail server did not confirm the send in time (timed out). Check Sent before trying again: the message may have gone out.')] });
  render(<OutboxTray onRestoreDraft={vi.fn()} />);

  expect(screen.queryByRole('button', { name: new RegExp(t('common.retry')) })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: new RegExp(t('outbox.checkSent')) }));
  await waitFor(() => expect(activateAccount).toHaveBeenCalledWith('jm', 'Sent Items'));
});

it('keeps Retry for a send that never left', () => {
  useMailStore.setState({ outboxItems: [item('Could not reach the server')] });
  render(<OutboxTray onRestoreDraft={vi.fn()} />);
  expect(screen.getByRole('button', { name: new RegExp(t('common.retry')) })).toBeTruthy();
  expect(screen.queryByRole('button', { name: new RegExp(t('outbox.checkSent')) })).toBeNull();
});

it('words a JMAP refusal in the catalog, not the daemon code', () => {
  useMailStore.setState({ outboxItems: [item('E_JMAP_NO_IDENTITY: the server lists no identity for b@x.test, so it will not send as that address')] });
  render(<OutboxTray onRestoreDraft={vi.fn()} />);
  expect(screen.getByText(t('errors.jmapNoIdentity'))).toBeTruthy();
  expect(screen.queryByText(/E_JMAP_NO_IDENTITY/)).toBeNull();
});
