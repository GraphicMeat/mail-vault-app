// @vitest-environment jsdom
//
// To / Cc / Bcc chips inside compose: Send refuses an entry that is not an
// address and names it; a pasted mailto: link fills Cc and Bcc from its
// headers; a chip dragged to another field moves there.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';

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
vi.mock('../../services/localDrafts', async () => ({
  resolveDraftsMailbox: vi.fn().mockResolvedValue('Drafts'),
  saveLocalDraft: vi.fn((await import('../../test/draftReply')).savedDraftReply),
  deleteLocalDraft: vi.fn().mockResolvedValue(undefined),
  newDraftUid: () => 1,
  newDraftId: () => "stable-draft",
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
  render(
    <ComposeModal
      mode="new"
      initialData={{ to: 'them@example.test', subject: 'Hi', body: '<p>Body</p>', ...extra }}
      onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}}
    />,
  );
}

const sentSnapshot = () => queueSend.mock.calls.at(-1)?.[0]?.initialData;
const row = f => document.querySelector(`[data-recipient-field="${f}"]`);
const rowChips = f => within(row(f)).queryAllByTestId('recipient-chip').map(c => c.textContent);

beforeEach(() => {
  queueSend.mockClear();
  premium.on = true;
  settings.attachmentReminder = false;
});
afterEach(cleanup);

describe('recipient chips in compose', () => {
  it('sends a valid recipient', async () => {
    open();
    fireEvent.click(await screen.findByTestId('compose-send'));
    await waitFor(() => expect(queueSend).toHaveBeenCalledTimes(1));
  });

  it('refuses to send an entry that is not an address, and names it', async () => {
    open({ to: 'them@example.test, John Doe' });
    fireEvent.click(await screen.findByTestId('compose-send'));
    expect((await screen.findByTestId('compose-error')).textContent).toContain('John Doe');
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('checks Cc and Bcc too', async () => {
    open({ cc: 'nobody', bcc: 'x@y.de' });
    fireEvent.click(await screen.findByTestId('compose-send'));
    expect((await screen.findByTestId('compose-error')).textContent).toContain('nobody');
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('a pasted mailto: fills Cc and Bcc from its headers', async () => {
    open({ to: '' });
    fireEvent.paste(await screen.findByTestId('compose-to'), {
      clipboardData: { getData: () => 'mailto:impressum@amazon.de?cc=c@d.de&bcc=e@f.de&subject=Hi' },
    });
    expect(rowChips('to')).toEqual(['impressum@amazon.de']);
    expect(rowChips('cc')).toEqual(['c@d.de']);
    expect(rowChips('bcc')).toEqual(['e@f.de']);
    fireEvent.click(screen.getByTestId('compose-send'));
    await waitFor(() => expect(queueSend).toHaveBeenCalledTimes(1));
    expect(sentSnapshot()).toMatchObject({ to: 'impressum@amazon.de, ', cc: 'c@d.de, ', bcc: 'e@f.de, ' });
  });

  it('a chip dragged to Cc moves there', async () => {
    open({ to: 'a@b.de, c@d.de' });
    const chip = (await screen.findAllByTestId('recipient-chip-text'))[0];
    document.elementFromPoint = () => row('cc');
    fireEvent.mouseDown(chip, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(document, { clientX: 50, clientY: 0 });
    fireEvent.mouseUp(document, { clientX: 50, clientY: 0 });
    expect(rowChips('to')).toEqual(['c@d.de']);
    expect(rowChips('cc')).toEqual(['a@b.de']);
  });
});
