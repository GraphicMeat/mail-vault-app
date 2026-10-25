// @vitest-environment jsdom
//
// "You mentioned an attachment": Send on a message that talks about one and
// carries none asks first (Premium). Send anyway sends; Attach file opens the
// picker and sends nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';

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
  RichTextEditor: ({ content, onUpdate }) => React.createElement('textarea', { 'data-testid': 'editor-stub', value: content || '', onChange: e => onUpdate(e.target.value) }),
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
const settingListeners = new Set();
const accountListeners = new Set();
vi.mock('../../stores/mailStore', () => {
  const hook = vi.fn((selector) => selector(mail));
  hook.getState = () => mail;
  hook.setState = vi.fn();
  hook.subscribe = callback => { accountListeners.add(callback); return () => accountListeners.delete(callback); };
  return { useMailStore: hook };
});
vi.mock('../../stores/accountStore', () => ({ useAccountStore: (selector) => selector(mail) }));
vi.mock('../../stores/settingsStore', () => {
  const hook = vi.fn((selector) => selector(settings));
  hook.getState = () => settings;
  hook.subscribe = callback => { settingListeners.add(callback); return () => settingListeners.delete(callback); };
  return {
    useSettingsStore: hook,
    hasPremiumAccess: () => premium.on,
    isTrackerBlockingActive: () => false,
  };
});

const { checkCompose } = vi.hoisted(() => ({ checkCompose: vi.fn() }));
vi.mock('../../services/composePrep', async original => ({ ...(await original()), checkCompose }));
const { checkDemoCompose } = await import('../../demo/composePrep');
const { ComposeModal } = await import('../ComposeModal');

function open(body, extra = {}) {
  const onClose = vi.fn();
  const view = render(
    <ComposeModal
      mode="new"
      initialData={{ to: 'them@example.test', subject: 'Hi', body, ...extra }}
      onClose={onClose} onMinimize={() => {}} onSaveState={() => {}}
    />,
  );
  return { onClose, replaceSource: source => view.rerender(<ComposeModal mode="new" initialData={{ to: 'them@example.test', subject: 'Hi', body, ...extra, _replyTo: source }} onClose={onClose} onMinimize={() => {}} onSaveState={() => {}} />) };
}

beforeEach(() => {
  queueSend.mockClear();
  checkCompose.mockReset();
  checkCompose.mockImplementation(async input => checkDemoCompose({ ...input, scheduleDraft: input.scheduleDraft && { localTime: input.scheduleDraft.localTime, tz: input.scheduleDraft.tz }, requestId: 'check', expectedSettingsVersion: 1 }, {
    accounts: mail.accounts, values: { 'mailvault-settings': { state: { ...settings, billingProfile: premium.on ? { hasSubscription: true, status: 'active' } : null } } }, version: 1, now: Date.now(),
  }));
  mail.accounts = [account];
  premium.on = true;
  settings.attachmentReminder = true;
  settings.displayNames = {};
  settings.sendDelay = 0;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

// Row 13 characterization: execute the real handleSend, not a reimplementation.
describe('current compose validation order', () => {
  it.each([
    [{ to: '', cc: 'bad-cc', bcc: 'bad-bcc' }, 'compose.pleaseEnterLeastOneRecipient', {}],
    [{ to: 'bad-to', cc: 'bad-cc', bcc: 'bad-bcc' }, 'compose.invalidRecipient', { address: 'bad-to' }],
    [{ to: 'ok@example.test', cc: 'bad-cc', bcc: 'bad-bcc' }, 'compose.invalidRecipient', { address: 'bad-cc' }],
    [{ to: 'ok@example.test', cc: '', bcc: 'bad-bcc' }, 'compose.invalidRecipient', { address: 'bad-bcc' }],
  ])('validates recipient fields before account, reminder and expired plan: %j', async (fields, key, args) => {
    const { t } = await import('../../i18n');
    mail.accounts = [];
    open('<p>attached</p>', { ...fields, _sendPlan: { kind: 'at' }, _scheduleDraft: { localTime: '2000-01-01T00:00', tz: 'UTC' } });
    fireEvent.submit(screen.getByTestId('compose-send').closest('form'));
    expect(await screen.findByText(t(key, args))).toBeTruthy();
    expect(screen.queryByTestId('compose-attachment-reminder')).toBeNull();
    expect(queueSend).not.toHaveBeenCalled();
  });
  it('requires an account before asking about attachment or an expired plan', async () => {
    const { t } = await import('../../i18n');
    mail.accounts = [];
    open('<p>attached</p>', { _sendPlan: { kind: 'at' }, _scheduleDraft: { localTime: '2000-01-01T00:00', tz: 'UTC' } });
    fireEvent.submit(screen.getByTestId('compose-send').closest('form'));
    expect(await screen.findByText(t('compose.noAccountSelected'))).toBeTruthy();
    expect(screen.queryByTestId('compose-attachment-reminder')).toBeNull();
  });
  it('asks about attachment before rejecting an expired absolute plan', async () => {
    open('<p>attached</p>', { _sendPlan: { kind: 'at' }, _scheduleDraft: { localTime: '2000-01-01T00:00', tz: 'UTC' } });
    fireEvent.click(await screen.findByTestId('compose-send'));
    expect(await screen.findByTestId('compose-attachment-reminder')).toBeTruthy();
    fireEvent.click(screen.getByTestId('compose-attachment-reminder-send'));
    const { t } = await import('../../i18n');
    expect(await screen.findByText(t('scheduled.picker.pastTime'))).toBeTruthy();
    expect(queueSend).not.toHaveBeenCalled();
  });
});

describe('checked send attempt lifetime', () => {
  it('does not send while the native check is pending or after an edit', async () => {
    let finish;
    checkCompose.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    open('<p>Complete body</p>');
    fireEvent.submit(screen.getByTestId('compose-send').closest('form'));
    await act(async () => {});
    expect(queueSend).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('compose-subject'), { target: { value: 'Changed' } });
    await act(async () => finish({ kind: 'ready', route: { delay: null } }));
    expect(queueSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('compose-subject').value).toBe('Changed');
  });
  it('claims form and shortcut submission synchronously', async () => {
    open('<p>Complete body</p>');
    const form = screen.getByTestId('compose-send').closest('form');
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.keyDown(screen.getByTestId('compose-subject'), { key: 'Enter', shiftKey: true });
    });
    await waitFor(() => expect(queueSend).toHaveBeenCalledTimes(1));
  });
});

