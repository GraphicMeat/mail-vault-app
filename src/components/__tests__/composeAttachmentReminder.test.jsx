// @vitest-environment jsdom
//
// "You mentioned an attachment": Send on a message that talks about one and
// carries none asks first (Premium). Send anyway sends; Attach file opens the
// picker and sends nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ label: 'main' }) }));
vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, initial, animate, exit, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));
vi.mock('../RichTextEditor', () => ({
  RichTextEditor: ({ placeholder }) => React.createElement('div', { 'data-testid': 'editor-stub' }, placeholder),
  insertImages: vi.fn(),
  textToHtml: (s) => s || '',
  htmlToText: (h) => (h || '').replace(/<\/p>/g, '\n').replace(/<[^>]*>/g, ''),
  inlineComposeSpacing: (h) => h,
}));
vi.mock('../ContactsPicker', () => ({ ContactsPickerButton: () => null, ContactsAutocomplete: () => null }));
vi.mock('../../services/localDrafts', () => ({
  resolveDraftsMailbox: vi.fn().mockResolvedValue('Drafts'),
  saveLocalDraft: vi.fn().mockResolvedValue(undefined),
  deleteLocalDraft: vi.fn().mockResolvedValue(undefined),
  newDraftUid: () => 1,
}));
vi.mock('../../services/api', () => ({}));
vi.mock('../../services/db', () => ({ getCachedMailboxes: vi.fn().mockResolvedValue([]) }));
vi.mock('../../services/authUtils', () => ({ ensureFreshToken: vi.fn(async (a) => a) }));
vi.mock('../email/ThreadView', () => ({ ThreadView: () => null }));

const account = { id: 'acct-1', email: 'me@example.test', name: 'Me' };
const queueSend = vi.fn();
const mail = {
  accounts: [account],
  activeAccountId: 'acct-1',
  lastSelectedAccountId: 'acct-1',
  activeMailbox: 'INBOX',
  mailboxes: [],
  queueSend: (...a) => queueSend(...a),
};
const settings = {
  getSignature: () => '', getDisplayName: () => 'Me', getOrderedAccounts: (accounts) => accounts,
  sendAsAddresses: {}, sendDelay: 0, emailTemplates: [], spellcheckEnabled: true,
  addEmailTemplate: vi.fn(), lastComposeIdentity: null, setLastComposeIdentity: vi.fn(),
  attachmentReminder: true,
};
const premium = { on: true };
vi.mock('../../stores/mailStore', () => {
  const hook = vi.fn((selector) => selector(mail));
  hook.getState = () => mail;
  hook.setState = vi.fn();
  return { useMailStore: hook };
});
vi.mock('../../stores/accountStore', () => ({ useAccountStore: (selector) => selector(mail) }));
vi.mock('../../stores/settingsStore', () => {
  const hook = vi.fn((selector) => selector(settings));
  hook.getState = () => settings;
  return {
    useSettingsStore: hook,
    hasPremiumAccess: () => premium.on,
    isTrackerBlockingActive: () => false,
  };
});

const { ComposeModal } = await import('../ComposeModal');

function open(body, extra = {}) {
  const onClose = vi.fn();
  render(
    <ComposeModal
      mode="new"
      initialData={{ to: 'them@example.test', subject: 'Hi', body, ...extra }}
      onClose={onClose} onMinimize={() => {}} onSaveState={() => {}}
    />,
  );
  return { onClose };
}

beforeEach(() => {
  queueSend.mockClear();
  premium.on = true;
  settings.attachmentReminder = true;
});
afterEach(cleanup);

describe('attachment reminder at send', () => {
  it('asks before sending a message that mentions an attachment and has none', async () => {
    open('<p>The report is attached.</p>');
    fireEvent.click(await screen.findByTestId('compose-send'));

    expect(await screen.findByTestId('compose-attachment-reminder')).toBeTruthy();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('Send anyway sends', async () => {
    const { onClose } = open('<p>The report is attached.</p>');
    fireEvent.click(await screen.findByTestId('compose-send'));
    fireEvent.click(await screen.findByTestId('compose-attachment-reminder-send'));

    await waitFor(() => expect(queueSend).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
  });

  it('Attach file opens the file picker and sends nothing', async () => {
    open('<p>The report is attached.</p>');
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(await screen.findByTestId('compose-send'));
    fireEvent.click(await screen.findByTestId('compose-attachment-reminder-attach'));

    expect(click.mock.contexts.some(el => el.dataset.testid === 'compose-attach-input')).toBe(true);
    click.mockRestore();
    expect(screen.queryByTestId('compose-attachment-reminder')).toBeNull();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('sends straight away when a file is attached', async () => {
    open('<p>The report is attached.</p>', {
      attachments: [{ filename: 'r.pdf', contentType: 'application/pdf', size: 1, content: 'AA==', isFromOriginal: false }],
    });
    fireEvent.click(await screen.findByTestId('compose-send'));

    await waitFor(() => expect(queueSend).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('compose-attachment-reminder')).toBeNull();
  });

  it('sends straight away without Premium', async () => {
    premium.on = false;
    open('<p>The report is attached.</p>');
    fireEvent.click(await screen.findByTestId('compose-send'));

    await waitFor(() => expect(queueSend).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('compose-attachment-reminder')).toBeNull();
  });

  it("ignores a restored reply draft's subject", async () => {
    open('<p>Paid, thanks.</p>', { subject: 'Re: Invoice attached', inReplyTo: '<inv@example.test>' });
    fireEvent.click(await screen.findByTestId('compose-send'));

    await waitFor(() => expect(queueSend).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('compose-attachment-reminder')).toBeNull();
  });

  it('sends straight away when the reminder is turned off', async () => {
    settings.attachmentReminder = false;
    open('<p>The report is attached.</p>');
    fireEvent.click(await screen.findByTestId('compose-send'));

    await waitFor(() => expect(queueSend).toHaveBeenCalledTimes(1));
  });
});
