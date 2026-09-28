// @vitest-environment jsdom
// jsdom: frameBody runs the real tracker scan, which needs DOMParser.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const harness = vi.hoisted(() => ({ daemonCall: vi.fn(), listeners: new Map(), unlisten: vi.fn() }));

vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...args) => harness.daemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name, cb) => {
    harness.listeners.set(name, cb);
    return () => { harness.listeners.delete(name); harness.unlisten(name); };
  },
}));

const { useNetActivityStore, visibleEvents, filterEvents, summarize, copyText, frameBody } = await import('../netActivityStore');

const ev = (over = {}) => ({
  atMs: Date.UTC(2026, 8, 28, 10, 0, 0), direction: 'out', process: 'helper', protocol: 'imap',
  host: 'imap.example.test', ip: '192.0.2.1', port: 993, purpose: 'sync', account: '<imap#ab12>',
  bytesUp: 100, bytesDown: 2000, durationMs: 1500, result: 'ok', commands: null, ...over,
});
const push = payload => harness.listeners.get('net-activity')({ payload });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  harness.daemonCall.mockReset();
  harness.unlisten.mockReset();
  harness.listeners.clear();
  useNetActivityStore.setState({ events: [], frozen: null, loadError: false, remoteImages: { blocked: 0, loaded: 0 } });
});

describe('live list', () => {
  it('shows the snapshot newest first, then puts each pushed event on top', async () => {
    const older = ev({ host: 'older.test' });
    const newer = ev({ host: 'newer.test' });
    harness.daemonCall.mockResolvedValue({ events: [newer, older] });
    const stop = useNetActivityStore.getState().start();
    await flush();
    expect(harness.daemonCall).toHaveBeenCalledWith('net.activity');
    expect(useNetActivityStore.getState().events.map(e => e.host)).toEqual(['newer.test', 'older.test']);
    push(ev({ host: 'live.test' }));
    expect(useNetActivityStore.getState().events.map(e => e.host)).toEqual(['live.test', 'newer.test', 'older.test']);
    stop();
  });

  // Arrival order, not atMs: an IMAP connection is recorded when it closes,
  // so the newest row can carry the oldest start time.
  it('keeps arrival order even when a later event started earlier', async () => {
    harness.daemonCall.mockResolvedValue({ events: [ev({ host: 'a.test', atMs: 5000 })] });
    const stop = useNetActivityStore.getState().start();
    await flush();
    push(ev({ host: 'long-idle.test', atMs: 1000 }));
    expect(useNetActivityStore.getState().events.map(e => e.host)).toEqual(['long-idle.test', 'a.test']);
    stop();
  });

  it('listens before it asks for the snapshot, and an event already in the snapshot is not listed twice', async () => {
    let answer;
    harness.daemonCall.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const stop = useNetActivityStore.getState().start();
    await flush();
    expect(harness.listeners.has('net-activity')).toBe(true);
    const both = ev({ host: 'both.test' });
    const onlyLive = ev({ host: 'only-live.test' });
    push(both);
    push(onlyLive);
    answer({ events: [{ ...both }] });
    await flush();
    expect(useNetActivityStore.getState().events.map(e => e.host)).toEqual(['only-live.test', 'both.test']);
    stop();
  });

  it('stops listening when stopped, even before the listener was in place', async () => {
    harness.daemonCall.mockResolvedValue({ events: [] });
    const stop = useNetActivityStore.getState().start();
    stop();
    await flush();
    expect(harness.listeners.has('net-activity')).toBe(false);
    expect(harness.unlisten).toHaveBeenCalledWith('net-activity');
  });

  it('keeps at most 2,000 rows, dropping the oldest', async () => {
    harness.daemonCall.mockResolvedValue({ events: Array.from({ length: 2000 }, (_, i) => ev({ host: `h${i}.test` })) });
    const stop = useNetActivityStore.getState().start();
    await flush();
    push(ev({ host: 'new.test' }));
    const { events } = useNetActivityStore.getState();
    expect(events).toHaveLength(2000);
    expect(events[0].host).toBe('new.test');
    expect(events.at(-1).host).toBe('h1998.test');
    stop();
  });

  // A restarted daemon starts an empty ring: the rows it no longer has go.
  it('takes a fresh snapshot when the daemon reconnects', async () => {
    harness.daemonCall.mockResolvedValue({ events: [ev({ host: 'before-restart.test' })] });
    const stop = useNetActivityStore.getState().start();
    await flush();
    expect(harness.listeners.has('daemon-reconnected')).toBe(true);
    harness.daemonCall.mockResolvedValue({ events: [ev({ host: 'after-restart.test' })] });
    harness.listeners.get('daemon-reconnected')({ payload: null });
    await flush();
    expect(useNetActivityStore.getState().events.map(e => e.host)).toEqual(['after-restart.test']);
    stop();
  });

  // The next visit must never open on the last visit's rows.
  it('clears the rows and any pause when stopped', async () => {
    harness.daemonCall.mockResolvedValue({ events: [ev({ host: 'old-visit.test' })] });
    const stop = useNetActivityStore.getState().start();
    await flush();
    useNetActivityStore.getState().pause();
    stop();
    expect(useNetActivityStore.getState().events).toEqual([]);
    expect(useNetActivityStore.getState().frozen).toBeNull();
    expect(harness.listeners.has('daemon-reconnected')).toBe(false);
  });

  it('says so when the snapshot cannot be read', async () => {
    harness.daemonCall.mockRejectedValue(new Error('offline'));
    const stop = useNetActivityStore.getState().start();
    await flush();
    expect(useNetActivityStore.getState().loadError).toBe(true);
    stop();
  });
});

