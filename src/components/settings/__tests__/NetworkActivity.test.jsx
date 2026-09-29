// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const harness = vi.hoisted(() => ({ daemonCall: vi.fn(), listeners: new Map(), unlisten: vi.fn() }));

vi.mock('../../../services/daemonClient', () => ({
  daemonCall: (...args) => harness.daemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, cb) => {
    harness.listeners.set(name, cb);
    return () => { harness.listeners.delete(name); harness.unlisten(name); };
  },
}));

const { NetworkActivity } = await import('../NetworkActivity');
const { useNetActivityStore } = await import('../../../stores/netActivityStore');

const ev = (over = {}) => ({
  atMs: Date.now(), direction: 'out', process: 'helper', protocol: 'imap',
  host: 'imap.example.test', ip: '192.0.2.1', port: 993, purpose: 'sync', account: 'someone@example.test',
  bytesUp: 100, bytesDown: 2000, durationMs: 1500, result: 'ok', commands: null, country: 'DE', ...over,
});
const flush = () => act(() => new Promise(resolve => setTimeout(resolve, 0)));
const push = async payload => { await act(async () => { harness.listeners.get('net-activity')({ payload }); }); };
const hosts = () => screen.getAllByTestId('net-row').map(row => row.getAttribute('data-host'));
const writeText = vi.fn(() => Promise.resolve());
const calls = method => harness.daemonCall.mock.calls.filter(([m]) => m === method).map(([, p]) => p);
const HOUR = 60 * 60 * 1000;

/**
 * A daemon that holds `events` and answers the page's reads the way
 * `net_log` does: `net.activity` narrowed by account and country.
 */
async function mount(events, { countries = [], summary = {}, retention = 'week' } = {}) {
  harness.daemonCall.mockImplementation(async (method, params = {}) => {
    switch (method) {
      case 'net.activity':
        return { events: events.filter(e => (!params.account || e.account === params.account) && (!params.country || e.country === params.country)) };
      case 'net.geo': return { countries };
      case 'net.summary': return { hosts: 0, sent: 0, received: 0, accounts: [], ...summary };
      case 'net.retention': return { retention };
      case 'net.set_retention': return { retention: params.retention };
      default: return null;
    }
  });
  const view = render(<NetworkActivity />);
  await flush();
  return view;
}

beforeEach(() => {
  harness.daemonCall.mockReset();
  harness.unlisten.mockReset();
  harness.listeners.clear();
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  useNetActivityStore.setState({
    events: [], frozen: null, loadError: false, remoteImages: { blocked: 0, loaded: 0 },
    query: { range: 'day', account: '', country: '' }, retention: 'week', retentionError: false,
  });
});
afterEach(cleanup);

