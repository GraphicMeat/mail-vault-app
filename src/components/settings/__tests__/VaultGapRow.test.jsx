// @vitest-environment jsdom

/**
 * Settings > Backup, per account: the copies the app has shown or cached that
 * the vault does not hold, and "Save them now" (Phase 5, D7).
 *
 * The daemon counts (`vault_gap_count`) and saves (`vault_gap_save`, which
 * reports through the backup's own `backup-progress` frames and stops on
 * `backup_cancel`). These specs drive the row with the daemon's exact reply
 * shapes (src-daemon/src/vault_gap.rs) and pin the rules the row must keep:
 * never "everything is in your vault" when the count is a floor, unknown,
 * taken from an unreachable vault, or for a mode that keeps no copies; the
 * words say "copies"; every daemon code becomes catalog words.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';

// Every `backup-progress` subscriber, so a spec can send the daemon's frames.
const handlers = {};
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, cb) => {
    (handlers[name] ||= new Set()).add(cb);
    return () => handlers[name].delete(cb);
  }),
}));

const sendMock = vi.fn();
vi.mock('../../../services/transport', () => ({ send: (...a) => sendMock(...a) }));
const resolveServerAccount = vi.fn();
vi.mock('../../../services/authUtils', () => ({ resolveServerAccount: (...a) => resolveServerAccount(...a) }));

const { default: VaultGapRow, errorKey } = await import('../VaultGapRow');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { useBackupStore } = await import('../../../stores/backupStore');
const { default: en } = await import('../../../i18n/locales/en.json');

const LUKE = { id: 'acc-luke', email: 'luke@mock.test', password: 'pw' };
const VADER = { id: 'acc-vader', email: 'vader@mock.test', password: 'pw' };
const OUTLOOK = { id: 'acc-outlook', email: 'o@outlook.test', authType: 'oauth2', oauth2Transport: 'graph', oauth2AccessToken: 'a.b.c' };

const NONE = en['settings.backup.vaultGap.none'];
// Keep Recent (the default mode, a 3-month window in these specs) leaves older
// mail on the server by design: its all-saved line names the window.
const NONE_RECENT = en['settings.backup.vaultGap.noneRecent_other'].replace('{{count}}', '3');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Either all-saved line: the ones a row must never show when it cannot know.
const ALL_SAVED = new RegExp(`${escape(NONE)}|${escape(NONE_RECENT)}`);
const PARTIAL = en['settings.backup.vaultGap.partial'];
const UNAVAILABLE = en['errors.E_VAULT_UNAVAILABLE'];

/** The daemon's success reply (vault_gap.rs `count`). */
const reply = (over = {}) => ({ count: 0, vaultReachable: true, partial: false, byMailbox: [], ...over });

// accountId -> the count reply, or an Error to reject with, or a Promise.
let counts;
let saveReply;

const row = (id = LUKE.id) => document.querySelector(`[data-testid="vault-gap-row"][data-account-id="${id}"]`);
const saveButton = (id = LUKE.id) => row(id).querySelector('[data-testid="vault-gap-save"]');
const cancelButton = (id = LUKE.id) => row(id).querySelector('[data-testid="vault-gap-cancel"]');
const progress = (id = LUKE.id) => row(id).querySelector('[data-testid="vault-gap-progress"]');
const calls = (method) => sendMock.mock.calls.filter(([m]) => m === method);
const countCalls = (id = LUKE.id) => calls('vault_gap_count').filter(([, p]) => p.accountId === id).length;

