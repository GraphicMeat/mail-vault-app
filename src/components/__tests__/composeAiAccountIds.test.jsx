// @vitest-environment jsdom
//
// Compose's AI actions say whose mail they send: the account the draft leaves
// from, and the account of the message being answered (its body is the thread
// text, and From can be switched to another account). The daemon refuses a
// cloud endpoint for a request that names no account.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

const { invoke, captured } = vi.hoisted(() => ({ invoke: vi.fn(), captured: { props: null } }));

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('../ai/AiComposeActions', () => ({ AiComposeActions: (props) => { captured.props = props; return null; } }));
vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
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
// A real TipTap editor destroys itself on a 1ms timer after unmount; the last
// spec of the file can end before it fires, and it then throws into a torn-down
// jsdom (an unhandled error that fails the whole run).
vi.mock('../RichTextEditor', async (importOriginal) => ({
  ...(await importOriginal()),
  RichTextEditor: ({ placeholder }) => React.createElement('div', { 'data-testid': 'editor-stub' }, placeholder),
}));
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

const mail = {
  accounts: [{ id: 'acct-1', email: 'me@example.test', name: 'Me' }, { id: 'acct-2', email: 'me@gmail.com', name: 'Me' }],
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
  return { useSettingsStore: hook, hasPremiumAccess: () => false, isTrackerBlockingActive: (s) => !!(s || settings).trackerBlockingEnabled };
});
vi.mock('../email/ThreadView', () => ({ ThreadView: () => null }));

const { ComposeModal } = await import('../ComposeModal');

const parent = {
  uid: 10, messageId: '<parent@example.test>', subject: 'Quote request',
  from: { address: 'them@example.test', name: 'Them' }, to: [{ address: 'me@example.test' }],
  date: '2026-09-07T09:00:00Z', text: 'How much?', flags: ['\\Seen'],
};
const baseProps = { onClose: () => {}, onMinimize: () => {}, onSaveState: () => {} };

beforeEach(() => { invoke.mockReset(); captured.props = null; });
afterEach(() => cleanup());

describe('ComposeModal names the account(s) behind its AI actions', () => {
  it('a new message is the account it leaves from', async () => {
    render(<ComposeModal mode="new" {...baseProps} />);
    await screen.findByTestId('compose-to');
    expect(captured.props.accountIds).toEqual(['acct-1']);
  });

  it('a reply is the account it leaves from plus the account of the message answered', async () => {
    render(<ComposeModal mode="reply" replyTo={{ ...parent, _accountId: 'acct-2' }} {...baseProps} />);
    await screen.findByTestId('compose-to');
    expect(captured.props.accountIds.slice().sort()).toEqual(['acct-2']);
  });

  it('a reply to a message that carries no account is the account being read', async () => {
    render(<ComposeModal mode="reply" replyTo={parent} {...baseProps} />);
    await screen.findByTestId('compose-to');
    expect(captured.props.accountIds).toEqual(['acct-1']);
  });

  it('a draft restored for one account, answering a message of another, names both', async () => {
    render(<ComposeModal mode="new" initialData={{ _accountId: 'acct-1', _replyTo: { ...parent, _accountId: 'acct-2' } }} {...baseProps} />);
    await screen.findByTestId('compose-to');
    expect(captured.props.accountIds.slice().sort()).toEqual(['acct-1', 'acct-2']);
  });
});