describe('same-snapshot confirmation and failures', () => {
  it('does not carry Send anyway across an edit away and back', async () => {
    open('<p>attached</p>');
    fireEvent.click(screen.getByTestId('compose-send'));
    await screen.findByTestId('compose-attachment-reminder');
    fireEvent.change(screen.getByTestId('compose-subject'), { target: { value: 'Other' } });
    fireEvent.change(screen.getByTestId('compose-subject'), { target: { value: 'Hi' } });
    fireEvent.click(screen.getByTestId('compose-attachment-reminder-send'));
    await waitFor(() => expect(checkCompose).toHaveBeenCalledTimes(2));
    expect(checkCompose.mock.calls[1][0].sendAnyway).toBe(false);
    expect(queueSend).not.toHaveBeenCalled();
    expect(await screen.findByTestId('compose-attachment-reminder')).toBeTruthy();
  });
  it('retains body, explicit Bcc, quote and source attachments in a frozen handoff', async () => {
    open('<p>Full authored body</p>', { bcc: 'private@example.test', _quotedHtml: '<p>Quote</p>', attachments: [{ filename: 'source.bin', source: { uid: 42 }, content: 'AA==' }] });
    fireEvent.click(screen.getByTestId('compose-send'));
    await waitFor(() => expect(queueSend).toHaveBeenCalledTimes(1));
    const sent = queueSend.mock.calls[0][0].initialData;
    expect(sent).toMatchObject({ body: '<p>Full authored body</p>', bcc: 'private@example.test', _quotedHtml: '<p>Quote</p>', attachments: [{ source: { uid: 42 }, content: 'AA==' }] });
    expect(checkCompose.mock.calls[0][0]).toMatchObject({ authoredBodyText: 'Full authored body\n', attachmentCount: 1, revision: sent._draftRevision });
    expect(checkCompose.mock.calls[0][0].body).toBeUndefined();
  });
  it.each(['compose.preparationUnavailable', 'request timed out'])('keeps the complete draft unsent on %s', async error => {
    checkCompose.mockRejectedValue(new Error(error));
    const { onClose } = open('<p>Keep this body</p>', { bcc: 'private@example.test' });
    fireEvent.click(screen.getByTestId('compose-send'));
    await waitFor(() => expect(checkCompose).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(queueSend).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('editor-stub').value).toBe('<p>Keep this body</p>');
  });
});