async function listening() {
  await waitFor(() => expect(handlers['backup-progress']?.size).toBeGreaterThan(0));
}
const frame = (payload) => act(() => { for (const cb of handlers['backup-progress'] || []) cb({ payload }); });
/** The daemon's frame as a folder starts (snake_case `BackupProgress`). */
const activeFrame = (over = {}) => ({
  account_id: LUKE.id, folder: 'INBOX', total_folders: 2, completed_folders: 0,
  total_emails: 0, completed_emails: 0, errors: 0, active: true, missing_in_folder: 3,
  cancelled: false, success: true, ...over,
});
/** Its terminal frame. */
const lastFrame = (over = {}) => ({
  account_id: LUKE.id, folder: 'Complete', total_folders: 2, completed_folders: 2,
  total_emails: 0, completed_emails: 3, errors: 0, active: false, last_error: null,
  missing_in_folder: 0, cancelled: false, success: true, ...over,
});

async function renderRow(account = LUKE, state) {
  const view = render(<VaultGapRow account={account} />);
  if (state) await waitFor(() => expect(row(account.id).dataset.state).toBe(state));
  return view;
}

async function clickSave(id = LUKE.id) {
  await listening();
  fireEvent.click(saveButton(id));
  await waitFor(() => expect(resolveServerAccount).toHaveBeenCalled());
}

let settingsSnapshot;
beforeEach(() => {
  vi.clearAllMocks();
  for (const name of Object.keys(handlers)) delete handlers[name];
  counts = {};
  saveReply = { runId: LUKE.id, started: true };
  sendMock.mockImplementation(async (method, params) => {
    if (method === 'vault_gap_count') {
      const r = counts[params.accountId];
      if (r instanceof Error) throw r;
      return r;
    }
    if (method === 'vault_gap_save') {
      if (saveReply instanceof Error) throw saveReply;
      return saveReply;
    }
    if (method === 'backup_cancel') return { cancelled: true };
    throw new Error(`unexpected ${method}`);
  });
  resolveServerAccount.mockImplementation(async (id, account) => ({ ok: true, account: { ...account, resolved: true }, source: 'store' }));
  settingsSnapshot = useSettingsStore.getState();
  useSettingsStore.setState({ language: 'en', fetchMode: 'keepRecent', fetchModes: {}, hiddenAccounts: {}, localCacheDurationMonths: 3 });
  useBackupStore.setState({ activeBackup: null, queue: [] });
});
afterEach(() => {
  cleanup();
  useBackupStore.setState({ activeBackup: null, queue: [] });
  useSettingsStore.setState(settingsSnapshot, true);
});