describe('Network Activity', () => {
  it('renders the net.activity snapshot newest first, asking for the last 24 hours', async () => {
    await mount([ev({ host: 'newest.test' }), ev({ host: 'older.test' })]);
    const [asked] = calls('net.activity');
    expect(Math.abs(asked.sinceMs - (Date.now() - 24 * HOUR))).toBeLessThan(5000);
    expect(hosts()).toEqual(['newest.test', 'older.test']);
  });

  it('names the account by its address', async () => {
    await mount([ev({ account: 'person@example.test' })]);
    expect(screen.getByTestId('net-row').textContent).toContain('person@example.test');
  });

  // The daemon's `aliases.discover` asks Gmail for the send-as list.
  it('words the send-as alias lookup', async () => {
    await mount([ev({ host: 'gmail.googleapis.com', protocol: 'https', port: 443, purpose: 'alias lookup', account: 'person@example.test' })]);
    const row = screen.getByTestId('net-row');
    expect(row.textContent).toContain('Alias lookup');
    expect(row.textContent).not.toContain('alias lookup');
  });

  // An update check or a model download is no account's: said, not left blank.
  it('says a connection is not tied to an account, on screen and in Copy as text', async () => {
    await mount([ev({ host: 'app.test', protocol: 'https', purpose: 'AI model', account: null })]);
    expect(within(screen.getByTestId('net-row')).getByTestId('net-account').textContent).toBe('Not tied to an account');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy as text' })); });
    expect(writeText.mock.calls[0][0].split('\t')).toContain('Not tied to an account');
  });

  it('puts a net-activity event on top as it arrives', async () => {
    await mount([ev({ host: 'older.test' })]);
    await push(ev({ host: 'live.test' }));
    expect(hosts()).toEqual(['live.test', 'older.test']);
  });

  it('Pause stops new rows, Resume shows the ones that arrived meanwhile', async () => {
    await mount([ev({ host: 'first.test' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await push(ev({ host: 'while-paused.test' }));
    expect(hosts()).toEqual(['first.test']);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(hosts()).toEqual(['while-paused.test', 'first.test']);
  });

  it('narrows the rows by protocol, purpose and account', async () => {
    await mount([
      ev({ host: 'a.test', protocol: 'imap', purpose: 'sync', account: 'one@example.test' }),
      ev({ host: 'b.test', protocol: 'smtp', purpose: 'send', account: 'one@example.test' }),
      ev({ host: 'c.test', protocol: 'https', purpose: 'AI model', account: null }),
      ev({ host: 'd.test', protocol: 'imap', purpose: 'backup', account: 'two@example.test' }),
    ], { summary: { accounts: ['one@example.test', 'two@example.test'] } });
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'imap' } });
    expect(hosts()).toEqual(['a.test', 'd.test']);
    // The account is the daemon's query: the map and totals follow it too.
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'two@example.test' } });
    await flush();
    expect(calls('net.activity').at(-1).account).toBe('two@example.test');
    expect(calls('net.geo').at(-1).account).toBe('two@example.test');
    expect(hosts()).toEqual(['d.test']);
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: '' } });
    await flush();
    fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'AI model' } });
    expect(hosts()).toEqual(['c.test']);
  });

  it('keeps a live row for another account off a table narrowed to one', async () => {
    await mount([ev({ host: 'mine.test', account: 'one@example.test' })], { summary: { accounts: ['one@example.test'] } });
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'one@example.test' } });
    await flush();
    await push(ev({ host: 'other.test', account: 'two@example.test' }));
    await push(ev({ host: 'mine-live.test', account: 'one@example.test' }));
    expect(hosts()).toEqual(['mine-live.test', 'mine.test']);
  });

  it('asks for the chosen time range, and offers none longer than the history kept', async () => {
    await mount([], { retention: 'day' });
    const ranges = [...screen.getByLabelText('Time range').querySelectorAll('option')].map(o => o.value);
    expect(ranges).toEqual(['hour', 'day']);
    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: 'hour' } });
    await flush();
    for (const method of ['net.activity', 'net.geo', 'net.summary']) {
      expect(Math.abs(calls(method).at(-1).sinceMs - (Date.now() - HOUR)), method).toBeLessThan(5000);
    }
  });

  it('keeping history for longer or shorter tells the daemon, and a shorter period caps the range', async () => {
    await mount([]);
    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: 'twoWeeks' } });
    await flush();
    fireEvent.change(screen.getByLabelText('Keep history for'), { target: { value: 'day' } });
    await flush();
    expect(calls('net.set_retention')).toEqual([{ retention: 'day' }]);
    expect(screen.getByLabelText('Keep history for').value).toBe('day');
    expect(screen.getByLabelText('Time range').value).toBe('day');
    expect(Math.abs(calls('net.activity').at(-1).sinceMs - (Date.now() - 24 * HOUR))).toBeLessThan(5000);
  });

  it('says so when the period cannot be changed', async () => {
    await mount([]);
    const answer = harness.daemonCall.getMockImplementation();
    harness.daemonCall.mockImplementation((method, params) => (method === 'net.set_retention' ? Promise.reject(new Error('busy')) : answer(method, params)));
    fireEvent.change(screen.getByLabelText('Keep history for'), { target: { value: 'month' } });
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('The history period could not be changed.');
    expect(screen.getByLabelText('Keep history for').value).toBe('week');
  });

  it('draws the countries net.geo placed, with the local network beside the map', async () => {
    const { container } = await mount([], {
      countries: [
        { country: 'DE', connections: 12, bytesUp: 2048, bytesDown: 4096, hosts: ['imap.de.test'] },
        { country: 'local', connections: 3, bytesUp: 1, bytesDown: 1, hosts: ['nas.test'] },
        { country: 'SG', connections: 1, bytesUp: 1, bytesDown: 1, hosts: ['api.sg.test'] },
      ],
    });
    const listed = screen.getAllByTestId('net-map-country').map(b => b.getAttribute('data-country'));
    // Singapore is too small for the 110m shapes: the list still holds it.
    expect(listed).toEqual(['DE', 'SG']);
    expect(screen.getAllByTestId('net-map-country')[0].textContent).toContain('Germany');
    expect(screen.getByTestId('net-map-local').textContent).toContain('3');
    expect(container.querySelector('path[data-country="DE"]').getAttribute('data-connections')).toBe('12');
    expect(container.querySelector('path[data-country="FR"]').hasAttribute('data-connections')).toBe(false);
    expect(container.querySelector('path[data-country="local"]')).toBeNull();
    fireEvent.mouseEnter(screen.getAllByTestId('net-map-country')[0]);
    const tip = screen.getByTestId('net-map-tooltip').textContent;
    expect(tip).toContain('Germany');
    expect(tip).toContain('12 connections');
    expect(tip).toContain('2.0 KB');
    expect(tip).toContain('4.0 KB');
    expect(tip).toContain('imap.de.test');
    expect(screen.getByRole('button', { name: /IP geolocation by DB-IP/ })).toBeTruthy();
  });

  it('a country click narrows the table to it, and a second click shows them all again', async () => {
    const { container } = await mount(
      [ev({ host: 'de.test', country: 'DE' }), ev({ host: 'us.test', country: 'US' })],
      { countries: [{ country: 'DE', connections: 1, bytesUp: 0, bytesDown: 0, hosts: [] }, { country: 'US', connections: 1, bytesUp: 0, bytesDown: 0, hosts: [] }] },
    );
    expect(hosts()).toEqual(['de.test', 'us.test']);
    fireEvent.click(container.querySelector('path[data-country="DE"]'));
    await flush();
    expect(calls('net.activity').at(-1).country).toBe('DE');
    expect(calls('net.geo').at(-1).country).toBeUndefined();
    expect(hosts()).toEqual(['de.test']);
    expect(screen.getByTestId('net-country-filter').textContent).toContain('Germany');
    // A live row for another country stays off the narrowed table.
    await push(ev({ host: 'us-live.test', country: 'US' }));
    expect(hosts()).toEqual(['de.test']);
    fireEvent.click(screen.getByRole('button', { name: /Germany/, pressed: true }));
    await flush();
    expect(hosts()).toEqual(['de.test', 'us.test']);
    expect(screen.queryByTestId('net-country-filter')).toBeNull();
  });

  it('Copy as text writes one line per visible row', async () => {
    await mount([
      ev({ host: 'a.test', protocol: 'imap', port: 993, purpose: 'sync', bytesUp: 11, bytesDown: 22, result: 'ok' }),
      ev({ host: 'b.test', protocol: 'smtp', port: 465, purpose: 'send', result: 'ok' }),
      ev({ host: 'c.test', protocol: 'imap', port: 143, purpose: 'backup', result: 'connection reset' }),
    ]);
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'imap' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy as text' })); });
    expect(writeText).toHaveBeenCalledTimes(1);
    const lines = writeText.mock.calls[0][0].split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('IMAP');
    expect(lines[0]).toContain('a.test:993');
    expect(lines[0]).toContain('sync');
    expect(lines[0]).toContain('11');
    expect(lines[0]).toContain('22');
    expect(lines[0]).toContain('ok');
    expect(lines[1]).toContain('c.test:143');
    expect(lines[1]).toContain('connection reset');
  });

  // The daemon's totals over the whole range, not a sum of the capped rows.
  it('shows the hosts contacted and the bytes sent and received that net.summary counted', async () => {
    await mount([ev({ bytesUp: 1, bytesDown: 1 })], { summary: { hosts: 2, sent: 1024, received: 3072 } });
    const strip = screen.getByTestId('net-summary');
    expect(within(strip).getByTestId('net-summary-hosts').textContent).toBe('2');
    expect(within(strip).getByTestId('net-summary-sent').textContent).toBe('1.0 KB');
    expect(within(strip).getByTestId('net-summary-received').textContent).toBe('3.0 KB');
    expect(strip.textContent).toContain('Hosts contacted');
  });

  it('offers only filter values the rows on screen carry, even while paused', async () => {
    await mount([ev({ host: 'a.test', protocol: 'imap' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await push(ev({ host: 'b.test', protocol: 'smtp' }));
    const options = [...screen.getByLabelText('Protocol').querySelectorAll('option')].map(o => o.value);
    expect(options).toEqual(['', 'imap']);
  });

  it('reads the remote-images line from the session counters', async () => {
    useNetActivityStore.setState({ remoteImages: { blocked: 3, loaded: 7 } });
    await mount([]);
    const line = screen.getByTestId('net-remote-images').textContent;
    expect(line).toContain('3');
    expect(line).toContain('7');
  });

  it('says what it shows and what it leaves out, and never claims all requests', async () => {
    const { container } = await mount([]);
    const text = container.textContent;
    expect(text).toContain('Connections made by MailVault and its background helper');
    expect(text).toMatch(/Remote images and other web content inside emails/);
    expect(text).toMatch(/App update downloads, and on macOS the update check too/);
    expect(text).not.toMatch(/all requests|every request|all connections|every connection/i);
    expect(text).not.toContain('—');
  });

  it('shows a lookup as name and answer, without a port', async () => {
    await mount([ev({ protocol: 'dns', host: 'imap.a.test', ip: '192.0.2.9', port: 53, purpose: 'sync' })]);
    const row = screen.getByTestId('net-row');
    expect(row.textContent).toContain('imap.a.test');
    expect(row.textContent).toContain('192.0.2.9');
    expect(within(row).getByTestId('net-port').textContent).toBe('');
  });

  it('stops listening when it unmounts', async () => {
    const view = await mount([]);
    expect(harness.listeners.has('net-activity')).toBe(true);
    view.unmount();
    expect(harness.unlisten).toHaveBeenCalledWith('net-activity');
    expect(harness.listeners.has('net-activity')).toBe(false);
  });
});