describe('pause', () => {
  it('holds the rows on screen while paused and shows what arrived on resume', async () => {
    harness.daemonCall.mockResolvedValue({ events: [ev({ host: 'first.test' })] });
    const stop = useNetActivityStore.getState().start();
    await flush();
    useNetActivityStore.getState().pause();
    push(ev({ host: 'while-paused.test' }));
    expect(visibleEvents(useNetActivityStore.getState()).map(e => e.host)).toEqual(['first.test']);
    useNetActivityStore.getState().resume();
    expect(visibleEvents(useNetActivityStore.getState()).map(e => e.host)).toEqual(['while-paused.test', 'first.test']);
    stop();
  });
});

describe('filterEvents', () => {
  const rows = [
    ev({ host: 'a', protocol: 'imap', purpose: 'sync', account: '<imap#1>' }),
    ev({ host: 'b', protocol: 'smtp', purpose: 'send', account: '<imap#1>' }),
    ev({ host: 'c', protocol: 'https', purpose: 'AI model', account: null }),
    ev({ host: 'd', protocol: 'imap', purpose: 'backup', account: '<imap#2>' }),
  ];
  it('narrows by protocol, purpose and account, and an empty filter keeps everything', () => {
    expect(filterEvents(rows, {}).map(e => e.host)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterEvents(rows, { protocol: 'imap' }).map(e => e.host)).toEqual(['a', 'd']);
    expect(filterEvents(rows, { purpose: 'AI model' }).map(e => e.host)).toEqual(['c']);
    expect(filterEvents(rows, { account: '<imap#1>' }).map(e => e.host)).toEqual(['a', 'b']);
    expect(filterEvents(rows, { protocol: 'imap', account: '<imap#2>' }).map(e => e.host)).toEqual(['d']);
  });
});

describe('summarize', () => {
  const now = new Date(2026, 8, 28, 15, 0, 0).getTime();
  const today = new Date(2026, 8, 28, 9, 0, 0).getTime();
  const yesterday = new Date(2026, 8, 27, 23, 0, 0).getTime();
  it('counts the distinct hosts contacted today and the bytes sent and received today', () => {
    const s = summarize([
      ev({ host: 'imap.a.test', atMs: today, bytesUp: 10, bytesDown: 100 }),
      ev({ host: 'imap.a.test', atMs: today, bytesUp: 5, bytesDown: 50 }),
      ev({ host: 'smtp.a.test', protocol: 'smtp', atMs: today, bytesUp: 1000, bytesDown: 20 }),
      // A lookup names a host but contacts the resolver, not the host.
      ev({ host: 'only-looked-up.test', protocol: 'dns', port: 53, atMs: today, bytesUp: 0, bytesDown: 0 }),
      // Inbound: a hit on the sign-in loopback, not a host MailVault contacted.
      ev({ host: '127.0.0.1', direction: 'in', protocol: 'http', atMs: today, bytesUp: 7, bytesDown: 3 }),
      ev({ host: 'yesterday.test', atMs: yesterday, bytesUp: 99999, bytesDown: 99999 }),
    ], now);
    expect(s).toEqual({ hosts: 2, sent: 1022, received: 173 });
  });
});

