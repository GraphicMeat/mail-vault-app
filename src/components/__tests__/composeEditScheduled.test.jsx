// @vitest-environment jsdom
//
// Compose as the editor of a scheduled email (ScheduledFolderModal's row
// click). The window names the email it is editing, every snapshot it hands
// out still says which row it replaces (minimize, undo, detach and Schedule
// all go through one), and a Schedule the daemon refuses because the row
// already fired is shown as its catalog message with the window left open.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const { invoke, sendEmail, buildOutgoingMime, appendLocalIndex, listen } = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  sendEmail: vi.fn(),
  buildOutgoingMime: vi.fn(),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: (...a) => listen(...a) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ label: 'main' }) }));
// maildir_store/maildir_delete/local_index_remove now route through
// transport.js (Task 2.1); delegate to the same `invoke` mock so
// storedUids() and every existing assertion below still see them.
vi.mock('../../services/transport', () => ({ send: (...a) => invoke(...a) }));
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
  RichTextEditor: ({ placeholder }) => React.createElement('div', { className: 'ProseMirror', 'data-testid': 'editor-stub' }, placeholder),
  insertImages: vi.fn(),
  textToHtml: (s) => s || '',
  htmlToText: (h) => (h || '').replace(/<[^>]*>/g, ''),
  inlineComposeSpacing: (h) => h,
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
  sendEmail: (...a) => sendEmail(...a),
  buildOutgoingMime: (...a) => buildOutgoingMime(...a),
  appendLocalIndex: (...a) => appendLocalIndex(...a),
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
  activeMailbox: 'Sent',
  mailboxes: [{ path: 'INBOX', name: 'INBOX' }, { path: 'Sent', name: 'Sent', specialUse: '\\Sent' }],
  sentEmails: [],
  emails: [],
  totalEmails: 0,
  updateSortedEmails: vi.fn(),
  loadSentHeaders: vi.fn(),
  // Send now, and keep the closure: retryOutbox re-runs this exact function.
  queueSend: (_state, sendFn) => {
    mail._sendFn = sendFn;
    mail._sendError = null;
    mail._inFlight = sendFn().catch((err) => { mail._sendError = err; });
  },
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
  return { useSettingsStore: hook };
});

const { ComposeModal } = await import('../ComposeModal');

const initialData = {
  to: 'you@example.test', cc: '', bcc: '', subject: 'Later', body: '<p>See you then</p>',
  attachments: [],
  _accountId: 'acct-1',
  _baseline: { to: 'you@example.test', subject: 'Later', body: '<p>See you then</p>' },
  _scheduleDraft: { localTime: '2999-01-01T09:00', tz: 'UTC' },
  _editScheduledId: 'row-1',
  _editScheduledRow: { accountId: 'acct-1', localTime: '2026-10-01T09:00', tz: 'Europe/Vilnius' },
};

beforeEach(() => { window.__TAURI__ = { core: { invoke } }; });
afterEach(() => { cleanup(); delete window.__TAURI__; });

describe('compose editing a scheduled email', () => {
  it('says which scheduled email it is editing, and when that one is set to go', async () => {
    render(<ComposeModal initialData={initialData} onClose={() => {}} onSaveState={() => {}} />);
    const notice = await screen.findByTestId('compose-editing-scheduled');
    expect(notice.textContent).toContain('Europe/Vilnius');
    expect(notice.textContent).toContain('2026');
  });

  it('carries the row it replaces through every snapshot', async () => {
    const snapshotRef = { current: null };
    render(<ComposeModal initialData={initialData} snapshotRef={snapshotRef} onClose={() => {}} onSaveState={() => {}} />);
    await screen.findByTestId('compose-editing-scheduled');
    const snapshot = await snapshotRef.current();
    expect(snapshot._editScheduledId).toBe('row-1');
    expect(snapshot._editScheduledRow).toEqual(initialData._editScheduledRow);
    expect(snapshot._draftUid ?? null).toBeNull();
  });

  it('an ordinary compose carries no scheduled row at all', async () => {
    const snapshotRef = { current: null };
    render(<ComposeModal snapshotRef={snapshotRef} onClose={() => {}} onSaveState={() => {}} />);
    await screen.findByTestId('compose-send');
    expect(screen.queryByTestId('compose-editing-scheduled')).toBeNull();
    const snapshot = await snapshotRef.current();
    expect(snapshot).not.toHaveProperty('_editScheduledId');
    expect(snapshot).not.toHaveProperty('_editScheduledRow');
  });

  it('shows a refused save as its message and keeps the window open', async () => {
    const onClose = vi.fn();
    const onSchedule = vi.fn().mockRejectedValue(
      new Error('E_SCHEDULED_NOT_EDITABLE: This scheduled email is already being sent or is no longer scheduled'),
    );
    render(<ComposeModal initialData={initialData} onClose={onClose} onSchedule={onSchedule} onSaveState={() => {}} />);
    fireEvent.click(await screen.findByTestId('compose-schedule-toggle'));
    fireEvent.click(await screen.findByTestId('compose-schedule-submit'));

    const error = await screen.findByTestId('compose-error');
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ _editScheduledId: 'row-1' }));
    // tErr, not the raw daemon string: the E_ code is gone, the sentence stays.
    expect(error.textContent).toBe('This scheduled email is already being sent or is no longer scheduled');
    expect(onClose).not.toHaveBeenCalled();
  });
});
