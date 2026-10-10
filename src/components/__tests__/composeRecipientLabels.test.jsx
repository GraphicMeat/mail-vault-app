// @vitest-environment jsdom
//
// The To / Cc / Bcc captions of the compose window were hardcoded English next
// to a localized From: / Subject:. They, and the contacts-picker button that
// names the field, now come from the catalog.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { setLocale } from '../../i18n/index.js';
import en from '../../i18n/locales/en.json';
import de from '../../i18n/locales/de.json';

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
const settings = {
  getSignature: () => '', getDisplayName: () => 'Me', getOrderedAccounts: (accounts) => accounts,
  sendAsAddresses: {}, sendDelay: 0, emailTemplates: [], spellcheckEnabled: true,
  addEmailTemplate: vi.fn(), lastComposeIdentity: null, setLastComposeIdentity: vi.fn(),
  accountColors: {},
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
  hook.setState = (update) => Object.assign(settings, typeof update === 'function' ? update(settings) : update);
  return {
    useSettingsStore: hook, hasPremiumAccess: () => false,
    isTrackerBlockingActive: () => false, getAccountInitial: () => 'M', getAccountColor: () => '#000',
  };
});
vi.mock('../email/ThreadView', () => ({ ThreadView: () => null }));

const { ComposeModal } = await import('../ComposeModal');

const baseProps = { onClose: () => {}, onMinimize: () => {}, onSaveState: () => {} };
const strip = (s) => s.replace(/[:：]\s*$/, '');

beforeEach(() => { invoke.mockReset(); });
afterEach(async () => { cleanup(); await setLocale('en'); });

describe('compose recipient labels', () => {
  it('shows the English captions and picker names under English', async () => {
    render(<ComposeModal mode="new" {...baseProps} />);
    await screen.findByTestId('compose-to');
    expect(screen.getByLabelText('To:')).toBe(screen.getByTestId('compose-to'));
    expect(screen.getByLabelText('Cc:')).toBe(screen.getByTestId('compose-cc'));
    expect(screen.getByLabelText('Bcc:')).toBe(screen.getByTestId('compose-bcc'));
    expect(screen.getByLabelText('Pick To from contacts')).toBeTruthy();
    expect(screen.getByLabelText('Pick Cc from contacts')).toBeTruthy();
    expect(screen.getByLabelText('Pick Bcc from contacts')).toBeTruthy();
  });

  it('localizes To / Cc / Bcc and the picker buttons, never leaving English beside Von: / Betreff:', async () => {
    await setLocale('de');
    render(<ComposeModal mode="new" {...baseProps} />);
    await screen.findByTestId('compose-to');
    expect(de['compose.to']).not.toBe(en['compose.to']);
    expect(screen.getByLabelText(de['compose.to'])).toBe(screen.getByTestId('compose-to'));
    expect(screen.getByLabelText(de['compose.cc'])).toBe(screen.getByTestId('compose-cc'));
    expect(screen.getByLabelText(de['compose.bcc'])).toBe(screen.getByTestId('compose-bcc'));
    expect(screen.queryByLabelText('To:')).toBeNull();
    for (const key of ['compose.to', 'compose.cc', 'compose.bcc']) {
      const name = de['compose.pickFromContacts'].replace('{{field}}', strip(de[key]));
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
    expect(screen.queryByLabelText(/^Pick /)).toBeNull();
  });
});