describe('VaultGapRow - the count', () => {
  it('shows each account its own count from the daemon, in copies', async () => {
    counts = {
      [LUKE.id]: reply({ count: 3, byMailbox: [{ mailbox: 'INBOX', count: 2, partial: false }, { mailbox: 'Work', count: 1, partial: false }] }),
      [VADER.id]: reply({ count: 1, byMailbox: [{ mailbox: 'INBOX', count: 1, partial: false }] }),
    };
    render(<><VaultGapRow account={LUKE} /><VaultGapRow account={VADER} /></>);
    await waitFor(() => expect(row(LUKE.id).dataset.state).toBe('missing'));
    await waitFor(() => expect(row(VADER.id).dataset.state).toBe('missing'));

    expect(row(LUKE.id).textContent).toContain('3 copies are not in your vault yet');
    expect(row(VADER.id).textContent).toContain('1 copy is not in your vault yet');
    expect(row(LUKE.id).dataset.count).toBe('3');
    expect(row(VADER.id).dataset.count).toBe('1');
    expect(sendMock).toHaveBeenCalledWith('vault_gap_count', { accountId: LUKE.id });
    expect(sendMock).toHaveBeenCalledWith('vault_gap_count', { accountId: VADER.id });
    expect(calls('vault_gap_count')).toHaveLength(2);
    expect(saveButton(LUKE.id).disabled).toBe(false);
    expect(row(LUKE.id).textContent).not.toMatch(ALL_SAVED);
  });

  it('while the daemon counts, it says so and offers nothing to save', async () => {
    counts = { [LUKE.id]: new Promise(() => {}) };
    await renderRow(LUKE, 'loading');
    expect(row().textContent).toContain(en['settings.daemon.checking']);
    expect(row().textContent).not.toMatch(ALL_SAVED);
    // No count yet is not a count that failed.
    expect(row().querySelector('[data-testid="vault-gap-reason"]')).toBe(null);
    expect(row().textContent).not.toContain(en['settings.backup.vaultGap.countFailed']);
    expect(saveButton().disabled).toBe(true);
  });

  it('nothing missing, complete, reachable, in Hoarder: every copy is in the vault', async () => {
    useSettingsStore.setState({ fetchModes: { [LUKE.id]: 'hoarder' } });
    counts = { [LUKE.id]: reply({ count: 0 }) };
    await renderRow(LUKE, 'none');
    expect(row().textContent).toContain('Every copy this app has shown or cached is in your vault.');
    expect(row().textContent).toContain(en['settings.backup.vaultGap.hint']);
    expect(row().dataset.count).toBe('0');
    expect(row().querySelector('[data-testid="vault-gap-count"]')).toBe(null);
    expect(saveButton().disabled).toBe(true);
  });

  // The daemon leaves out mail dated before the Keep Recent window on purpose
  // (the mode leaves it on the server), so "every copy" would claim too much.
  it('under Keep Recent the all-saved line and the hint name the window, and say older mail stays on the server', async () => {
    counts = { [LUKE.id]: reply({ count: 0 }) };
    await renderRow(LUKE, 'none');
    expect(row().textContent).toContain('Every copy from the last 3 months is in your vault. Older mail stays on the server under your download mode.');
    expect(row().textContent).toContain(en['settings.backup.vaultGap.hintRecent_other'].replace('{{count}}', '3'));
    expect(row().textContent).not.toContain(NONE);
    expect(row().textContent).not.toContain(en['settings.backup.vaultGap.hint']);
  });

  it('a one-month window reads in the singular', async () => {
    useSettingsStore.setState({ localCacheDurationMonths: 1 });
    counts = { [LUKE.id]: reply({ count: 0 }) };
    await renderRow(LUKE, 'none');
    expect(row().textContent).toContain(en['settings.backup.vaultGap.noneRecent_one'].replace('{{count}}', '1'));
  });

  it('a Keep Recent window of 0 keeps everything: the plain line', async () => {
    useSettingsStore.setState({ localCacheDurationMonths: 0, fetchMode: 'keepRecent' });
    counts = { [LUKE.id]: reply({ count: 0 }) };
    await renderRow(LUKE, 'none');
    expect(row().textContent).toContain(NONE);
    expect(row().textContent).toContain(en['settings.backup.vaultGap.hint']);
  });
});

