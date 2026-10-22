// The client of the daemon's body scan (`body.scan`): what it sends, what it
// keeps, what it answers when the daemon cannot be asked. The verdicts
// themselves are the daemon's, held to the deleted JS by
// src-core/tests/fixtures/body-scan-cases.json.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vitest.setup.js answers every scan at once for the renderers' tests; this is the client itself.
vi.unmock('../bodyScan');

const harness = vi.hoisted(() => ({ daemonCall: vi.fn() }));
vi.mock('../daemonClient', () => ({
  daemonCall: (...args) => harness.daemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));

const { scanBody, scanForFrame, SCAN_BUDGET_MS, peekBodyScan, getCachedAlerts, getCachedTrackers, scanHead, classifyLinks, trackerPatternCount, bodyTexts, BODY_TEXT_KEYS, UNSCANNED_HEAD, _resetBodyScans } = await import('../bodyScan');
const { useNetActivityStore } = await import('../../stores/netActivityStore');
const { setLocale } = await import('../../i18n/index.js');

const BEACON = '<p>hi</p><img src="https://u1.ct.sendgrid.net/wf/open?upn=abc" width="1" height="1">';
const MARKED = '<p>hi</p><span data-mv-tracker-blocked="SendGrid">x</span>';
const tracker = { vendor: 'SendGrid', known: true, domain: 'u1.ct.sendgrid.net', url: 'https://u1.ct.sendgrid.net/wf/open?upn=abc', reason: 'SendGrid open-tracking beacon' };
const alert = { level: 'red', textContent: 'https://bank.test', textDomain: 'bank.test', actualUrl: 'https://evil.test/', actualDomain: 'evil.test', reason: 'r' };

const scans = () => harness.daemonCall.mock.calls.filter(([m]) => m === 'body.scan').map(([, p]) => p);

beforeEach(() => {
  _resetBodyScans();
  harness.daemonCall.mockReset();
  harness.daemonCall.mockImplementation(async (method, p) => {
    if (method !== 'body.scan') throw new Error(`unexpected ${method}`);
    const found = p.html.includes('sendgrid');
    return {
      trackers: found ? [tracker] : [], count: found ? 1 : 0, https: found ? 1 : 0,
      summary: found ? { count: 1, vendors: ['SendGrid'] } : null,
      html: p.blocking && found ? MARKED : p.links ? `${p.html}<!--links-->` : null,
      alerts: p.links ? [alert] : null, maxAlertLevel: p.links ? 'red' : null,
    };
  });
  useNetActivityStore.setState({ remoteImages: { blocked: 0, loaded: 0 } });
});

describe('scanBody', () => {
  it('sends the body without its Google Font imports, the flags and the UI language templates', async () => {
    const font = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora">';
    await scanBody(`${font}${BEACON}`, { key: 'a-INBOX-1', blocking: true, links: true });
    const [p] = scans();
    expect(p.html).toBe(BEACON);
    expect(p).toMatchObject({ blocking: true, links: true });
    expect(Object.keys(p.texts)).toEqual(BODY_TEXT_KEYS);
    expect(p.texts['util.trackerDetect.vendorBeacon']).toBe('{{vendor}} open-tracking beacon');
  });

  it('frames the daemon body, or the one sent when the daemon says it is unchanged', async () => {
    expect((await scanBody(BEACON, { key: 'a-INBOX-2', blocking: true })).html).toBe(MARKED);
    expect((await scanBody(BEACON, { key: 'a-INBOX-2', blocking: false })).html).toBe(BEACON);
  });

  it('asks once per message, body, language and flags', async () => {
    const first = await scanBody(BEACON, { key: 'a-INBOX-3', blocking: true });
    expect(await scanBody(BEACON, { key: 'a-INBOX-3', blocking: true })).toBe(first);
    expect(peekBodyScan(BEACON, { key: 'a-INBOX-3', blocking: true })).toBe(first);
    await scanBody(BEACON, { key: 'a-INBOX-3', blocking: false });
    await scanBody(BEACON, { key: 'b-INBOX-3', blocking: true });
    await scanBody('<p>other</p>', { key: 'a-INBOX-3', blocking: true });
    expect(scans()).toHaveLength(4);
  });

  it('a language change is a different scan', async () => {
    await scanBody(BEACON, { key: 'a-INBOX-4' });
    await setLocale('de');
    try {
      await scanBody(BEACON, { key: 'a-INBOX-4' });
      expect(scans()).toHaveLength(2);
      expect(scans()[1].texts['util.trackerDetect.beaconPath']).toBe('Der Anfragepfad ist ein Endpunkt zur Öffnungserkennung');
    } finally {
      await setLocale('en');
    }
  });

  it('an empty body asks nothing', async () => {
    expect(await scanBody('', { key: 'a-INBOX-5' })).toMatchObject({ html: '', count: 0, scanned: true });
    expect(scans()).toHaveLength(0);
  });

  it('a failed call is "not scanned", never "clean", and is asked again next time', async () => {
    harness.daemonCall.mockRejectedValueOnce(new Error('down'));
    const failed = await scanBody(BEACON, { key: 'a-INBOX-6', blocking: true });
    expect(failed).toMatchObject({ scanned: false, html: BEACON, count: 0 });
    expect(scanHead(failed)).toBe(UNSCANNED_HEAD);
    expect(peekBodyScan(BEACON, { key: 'a-INBOX-6', blocking: true })).toBeUndefined();
    expect((await scanBody(BEACON, { key: 'a-INBOX-6', blocking: true })).scanned).toBe(true);
  });

  it('keeps the trackers and the flagged links for the key, never for a keyless body', async () => {
    await scanBody(BEACON, { key: 'a-INBOX-7', links: true });
    expect(getCachedTrackers('a-INBOX-7')).toEqual([tracker]);
    expect(getCachedAlerts('a-INBOX-7')).toEqual([alert]);
    // Another account's uid 7 was never scanned.
    expect(getCachedAlerts('b-INBOX-7')).toBeNull();
    await scanBody(BEACON, { key: null, links: true });
    expect(getCachedAlerts(null)).toBeNull();
    // A scan without links says nothing about the links.
    await scanBody(BEACON, { key: 'a-INBOX-8' });
    expect(getCachedAlerts('a-INBOX-8')).toBeNull();
  });

  it('counts what a frame loads and what it blocks for Network Activity, a frame it draws only', async () => {
    // A scan nobody frames (the list's tracker backfill) loads nothing.
    await scanBody(BEACON, { key: 'a-INBOX-9', blocking: true });
    await Promise.resolve();
    expect(useNetActivityStore.getState().remoteImages).toEqual({ blocked: 0, loaded: 0 });
    // A pop-out window frames what it scanned.
    await scanForFrame(BEACON, { key: 'a-INBOX-9', blocking: true });
    await Promise.resolve();
    expect(useNetActivityStore.getState().remoteImages).toEqual({ blocked: 1, loaded: 0 });
  });

  it('a daemon that never answers is "not scanned" after the budget, so the frame refuses remote images', async () => {
    vi.useFakeTimers();
    try {
      harness.daemonCall.mockImplementation(() => new Promise(() => {}));
      let got;
      scanBody(BEACON, { key: 'a-INBOX-11' }).then((scan) => { got = scan; });
      await vi.advanceTimersByTimeAsync(SCAN_BUDGET_MS - 1);
      expect(got).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);
      expect(got).toMatchObject({ scanned: false, html: BEACON });
      expect(scanHead(got)).toBe(UNSCANNED_HEAD);
      // Not kept: the next look asks again.
      expect(peekBodyScan(BEACON, { key: 'a-INBOX-11' })).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never evicts a scan still being asked: its answer is kept when it lands', async () => {
    let release;
    harness.daemonCall.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = scanBody(BEACON, { key: 'a-INBOX-12' });
    for (let i = 0; i < 520; i++) await scanBody(`<p>${i}</p>`, { key: `b-INBOX-${i}` });
    release({ trackers: [], count: 0, https: 0, summary: null, html: null, alerts: null, maxAlertLevel: null });
    await pending;
    expect(peekBodyScan(BEACON, { key: 'a-INBOX-12' })).toMatchObject({ scanned: true });
  });

  it('the frame head carries the link marks only when a link is flagged', async () => {
    expect(scanHead(await scanBody(BEACON, { key: 'a-INBOX-10', links: true }))).toMatch(/^<style>[\s\S]*data-link-alert="red"/);
    expect(scanHead(await scanBody(BEACON, { key: 'a-INBOX-10' }))).toBe('');
  });

  it('the templates are the catalog strings with their slots', () => {
    expect(bodyTexts()['linkSafety.reason.textMismatch']).toBe('Link text shows {{textDomain}} but goes to {{actualDomain}}');
  });
});

describe('classifyLinks and the pattern count', () => {
  it('ask the daemon, and answer null when it cannot', async () => {
    harness.daemonCall.mockImplementation(async (method, p) => {
      if (method === 'body.classify_links') return p.links.map(() => ({ level: 'red' }));
      if (method === 'body.info') return { trackerPatterns: 498 };
      throw new Error(method);
    });
    expect(await classifyLinks([{ href: 'javascript:x', text: 'x' }])).toEqual([{ level: 'red' }]);
    expect(await trackerPatternCount()).toBe(498);
    harness.daemonCall.mockRejectedValue(new Error('down'));
    expect(await classifyLinks([{ href: 'javascript:x', text: 'x' }])).toBeNull();
    expect(await trackerPatternCount()).toBeNull();
    expect(await classifyLinks([])).toEqual([]);
  });
});
