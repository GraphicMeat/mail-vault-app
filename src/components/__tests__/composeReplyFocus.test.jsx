// @vitest-environment jsdom
//
// Reply and Reply all used to leave the caret in the To field — a field that
// already has a recipient, so there is nothing useful to type there. New and
// Forward still need To focused (Forward starts with no recipients at all).
// The real @tiptap/react editor runs here (not the usual stub) because the
// fix hinges on TipTap's own onCreate callback, which a stub never fires.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
// One component per tag, memoized — the usual inline-Proxy mock (seen in
// composeReplyThreading.test.jsx etc.) hands back a brand new component type
// from every `motion.div` property read, so JSX evaluating it on each render
// unmounts and remounts the whole tree (and any focus with it). Harmless for
// tests that don't check focus; fatal for this one.
vi.mock('framer-motion', () => {
  const cache = new Map();
  const motion = new Proxy({}, {
    get: (_t, tag) => {
      if (!cache.has(tag)) {
        cache.set(tag, React.forwardRef(({ children, initial, animate, exit, ...props }, ref) =>
          React.createElement('div', { ...props, ref }, children)));
      }
      return cache.get(tag);
    },
  });
  return { motion, AnimatePresence: ({ children }) => children };
});
vi.mock('../ContactsPicker', () => ({ ContactsPickerButton: () => null, ContactsAutocomplete: () => null }));
vi.mock('../../services/localDrafts', () => ({
  resolveDraftsMailbox: vi.fn().mockResolvedValue('Drafts'),
  saveLocalDraft: vi.fn().mockResolvedValue(undefined),
  deleteLocalDraft: vi.fn().mockResolvedValue(undefined),
  newDraftUid: () => 1,
}));
vi.mock('../../services/workflows/messageMutations', () => ({
  markAnswered: vi.fn().mockResolvedValue(undefined),
  markForwarded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/api', () => ({
  sendEmail: vi.fn(),
  buildOutgoingMime: vi.fn(),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
  ensureSentMailbox: vi.fn().mockResolvedValue('Sent'),
}));
vi.mock('../../services/db', () => ({
  getCachedMailboxes: vi.fn().mockResolvedValue([]),
  saveAccount: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/authUtils', () => ({ ensureFreshToken: vi.fn(async (a) => a) }));
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
  mailboxes: [{ path: 'INBOX', name: 'INBOX' }, { path: 'Sent', name: 'Sent', specialUse: '\\Sent' }],
  sentEmails: [],
  emails: [],
  queueSend: vi.fn(),
  updateSortedEmails: vi.fn(),
  loadSentHeaders: vi.fn(),
};
const settings = {
  getSignature: () => '', getDisplayName: () => 'Me', getOrderedAccounts: (accounts) => accounts,
  sendAsAddresses: {}, sendDelay: 0, emailTemplates: [], spellcheckEnabled: true,
  addEmailTemplate: vi.fn(), lastComposeIdentity: null, setLastComposeIdentity: vi.fn(),
};
vi.mock('../../stores/mailStore', () => {
  const hook = vi.fn((selector) => selector(mail));
  hook.getState = () => mail;
  hook.setState = (update) => Object.assign(mail, typeof update === 'function' ? update(mail) : update);
  return { useMailStore: hook };
});
vi.mock('../../stores/accountStore', () => ({ useAccountStore: (selector) => selector(mail) }));
vi.mock('../../stores/settingsStore', () => {
  const hook = vi.fn((selector) => selector(settings));
  hook.getState = () => settings;
  return { useSettingsStore: hook, hasPremiumAccess: () => false };
});

const { ComposeModal } = await import('../ComposeModal');

const parent = {
  uid: 10,
  messageId: '<parent@example.test>',
  subject: 'Quote request',
  from: { address: 'them@example.test', name: 'Them' },
  to: [{ address: 'me@example.test' }],
  date: '2026-09-07T09:00:00Z',
  text: 'How much?',
  flags: ['\\Seen'],
};

beforeEach(() => { invoke.mockReset(); });
afterEach(() => cleanup());

const baseProps = { onClose: () => {}, onMinimize: () => {}, onSaveState: () => {} };

describe('compose focus on open', () => {
  it('puts the caret in the body for reply', async () => {
    render(<ComposeModal mode="reply" replyTo={parent} {...baseProps} />);
    const body = await screen.findByTestId('compose-body');
    const editor = await within(body).findByRole('textbox');
    await waitFor(() => expect(document.activeElement).toBe(editor));
  });

  it('puts the caret in the body for reply all', async () => {
    render(<ComposeModal mode="replyAll" replyTo={parent} {...baseProps} />);
    const body = await screen.findByTestId('compose-body');
    const editor = await within(body).findByRole('textbox');
    await waitFor(() => expect(document.activeElement).toBe(editor));
  });

  it('keeps the caret in To for a new message', async () => {
    render(<ComposeModal mode="new" {...baseProps} />);
    const to = await screen.findByTestId('compose-to');
    await waitFor(() => expect(document.activeElement).toBe(to));
  });

  it('keeps the caret in To for a forward, which starts with no recipients', async () => {
    render(<ComposeModal mode="forward" replyTo={parent} {...baseProps} />);
    const to = await screen.findByTestId('compose-to');
    await waitFor(() => expect(document.activeElement).toBe(to));
  });
});