describe('VaultGapRow - an unreachable vault', () => {
  it('shows the count with its reason, and cannot save into it', async () => {
    counts = { [LUKE.id]: reply({ count: 4, vaultReachable: false, reason: 'E_VAULT_UNAVAILABLE' }) };
    await renderRow(LUKE, 'unreachable');
    expect(row().textContent).toContain('4 copies are not in your vault yet');
    expect(row().querySelector('[data-testid="vault-gap-reason"]').textContent).toBe(UNAVAILABLE);
    expect(saveButton().disabled).toBe(true);
  });

  it('with nothing missing, still shows the reason and never the everything-is-in-your-vault line', async () => {
    counts = { [LUKE.id]: reply({ count: 0, vaultReachable: false, reason: 'E_VAULT_UNAVAILABLE' }) };
    await renderRow(LUKE, 'unreachable');
    expect(row().textContent).toContain(UNAVAILABLE);
    expect(row().textContent).not.toMatch(ALL_SAVED);
    expect(saveButton().disabled).toBe(true);
  });

  it('a count the daemon could not make shows only the reason', async () => {
    counts = { [LUKE.id]: { count: null, vaultReachable: false, reason: 'E_VAULT_UNAVAILABLE', partial: true, byMailbox: [] } };
    await renderRow(LUKE, 'unknown');
    expect(row().querySelector('[data-testid="vault-gap-reason"]').textContent).toBe(UNAVAILABLE);
    expect(row().querySelector('[data-testid="vault-gap-count"]')).toBe(null);
    expect(row().textContent).not.toMatch(ALL_SAVED);
    // `partial` is always true with a null count: the reason is the whole story.
    expect(row().textContent).not.toContain(PARTIAL);
    expect(row().dataset.count).toBe('');
    expect(saveButton().disabled).toBe(true);
  });

  it('an unreadable header cache on a reachable vault says so in its own words', async () => {
    counts = { [LUKE.id]: { count: null, vaultReachable: true, reason: 'E_HEADER_CACHE_UNAVAILABLE', partial: true, byMailbox: [] } };
    await renderRow(LUKE, 'unknown');
    expect(row().querySelector('[data-testid="vault-gap-reason"]').textContent).toBe(en['errors.E_HEADER_CACHE_UNAVAILABLE']);
    expect(saveButton().disabled).toBe(true);
  });

  it('a reason code it does not know reads as catalog words, never a raw key or code', async () => {
    counts = { [LUKE.id]: { count: null, vaultReachable: false, reason: 'E_SOMETHING_NEWER', partial: true, byMailbox: [] } };
    await renderRow(LUKE, 'unknown');
    expect(row().textContent).toContain(UNAVAILABLE);
    expect(row().textContent).not.toMatch(/E_SOMETHING_NEWER|errors\./);
  });

  it('a reply with no count and no reason says the count failed', async () => {
    counts = { [LUKE.id]: {} };
    await renderRow(LUKE, 'unknown');
    expect(row().textContent).toContain(en['settings.backup.vaultGap.countFailed']);
    expect(row().textContent).not.toMatch(ALL_SAVED);
  });
});

describe('VaultGapRow - a count that is only a floor', () => {
  it('reads as at least N, says why, and can still save what it knows', async () => {
    counts = { [LUKE.id]: reply({ count: 5, partial: true, byMailbox: [{ mailbox: 'INBOX', count: 5, partial: true }] }) };
    await renderRow(LUKE, 'partial');
    expect(row().textContent).toContain('At least 5 copies are not in your vault yet');
    expect(row().textContent).toContain(PARTIAL);
    expect(saveButton().disabled).toBe(false);
  });

  it('a floor of zero is not everything in the vault', async () => {
    counts = { [LUKE.id]: reply({ count: 0, partial: true, byMailbox: [{ mailbox: 'INBOX', count: 0, partial: true }] }) };
    await renderRow(LUKE, 'partial');
    expect(row().textContent).toContain(PARTIAL);
    expect(row().textContent).not.toMatch(ALL_SAVED);
    expect(row().querySelector('[data-testid="vault-gap-count"]')).toBe(null);
    expect(saveButton().disabled).toBe(true);
  });
});

describe('VaultGapRow - download modes that keep no copies', () => {
  it.each([
    ['On Demand for the account', { fetchModes: { [LUKE.id]: 'onDemand' } }],
    ['Index Only by default', { fetchMode: 'indexOnly' }],
    ['a hidden account', { hiddenAccounts: { [LUKE.id]: true } }],
  ])('%s says the mode keeps no copies, and is never counted', async (_, settings) => {
    useSettingsStore.setState(settings);
    counts = { [LUKE.id]: reply({ count: 0 }) };
    await renderRow(LUKE, 'byDesign');
    expect(row().textContent).toContain(en['settings.backup.vaultGap.byDesign']);
    expect(row().textContent).not.toMatch(ALL_SAVED);
    // Nothing is counted by design: no "could not be counted" beside it.
    expect(row().querySelector('[data-testid="vault-gap-reason"]')).toBe(null);
    expect(row().textContent).not.toContain(en['settings.backup.vaultGap.countFailed']);
    expect(saveButton().disabled).toBe(true);
    expect(countCalls()).toBe(0);
  });

  it.each([
    ['Keep Recent', { fetchMode: 'keepRecent' }],
    ['Hoarder for the account', { fetchModes: { [LUKE.id]: 'hoarder' } }],
    ['On Demand for another account only', { fetchModes: { [VADER.id]: 'onDemand' } }],
  ])('%s is counted', async (_, settings) => {
    useSettingsStore.setState(settings);
    counts = { [LUKE.id]: reply({ count: 2 }) };
    await renderRow(LUKE, 'missing');
    expect(countCalls()).toBe(1);
  });
});

