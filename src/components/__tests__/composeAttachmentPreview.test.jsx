// @vitest-environment jsdom
//
// A file attached in compose can be previewed before it is sent: an eye
// button sits before the remove button on every image or PDF chip, and opens
// the same dialog the reading pane uses.

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';

import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

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

// TipTap never sees this drop; keep only the pure helpers ComposeModal imports.
vi.mock('../RichTextEditor', () => ({
  RichTextEditor: ({ placeholder }) => React.createElement('div', { 'data-testid': 'editor-stub' }, placeholder),
  insertImages: vi.fn(),
  textToHtml: (s) => s || '',
  htmlToText: (h) => (h || '').replace(/<[^>]*>/g, ''),
  inlineComposeSpacing: (h) => h,
}));
// The utils that used to import these from the component read the same stubs.
vi.mock('../../utils/editorHtml', () => ({
  htmlToText: (h) => (h || '').replace(/<[^>]*>/g, ''),
  inlineComposeSpacing: (h) => h,
}));
vi.mock('../../utils/textToHtml', () => ({ textToHtml: (s) => s || '' }));
vi.mock('../ContactsPicker', () => ({
  ContactsPickerButton: () => null,
  ContactsAutocomplete: () => null,
}));
vi.mock('../../services/localDrafts', async () => ({
  resolveDraftsMailbox: vi.fn().mockResolvedValue('Drafts'),
  saveLocalDraft: vi.fn((await import('../../test/draftReply')).savedDraftReply),
  deleteLocalDraft: vi.fn().mockResolvedValue(undefined),
  newDraftUid: () => 1,
  newDraftId: () => "stable-draft",
}));
vi.mock('../../services/api', () => ({}));
vi.mock('../../services/db', () => ({}));
vi.mock('../../services/authUtils', () => ({ ensureFreshToken: vi.fn() }));

const account = { id: 'acct-1', email: 'me@example.test', name: 'Me' };
const mail = {
  accounts: [account],
  activeAccountId: 'acct-1',
  lastSelectedAccountId: 'acct-1',
  activeMailbox: 'INBOX',
};
const settings = {
  getSignature: () => '',
  getDisplayName: () => 'Me',
  getOrderedAccounts: (accounts) => accounts,
  sendAsAddresses: {},
  sendDelay: 0,
  emailTemplates: [],
  spellcheckEnabled: true,
  addEmailTemplate: vi.fn(),
  lastComposeIdentity: null,
};
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
  return { useSettingsStore: hook };
});

// ComposeModal imports the read-only ThreadView for a reply's original; this
// suite never shows one, so its module tree stays out.
vi.mock('../email/ThreadView', () => ({ ThreadView: () => null }));

const { ComposeModal } = await import('../ComposeModal');

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(async (cmd) => (cmd === 'maildir_read_attachment' ? 'iVBORw0KGgo=' : null)),
}));
vi.mock('../../services/transport', () => ({ send: (...a) => sendMock(...a) }));

const PNG_B64 = 'iVBORw0KGgo=';

function renderWith(attachments) {
  return render(<ComposeModal mode="new" initialData={{ to: '', subject: '', body: '', attachments }}
    onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
}

afterEach(() => { cleanup(); sendMock.mockClear(); });

describe('compose attachment preview', () => {
  it('puts a preview button before the remove button and opens the image', async () => {
    renderWith([{ filename: 'shot.png', contentType: 'image/png', size: 8, content: PNG_B64, isFromOriginal: false }]);
    const chip = await screen.findByTestId('compose-attachment');
    const preview = within(chip).getByTestId('attachment-preview');
    const remove = within(chip).getByTestId('compose-attachment-remove');
    expect(preview.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(preview);
    const img = await screen.findByTestId('attachment-preview-image');
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('reads a forwarded attachment with no bytes yet from the original message', async () => {
    const source = { accountId: 'acct-1', mailbox: 'INBOX', uid: 7, attachmentIndex: 0 };
    renderWith([{ filename: 'fwd.png', contentType: 'image/png', size: 8, isFromOriginal: true, _source: source }]);
    fireEvent.click(within(await screen.findByTestId('compose-attachment')).getByTestId('attachment-preview'));
    const img = await screen.findByTestId('attachment-preview-image');
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(sendMock).toHaveBeenCalledWith('maildir_read_attachment', source);
  });

  it('shows no preview button for a file it cannot show', async () => {
    renderWith([{ filename: 'a.zip', contentType: 'application/zip', size: 8, content: PNG_B64, isFromOriginal: false }]);
    const chip = await screen.findByTestId('compose-attachment');
    expect(within(chip).queryByTestId('attachment-preview')).toBeNull();
    expect(within(chip).getByTestId('compose-attachment-remove')).toBeTruthy();
  });
});