describe('external authority and save boundaries', () => {
  it.each(['settings', 'account', 'unmount'])('refuses late ready after %s changes while the check is pending', async change => {
    let finish;
    checkCompose.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    open('<p>Complete body</p>');
    fireEvent.click(screen.getByTestId('compose-send'));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    await act(async () => {
      if (change === 'settings') {
        const previous = { ...settings }; settings.displayNames = { 'acct-1': 'Changed' };
        settingListeners.forEach(callback => callback(settings, previous));
      }
      if (change === 'account') {
        const previous = { ...mail }; mail.accounts = [{ ...account, name: 'Changed' }];
        accountListeners.forEach(callback => callback(mail, previous));
      }
      if (change === 'unmount') cleanup();
      finish({ kind: 'ready', route: { delay: null } });
    });
    expect(queueSend).not.toHaveBeenCalled();
  });
  it('waits the existing save without recapturing or checking changed content', async () => {
    const { saveLocalDraft } = await import('../../services/localDrafts');
    let finish;
    const { savedDraftReply } = await import('../../test/draftReply');
    saveLocalDraft.mockImplementationOnce(request => new Promise(resolve => { finish = () => resolve(savedDraftReply(request)); }));
    open('<p>Before save</p>');
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.click(screen.getByTestId('compose-send'));
    expect(checkCompose).not.toHaveBeenCalled();
    const previous = { ...settings }; settings.sendDelay = 60;
    settingListeners.forEach(callback => callback(settings, previous));
    await act(async () => finish(undefined));
    expect(checkCompose).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('editor-stub').value).toBe('<p>Before save</p>');
  });
  it('uses the returned route on a handoff copy without raising the issued cleanup bound', async () => {
    checkCompose.mockResolvedValue({ kind: 'ready', route: { delay: 300 } });
    open('<p>Body</p>', { _composeDelay: 60, _draftRevision: 3, _draftAcceptedRevision: 2, _sendPlan: { kind: 'in', minutes: 1 } });
    fireEvent.click(screen.getByTestId('compose-send'));
    await waitFor(() => expect(queueSend).toHaveBeenCalledTimes(1));
    const sent = queueSend.mock.calls[0][0].initialData;
    expect(sent._composeDelay).toBe(300);
    expect(sent._draftRevision).toBe(checkCompose.mock.calls[0][0].revision);
    expect(queueSend.mock.calls[0][2]).toBe(300);
  });
});

it('invalidates a pending check synchronously when minimizing', async () => {
  let finish;
  checkCompose.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  open('<p>Retain while minimizing</p>');
  fireEvent.click(screen.getByTestId('compose-send'));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.keyDown(document, { key: 'Escape' });
  await act(async () => finish({ kind: 'ready', route: { delay: null } }));
  expect(queueSend).not.toHaveBeenCalled();
});

it.each(['body', 'attachment'])('immediately retires a pending check on a %s edit', async field => {
  let finish;
  checkCompose.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  open('<p>Body before check</p>', { attachments: [{ filename: 'keep.bin', content: 'AA==' }] });
  fireEvent.click(screen.getByTestId('compose-send'));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  if (field === 'body') fireEvent.change(screen.getByTestId('editor-stub'), { target: { value: '<p>New body</p>' } });
  else fireEvent.click(screen.getByTitle('Remove attachment'));
  await act(async () => finish({ kind: 'ready', route: { delay: null } }));
  expect(queueSend).not.toHaveBeenCalled();
});
it('checks expiry only after the pending save settles, with the original issued source', async () => {
  const { saveLocalDraft } = await import('../../services/localDrafts');
  const { savedDraftReply } = await import('../../test/draftReply');
  const now = Date.now();
  let finish;
  saveLocalDraft.mockImplementationOnce(request => new Promise(resolve => { finish = () => resolve(savedDraftReply(request)); }));
  const localTime = new Date(now + 120_000).toISOString().slice(0, 16);
  open('<p>Saved before expiry</p>', { _sendPlan: { kind: 'at' }, _scheduleDraft: { localTime, tz: 'UTC', tzPicked: true } });
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.click(screen.getByTestId('compose-send'));
  expect(checkCompose).not.toHaveBeenCalled();
  vi.spyOn(Date, 'now').mockReturnValue(now + 180_000);
  await act(async () => finish());
  await waitFor(() => expect(checkCompose).toHaveBeenCalledTimes(1));
  const { t } = await import('../../i18n');
  expect(await screen.findByText(t('scheduled.picker.pastTime'))).toBeTruthy();
  expect(queueSend).not.toHaveBeenCalled();
  expect(checkCompose.mock.calls[0][0]).toMatchObject({ scheduleDraft: { localTime, tz: 'UTC', tzPicked: true }, sendPlan: { kind: 'at' } });
});

it('invalidates a pending check on a parent-owned source fill before native preparation returns', async () => {
  let finish;
  checkCompose.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { replaceSource } = open('<p>Complete body</p>');
  fireEvent.click(screen.getByTestId('compose-send'));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  replaceSource({ uid: 1, text: 'Complete late source' });
  await act(async () => finish({ kind: 'ready', route: { delay: null } }));
  expect(queueSend).not.toHaveBeenCalled();
});