describe('VaultGapRow - an Outlook account', () => {
  it('shows its count but cannot save here, and says why', async () => {
    counts = { [OUTLOOK.id]: reply({ count: 2 }) };
    await renderRow(OUTLOOK, 'missing');
    expect(row(OUTLOOK.id).textContent).toContain('2 copies are not in your vault yet');
    expect(row(OUTLOOK.id).textContent).toContain(en['errors.E_VAULT_GAP_GRAPH']);
    expect(saveButton(OUTLOOK.id).disabled).toBe(true);
    fireEvent.click(saveButton(OUTLOOK.id));
    expect(calls('vault_gap_save')).toHaveLength(0);
    expect(resolveServerAccount).not.toHaveBeenCalled();
  });
});

describe('VaultGapRow - Save them now', () => {
  it('sends the account the backup would send, freshly resolved, once', async () => {
    counts = { [LUKE.id]: reply({ count: 3 }) };
    resolveServerAccount.mockResolvedValue({ ok: true, account: { ...LUKE, oauth2AccessToken: 'fresh' }, source: 'refreshed' });
    await renderRow(LUKE, 'missing');
    await clickSave();

    await waitFor(() => expect(calls('vault_gap_save')).toHaveLength(1));
    expect(resolveServerAccount).toHaveBeenCalledWith(LUKE.id, LUKE);
    expect(calls('vault_gap_save')[0][1]).toEqual({ accountId: LUKE.id, accountJson: JSON.stringify({ ...LUKE, oauth2AccessToken: 'fresh' }) });
    // Running: held, cancellable, and waiting for the daemon's first frame.
    expect(row().dataset.running).toBe('true');
    expect(saveButton().disabled).toBe(true);
    expect(cancelButton()).not.toBe(null);
    expect(progress().textContent).toContain(en['settings.migration.starting']);
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(calls('vault_gap_save')).toHaveLength(1);
  });

  it('Cancel stops it through the backup cancel, and the last frame ends it', async () => {
    counts = { [LUKE.id]: reply({ count: 3 }) };
    await renderRow(LUKE, 'missing');
    await clickSave();
    await waitFor(() => expect(cancelButton()).not.toBe(null));
    await waitFor(() => expect(calls('vault_gap_save')).toHaveLength(1));

    fireEvent.click(cancelButton());
    await waitFor(() => expect(calls('backup_cancel')).toHaveLength(1));
    expect(calls('backup_cancel')[0][1]).toEqual({ accountId: LUKE.id });
    // The row follows the daemon, not the button.
    expect(row().dataset.running).toBe('true');

    counts = { [LUKE.id]: reply({ count: 2 }) };
    frame(lastFrame({ folder: 'Cancelled', cancelled: true, success: false, completed_emails: 1 }));
    await waitFor(() => expect(row().dataset.running).toBe('false'));
    await waitFor(() => expect(row().dataset.count).toBe('2'));
    expect(progress()).toBe(null);
    expect(cancelButton()).toBe(null);
    expect(saveButton().disabled).toBe(false);
  });

  it('a backup running or queued for the account holds it', async () => {
    counts = { [LUKE.id]: reply({ count: 3 }) };
    await renderRow(LUKE, 'missing');
    expect(saveButton().disabled).toBe(false);

    act(() => useBackupStore.setState({ activeBackup: { accountId: LUKE.id, active: true } }));
    expect(saveButton().disabled).toBe(true);
    // The three-second Complete tail is not a live run.
    act(() => useBackupStore.setState({ activeBackup: { accountId: LUKE.id, active: true, done: true } }));
    expect(saveButton().disabled).toBe(false);
    act(() => useBackupStore.setState({ activeBackup: { accountId: VADER.id, active: true } }));
    expect(saveButton().disabled).toBe(false);
    act(() => useBackupStore.setState({ activeBackup: null, queue: [VADER.id, LUKE.id] }));
    expect(saveButton().disabled).toBe(true);
  });

  it('an account whose credentials cannot be resolved is not sent, and the user is told to sign in again', async () => {
    counts = { [LUKE.id]: reply({ count: 3 }) };
    resolveServerAccount.mockResolvedValue({ ok: false, reason: 'missing_credentials', message: 'Credentials unavailable \u2014 retry keychain access' });
    await renderRow(LUKE, 'missing');
    await clickSave();

    await waitFor(() => expect(row().textContent).toContain(en['errors.conn.recovery.signAgainReconnectAccount']));
    expect(calls('vault_gap_save')).toHaveLength(0);
    expect(row().textContent).not.toContain('Credentials unavailable');
    expect(row().dataset.running).toBe('false');
    expect(saveButton().disabled).toBe(false);
  });

  it.each([
    ['E_VAULT_UNAVAILABLE: Mail storage folder unavailable: /Volumes/Gone', 'errors.E_VAULT_UNAVAILABLE', '/Volumes/Gone'],
    ['E_VAULT_GAP_GRAPH: an Outlook account\'s missing messages are saved by its backup', 'errors.E_VAULT_GAP_GRAPH', 'saved by its backup'],
    ['E_ACCOUNT_NOT_FOUND: acc-luke', 'errors.E_ACCOUNT_NOT_FOUND', 'acc-luke'],
    ['E_HEADER_CACHE_UNAVAILABLE: database is locked', 'errors.E_HEADER_CACHE_UNAVAILABLE', 'database is locked'],
    ['Bad account JSON: expected value at line 1', 'settings.backup.vaultGap.saveFailed', 'Bad account JSON'],
  ])('a refused save (%s) shows catalog words, never the daemon text', async (refusal, key, detail) => {
    counts = { [LUKE.id]: reply({ count: 3 }) };
    saveReply = new Error(refusal);
    await renderRow(LUKE, 'missing');
    await clickSave();

    await waitFor(() => expect(row().textContent).toContain(en[key]));
    expect(row().textContent).not.toContain(detail);
    expect(row().dataset.running).toBe('false');
    expect(progress()).toBe(null);
  });

  it('joining a backup already running follows it, without offering to cancel it', async () => {
    counts = { [LUKE.id]: reply({ count: 3 }) };
    saveReply = { runId: LUKE.id, started: false, running: true };
    await renderRow(LUKE, 'missing');
    await clickSave();

    await waitFor(() => expect(progress().textContent).toContain(en['settings.backup.vaultGap.joined']));
    expect(cancelButton()).toBe(null);
    expect(saveButton().disabled).toBe(true);

    counts = { [LUKE.id]: reply({ count: 0 }) };
    frame(lastFrame());
    await waitFor(() => expect(row().dataset.state).toBe('none'));
    expect(row().dataset.running).toBe('false');
  });
});

