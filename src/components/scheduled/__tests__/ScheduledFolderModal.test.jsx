// @vitest-environment jsdom
//
// The Scheduled folder: its "keep running" card tells the truth for each
// always-on state, and clicking a row opens that email for editing from its
// vault copy without cancelling the schedule underneath it. Editing and
// rescheduling are Premium; Cancel and Send now work on any plan.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { getLocalEmailFull, openCompose, cancel, sendNow, loadRows, state } = vi.hoisted(() => ({
  getLocalEmailFull: vi.fn(),
  loadRows: async () => [],
  openCompose: vi.fn(),
  cancel: vi.fn(),
  sendNow: vi.fn(),
  state: { rows: [], daemonAlwaysOn: false, autostart: null, premium: true },
}));

vi.mock('../../../i18n/index.js', () => ({
  useT: () => (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  getLocale: () => 'en',
}));
vi.mock('../../ui/Dialog', () => ({ Dialog: ({ children }) => <div>{children}</div> }));
vi.mock('../../../stores/scheduledStore', () => ({
  useScheduledStore: selector => selector({
    rows: state.rows,
    loadRows,
    reschedule: vi.fn(),
    cancel,
    sendNow,
  }),
}));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: selector => selector({ daemonAlwaysOn: state.daemonAlwaysOn, billingProfile: state.premium }),
  hasPremiumAccess: profile => profile === true,
}));
vi.mock('../../../hooks/useAutostartState', () => ({ useAutostartState: () => state.autostart }));
vi.mock('../../../stores/accountStore', () => ({ getAccounts: () => [{ id: 'acct-1', email: 'me@example.com' }] }));
vi.mock('../../../services/db', () => ({ getLocalEmailFull: (...args) => getLocalEmailFull(...args) }));
vi.mock('../../../services/localDrafts', () => ({
  scheduledEmlToInitialData: ({ row, eml }) => ({ fromRow: row.id, subject: eml.subject }),
}));
vi.mock('../../../utils/composeOpener', () => ({ openCompose: (...args) => openCompose(...args) }));

const { ScheduledFolderModal } = await import('../ScheduledFolderModal');

const row = (id, status, over = {}) => ({
  id, status, accountId: 'acct-1', mailbox: 'Scheduled', uid: 7,
  envelope: JSON.stringify({ to: `${id}@example.com` }),
  localTime: '2026-10-01T09:00', tz: 'Europe/Vilnius', ...over,
});

beforeEach(() => {
  state.rows = [];
  state.daemonAlwaysOn = false;
  state.autostart = null;
  state.premium = true;
  getLocalEmailFull.mockReset();
  openCompose.mockReset();
  cancel.mockReset();
  sendNow.mockReset();
});
afterEach(cleanup);

