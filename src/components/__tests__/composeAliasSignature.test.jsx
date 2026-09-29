// @vitest-environment jsdom
//
// An alias can sign differently from its account: the signature in a message
// follows the address it leaves from, when it is opened and when From changes.
// The real @tiptap/react editor runs, so the body read here is the document the
// person would type into.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';

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
const ACCOUNT_SIGNATURE = { enabled: true, html: '<p>Best, Me</p>', text: 'Best, Me' };
const DESK = { address: 'desk@example.test', name: 'Desk', source: 'manual', signature: { html: '<p>Desk team</p>', text: 'Desk team' } };
const SHOP = { address: 'shop@example.test', name: '', source: 'manual' };
const QUIET = { address: 'quiet@example.test', name: '', source: 'manual', signature: { html: '', text: '' } };
const settings = {
  aliases: {}, getSignature: () => '', getDisplayName: () => 'Me', getOrderedAccounts: (accounts) => accounts,
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

// The original's pane is a read-only ThreadView with its own specs
// (ThreadViewReadOnly, composeQuotedOriginal); this suite's stores are too thin
// to host its body loader.
vi.mock('../email/ThreadView', () => ({ ThreadView: () => null }));

const { ComposeModal } = await import('../ComposeModal');

const forward = {
  uid: 11,
  messageId: '<fwd@example.test>',
  subject: 'Quote request',
  from: { address: 'them@example.test', name: 'Them' },
  to: [{ address: 'me@example.test' }],
  date: '2026-09-07T09:00:00Z',
  text: 'Original words',
  flags: ['\\Seen'],
};

beforeEach(() => {
  invoke.mockReset();
  settings.getSignature = () => ACCOUNT_SIGNATURE;
  settings.aliases = { 'acct-1': [DESK, SHOP, QUIET] };
  settings.sendAsAddresses = {};
});
afterEach(() => cleanup());

const baseProps = { onClose: () => {}, onMinimize: () => {}, onSaveState: () => {} };
const bodyText = async () => {
  const body = await screen.findByTestId('compose-body');
  return (await within(body).findByRole('textbox')).textContent;
};
const pickFrom = async address => {
  fireEvent.change(await screen.findByTestId('compose-from'), { target: { value: `acct-1 ${address}` } });
};

describe('the signature follows the address a message leaves from', () => {
  it("opens with the account's signature for the login", async () => {
    render(<ComposeModal mode="new" {...baseProps} />);
    await waitFor(async () => expect(await bodyText()).toContain('Best, Me'));
    expect(await bodyText()).not.toContain('Desk team');
  });

  it('swaps to an alias signature and back when From changes, and nothing else in the body', async () => {
    render(<ComposeModal mode="new" initialData={{ _prefill: true, body: '<p>Hello there</p>' }} {...baseProps} />);
    await waitFor(async () => expect(await bodyText()).toContain('Hello there'));
    expect(await bodyText()).toContain('Best, Me');

    await pickFrom('desk@example.test');
    await waitFor(async () => expect(await bodyText()).toContain('Desk team'));
    let text = await bodyText();
    expect(text).not.toContain('Best, Me');
    expect(text).toContain('Hello there');

    await pickFrom('me@example.test');
    await waitFor(async () => expect(await bodyText()).toContain('Best, Me'));
    text = await bodyText();
    expect(text).not.toContain('Desk team');
    expect(text).toContain('Hello there');
  });

  it("keeps the account's signature for an alias that has none of its own", async () => {
    render(<ComposeModal mode="new" {...baseProps} />);
    await waitFor(async () => expect(await bodyText()).toContain('Best, Me'));
    await pickFrom('shop@example.test');
    // Nothing to swap: the same signature stays, once.
    expect(await bodyText()).toContain('Best, Me');
    expect((await bodyText()).split('Best, Me')).toHaveLength(2);
  });

  it('removes the signature for an alias whose own signature is empty, and brings it back', async () => {
    render(<ComposeModal mode="new" initialData={{ _prefill: true, body: '<p>Hello there</p>' }} {...baseProps} />);
    await waitFor(async () => expect(await bodyText()).toContain('Best, Me'));
    await pickFrom('quiet@example.test');
    await waitFor(async () => expect(await bodyText()).not.toContain('Best, Me'));
    expect(await bodyText()).toContain('Hello there');
    expect(await bodyText()).not.toContain('--');
    await pickFrom('me@example.test');
    await waitFor(async () => expect(await bodyText()).toContain('Best, Me'));
  });

  it('signs an alias with its own signature even while the account signature is switched off', async () => {
    settings.getSignature = () => ({ ...ACCOUNT_SIGNATURE, enabled: false });
    render(<ComposeModal mode="new" {...baseProps} />);
    await waitFor(async () => expect(await bodyText()).not.toContain('Best, Me'));
    await pickFrom('desk@example.test');
    await waitFor(async () => expect(await bodyText()).toContain('Desk team'));
  });

  it('opens signed as the default From when that is an alias', async () => {
    settings.sendAsAddresses = { 'acct-1': 'desk@example.test' };
    render(<ComposeModal mode="new" {...baseProps} />);
    await waitFor(async () => expect(await bodyText()).toContain('Desk team'));
    expect(await bodyText()).not.toContain('Best, Me');
  });

  it('puts the swapped signature above the original in a forward', async () => {
    render(<ComposeModal mode="forward" replyTo={forward} {...baseProps} />);
    await waitFor(async () => expect(await bodyText()).toContain('Best, Me'));
    await pickFrom('desk@example.test');
    await waitFor(async () => expect(await bodyText()).toContain('Desk team'));
    const text = await bodyText();
    expect(text).not.toContain('Best, Me');
    expect(text.indexOf('Desk team')).toBeLessThan(text.indexOf('Original words'));
  });
});