describe('VaultGapRow - progress', () => {
  it('renders the save\'s frames: folder, folders done, copies saved, and a bar', async () => {
    counts = { [LUKE.id]: reply({ count: 9 }) };
    await renderRow(LUKE, 'missing');
    await clickSave();
    await waitFor(() => expect(calls('vault_gap_save')).toHaveLength(1));

    frame(activeFrame({ folder: 'INBOX', total_folders: 4, completed_folders: 1, completed_emails: 7 }));
    await waitFor(() => expect(progress().textContent).toContain('INBOX (1 of 4 folders), 7 saved'));
    expect(progress().querySelector('[data-testid="vault-gap-bar"]').style.width).toBe('25%');

    // Another account's run is not this one.
    frame(activeFrame({ account_id: VADER.id, folder: 'Other', completed_emails: 99 }));
    expect(progress().textContent).toContain('INBOX (1 of 4 folders), 7 saved');

    // The folder is shown by its name, not its IMAP modified UTF-7 wire form.
    frame(activeFrame({ folder: 'Entw&APw-rfe', total_folders: 4, completed_folders: 2, completed_emails: 8 }));
    await waitFor(() => expect(progress().textContent).toContain('Entwürfe (2 of 4 folders), 8 saved'));
    expect(progress().querySelector('[data-testid="vault-gap-bar"]').style.width).toBe('50%');
  });

  it('the last frame ends the save and counts again: nothing left is everything in the vault', async () => {
    counts = { [LUKE.id]: reply({ count: 3 }) };
    await renderRow(LUKE, 'missing');
    await clickSave();
    await waitFor(() => expect(calls('vault_gap_save')).toHaveLength(1));
    frame(activeFrame());
    expect(countCalls()).toBe(1);

    counts = { [LUKE.id]: reply({ count: 0 }) };
    frame(lastFrame({ completed_emails: 3 }));
    await waitFor(() => expect(row().dataset.state).toBe('none'));
    expect(countCalls()).toBe(2);
    expect(row().textContent).toContain(NONE_RECENT);
    expect(progress()).toBe(null);
    expect(saveButton().disabled).toBe(true);
  });

  it('copies that could not be saved are said, and stay counted', async () => {
    counts = { [LUKE.id]: reply({ count: 5 }) };
    await renderRow(LUKE, 'missing');
    await clickSave();
    await waitFor(() => expect(calls('vault_gap_save')).toHaveLength(1));

    counts = { [LUKE.id]: reply({ count: 2 }) };
    frame(lastFrame({ completed_emails: 3, errors: 2, last_error: '2 of 5 messages could not be fetched. Last error: UID FETCH 9 failed' }));
    await waitFor(() => expect(row().dataset.count).toBe('2'));
    expect(row().textContent).toContain('2 copies could not be saved. They stay counted here.');
    expect(row().textContent).toContain('2 copies are not in your vault yet');
    expect(row().textContent).not.toContain('UID FETCH');
  });

  it('a save that died before its last frame shows catalog words for its code', async () => {
    counts = { [LUKE.id]: reply({ count: 3 }) };
    await renderRow(LUKE, 'missing');
    await clickSave();
    await waitFor(() => expect(calls('vault_gap_save')).toHaveLength(1));

    frame(lastFrame({ folder: 'Error', success: false, cancelled: false, completed_emails: 0, last_error: 'E_HEADER_CACHE_UNAVAILABLE: database is locked' }));
    await waitFor(() => expect(row().textContent).toContain(en['errors.E_HEADER_CACHE_UNAVAILABLE']));
    expect(row().textContent).not.toContain('database is locked');
    expect(row().dataset.running).toBe('false');
  });

  it('a last frame that lands before the daemon\'s answer does not leave the row saving', async () => {
    counts = { [LUKE.id]: reply({ count: 3 }) };
    let answer;
    saveReply = new Promise((resolve) => { answer = resolve; });
    await renderRow(LUKE, 'missing');
    await clickSave();
    await waitFor(() => expect(calls('vault_gap_save')).toHaveLength(1));

    counts = { [LUKE.id]: reply({ count: 0 }) };
    frame(lastFrame());
    await act(async () => { answer({ runId: LUKE.id, started: true }); });
    await waitFor(() => expect(row().dataset.state).toBe('none'));
    expect(row().dataset.running).toBe('false');
    expect(progress()).toBe(null);
  });

  it('a backup of the account that ends elsewhere counts again; another account\'s does not', async () => {
    counts = { [LUKE.id]: reply({ count: 3 }) };
    await renderRow(LUKE, 'missing');
    await listening();

    frame(lastFrame({ account_id: VADER.id }));
    await act(async () => {});
    expect(countCalls()).toBe(1);

    counts = { [LUKE.id]: reply({ count: 1 }) };
    frame(lastFrame());
    await waitFor(() => expect(row().dataset.count).toBe('1'));
    expect(countCalls()).toBe(2);
    // Not this row's save: no outcome line of its own, and nothing was saving.
    expect(row().textContent).not.toContain('could not be saved');
    expect(row().dataset.running).toBe('false');
  });
});

