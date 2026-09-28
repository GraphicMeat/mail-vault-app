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
  host: 'imap.example.test', ip: '192.0.2.1', port: 993, purpose: 'sync', account: '<imap#ab12>',
  bytesUp: 100, bytesDown: 2000, durationMs: 1500, result: 'ok', commands: null, ...over,
});
const flush = () => act(() => new Promise(resolve => setTimeout(resolve, 0)));
const push = async payload => { await act(async () => { harness.listeners.get('net-activity')({ payload }); }); };
const hosts = () => screen.getAllByTestId('net-row').map(row => row.getAttribute('data-host'));
const writeText = vi.fn(() => Promise.resolve());

async function mount(events) {
  harness.daemonCall.mockResolvedValue({ events });
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
  useNetActivityStore.setState({ events: [], frozen: null, loadError: false, remoteImages: { blocked: 0, loaded: 0 } });
});
afterEach(cleanup);

describe('Network Activity', () => {
  it('renders the net.activity snapshot newest first', async () => {
    await mount([ev({ host: 'newest.test' }), ev({ host: 'older.test' })]);
    expect(harness.daemonCall).toHaveBeenCalledWith('net.activity');
    expect(hosts()).toEqual(['newest.test', 'older.test']);
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
      ev({ host: 'a.test', protocol: 'imap', purpose: 'sync', account: '<imap#1>' }),
      ev({ host: 'b.test', protocol: 'smtp', purpose: 'send', account: '<imap#1>' }),
      ev({ host: 'c.test', protocol: 'https', purpose: 'AI model', account: null }),
      ev({ host: 'd.test', protocol: 'imap', purpose: 'backup', account: '<imap#2>' }),
    ]);
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'imap' } });
    expect(hosts()).toEqual(['a.test', 'd.test']);
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: '<imap#2>' } });
    expect(hosts()).toEqual(['d.test']);
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'AI model' } });
    expect(hosts()).toEqual(['c.test']);
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

  it('sums up the hosts contacted today and the bytes sent and received', async () => {
    await mount([
      ev({ host: 'a.test', bytesUp: 1000, bytesDown: 3000 }),
      ev({ host: 'a.test', bytesUp: 24, bytesDown: 72 }),
      ev({ host: 'b.test', bytesUp: 0, bytesDown: 0 }),
    ]);
    const strip = screen.getByTestId('net-summary');
    expect(within(strip).getByTestId('net-summary-hosts').textContent).toBe('2');
    expect(within(strip).getByTestId('net-summary-sent').textContent).toBe('1.0 KB');
    expect(within(strip).getByTestId('net-summary-received').textContent).toBe('3.0 KB');
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
    expect(text).toMatch(/App update downloads/);
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
