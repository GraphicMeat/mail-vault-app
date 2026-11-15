// @vitest-environment jsdom
// Settings > Appearance > App icon (`appIcon`): the picker switches the home screen icon through
// the shell (`mobile_app_icon`) and stores the choice; every preference read keeps the OS icon on
// the stored one (so a desktop import applies it), calling the shell only when it changes.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, waitFor, fireEvent } from '@testing-library/react';

const shell = vi.hoisted(() => ({ prefs: {}, icons: [], fail: false }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    if (method === 'mobile.prefs.get') return { ...shell.prefs };
    if (method === 'mobile.prefs.set') {
      shell.prefs = { ...shell.prefs, ...params };
      return { ...shell.prefs };
    }
    throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
  }),
  listen: vi.fn(() => () => {}),
  setAppIcon: vi.fn(async (icon) => {
    if (shell.fail) throw Object.assign(new Error('no'), { code: 'INTERNAL' });
    shell.icons.push(icon);
  }),
}));

beforeEach(() => {
  vi.resetModules();
  shell.prefs = {};
  shell.icons = [];
  shell.fail = false;
});
afterEach(cleanup);

describe('app icon', () => {
  it('a preference read applies the stored icon once, and again only on a change', async () => {
    const { useMobileStore } = await import('../store.js');
    shell.prefs = { appIcon: 'teal' };
    await useMobileStore.getState().loadPrefs();
    await useMobileStore.getState().loadPrefs();
    await waitFor(() => expect(shell.icons).toEqual(['teal']));
    await useMobileStore.getState().setPrefs({ appIcon: 'purple' });
    await waitFor(() => expect(shell.icons).toEqual(['teal', 'purple']));
  });

  it('a failed switch is tried again on the next read', async () => {
    const { followAppIcon } = await import('../appIcon.js');
    const apply = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(undefined);
    followAppIcon({ appIcon: 'teal' }, apply);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    followAppIcon({ appIcon: 'teal' }, apply);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
  });

  it('the picker switches the icon and stores it; a refusal says so and keeps the old one', async () => {
    const { default: AppIconSetting } = await import('../AppIconSetting.jsx');
    const { useMobileStore } = await import('../store.js');
    render(<AppIconSetting />);
    expect(document.querySelector('[data-mv-app-icon="purple"]').getAttribute('aria-pressed')).toBe('true');
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-app-icon="teal"]')); });
    await waitFor(() => expect(shell.prefs.appIcon).toBe('teal'));
    expect(shell.icons[0]).toBe('teal');
    expect(useMobileStore.getState().prefs.appIcon).toBe('teal');
    expect(document.querySelector('[data-mv-app-icon="teal"]').getAttribute('aria-pressed')).toBe('true');

    shell.fail = true;
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-app-icon="purple"]')); });
    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy());
    expect(shell.prefs.appIcon).toBe('teal');
  });
});
