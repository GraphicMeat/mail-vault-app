// @vitest-environment jsdom
//
// "Remind me if no reply" in compose: Off / 1 day / 3 days / 1 week, armed
// on the message (`_remindDays`) so a minimize, an undo or a detach keeps it.
// Premium; a free user sees it locked with the upgrade. Not offered on a
// Microsoft Graph account, which the daemon cannot check for replies.

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
const graphAccount = { id: 'acct-g', email: 'me@outlook.test', name: 'Me', oauth2Transport: 'graph' };
const queueSend = vi.fn();
const mail = {
  accounts: [account, graphAccount],
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

function open(extra = {}) {
  const onClose = vi.fn();
  render(
    <ComposeModal
      mode="new"
      initialData={{ to: 'them@example.test', subject: 'Quote', body: '<p>Price?</p>', ...extra }}
      onClose={onClose} onMinimize={() => {}} onSaveState={() => {}}
    />,
  );
  return { onClose };
}

const sentSnapshot = () => queueSend.mock.calls.at(-1)?.[0]?.initialData;

beforeEach(() => {
  queueSend.mockClear();
  premium.on = true;
  settings.attachmentReminder = false;
});
afterEach(cleanup);

describe('remind me if no reply', () => {
  it('arms a reminder that the send carries', async () => {
    open();
    fireEvent.click(await screen.findByTestId('compose-remind-toggle'));
    fireEvent.click(await screen.findByTestId('compose-remind-option-3'));

    expect(screen.getByTestId('compose-remind-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('compose-remind-armed')).toBeTruthy();
    fireEvent.click(screen.getByTestId('compose-send'));
    await waitFor(() => expect(queueSend).toHaveBeenCalledTimes(1));
    expect(sentSnapshot()._remindDays).toBe(3);
  });

  it('offers 1 day, 3 days, 1 week and Off', async () => {
    open();
    fireEvent.click(await screen.findByTestId('compose-remind-toggle'));
    for (const days of [0, 1, 3, 7]) expect(screen.getByTestId(`compose-remind-option-${days}`)).toBeTruthy();
  });

  it('keeps the reminder a restored window was armed with, and Off clears it', async () => {
    open({ _remindDays: 7 });
    expect(await screen.findByTestId('compose-remind-armed')).toBeTruthy();
    fireEvent.click(screen.getByTestId('compose-remind-toggle'));
    fireEvent.click(await screen.findByTestId('compose-remind-option-0'));
    expect(screen.queryByTestId('compose-remind-armed')).toBeNull();
    fireEvent.click(screen.getByTestId('compose-send'));
    await waitFor(() => expect(queueSend).toHaveBeenCalledTimes(1));
    expect(sentSnapshot()._remindDays).toBe(0);
  });

  it('sends a restored reminder without touching it', async () => {
    open({ _remindDays: 1 });
    fireEvent.click(await screen.findByTestId('compose-send'));
    await waitFor(() => expect(queueSend).toHaveBeenCalledTimes(1));
    expect(sentSnapshot()._remindDays).toBe(1);
  });

  it('is locked with the upgrade for a free user', async () => {
    premium.on = false;
    open();
    fireEvent.click(await screen.findByTestId('compose-remind-toggle'));
    expect(screen.getByTestId('compose-remind-locked')).toBeTruthy();
    expect(screen.getByTestId('compose-remind-upgrade')).toBeTruthy();
    expect(screen.queryByTestId('compose-remind-option-3')).toBeNull();
  });

  it('a free user\'s restored reminder is not sent', async () => {
    premium.on = false;
    open({ _remindDays: 3 });
    fireEvent.click(await screen.findByTestId('compose-send'));
    await waitFor(() => expect(queueSend).toHaveBeenCalledTimes(1));
    expect(sentSnapshot()._remindDays || 0).toBe(0);
  });

  it('is not offered on a Microsoft Graph account', async () => {
    open({ _accountId: 'acct-g', _fromAddress: 'me@outlook.test' });
    await screen.findByTestId('compose-send');
    expect(screen.queryByTestId('compose-remind-toggle')).toBeNull();
  });
});
