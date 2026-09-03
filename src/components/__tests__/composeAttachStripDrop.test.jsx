// @vitest-environment jsdom
//
// A file dropped on the "Drop here to attach file" strip, dispatched the way a
// BROWSER dispatches it. The wdio suite fires its drops from a script, and a
// script-dispatched event runs every listener back to back. A drop the user
// performs is different: the browser runs a microtask checkpoint after each
// listener returns, so whatever React's root capture listener set is committed
// before the root bubble listener runs. If that commit removes the strip, React
// finds no mounted fiber for the event target and dispatches the drop to
// nobody — the file never reaches addFiles and nothing appears.
//
// jsdom cannot yield a checkpoint mid-dispatch either, so a target-phase native
// listener flushes React at exactly the point the browser would.

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { flushSync } from 'react-dom';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

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
vi.mock('../ContactsPicker', () => ({
  ContactsPickerButton: () => null,
  ContactsAutocomplete: () => null,
}));
vi.mock('../../services/localDrafts', () => ({
  resolveDraftsMailbox: vi.fn().mockResolvedValue('Drafts'),
  saveLocalDraft: vi.fn().mockResolvedValue(undefined),
  deleteLocalDraft: vi.fn().mockResolvedValue(undefined),
  newDraftUid: () => 1,
}));
vi.mock('../../services/api', () => ({}));
vi.mock('../../services/db', () => ({}));
vi.mock('../../services/authUtils', () => ({ ensureFreshToken: vi.fn() }));
vi.mock('../../utils/sendAsSuggestions', async (orig) => ({
  ...(await orig()),
  suggestSendAsAddresses: vi.fn().mockResolvedValue([]),
}));

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

const { ComposeModal } = await import('../ComposeModal');

const png = () => new File([new Uint8Array(64)], 'shot.png', { type: 'image/png' });

/** Dispatch through the DOM, not fireEvent: no act() wrapper, like a real drop. */
function nativeDrop(target, files) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { files, types: ['Files'], items: [], dropEffect: 'copy', effectAllowed: 'all' },
  });
  target.dispatchEvent(event);
}

afterEach(cleanup);

describe('attach strip drop', () => {
  it('attaches a file dropped on the strip when the browser commits capture-phase state before the bubble phase', async () => {
    render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);

    fireEvent.dragEnter(screen.getByTestId('compose-modal'), { dataTransfer: { types: ['Files'], files: [] } });
    const strip = await screen.findByTestId('compose-attach-dropzone');

    // The browser's microtask checkpoint, at the point it would run: after the
    // root capture listener, before the root bubble listener.
    strip.addEventListener('drop', () => flushSync(() => {}));

    nativeDrop(strip, [png()]);

    await waitFor(() => expect(screen.getByTestId('compose-attachment').dataset.filename).toBe('shot.png'));
    await waitFor(() => expect(screen.queryByTestId('compose-attach-dropzone')).toBeNull());
  });
});
