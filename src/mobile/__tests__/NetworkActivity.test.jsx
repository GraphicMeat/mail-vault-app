// @vitest-environment jsdom
// Settings > Network Activity: the engine's stored connections (`mobile.netActivity.list`) with
// desktop's filters: time range and account and country asked of the engine, protocol and purpose
// narrowing the rows on screen, and how long the history is kept.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], retention: 'week', hold: null }));

const EVENTS = [
  { atMs: Date.now() - 1000, direction: 'out', protocol: 'imap', host: 'imap.example.test', port: 993, purpose: 'sync', account: 'ada@example.test', bytesUp: 100, bytesDown: 2048, durationMs: 120, result: 'ok', country: 'US' },
  { atMs: Date.now() - 2000, direction: 'out', protocol: 'https', host: 'mailvaultapp.com', port: 443, purpose: 'billing', account: null, bytesUp: 10, bytesDown: 20, durationMs: 80, result: 'HTTP 500', country: 'DE' },
];

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.netActivity.list':
        if (engine.hold) await engine.hold;
        return {
          events: EVENTS.filter((e) => (!params.country || e.country === params.country) && (!params.account || e.account === params.account)),
          countries: [{ country: 'US', connections: 1, bytesUp: 100, bytesDown: 2048, hosts: ['imap.example.test'] }, { country: 'DE', connections: 1, bytesUp: 10, bytesDown: 20, hosts: ['mailvaultapp.com'] }],
          summary: { hosts: 2, sent: 110, received: 2068, accounts: ['ada@example.test'] },
          retention: engine.retention,
        };
      case 'mobile.netActivity.setRetention':
        engine.retention = params.retention;
        return { retention: params.retention };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
}));

// Desktop's Network Activity view over the engine (settings/NetworkActivity.jsx).
const { default: NetworkActivity } = await import('../settings/NetworkActivity.jsx');

beforeEach(() => {
  engine.calls = [];
  engine.retention = 'week';
  engine.hold = null;
});
afterEach(cleanup);

const lists = () => engine.calls.filter(([m]) => m === 'mobile.netActivity.list').map(([, p]) => p);
const rows = () => screen.queryAllByTestId('net-row').map((r) => r.getAttribute('data-host'));
// Desktop's pickers by their names; the retention picker sits in its <label>, whose text also
// holds its options' text.
const picker = (label) => (label === t('netActivity.retention')
  ? document.querySelector('[data-testid="network-activity"] label > select')
  : screen.getByRole('combobox', { name: label }));

describe('Settings > Network Activity', () => {
  it('lists the stored connections with their totals, the last day by default', async () => {
    render(<NetworkActivity />);
    await waitFor(() => expect(rows()).toEqual(['imap.example.test', 'mailvaultapp.com']));
    const since = lists()[0].sinceMs;
    expect(Date.now() - since).toBeGreaterThan(23 * 3600 * 1000);
    expect(Date.now() - since).toBeLessThan(25 * 3600 * 1000);
    expect(screen.getByText(t('netActivity.hostsContacted'))).toBeTruthy();
    // A failed request shows its result; a billing call is named as such.
    const billing = document.querySelector('[data-testid="net-row"][data-host="mailvaultapp.com"]');
    expect(within(billing).getByText('HTTP 500')).toBeTruthy();
    expect(within(billing).getByText(t('mobile.netActivity.purposeBilling'), { exact: false })).toBeTruthy();
  });

  it('narrows the rows by protocol and purpose on screen, and asks the engine for an account', async () => {
    render(<NetworkActivity />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(picker(t('netActivity.protocol')), { target: { value: 'imap' } });
    expect(rows()).toEqual(['imap.example.test']);
    fireEvent.change(picker(t('netActivity.protocol')), { target: { value: '' } });
    fireEvent.change(picker(t('netActivity.purpose')), { target: { value: 'billing' } });
    expect(rows()).toEqual(['mailvaultapp.com']);
    fireEvent.change(picker(t('netActivity.account')), { target: { value: 'ada@example.test' } });
    await waitFor(() => expect(lists().at(-1).account).toBe('ada@example.test'));
  });

  it('filters by a country from the list, and Show all clears it', async () => {
    render(<NetworkActivity />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(document.querySelector('[data-testid="net-map-country"][data-country="DE"]'));
    await waitFor(() => expect(rows()).toEqual(['mailvaultapp.com']));
    expect(lists().at(-1).country).toBe('DE');
    fireEvent.click(screen.getByRole('button', { name: t('netActivity.map.clear') }));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it('keeps history for the chosen period, and offers no range longer than it', async () => {
    render(<NetworkActivity />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const range = picker(t('netActivity.range'));
    expect([...range.options].map((o) => o.value)).toEqual(['hour', 'day', 'week']);
    fireEvent.change(picker(t('netActivity.retention')), { target: { value: 'month' } });
    await waitFor(() => expect(engine.calls.some(([m, p]) => m === 'mobile.netActivity.setRetention' && p.retention === 'month')).toBe(true));
    await waitFor(() => expect([...picker(t('netActivity.range')).options].map((o) => o.value)).toEqual(['hour', 'day', 'week', 'twoWeeks', 'month']));
  });

  it('a slow list still lands: the refresh waits while one is on its way', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let release;
      engine.hold = new Promise((r) => { release = r; });
      render(<NetworkActivity />);
      await act(async () => { vi.advanceTimersByTime(15_000); });
      expect(lists()).toHaveLength(1);
      engine.hold = null;
      await act(async () => { release(); });
      await waitFor(() => expect(rows()).toEqual(['imap.example.test', 'mailvaultapp.com']));
      await act(async () => { vi.advanceTimersByTime(5_000); });
      expect(lists()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
