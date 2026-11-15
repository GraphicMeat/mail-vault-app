// @vitest-environment jsdom
// Settings > Search index on the phone: the bodies and attachment-text switches (attachment text
// behind Premium), the index's counts, size and progress, and Rebuild.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], status: null, prefs: {} }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.search.status':
        return { ...engine.status };
      case 'mobile.search.rebuild':
        engine.status = { ...engine.status, state: 'indexing' };
        return { ok: true };
      case 'mobile.prefs.set':
        Object.assign(engine.prefs, params);
        return { ...engine.prefs };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
}));

const { default: SearchIndexSettings } = await import('../SearchIndexSettings.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');

let paywall;
beforeEach(() => {
  engine.calls = [];
  engine.prefs = { ...PREF_DEFAULTS };
  engine.status = { available: true, state: 'idle', indexed: 1200, total: 1250, attachments: 3, sizeBytes: 3 * 1024 * 1024 };
  paywall = vi.fn();
  useMobileStore.setState({ prefs: { ...PREF_DEFAULTS }, premium: { premium: false, source: null, expiresMs: null }, openPaywall: paywall });
});
afterEach(cleanup);

const row = (name) => document.querySelector(`[data-mv-pref="${name}"]`);
const prefSets = () => engine.calls.filter(([m]) => m === 'mobile.prefs.set').map(([, p]) => p);

describe('Settings > Search index', () => {
  it('defaults both switches on and shows the counts and the size', async () => {
    expect(PREF_DEFAULTS.searchIndexBodies).toBe(true);
    expect(PREF_DEFAULTS.searchIndexAttachments).toBe(true);
    render(<SearchIndexSettings />);
    await waitFor(() => expect(screen.getByText(/1,200 \/ 1,250/)).toBeTruthy());
    expect(screen.getByText(/3 MB/)).toBeTruthy();
    expect(row('searchIndexBodies').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText(t('settings.searchIndex.indexing'))).toBeNull();
  });

  it('turns body words off', async () => {
    render(<SearchIndexSettings />);
    fireEvent.click(row('searchIndexBodies'));
    await waitFor(() => expect(prefSets()).toEqual([{ searchIndexBodies: false }]));
    await waitFor(() => expect(row('searchIndexBodies').getAttribute('aria-checked')).toBe('false'));
  });

  it('attachment text without Premium shows the badge and opens the Premium screen', async () => {
    render(<SearchIndexSettings />);
    expect(row('searchIndexAttachments').textContent).toContain(t('common.premium'));
    expect(row('searchIndexAttachments').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(row('searchIndexAttachments'));
    expect(paywall).toHaveBeenCalledWith(null);
    expect(prefSets()).toEqual([]);
  });

  it('with Premium, attachment text switches like any preference', async () => {
    useMobileStore.setState({ premium: { premium: true, source: 'apple', expiresMs: null } });
    render(<SearchIndexSettings />);
    expect(row('searchIndexAttachments').textContent).not.toContain(t('common.premium'));
    expect(row('searchIndexAttachments').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(row('searchIndexAttachments'));
    await waitFor(() => expect(prefSets()).toEqual([{ searchIndexAttachments: false }]));
  });

  it('Rebuild asks the engine and shows the progress', async () => {
    render(<SearchIndexSettings />);
    await waitFor(() => expect(screen.getByText(/1,200 \/ 1,250/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: t('settings.searchIndex.rebuild') }));
    await waitFor(() => expect(engine.calls.some(([m]) => m === 'mobile.search.rebuild')).toBe(true));
    await waitFor(() => expect(screen.getByText(t('settings.searchIndex.indexing'))).toBeTruthy());
  });

  it('an index that cannot open says so and still offers Rebuild', async () => {
    engine.status = { available: false, state: 'idle', indexed: 0, total: 40, attachments: 0, sizeBytes: 0 };
    render(<SearchIndexSettings />);
    await waitFor(() => expect(screen.getByText(t('mobile.searchIndex.unavailable'))).toBeTruthy());
    expect(screen.getByRole('button', { name: t('settings.searchIndex.rebuild') })).toBeTruthy();
  });
});
