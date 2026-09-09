// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMailStore } from '../../stores/mailStore';
import { useThemeStore } from '../../stores/themeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { EmailViewer } from '../EmailViewer';
import InsightsMessages from '../insights/InsightsMessages';
import { cancelInsightsSelection, getSelectionGeneration } from '../../services/workflows/selectEmail';
import * as api from '../../services/api';

const { native } = vi.hoisted(() => ({ native: vi.fn(async () => null) }));
vi.mock('../../services/transport.js', () => ({ send: (...args) => native(...args) }));
vi.mock('../../services/db/accounts.js', () => ({ initDB: async () => {}, initBasic: async () => {}, accountDir: () => '' }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readDir: vi.fn(), exists: vi.fn(), BaseDirectory: {} }));
vi.mock('../email/EmailActionBar', () => ({ EmailActionBar: ({ onViewSource }) => <button onClick={onViewSource}>View source</button> }));
const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002';
const email = (id, subject) => ({ uid: 7, _accountId: id, _mailbox: 'Archive/2026', _insightsReadOnly: true,
  messageId: '<shared@test>', subject, from: { address: 'ana@example.test' }, to: [], flags: ['\\Seen'],
  date: '2026-09-08T10:00:00Z', messageDate: '2026-09-08T10:00:00Z', text: 'Reader body', attachments: [] });
const raw = subject => btoa(`From: ana@example.test\r\nSubject: ${subject}\r\nMessage-ID: <shared@test>\r\n\r\n${subject} raw bytes`);
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  native.mockReset().mockImplementation(async (command, args) => command === 'maildir_read_raw_source'
    ? raw(args.accountId === b ? 'Selected account' : 'Active account')
    : command === 'maildir_read_light' ? email(args.accountId, args.accountId === b ? 'Selected account' : 'Active account') : null);
  useMailStore.setState({ accounts: [{ id: a, email: 'a@test' }, { id: b, email: 'b@test' }], activeAccountId: a, activeMailbox: 'INBOX',
    selectedEmail: email(b, 'Selected account'), selectedEmailSource: 'local-only', selectedThread: null, loadingEmail: false,
    emails: [], sortedEmails: [], localEmails: [], sentEmails: [], savedEmailIds: new Set(), archivedEmailIds: new Set(),
    serverUids: { complete: false, uids: new Set() }, backupConfigured: false, backedUpKeys: null, backedUpScopes: null });
  useThemeStore.setState({ theme: 'light', palette: 'graphite' });
  useSettingsStore.setState({ emailViewerTheme: 'system', linkSafetyEnabled: false, signatureDisplay: 'smart' });
});
afterEach(() => { cleanup(); cancelInsightsSelection(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('shows source from the selected Insights account and folder while the mailbox stays unchanged', async () => {
  render(<EmailViewer />);
  fireEvent.click(screen.getByRole('button', { name: 'View source' }));
  expect(await screen.findByText(/Selected account raw bytes/)).toBeTruthy();
  expect(screen.queryByText(/Active account raw bytes/)).toBeNull();
  expect(useMailStore.getState().activeMailbox).toBe('INBOX');
});
it('clears cached source when another account has the same UID', async () => {
  render(<EmailViewer />);
  fireEvent.click(screen.getByRole('button', { name: 'View source' }));
  await screen.findByText(/raw bytes/);
  act(() => useMailStore.setState({ selectedEmail: email(a, 'Active account') }));
  expect(screen.queryByText(/raw bytes/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'View source' }));
  expect(await screen.findByText(/Active account raw bytes/)).toBeTruthy();
});
it('does not publish late raw source under a newly selected message', async () => {
  let finish;
  native.mockImplementation((command, args) => command === 'maildir_read_raw_source'
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(email(args.accountId, 'Selected account')));
  render(<EmailViewer />);
  fireEvent.click(screen.getByRole('button', { name: 'View source' }));
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  act(() => useMailStore.setState({ selectedEmail: email(a, 'Active account') }));
  await act(async () => finish(raw('Selected account')));
  expect(screen.queryByText(/Selected account raw bytes/)).toBeNull();
});

it('uses Insights custody instead of a stale active row with the same UID', () => {
  const selected = { ...email(b, 'Selected account'), isArchived: true, source: 'local' };
  const staleActiveRow = { ...email(b, 'Active account'), _insightsReadOnly: false, isArchived: false, source: 'server' };
  useMailStore.setState({ selectedEmail: selected, selectedEmailSource: 'local-only', sortedEmails: [staleActiveRow], serverUids: { complete: true, uids: new Set([7]) } });
  render(<EmailViewer />);
  expect(screen.getByText('Saved in your vault')).toBeTruthy();
  expect(screen.getByText('Server copy not verified yet.')).toBeTruthy();
  expect(screen.queryByText('Also still on the server.')).toBeNull();
});

it('preserves only-copy wording for an Insights record with a completed absence proof', () => {
  const selected = { ...email(b, 'Selected account'), isArchived: true, source: 'local', serverAbsent: true };
  useMailStore.setState({ selectedEmail: selected, selectedEmailSource: 'local-only', sortedEmails: [], serverUids: { complete: true, uids: new Set([7]) } });
  render(<EmailViewer />);
  expect(screen.getByText('Your only copy')).toBeTruthy();
  expect(screen.getByText('Someone else deleted the server copy. Nothing else has it.')).toBeTruthy();
});

it('keeps a server-only Insights record on the server despite stale archived state', () => {
  const selected = { ...email(b, 'Selected account'), isArchived: false, source: 'server' };
  const staleArchivedRow = { ...email(b, 'Active account'), isArchived: true, source: 'local', serverDeleted: true };
  useMailStore.setState({ selectedEmail: selected, selectedEmailSource: 'server', sortedEmails: [staleArchivedRow], archivedEmailIds: new Set([7]), serverUids: { complete: true, uids: new Set([7]) } });
  render(<EmailViewer />);
  expect(screen.getByText('On the server')).toBeTruthy();
  expect(screen.queryByText('Saved in your vault')).toBeNull();
  expect(screen.queryByText('Your only copy')).toBeNull();
});

it('the reader header close closes the Insights detail, returns row focus and cancels its delayed mark', async () => {
  vi.useFakeTimers();
  useSettingsStore.setState({ markAsReadMode: 'delay', markAsReadDelay: 1 });
  const header = { ...email(b, 'Selected account'), flags: [] };
  native.mockImplementation(async command => command === 'maildir_read_light' ? header : null);
  const mark = vi.spyOn(api, 'vaultApplyFlags');
  await useMailStore.getState().selectEmail(7, 'local-only', 'Archive/2026',
    { accountId: b, mailbox: 'Archive/2026', uid: 7, header });
  const message = { key: 'selected', subject: header.subject, from: header.from, copies: [header] };
  function Harness() {
    const [detailOpen, setDetailOpen] = React.useState(true);
    return <InsightsMessages messages={[message]} detailOpen={detailOpen}
      onCloseReader={() => { cancelInsightsSelection(); setDetailOpen(false); }} />;
  }
  render(<Harness />);
  const generation = getSelectionGeneration();
  fireEvent.click(screen.getByTestId('close-viewer'));
  expect.soft(screen.queryByTestId('insights-reader')).toBeNull();
  expect.soft(document.activeElement).toBe(screen.getByTestId('insights-match'));
  expect.soft(getSelectionGeneration()).toBeGreaterThan(generation);
  await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
  expect(mark).not.toHaveBeenCalled();
});