describe('Scheduled folder rows', () => {
  it('opens a queued row for editing from the vault copy, and leaves the schedule in place', async () => {
    state.rows = [row('q1', 'queued')];
    getLocalEmailFull.mockResolvedValue({ subject: 'Later' });
    const onClose = vi.fn();
    render(<ScheduledFolderModal onClose={onClose} />);

    fireEvent.click(screen.getByTestId('scheduled-row-open-q1'));

    await waitFor(() => expect(openCompose).toHaveBeenCalledWith({ initialData: { fromRow: 'q1', subject: 'Later' } }));
    expect(getLocalEmailFull).toHaveBeenCalledWith('acct-1', 'Scheduled', 7);
    expect(cancel).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Reschedule opens the picker under the row, with no upgrade prompt', () => {
    state.rows = [row('q1', 'queued')];
    render(<ScheduledFolderModal />);
    fireEvent.click(within(screen.getByTestId('scheduled-row-q1')).getByTitle('scheduled.row.reschedule'));
    expect(screen.getByTestId('scheduled-reschedule-q1-time')).toBeTruthy();
    expect(screen.queryByTestId('scheduled-locked-q1')).toBeNull();
  });

  it('opens a failed row too, but a row already sending is not a button', () => {
    state.rows = [row('f1', 'failed'), row('s1', 'sending')];
    render(<ScheduledFolderModal />);

    expect(screen.getByTestId('scheduled-row-open-f1')).toBeTruthy();
    expect(screen.queryByTestId('scheduled-row-open-s1')).toBeNull();
    const sending = screen.getByTestId('scheduled-row-s1');
    expect(within(sending).getByText('s1@example.com').closest('button')).toBeNull();
  });

  it('says so, and opens nothing, when the vault copy cannot be read', async () => {
    state.rows = [row('q1', 'queued')];
    getLocalEmailFull.mockResolvedValue(undefined);
    render(<ScheduledFolderModal />);

    fireEvent.click(screen.getByTestId('scheduled-row-open-q1'));

    expect((await screen.findByRole('alert')).textContent).toBe('scheduled.errors.openFailed');
    expect(openCompose).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('Scheduled folder for a free user', () => {
  beforeEach(() => { state.premium = false; });

  it('a row click shows the upgrade under that row instead of opening it', async () => {
    state.rows = [row('q1', 'queued'), row('q2', 'queued')];
    const onOpenSettings = vi.fn();
    render(<ScheduledFolderModal onOpenSettings={onOpenSettings} />);

    fireEvent.click(screen.getByTestId('scheduled-row-open-q1'));

    const locked = screen.getByTestId('scheduled-locked-q1');
    expect(locked.textContent).toContain('scheduled.premium.editLocked');
    expect(screen.queryByTestId('scheduled-locked-q2')).toBeNull();
    expect(getLocalEmailFull).not.toHaveBeenCalled();
    expect(openCompose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('scheduled-upgrade-q1'));
    expect(onOpenSettings).toHaveBeenCalledWith('billing');
  });

  it('Reschedule shows the upgrade, not the picker, while Cancel and Send now still work', () => {
    state.rows = [row('q1', 'queued')];
    render(<ScheduledFolderModal onOpenSettings={vi.fn()} />);
    const scope = within(screen.getByTestId('scheduled-row-q1'));

    fireEvent.click(scope.getByTitle('scheduled.row.reschedule'));
    expect(screen.getByTestId('scheduled-locked-q1')).toBeTruthy();
    expect(screen.queryByTestId('scheduled-reschedule-q1-time')).toBeNull();

    fireEvent.click(scope.getByTitle('scheduled.row.sendNow'));
    expect(sendNow).toHaveBeenCalledWith('q1');
    fireEvent.click(scope.getByTitle('common.cancel'));
    expect(cancel).toHaveBeenCalledWith('q1');
  });

  it('Retry on a failed row works too', () => {
    state.rows = [row('f1', 'failed')];
    render(<ScheduledFolderModal />);
    fireEvent.click(within(screen.getByTestId('scheduled-row-f1')).getByTitle('common.retry'));
    expect(sendNow).toHaveBeenCalledWith('f1');
  });
});

describe('Scheduled folder background card', () => {
  it('explains the background helper by the setting\'s own name', () => {
    render(<ScheduledFolderModal />);
    expect(screen.getByTestId('scheduled-background-card').textContent)
      .toContain('scheduled.background.explain:{"setting":"settings.daemon.alwaysOn.label"}');
  });

  it('confirms it when always-on is on, and offers nothing to turn on', () => {
    state.daemonAlwaysOn = true;
    state.autostart = { supported: true, enabled: true };
    render(<ScheduledFolderModal />);
    expect(screen.getByTestId('scheduled-background-on').textContent).toBe('scheduled.background.on');
    expect(screen.queryByTestId('scheduled-background-turn-on')).toBeNull();
    expect(screen.queryByTestId('scheduled-background-unsupported')).toBeNull();
  });

  it('offers to turn it on in Settings when this build can', () => {
    state.autostart = { supported: true, enabled: false };
    const onOpenSettings = vi.fn();
    render(<ScheduledFolderModal onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByTestId('scheduled-background-turn-on'));
    expect(onOpenSettings).toHaveBeenCalledWith('daemon');
    expect(screen.queryByTestId('scheduled-background-unsupported')).toBeNull();
  });

  it('says this build cannot, and still links to the Settings tab that explains why', () => {
    state.autostart = { supported: false, enabled: false, reason: 'snap' };
    const onOpenSettings = vi.fn();
    render(<ScheduledFolderModal onOpenSettings={onOpenSettings} />);
    expect(screen.getByTestId('scheduled-background-unsupported')).toBeTruthy();
    expect(screen.queryByTestId('scheduled-background-turn-on')).toBeNull();
    fireEvent.click(screen.getByTestId('scheduled-background-settings'));
    expect(onOpenSettings).toHaveBeenCalledWith('daemon');
  });

  it('claims nothing about this build before the answer arrives', () => {
    render(<ScheduledFolderModal onOpenSettings={vi.fn()} />);
    expect(screen.queryByTestId('scheduled-background-unsupported')).toBeNull();
    expect(screen.queryByTestId('scheduled-background-turn-on')).toBeNull();
    expect(screen.getByTestId('scheduled-background-settings')).toBeTruthy();
  });
});