describe('copyText', () => {
  it('writes one line per row with time, protocol, host:port, purpose, bytes and result', () => {
    const rows = [
      ev({ host: 'imap.a.test', port: 993, purpose: 'sync', bytesUp: 100, bytesDown: 2000, result: 'ok' }),
      ev({ host: 'api.b.test', protocol: 'https', port: 443, purpose: 'AI model', bytesUp: 5, bytesDown: 6, result: 'HTTP 503' }),
    ];
    const lines = copyText(rows).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(new Date(rows[0].atMs).toISOString());
    expect(lines[0]).toContain('IMAP');
    expect(lines[0]).toContain('imap.a.test:993');
    expect(lines[0]).toContain('sync');
    expect(lines[0]).toContain('100');
    expect(lines[0]).toContain('2000');
    expect(lines[0]).toContain('ok');
    expect(lines[1]).toContain('HTTPS');
    expect(lines[1]).toContain('api.b.test:443');
    expect(lines[1]).toContain('AI model');
    expect(lines[1]).toContain('HTTP 503');
  });

  it('writes a lookup as name and answer, not as a connection to port 53', () => {
    const line = copyText([ev({ protocol: 'dns', host: 'imap.a.test', ip: '192.0.2.9', port: 53 })]);
    expect(line).toContain('imap.a.test -> 192.0.2.9');
    expect(line).not.toContain(':53');
  });
});

describe('remote images', () => {
  const beacon = '<img src="https://track.example.test/o.gif" width="1" height="1">';
  const photo = '<img src="https://cdn.example.test/photo.jpg" width="600" height="400">';
  const plainHttp = '<img src="http://old.example.test/photo.jpg" width="600" height="400">';
  const inline = '<img src="cid:logo@x" width="600" height="400">';
  const counts = () => useNetActivityStore.getState().remoteImages;

  it('with blocking on, counts the removed beacon as blocked and the other https image as loaded', async () => {
    const body = `<p>hi</p>${beacon}${photo}${inline}`;
    const { body: rendered } = frameBody(body, 'acct-INBOX-1', true);
    expect(rendered).not.toContain('track.example.test');
    await flush();
    expect(counts()).toEqual({ blocked: 1, loaded: 1 });
  });

  it('with blocking off, blocks nothing and counts every https image as loaded', async () => {
    const body = `<p>x</p>${beacon}${photo}`;
    const { body: rendered } = frameBody(body, 'acct-INBOX-2', false);
    expect(rendered).toBe(body);
    await flush();
    expect(counts()).toEqual({ blocked: 0, loaded: 2 });
  });

  // The app's CSP allows `img-src https:` only: a plain http image never loads.
  it('does not count a plain http or inline image as loaded', async () => {
    frameBody(`<p>y</p>${plainHttp}${inline}`, 'acct-INBOX-3', false);
    await flush();
    expect(counts()).toEqual({ blocked: 0, loaded: 0 });
  });

  it('counts a message once however often it is rendered', async () => {
    const body = `<p>z</p>${photo}`;
    frameBody(body, 'acct-INBOX-4', false);
    frameBody(body, 'acct-INBOX-4', false);
    frameBody(body, 'acct-INBOX-4', true);
    await flush();
    expect(counts()).toEqual({ blocked: 0, loaded: 1 });
  });

  // Index Only / On Demand: a preview body first, the full one later, same key.
  it('adds what a fuller body of the same message brings, and only that', async () => {
    frameBody(`<p>preview</p>${photo}`, 'acct-INBOX-5', false);
    frameBody(`<p>full</p>${photo}<img src="https://cdn.example.test/second.jpg" width="600" height="400">`, 'acct-INBOX-5', false);
    await flush();
    expect(counts()).toEqual({ blocked: 0, loaded: 2 });
  });

  it('tells keyless previews apart by their body', async () => {
    frameBody(`<p>one</p>${photo}`, null, false);
    frameBody(`<p>two</p>${photo}`, null, false);
    frameBody(`<p>two</p>${photo}`, null, false);
    await flush();
    expect(counts()).toEqual({ blocked: 0, loaded: 2 });
  });
});
