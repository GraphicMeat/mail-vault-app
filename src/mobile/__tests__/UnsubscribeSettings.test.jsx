// @vitest-environment jsdom
// Settings > Unsubscribe: the senders whose mail carries an unsubscribe link
// (`mobile.unsubscribe.list`), a confirm before each unsubscribe (`mobile.unsubscribe.run`), the
// list's page or email to finish on when one-click is not there, and the history.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], history: [], replies: {} }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.unsubscribe.list':
        return {
          senders: [
            { accountId: 'a1', address: 'news@news.test', name: 'News', folder: 'INBOX', lastMs: Date.now() - 1000, count: 4, method: 'one-click' },
            { accountId: 'a2', address: 'letters@letters.test', name: '', folder: 'INBOX', lastMs: Date.now() - 5000, count: 1, method: 'browser' },
          ],
          history: engine.history,
        };
      case 'mobile.unsubscribe.run': {
        const reply = engine.replies[params.address];
        engine.history = [{ address: params.address, accountId: params.accountId, unsubscribedAt: Date.now(), method: reply.method, status: reply.status }, ...engine.history];
        return reply;
      }
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
}));

// Desktop's Unsubscribe view over the phone's engine.
const { default: UnsubscribeSettings } = await import('../settings/Unsubscribe.jsx');
const { useMobileStore } = await import('../store.js');

beforeEach(() => {
  engine.calls = [];
  engine.history = [];
  engine.replies = {
    'news@news.test': { method: 'one-click', status: 'ok', url: null, oneClickError: null },
    'letters@letters.test': { method: 'browser', status: 'opened', url: 'https://letters.test/leave', oneClickError: null },
  };
  useMobileStore.setState({
    accounts: [{ id: 'a1', email: 'ada@example.test', displayName: 'Ada' }, { id: 'a2', email: 'grace@example.test', displayName: '' }],
  });
});
afterEach(cleanup);

const sender = (address) => document.querySelector(`tr[data-sender="${address}"]`);
const runs = () => engine.calls.filter(([m]) => m === 'mobile.unsubscribe.run').map(([, p]) => p);

describe('Settings > Unsubscribe', () => {
  it('lists each sender with its count and method', async () => {
    render(<UnsubscribeSettings />);
    await waitFor(() => expect(sender('news@news.test')).toBeTruthy());
    expect(within(sender('news@news.test')).getByText('News')).toBeTruthy();
    expect(within(sender('news@news.test')).getByText(t('unsubscribe.methodOneClick'), { exact: false })).toBeTruthy();
    expect(within(sender('letters@letters.test')).getByText(t('unsubscribe.methodLink'), { exact: false })).toBeTruthy();
    expect(screen.getByText(t('unsubscribe.historyEmpty'))).toBeTruthy();
  });

  it('asks first, then unsubscribes in one click and keeps it in the history', async () => {
    render(<UnsubscribeSettings />);
    await waitFor(() => expect(sender('news@news.test')).toBeTruthy());
    fireEvent.click(within(sender('news@news.test')).getByRole('button', { name: t('unsubscribe.action') }));
    expect(runs()).toEqual([]);
    expect(screen.getByText(t('unsubscribe.confirmBody'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(screen.queryByText(t('unsubscribe.confirmBody'))).toBeNull();
    fireEvent.click(within(sender('news@news.test')).getByRole('button', { name: t('unsubscribe.action') }));
    fireEvent.click(screen.getByRole('button', { name: t('unsubscribe.confirmTitle', { sender: 'News' }) }));
    await waitFor(() => expect(runs()).toEqual([{ accountId: 'a1', address: 'news@news.test' }]));
    await waitFor(() => expect(screen.getByText(t('unsubscribe.done', { sender: 'News' }))).toBeTruthy());
    await waitFor(() => expect(screen.queryByTestId('unsubscribe-history')).toBeTruthy());
  });

  it('hands over the list\'s own page when it offers no one-click', async () => {
    render(<UnsubscribeSettings />);
    await waitFor(() => expect(sender('letters@letters.test')).toBeTruthy());
    fireEvent.click(within(sender('letters@letters.test')).getByRole('button', { name: t('unsubscribe.action') }));
    fireEvent.click(screen.getByRole('button', { name: t('unsubscribe.confirmTitle', { sender: 'letters@letters.test' }) }));
    const link = await waitFor(() => screen.getByRole('link', { name: t('mobile.unsubscribe.openPage') }));
    expect(link.getAttribute('href')).toBe('https://letters.test/leave');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('narrows the list to one account', async () => {
    render(<UnsubscribeSettings />);
    await waitFor(() => expect(sender('news@news.test')).toBeTruthy());
    // Desktop's account pills.
    fireEvent.click(screen.getByRole('radio', { name: /grace@example.test/ }));
    expect(sender('news@news.test')).toBeNull();
    expect(sender('letters@letters.test')).toBeTruthy();
  });
});
