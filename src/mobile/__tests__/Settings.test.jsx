// @vitest-environment jsdom
// The settings screen: accounts (sign in again, remove after a confirm), notifications (asks the
// system's permission first; stays off when it is denied), and About.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], settings: null, granted: true, failRemove: false, permissionAsked: 0, osAllows: true, statusAsked: 0 }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.settings.get':
        return { ...engine.settings };
      case 'mobile.settings.set':
        engine.settings = { ...engine.settings, ...params };
        return { ...engine.settings };
      case 'mobile.accounts.remove':
        if (engine.failRemove) throw Object.assign(new Error('no'), { code: 'INTERNAL' });
        return { removed: true };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
  requestNotificationPermission: vi.fn(async () => {
    engine.permissionAsked++;
    return { granted: engine.granted };
  }),
  // The OS's current answer, never a prompt.
  notificationPermission: vi.fn(async () => {
    engine.statusAsked++;
    return { granted: engine.osAllows };
  }),
}));

const { default: Settings } = await import('../Settings.jsx');
const { useMobileStore } = await import('../store.js');

const A1 = { id: 'a1', email: 'ada@example.test', displayName: 'Ada', needsAuth: false };
const A2 = { id: 'a2', email: 'grace@example.test', displayName: 'Grace', needsAuth: true };

beforeEach(() => {
  engine.calls = [];
  engine.settings = { notifications: 'off', notificationPreview: true };
  engine.granted = true;
  engine.failRemove = false;
  engine.permissionAsked = 0;
  engine.osAllows = true;
  engine.statusAsked = 0;
  useMobileStore.setState({ accounts: [A1, A2], activeAccountId: 'a1', reauthState: null });
});
afterEach(cleanup);

const toggle = () => screen.getByRole('switch', { name: t('mobile.settings.notifyToggle') });
const sets = () => engine.calls.filter(([m]) => m === 'mobile.settings.set').map(([, p]) => p);

describe('Settings', () => {
  it('turning notifications on asks permission and stays off when denied', async () => {
    engine.granted = false;
    render(<Settings onClose={() => {}} />);
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByText(t('mobile.settings.notifyDenied'))).toBeTruthy());
    expect(engine.permissionAsked).toBe(1);
    expect(sets()).toEqual([]);
    expect(toggle().getAttribute('aria-checked')).toBe('false');

    // Allowed in the system settings: the next tap turns it on, and the notice goes.
    engine.granted = true;
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    expect(sets()).toEqual([{ notifications: 'on' }]);
    expect(screen.queryByText(t('mobile.settings.notifyDenied'))).toBeNull();

    // Off needs no permission.
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    expect(engine.permissionAsked).toBe(2);
    expect(sets()).toEqual([{ notifications: 'on' }, { notifications: 'off' }]);
  });

  it('shows the stored values and saves the preview choice', async () => {
    engine.settings = { notifications: 'on', notificationPreview: true };
    render(<Settings onClose={() => {}} />);
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    const preview = screen.getByRole('switch', { name: t('mobile.settings.preview') });
    expect(preview.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(preview);
    await waitFor(() => expect(preview.getAttribute('aria-checked')).toBe('false'));
    expect(sets()).toEqual([{ notificationPreview: false }]);
    expect(engine.permissionAsked).toBe(0);
  });

  it('remove account confirms, then calls mobile.accounts.remove', async () => {
    render(<Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: t('mobile.switcher.remove', { email: A1.email }) }));
    expect(engine.calls.some(([m]) => m === 'mobile.accounts.remove')).toBe(false);
    expect(screen.getByText(t('mobile.switcher.removeConfirm', { email: A1.email }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('common.remove') }));
    await waitFor(() => expect(engine.calls.filter(([m]) => m === 'mobile.accounts.remove')).toEqual([['mobile.accounts.remove', { accountId: 'a1' }]]));
    await waitFor(() => expect(screen.queryByText(A1.email)).toBeNull());
    expect(screen.getByText(A2.email)).toBeTruthy();
  });

  it('keeps the account and its question when the removal fails', async () => {
    engine.failRemove = true;
    render(<Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: t('mobile.switcher.remove', { email: A1.email }) }));
    fireEvent.click(screen.getByRole('button', { name: t('common.remove') }));
    await waitFor(() => expect(engine.calls.some(([m]) => m === 'mobile.accounts.remove')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: t('common.remove') }).disabled).toBe(false));
    expect(screen.getByText(t('mobile.switcher.removeConfirm', { email: A1.email }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(screen.getByText(A1.email)).toBeTruthy();
  });

  it('offers Sign in again only on an account that needs it, through the store reauth', async () => {
    const reauth = vi.fn(async () => ({ ok: true }));
    useMobileStore.setState({ reauth });
    render(<Settings onClose={() => {}} />);
    const buttons = screen.getAllByRole('button', { name: t('mobile.reauth.action') });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(reauth).toHaveBeenCalledWith('a2');
  });

  it('links the source as a plain https anchor for the shell navigation guard, with the version', async () => {
    render(<Settings onClose={() => {}} version="9.8.7" />);
    const link = screen.getByRole('link', { name: t('mobile.settings.source') });
    expect(link.getAttribute('href')).toBe('https://github.com/GraphicMeat/mail-vault-app');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText(t('mobile.settings.version', { version: '9.8.7' }))).toBeTruthy();
    expect(document.body.textContent.toLowerCase()).not.toContain('open source');
  });

  it('Back closes it', async () => {
    const onClose = vi.fn();
    render(<Settings onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    expect(onClose).toHaveBeenCalled();
  });

  it('Show preview cannot be changed while notifications are off', async () => {
    render(<Settings onClose={() => {}} />);
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    const preview = screen.getByRole('switch', { name: t('mobile.settings.preview') });
    expect(preview.disabled).toBe(true);
    engine.granted = true;
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    await waitFor(() => expect(screen.getByRole('switch', { name: t('mobile.settings.preview') }).disabled).toBe(false));
  });

  it('notifications turned off in the system settings show as off, with the pointer there', async () => {
    engine.settings = { notifications: 'on', notificationPreview: true };
    engine.osAllows = false;
    render(<Settings onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(t('mobile.settings.notifyDenied'))).toBeTruthy());
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(sets()).toEqual([{ notifications: 'off' }]);
    expect(engine.permissionAsked).toBe(0);
    // Turned on again here, then off in the system settings while the app was away: checked
    // again when it comes back to the front.
    engine.osAllows = true;
    engine.granted = true;
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    engine.osAllows = false;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    expect(sets()).toEqual([{ notifications: 'off' }, { notifications: 'on' }, { notifications: 'off' }]);
  });
});