describe('VaultGapRow - counts again when the panel opens', () => {
  it('asks the daemon on every mount', async () => {
    counts = { [LUKE.id]: reply({ count: 3 }) };
    const first = await renderRow(LUKE, 'missing');
    first.unmount();
    expect(countCalls()).toBe(1);

    counts = { [LUKE.id]: reply({ count: 0 }) };
    await renderRow(LUKE, 'none');
    expect(countCalls()).toBe(2);
  });

  it('a slower earlier answer never overwrites a newer one', async () => {
    let early;
    counts = { [LUKE.id]: new Promise((resolve) => { early = resolve; }) };
    await renderRow(LUKE, 'loading');
    await listening();

    counts = { [LUKE.id]: reply({ count: 0 }) };
    frame(lastFrame());
    await waitFor(() => expect(row().dataset.state).toBe('none'));
    await act(async () => { early(reply({ count: 9 })); });
    expect(row().dataset.state).toBe('none');
    expect(row().dataset.count).toBe('0');
  });
});

describe('VaultGapRow - daemon codes as catalog words', () => {
  it.each([
    ['E_ACCOUNT_NOT_FOUND: acc-luke', 'errors.E_ACCOUNT_NOT_FOUND', 'acc-luke'],
    ['E_HEADER_CACHE_UNAVAILABLE: closed', 'errors.E_HEADER_CACHE_UNAVAILABLE', 'closed'],
    ['custody store unavailable: closed', 'settings.backup.vaultGap.countFailed', 'custody store'],
    ['Missing accountId', 'settings.backup.vaultGap.countFailed', 'Missing accountId'],
  ])('a refused count (%s) shows catalog words, never the daemon text', async (refusal, key, detail) => {
    counts = { [LUKE.id]: new Error(refusal) };
    await renderRow(LUKE, 'error');
    expect(row().textContent).toContain(en[key]);
    expect(row().textContent).not.toContain(detail);
    expect(row().textContent).not.toMatch(ALL_SAVED);
    expect(saveButton().disabled).toBe(true);
  });

  it('matches a code only whole, at the start, bare or before its colon', () => {
    expect(errorKey('E_VAULT_UNAVAILABLE', 'f')).toBe('errors.E_VAULT_UNAVAILABLE');
    expect(errorKey(new Error('E_VAULT_GAP_GRAPH: detail'), 'f')).toBe('errors.E_VAULT_GAP_GRAPH');
    expect(errorKey({ message: 'E_ACCOUNT_NOT_FOUND: x' }, 'f')).toBe('errors.E_ACCOUNT_NOT_FOUND');
    expect(errorKey('see E_VAULT_UNAVAILABLE: detail', 'f')).toBe('f');
    expect(errorKey('E_VAULT_UNAVAILABLE_LATER: detail', 'f')).toBe('f');
    expect(errorKey('E_MBOX_UPLOAD_READ: not this row\'s', 'f')).toBe('f');
    expect(errorKey(undefined, 'f')).toBe('f');
    expect(errorKey(null, 'f')).toBe('f');
  });

  it('every code it maps is an English catalog entry', () => {
    for (const code of ['E_ACCOUNT_NOT_FOUND', 'E_HEADER_CACHE_UNAVAILABLE', 'E_VAULT_GAP_GRAPH', 'E_VAULT_UNAVAILABLE']) {
      const key = errorKey(`${code}: x`, null);
      expect(key).toBe(`errors.${code}`);
      expect(String(en[key] || '').trim()).not.toBe('');
    }
  });
});
