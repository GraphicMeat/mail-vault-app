// @vitest-environment jsdom
//
// "once a day remind of failures. single modal, link to unfinished server
// actions" (2026-10-29). A delete the server refuses stays queued and is
// retried with no limit; this is the one place the user hears about it.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))), has: () => true });
});

import { PendingActionsReminder } from '../PendingActionsReminder';
import { remindOfUnfinished, REMIND_EVERY_MS } from '../../services/workflows/pendingActionsReminder';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useConnectivityStore } from '../../stores/connectivityStore';

beforeEach(() => {
  useSettingsStore.setState({ pendingActionsRemindedAt: null });
  useConnectivityStore.setState({ online: true });
  useMailStore.setState({ pendingActionsReminder: null, settingsRequest: null });
});
afterEach(cleanup);

describe('remindOfUnfinished', () => {
  it('raises one reminder, then waits a day before the next', async () => {
    const now = 1_800_000_000_000;
    expect(await remindOfUnfinished(3, now)).toBe(true);
    expect(useMailStore.getState().pendingActionsReminder).toEqual({ count: 3 });
    expect(useSettingsStore.getState().pendingActionsRemindedAt).toBe(now);

    useMailStore.setState({ pendingActionsReminder: null });
    expect(await remindOfUnfinished(3, now + REMIND_EVERY_MS - 1)).toBe(false);
    expect(useMailStore.getState().pendingActionsReminder).toBeNull();
    expect(await remindOfUnfinished(2, now + REMIND_EVERY_MS)).toBe(true);
    expect(useMailStore.getState().pendingActionsReminder).toEqual({ count: 2 });
  });

  it('says nothing with nothing owed, or offline', async () => {
    expect(await remindOfUnfinished(0)).toBe(false);
    useConnectivityStore.setState({ online: false });
    expect(await remindOfUnfinished(4)).toBe(false);
    expect(useSettingsStore.getState().pendingActionsRemindedAt).toBeNull();
  });
});

describe('PendingActionsReminder', () => {
  it('shows the count and links to Unfinished server actions', () => {
    render(<PendingActionsReminder />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => useMailStore.setState({ pendingActionsReminder: { count: 2 } }));
    expect(screen.getByText(/2 messages are still waiting/)).toBeTruthy();
    fireEvent.click(screen.getByText('Open unfinished server actions'));
    expect(useMailStore.getState().pendingActionsReminder).toBeNull();
    expect(useMailStore.getState().settingsRequest).toMatchObject({ tab: 'daemon', section: 'pending-actions' });
  });

  it('Later closes it without opening Settings', () => {
    useMailStore.setState({ pendingActionsReminder: { count: 1 } });
    render(<PendingActionsReminder />);
    expect(screen.getByText(/1 message is still waiting/)).toBeTruthy();
    fireEvent.click(screen.getByText('Later'));
    expect(useMailStore.getState().pendingActionsReminder).toBeNull();
    expect(useMailStore.getState().settingsRequest).toBeNull();
  });
});
