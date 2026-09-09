// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const send = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../services/transport.js', () => ({ send: (...args) => send(...args) }));

import { NotificationSettings } from '../NotificationSettings';
import { useSettingsStore, _mergePersistedSettings } from '../../../stores/settingsStore';
import { notify, useFocusStore } from '../../../stores/focusStore';

beforeEach(() => {
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
  useFocusStore.getState().abandon();
  useSettingsStore.setState({
    notificationSettings: { enabled: true, showPreview: true, accounts: {}, sound: 'none' },
  });
  send.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  useFocusStore.getState().abandon();
});

describe('incoming mail sounds', () => {
  it('remembers the selected sound and previews it without a notification banner', async () => {
    const view = render(<NotificationSettings accounts={[]} />);
    const select = screen.getByRole('combobox', { name: 'New email sound' });
    expect(select.value).toBe('none');
    expect(screen.getByRole('button', { name: 'Preview sound' }).disabled).toBe(true);

    fireEvent.change(select, { target: { value: 'Ping' } });
    expect(useSettingsStore.getState().notificationSettings.sound).toBe('Ping');
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview sound' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('preview_notification_sound', { sound: 'Ping' }));
    expect(send).toHaveBeenCalledTimes(1);

    view.unmount();
    render(<NotificationSettings accounts={[]} />);
    expect(screen.getByRole('combobox', { name: 'New email sound' }).value).toBe('Ping');
    fireEvent.change(screen.getByRole('combobox', { name: 'New email sound' }), { target: { value: 'none' } });
    expect(screen.getByRole('button', { name: 'Preview sound' }).disabled).toBe(true);
  });

  it('reports a preview failure and lets the user try again', async () => {
    send.mockRejectedValueOnce(new Error('Sound unavailable'));
    render(<NotificationSettings accounts={[]} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'New email sound' }), { target: { value: 'Glass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview sound' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Preview sound' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('does not offer Mac sounds on Linux or when notifications are disabled', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });
    const view = render(<NotificationSettings accounts={[]} />);
    expect(screen.queryByRole('combobox', { name: 'New email sound' })).toBeNull();
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    act(() => useSettingsStore.getState().setNotificationEnabled(false));
    view.rerender(<NotificationSettings accounts={[]} />);
    expect(screen.queryByRole('combobox', { name: 'New email sound' })).toBeNull();
  });

  it('keeps older settings silent and rejects unknown persisted sounds', () => {
    const current = useSettingsStore.getState();
    const old = { notificationSettings: { enabled: false, showPreview: false, accounts: { a: { enabled: false, folders: [] } } } };
    const merged = _mergePersistedSettings(old, current);
    expect(merged.notificationSettings).toEqual({ ...old.notificationSettings, sound: 'none' });
    expect(_mergePersistedSettings({ notificationSettings: { sound: '../other.wav' } }, current).notificationSettings.sound).toBe('none');
    expect(_mergePersistedSettings({ notificationSettings: { sound: 'Tink' } }, current).notificationSettings.sound).toBe('Tink');
  });

  it('holds the sound with its notification until Focus ends', async () => {
    useFocusStore.getState().start(25);
    await notify('Sender', 'New message', 'Ping');
    expect(send).not.toHaveBeenCalled();
    useFocusStore.getState().abandon();
    await waitFor(() => expect(send).toHaveBeenCalledWith('send_notification', { title: 'Sender', body: 'New message', sound: 'Ping' }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('plays only one sound when Focus releases a batch', async () => {
    useFocusStore.getState().start(25);
    for (let i = 0; i < 4; i++) await notify('Sender', `Message ${i}`, 'Purr');
    expect(send).not.toHaveBeenCalled();
    useFocusStore.getState().abandon();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][1].sound).toBe('Purr');
  });

  it('keeps other notifications silent', async () => {
    await notify('Backup complete', 'Saved');
    expect(send).toHaveBeenCalledWith('send_notification', { title: 'Backup complete', body: 'Saved' });
  });
});
